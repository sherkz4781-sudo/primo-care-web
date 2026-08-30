require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const gcal = require('./lib/google');
const airtable = require('./lib/airtable');
const stripeLib = require('./lib/stripe');
const anthropicLib = require('./lib/anthropic');
const twilioLib = require('./lib/twilio');
const multer = require('multer');

const app = express();
// Render (and most hosts) put the app behind a reverse proxy, so without this, req.ip would
// return the proxy's own address for every request — collapsing the chat widget's per-visitor
// rate limit into one shared bucket for the whole site. This trusts the X-Forwarded-For header
// the host sets, so req.ip reflects the actual visitor.
app.set('trust proxy', true);

// The Stripe webhook needs the raw, unparsed request body to verify its signature, so it's
// registered — with its own raw-body middleware — before the global JSON parser below. Express
// matches middleware/routes in registration order, so a request to this exact path never reaches
// express.json() at all; every other route is unaffected.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripeLib.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).send('Webhook signature verification failed.');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.orderId;
      if (orderId) {
        const rec = await airtable.findByField('Order ID', orderId);
        if (rec && (rec.fields || {})['Payment Status'] !== 'Paid') {
          await markJobPaid(rec.id, 'Online / Card', 'Stripe (automatic)');
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handling failed:', err.message);
    // Still 200 — Stripe retries on non-2xx, and retrying won't fix an application-side bug.
    // The failure is logged for a human to investigate instead.
    res.json({ received: true });
  }
});

app.use(express.json({ limit: '1mb' }));
// The Cash/Check buttons on /pay/:orderId are plain HTML <form> posts (no JS), which the browser
// sends as x-www-form-urlencoded rather than JSON.
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const CAL_TIMEZONE = gcal.CAL_TIMEZONE;

// Shared multipart-upload handler — used by the staff before/after job photo routes and by the
// client-facing bank-transfer proof upload further down.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|heic|heif)$|^application\/pdf$/.test(file.mimetype))
});

// ---- ID generation (moved server-side so a client can't forge/replay reference numbers) ----
function genRefId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PC-${prefix}-${ts}${rand}`;
}

// Self-serve client login accounts for the /account portal — separate from the internal
// Staff-Members table further down. Declared here (not alongside Staff-Members) since
// /api/submit, defined next, needs it too.
const CLIENT_MEMBERS_TABLE = 'Client Members';

// Escapes a value before it's interpolated into a server-rendered HTML response — used on the
// few pages here that echo back a query-string/route value (e.g. an Order ID) a client's browser
// sent, so that value can never be read as markup.
function escapeHtmlServer(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Verifies the supplied identity against an Airtable record fetched by Order ID. Returns the
// record if every field matches (case-insensitive), otherwise null. Never reveals *which*
// field mismatched, so a client can't use this to fish for valid Order IDs.
async function findVerifiedRecord({ firstName, lastName, email, orderId }) {
  const rec = await airtable.findByField('Order ID', orderId);
  if (!rec) return null;
  const f = rec.fields || {};
  const norm = v => (v || '').toString().trim().toLowerCase();
  if (norm(f['First Name']) !== norm(firstName)) return null;
  if (norm(f['Last Name']) !== norm(lastName)) return null;
  if (norm(f['Email']) !== norm(email)) return null;
  return rec;
}

// Ownership check for the /account dashboard's cancel/reschedule actions — the client is already
// authenticated via their session, so this replaces name/email verification with a straight
// Client ID match. Returns null (never revealing whether the Order ID exists at all) if it
// belongs to someone else, same non-disclosure treatment as findVerifiedRecord.
async function findOwnedOrder(orderId, clientId) {
  const rec = await airtable.findByField('Order ID', orderId);
  if (!rec || (rec.fields || {})['Client ID'] !== clientId) return null;
  return rec;
}

// Same identity-verification pattern as findVerifiedRecord, but matched by Client ID and
// returning EVERY property record under that client (a client can have multiple properties).
// Identity is checked against the first matching record, since a Client ID always ties back to
// one client's First/Last/Email across all their property records.
async function findVerifiedClientRecords({ firstName, lastName, email, clientId }) {
  const recs = await airtable.findAllByField('Client ID', clientId);
  if (!recs.length) return null;
  const f = recs[0].fields || {};
  const norm = v => (v || '').toString().trim().toLowerCase();
  if (norm(f['First Name']) !== norm(firstName)) return null;
  if (norm(f['Last Name']) !== norm(lastName)) return null;
  if (norm(f['Email']) !== norm(email)) return null;
  return recs;
}

// Deletes the calendar event tied to a booking. Prefers the stored Calendar Event ID
// (deleting a recurring series' master event cancels the whole series); falls back to a
// full-text search on the Order ID for records saved before that field existed.
async function deleteBookingEvent(rec, orderId) {
  const eventId = rec.fields && rec.fields['Calendar Event ID'];
  if (eventId) {
    await gcal.deleteEvent(eventId);
    return;
  }
  const now = new Date();
  const farFuture = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365 * 2);
  const events = await gcal.searchEventsByText(orderId, now.toISOString(), farFuture.toISOString());
  for (const ev of events) {
    await gcal.deleteEvent(ev.id).catch(() => null);
  }
}

// Builds a clickable Google Maps link from the "lat,lng" pin a client dropped on /intake's
// address autocomplete, for splicing into a calendar event description. Returns '' (filtered
// out by the .filter(Boolean) callers already use) if the property has no stored pin — either
// because it predates this feature or the client typed an address without picking a suggestion.
function mapPinLine(fields) {
  const pin = fields && fields['Map Pin (Lat,Lng)'];
  return pin ? `Map pin: https://www.google.com/maps?q=${pin}` : '';
}

// Public config for client-side scripts — safe to expose since a Maps JS API key is meant to be
// embedded in the browser and is restricted by HTTP referrer in Google Cloud Console, not kept
// secret. Returns an empty key (feature inactive, address field behaves as plain text) until
// GOOGLE_MAPS_API_KEY is set.
app.get('/api/config', (req, res) => {
  res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// Sends one SMS reminder via Twilio — called by the primo-care-48hr-notice scheduled task's
// same-day "~2 hours before" pass (separate from its 48hr email reminder), for clients who
// opted in on /intake. Gated by a shared secret (not client-facing auth — there's no logged-in
// user in this flow) since this relays real texts through your Twilio account; without that
// gate, anyone who found this URL could spam-text arbitrary numbers on your bill. Returns
// {sent:false} rather than erroring when Twilio isn't configured, so the scheduled task's SMS
// pass can no-op without failing the run.
app.post('/api/internal/send-sms', async (req, res) => {
  try {
    const secret = req.headers['x-internal-secret'];
    if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    if (!twilioLib.isConfigured()) {
      return res.json({ sent: false, reason: 'Twilio is not configured.' });
    }
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'Missing to/body.' });
    await twilioLib.sendSms(to, body);
    res.json({ sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Intake form endpoints
// ---------------------------------------------------------------------------

// Accepts one client + an array of properties (one client can book multiple properties in a
// single submission). A Client ID is resolved server-side (reused if this email already has one
// on file, minted fresh otherwise — never trusted from the client, same as Order ID) and shared
// across every property record created here; each property gets its own fresh Order ID so it
// can be individually cancelled/rescheduled later. Matched by email rather than name since two
// different clients can share a name but never an email. Transaction ID is intentionally NOT
// minted here — it's a proof-of-payment reference, so it's only generated once staff actually
// confirm the client paid (see /api/staff/mark-paid).
app.post('/api/submit', async (req, res) => {
  try {
    const b = req.body || {};
    const firstName = (b.firstName || '').trim();
    const lastName = (b.lastName || '').trim();
    const fullName = `${firstName} ${lastName}`;
    const email = (b.email || '').trim();
    const properties = Array.isArray(b.properties) ? b.properties : [];
    if (!properties.length) return res.status(400).json({ error: 'At least one property is required.' });

    // Client ID resolution checks Submissions first (the common case — a returning booker),
    // then falls back to Client Members (a prospect who signed up via /api/client/signup
    // before ever booking already has a Client ID minted there with no Submissions row yet) —
    // otherwise their first real booking would mint a second, different Client ID and silently
    // orphan it from the account they already set up.
    let clientId;
    try {
      const existing = email ? await airtable.findClientIdByEmail(email) : null;
      const existingClientId = existing && existing.fields && existing.fields['Client ID'];
      if (existingClientId) {
        clientId = existingClientId;
      } else {
        const member = email ? await findClientMemberByEmail(email) : null;
        clientId = (member && member.clientId) || genRefId('CLI');
      }
    } catch (err) {
      console.error('Client ID lookup failed, minting a new one:', err.message);
      clientId = genRefId('CLI');
    }

    // Referral discount — if this submitting client has an unused $10 credit (earned by a
    // previous referral of theirs whose referred client's first job was completed — see
    // /api/staff/complete), apply it to the first property in this submission only. Computed
    // from the grand total here, not the per-sqft Rate Card, so the core pricing engine used by
    // intake/booking/rescheduling is untouched.
    let availableCredit = null;
    try {
      const credits = await airtable.listAllForTable('Referral Credits', {
        formula: `AND({Referrer Client ID}="${String(clientId).replace(/"/g, '\\"')}", {Used}=FALSE())`
      });
      availableCredit = credits[0] || null;
    } catch (err) {
      console.error('Referral credit lookup failed (continuing without applying one):', err.message);
    }

    const referredBy = (b.referredBy || '').trim();
    const results = [];
    let creditConsumed = false;
    for (const p of properties) {
      const orderId = genRefId('ORD');
      let total = p.total;
      let discountApplied = false;
      if (availableCredit && !creditConsumed) {
        total = Math.max(0, (p.total || 0) - 10);
        discountApplied = true;
        creditConsumed = true;
      }

      const fields = {
        'Client Name': fullName,
        'Submitted At': new Date().toISOString(),
        'First Name': firstName,
        'Last Name': lastName,
        'Email': b.email,
        'Contact Number': b.phone,
        'SMS Opt-In': !!b.smsOptIn,
        'Address': p.address,
        'Zip Code': p.zip,
        'Property Type': p.propertyType === 'residential' ? 'Residential' : 'Commercial',
        'Property Size': p.sqft,
        'Property Size Unit': p.sizeUnit === 'sqm' ? 'sq m' : 'sq ft',
        'Areas / Facility Type': p.propertyType === 'residential' ? (p.areasFormatted || (p.areas || []).join(', ')) : p.service,
        'Service': p.service,
        'Estimated Total per Visit': total,
        'Draft Email Created': false,
        'Client ID': clientId,
        'Order ID': orderId,
        'Status': 'Scheduled'
      };
      if (b.prefix) fields['Prefix'] = b.prefix;
      if (b.suffix) fields['Suffix'] = b.suffix;
      if (p.mapPin) fields['Map Pin (Lat,Lng)'] = p.mapPin;
      if (referredBy) fields['Referred By (Client ID)'] = referredBy;
      const combinedAddonSqft = (p.balconySqftEquiv || 0) + (p.lanaiSqftEquiv || 0);
      if (combinedAddonSqft) fields['Balcony-Lanai Size (sq ft)'] = combinedAddonSqft;
      if (p.addonNote) fields['Balcony-Lanai Add-on'] = p.addonNote;
      if (p.othersSpecify) fields['Others Area Specify'] = p.othersSpecify;
      if (p.frequency) fields['Subscription'] = p.frequency;
      if (p.subscriptionDuration) fields['Duration'] = p.subscriptionDuration;

      const rec = await airtable.createRecord(fields);
      if (discountApplied) {
        await airtable.updateRecordForTable('Referral Credits', availableCredit.id, { 'Used': true, 'Used On Order ID': orderId });
      }
      results.push({ orderId, recordId: rec.id, total, discountApplied });
    }

    // Client portal auto-enrollment — the first time a given email submits, create a pending
    // (unverified, no password yet) Client Members record, and again on any later submission
    // as long as it's still unverified (they booked once, never finished setting a password —
    // this gives them a fresh code/link instead of leaving them stuck on a stale one). Matched
    // by email, same key as the Client ID lookup above. A failure here is logged but never
    // fails the booking itself, same treatment as the referral-credit lookup above.
    let accountSetup = null;
    if (email) {
      try {
        const escaped = email.replace(/"/g, '\\"').toLowerCase();
        const existingMember = await airtable.listAllForTable(CLIENT_MEMBERS_TABLE, {
          formula: `LOWER({Email}) = "${escaped}"`
        });
        if (!existingMember.length || !existingMember[0].fields.Verified) {
          if (!existingMember.length) {
            await airtable.createRecordForTable(CLIENT_MEMBERS_TABLE, {
              'Email': email,
              'Client ID': clientId,
              'Full Name': fullName,
              'Verified': false,
              'Account Created At': new Date().toISOString()
            });
          }
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          const code = String(crypto.randomInt(100000, 1000000));
          const token = signPurposeToken({ email, codeHash: hashOtpCode(code) }, OTP_TOKEN_TTL_MS, 'client-verify-otp');
          await sendAccountSetupEmail({ to: email, firstName: firstName || 'there', baseUrl, code });
          accountSetup = { token, email };
        }
      } catch (err) {
        console.error('Client Members auto-enrollment failed (booking still succeeded):', err.message);
      }
    }

    // Auto-un-hide: if this client had previously removed one of these addresses from their
    // saved-properties list (see /api/client/properties/hide — e.g. a rental they'd moved out
    // of), booking it again is a clear signal it's relevant once more. Un-hide it rather than
    // leaving it silently missing from /account next time they check.
    if (email) {
      try {
        const member = await findClientMemberByEmail(email);
        if (member && member.hiddenProperties.length) {
          const submittedKeys = new Set(properties.map(p => String(p.address || '').trim().toLowerCase()));
          const stillHidden = member.hiddenProperties.filter(a => !submittedKeys.has(String(a).trim().toLowerCase()));
          if (stillHidden.length !== member.hiddenProperties.length) {
            await airtable.updateRecordForTable(CLIENT_MEMBERS_TABLE, member.recordId, { 'Hidden Properties': JSON.stringify(stillHidden) });
          }
        }
      } catch (err) {
        console.error('Auto-unhide check failed (booking still succeeded):', err.message);
      }
    }

    res.json({ clientId, properties: results, accountSetup });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/find-times', async (req, res) => {
  try {
    const { date } = req.body || {};
    if (!date) return res.status(400).json({ error: 'Missing date.' });
    const slots = await gcal.findAvailableSlots(date);
    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/book', async (req, res) => {
  try {
    const b = req.body || {};
    const rec = await airtable.findByField('Order ID', b.orderId);
    if (!rec) return res.status(404).json({ error: 'Booking not found.' });

    const summary = b.isSubscription
      ? `Primo Care Cleaning (${b.freqName}) — ${b.firstName} ${b.lastName}`
      : `Primo Care Call — ${b.firstName} ${b.lastName}`;
    const description = [
      `Primo Care ${b.isSubscription ? 'subscription cleaning' : 'service call'}.`,
      `Client: ${b.firstName} ${b.lastName} — ${b.phone} — ${b.email}`,
      `Order ID: ${b.orderId}`,
      `Property: ${b.address} (${b.sqft} sq ft)`,
      mapPinLine(rec.fields),
      `Service: ${b.service}`,
      b.isSubscription ? `Schedule: ${b.freqName} for ${b.durationMonths} month(s)` : ''
    ].filter(Boolean).join('<br>');

    let recurrence = null;
    if (b.isSubscription) {
      const untilDate = new Date(b.slot.start);
      untilDate.setMonth(untilDate.getMonth() + Number(b.durationMonths));
      recurrence = { freqName: b.freqName, untilDate };
    }

    const event = await gcal.createEvent({
      summary, description, location: b.address,
      startIso: b.slot.start, endIso: b.slot.end, recurrence
    });

    const startStr = new Date(b.slot.start).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: CAL_TIMEZONE
    });

    await airtable.updateRecord(rec.id, {
      'Booked Date/Time': startStr + (b.isSubscription ? ` (recurring ${b.freqName})` : ''),
      'Booked Start (ISO)': new Date(b.slot.start).toISOString(),
      'Calendar Event ID': event.id
    });

    res.json({ eventId: event.id, startFormatted: startStr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Live "Book Now" page endpoints — lets a client scheduling from the proposal email's link
// look up their own property (identity-verified the same way as cancel/reschedule) and book
// it directly, without re-entering all their property details.
// ---------------------------------------------------------------------------

app.post('/api/order-lookup', async (req, res) => {
  try {
    const { firstName, lastName, email, orderId } = req.body || {};
    const rec = await findVerifiedRecord({ firstName, lastName, email, orderId });
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find a booking matching those details.' });

    const f = rec.fields || {};
    res.json({
      address: f['Address'] || '',
      propertyType: f['Property Type'] || '',
      sqft: f['Property Size'] || '',
      sizeUnit: f['Property Size Unit'] || 'sq ft',
      service: f['Service'] || '',
      total: f['Estimated Total per Visit'] || 0,
      frequency: f['Subscription'] || '',
      subscriptionDuration: f['Duration'] || '',
      alreadyBooked: !!f['Booked Date/Time'],
      bookedDisplay: f['Booked Date/Time'] || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Looks up every property under a Client ID at once — backs the single "Book a Schedule" link
// in the proposal email, which no longer points at one property's Order ID.
app.post('/api/client-lookup', async (req, res) => {
  try {
    const { firstName, lastName, email, clientId } = req.body || {};
    const recs = await findVerifiedClientRecords({ firstName, lastName, email, clientId });
    if (!recs) return res.status(404).json({ error: 'We couldn\'t find any properties matching those details.' });

    const properties = recs.map(rec => {
      const f = rec.fields || {};
      return {
        orderId: f['Order ID'] || '',
        address: f['Address'] || '',
        propertyType: f['Property Type'] || '',
        sqft: f['Property Size'] || '',
        sizeUnit: f['Property Size Unit'] || 'sq ft',
        service: f['Service'] || '',
        total: f['Estimated Total per Visit'] || 0,
        frequency: f['Subscription'] || '',
        subscriptionDuration: f['Duration'] || '',
        alreadyBooked: !!f['Booked Date/Time'],
        bookedDisplay: f['Booked Date/Time'] || ''
      };
    });
    // Surface not-yet-booked properties first, since those are the ones needing action.
    properties.sort((a, b) => Number(a.alreadyBooked) - Number(b.alreadyBooked));

    res.json({ properties });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/book-verified', async (req, res) => {
  try {
    const { firstName, lastName, email, orderId, slot } = req.body || {};
    const rec = await findVerifiedRecord({ firstName, lastName, email, orderId });
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find a booking matching those details.' });
    if (!slot || !slot.start || !slot.end) return res.status(400).json({ error: 'Missing time slot.' });

    const f = rec.fields || {};
    if (f['Booked Date/Time']) {
      return res.status(400).json({ error: 'This property already has a schedule booked. Use the cancel/reschedule page if you need to change it.' });
    }

    const freqName = f['Subscription'];
    const duration = f['Duration'];
    const isSubscription = !!(freqName && duration);
    const clientLine = `${firstName} ${lastName} — ${f['Contact Number'] || ''} — ${email}`;

    const summary = isSubscription
      ? `Primo Care Cleaning (${freqName}) — ${firstName} ${lastName}`
      : `Primo Care Call — ${firstName} ${lastName}`;
    const description = [
      `Primo Care ${isSubscription ? 'subscription cleaning' : 'service call'}.`,
      `Client: ${clientLine}`,
      `Order ID: ${orderId}`,
      `Property: ${f['Address'] || ''} (${f['Property Size'] || ''} ${f['Property Size Unit'] || 'sq ft'})`,
      mapPinLine(f),
      `Service: ${f['Service'] || ''}`,
      isSubscription ? `Schedule: ${freqName} for ${duration} month(s)` : ''
    ].filter(Boolean).join('<br>');

    let recurrence = null;
    if (isSubscription) {
      const untilDate = new Date(slot.start);
      untilDate.setMonth(untilDate.getMonth() + Number(duration));
      recurrence = { freqName, untilDate };
    }

    const event = await gcal.createEvent({
      summary, description, location: f['Address'] || '',
      startIso: slot.start, endIso: slot.end, recurrence
    });

    const startStr = new Date(slot.start).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: CAL_TIMEZONE
    });

    await airtable.updateRecord(rec.id, {
      'Booked Date/Time': startStr + (isSubscription ? ` (recurring ${freqName})` : ''),
      'Booked Start (ISO)': new Date(slot.start).toISOString(),
      'Calendar Event ID': event.id
    });

    res.json({ eventId: event.id, startFormatted: startStr, isSubscription, freqName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/book', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'book.html'));
});

// Intake/pricing/proposal tool — moved off "/" so that root can serve the marketing
// homepage instead. Proposal letters and outreach should link here directly.
app.get('/intake', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'intake.html'));
});

// Sends the proposal email covering one or more properties directly to the client (accepts
// either `orderId` for a single property or `orderIds` for a combined multi-property
// submission), and marks every referenced property record as sent. Real send, not a draft —
// previously this staged a Gmail draft for a human to review first, but that review step was
// removed by request; the proposal content is fully computed from the client's own submitted
// inputs, so there's no separate judgment call left to make before it goes out.
app.post('/api/create-draft', async (req, res) => {
  try {
    const { orderId, orderIds, to, subject, body, htmlBody } = req.body || {};
    const ids = Array.isArray(orderIds) ? orderIds : (orderId ? [orderId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Missing orderId(s).' });

    for (const id of ids) {
      const rec = await airtable.findByField('Order ID', id);
      if (rec) await airtable.updateRecord(rec.id, { 'Draft Email Created': true });
    }

    await gcal.sendGmailMessage({ to, subject, body, htmlBody });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Cancel / reschedule endpoints
// ---------------------------------------------------------------------------

// Explains whether the 48-hour/20% TCP late fee applies, based on how far out the ORIGINAL
// booked time was from right now (not the new time, for a reschedule).
function feeApplicabilityNote(originalBookedStartIso) {
  if (!originalBookedStartIso) return '';
  const hoursUntil = (new Date(originalBookedStartIso).getTime() - Date.now()) / 3600000;
  return hoursUntil < 48
    ? 'Since this request was made less than 48 hours before your originally scheduled time, a fee of 20% of the Total Contract Price (TCP) applies per our Cancellation & Reschedule Policy.'
    : 'Since this request was made 48 hours or more in advance, no fee applies.';
}

// Sends a short confirmation email immediately (real send, not a draft — these are low-risk
// transactional receipts, unlike the full proposal email which stays draft-only for review).
// Failure here is logged but never fails the cancel/reschedule request itself — the
// calendar/Airtable changes already succeeded by the time this runs.
async function sendConfirmationEmail({ to, subject, body, htmlBody }) {
  try {
    await gcal.sendGmailMessage({ to, subject, body, htmlBody });
  } catch (err) {
    console.error('Confirmation email failed to send:', err.message);
  }
}

// Cancel/reschedule moved here from a standalone identity-verified public page (no active
// clients existed yet when it was retired, so there was nothing to migrate) — the client's
// session already proves who they are, so ownership is just a Client ID match instead of
// re-typing name/email/Order ID. Name/email for the confirmation email come from the record
// itself (the authoritative values from when they booked), not the request body.
app.post('/api/client/cancel', clientAuth, async (req, res) => {
  try {
    const { orderId, note } = req.body || {};
    const rec = await findOwnedOrder(orderId, req.clientSession.clientId);
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find that booking.' });

    const f = rec.fields || {};
    const firstName = f['First Name'] || '';
    const email = f['Email'] || '';
    const originalBookedDisplay = f['Booked Date/Time'] || '';
    const feeNote = feeApplicabilityNote(f['Booked Start (ISO)']);

    await deleteBookingEvent(rec, orderId);
    await airtable.updateRecord(rec.id, {
      'Status': 'Cancelled',
      'Cancel/Reschedule Note': `[${new Date().toLocaleString()}] Cancelled${note ? ': ' + note : ' (no note provided)'}`
    });

    const subject = 'Your Primo Care Booking Has Been Cancelled';
    const body = `Hi ${firstName},\n\nThis confirms your Primo Care booking (Order ID: ${orderId})${originalBookedDisplay ? ', originally scheduled for ' + originalBookedDisplay : ''} has been cancelled.\n\n${feeNote}\n\nIf this wasn't you or you'd like to book again, just reply to this email.\n\nBest,\nPrimo Care Team`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
      <h2 style="color:#0a5c64;">Booking Cancelled</h2>
      <p>Hi ${firstName},</p>
      <p>This confirms your Primo Care booking (Order ID: <b>${orderId}</b>)${originalBookedDisplay ? ', originally scheduled for <b>' + originalBookedDisplay + '</b>,' : ''} has been cancelled.</p>
      <p style="background:#f7f9fa;border:1px dashed #d1d5db;border-radius:8px;padding:10px 14px;">${feeNote}</p>
      <p>If this wasn't you or you'd like to book again, just reply to this email.</p>
      <p>Best,<br>Primo Care Team</p>
    </div>`;
    await sendConfirmationEmail({ to: email, subject, body, htmlBody });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client/reschedule/find-times', clientAuth, async (req, res) => {
  try {
    const { orderId, date } = req.body || {};
    const rec = await findOwnedOrder(orderId, req.clientSession.clientId);
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find that booking.' });
    if (!date) return res.status(400).json({ error: 'Missing date.' });

    const slots = await gcal.findAvailableSlots(date);
    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client/reschedule/submit', clientAuth, async (req, res) => {
  try {
    const { orderId, slot, note } = req.body || {};
    const rec = await findOwnedOrder(orderId, req.clientSession.clientId);
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find that booking.' });

    const f = rec.fields || {};
    const firstName = f['First Name'] || '';
    const lastName = f['Last Name'] || '';
    const email = f['Email'] || '';
    const freqName = f['Subscription'];
    const duration = f['Duration'];
    const isSubscription = !!(freqName && duration);
    const originalBookedDisplay = f['Booked Date/Time'] || '';
    const feeNote = feeApplicabilityNote(f['Booked Start (ISO)']);

    await deleteBookingEvent(rec, orderId);

    const clientLine = `${firstName} ${lastName} — ${f['Contact Number'] || ''} — ${email}`;
    const summary = isSubscription
      ? `Primo Care Cleaning (${freqName}) — ${firstName} ${lastName}`
      : `Primo Care Call — ${firstName} ${lastName}`;
    const description = [
      `Primo Care ${isSubscription ? 'subscription cleaning' : 'service call'} (rescheduled).`,
      `Client: ${clientLine}`,
      `Order ID: ${orderId}`,
      `Property: ${f['Address'] || ''} (${f['Property Size'] || ''} sq ft)`,
      mapPinLine(f),
      `Service: ${f['Service'] || ''}`,
      isSubscription ? `Schedule: ${freqName} for ${duration} month(s)` : ''
    ].filter(Boolean).join('<br>');

    let recurrence = null;
    if (isSubscription) {
      const untilDate = new Date(slot.start);
      untilDate.setMonth(untilDate.getMonth() + Number(duration));
      recurrence = { freqName, untilDate };
    }

    const event = await gcal.createEvent({
      summary, description, location: f['Address'] || '',
      startIso: slot.start, endIso: slot.end, recurrence
    });

    const startStr = new Date(slot.start).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: CAL_TIMEZONE
    });

    await airtable.updateRecord(rec.id, {
      'Status': 'Rescheduled',
      'Booked Date/Time': startStr + (isSubscription ? ` (recurring ${freqName})` : ''),
      'Booked Start (ISO)': new Date(slot.start).toISOString(),
      'Calendar Event ID': event.id,
      'Cancel/Reschedule Note': `[${new Date().toLocaleString()}] Rescheduled to ${startStr}${note ? ': ' + note : ''}`
    });

    const subject = 'Your Primo Care Booking Has Been Rescheduled';
    const scheduleLine = isSubscription ? `${startStr} (recurring ${freqName})` : startStr;
    const body = `Hi ${firstName},\n\nThis confirms your Primo Care booking (Order ID: ${orderId}) has been rescheduled.\n\n${originalBookedDisplay ? 'Previous time: ' + originalBookedDisplay + '\n' : ''}New time: ${scheduleLine}\n\n${feeNote}\n\nIf anything looks off, just reply to this email.\n\nBest,\nPrimo Care Team`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
      <h2 style="color:#0a5c64;">Booking Rescheduled</h2>
      <p>Hi ${firstName},</p>
      <p>This confirms your Primo Care booking (Order ID: <b>${orderId}</b>) has been rescheduled.</p>
      <table style="margin:10px 0;">
        ${originalBookedDisplay ? `<tr><td style="color:#6b7280;padding:2px 10px 2px 0;">Previous time</td><td>${originalBookedDisplay}</td></tr>` : ''}
        <tr><td style="color:#6b7280;padding:2px 10px 2px 0;">New time</td><td><b>${scheduleLine}</b></td></tr>
      </table>
      <p style="background:#f7f9fa;border:1px dashed #d1d5db;border-radius:8px;padding:10px 14px;">${feeNote}</p>
      <p>If anything looks off, just reply to this email.</p>
      <p>Best,<br>Primo Care Team</p>
    </div>`;
    await sendConfirmationEmail({ to: email, subject, body, htmlBody });

    res.json({ ok: true, isSubscription, freqName, startFormatted: startStr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Staff-only: job completion
// ---------------------------------------------------------------------------

// Session-cookie gate for everything under /schedule, /dashboard, and their /api/staff +
// /api/dashboard data routes. Credentials (env-var break-glass accounts, or Members-table
// accounts) live server-side only; the browser just holds a signed, expiring session token —
// there's no server-side session store to manage, so this survives a redeploy/restart fine
// (existing sessions are simply invalidated, same as a Basic Auth browser cache would have
// been cleared). Compared with timingSafeEqual so a slow string compare can't leak how many
// characters matched.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Falls back to a random secret generated at boot if SESSION_SECRET isn't set, so the app never
// refuses to start — but every existing session is invalidated on every restart in that case
// (fine for local dev; set SESSION_SECRET in Render's environment for real deployments so staff
// don't get logged out every time the app redeploys).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — using a random per-boot secret. Every login will be invalidated on the next restart/redeploy. Set SESSION_SECRET in your environment to keep sessions across restarts.');
}
const SESSION_COOKIE = 'pc_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — roughly a work shift.

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

// Returns the decoded { u, r, n, exp } payload for a valid, unexpired, correctly-signed token,
// or null for anything else (missing, tampered, expired, malformed) — callers treat all of
// those identically, same as a wrong password.
function verifySession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expectedSig.length || !safeEqual(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// No cookie-parser dependency in this app — cookies are rare enough (just this one) that a
// tiny manual parse is simpler than adding a package for it.
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const map = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    map[key] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return map;
}

function setSessionCookie(res, payload) {
  const token = signSession(payload);
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Parses "user1:pass1,user2:pass2" into a { username: password } map. Used for STAFF_USERS (any
// number of staff logins) — one shared list edited in Render's env vars, not a database, since
// staff turnover here is infrequent enough that a redeploy-to-update model is fine.
function parseCredentialList(raw) {
  const map = {};
  String(raw || '').split(',').forEach(pair => {
    const trimmed = pair.trim();
    if (!trimmed) return;
    const sep = trimmed.indexOf(':');
    if (sep === -1) return;
    const user = trimmed.slice(0, sep).trim();
    const pass = trimmed.slice(sep + 1).trim();
    if (user && pass) map[user] = pass;
  });
  return map;
}

// Break-glass accounts that always work regardless of what's in the Staff-Members table — protects
// against ever being locked out if Airtable is briefly unreachable, or the Staff-Members table is
// accidentally emptied. Not shown anywhere in the UI; just env vars.
const BREAK_GLASS_STAFF = parseCredentialList(process.env.STAFF_USERS);
if (process.env.STAFF_USERNAME && process.env.STAFF_PASSWORD) {
  BREAK_GLASS_STAFF[process.env.STAFF_USERNAME] = process.env.STAFF_PASSWORD;
}
const BREAK_GLASS_DASHBOARD = parseCredentialList(process.env.DASHBOARD_USERS);

const MEMBERS_TABLE = 'Staff-Members';

// Looks up one login account by username in the Staff-Members table. Returns null if not found —
// callers treat that the same as a wrong password (never reveal which one was wrong).
async function findMember(username) {
  if (!username) return null;
  const escaped = String(username).replace(/"/g, '\\"');
  const records = await airtable.listAllForTable(MEMBERS_TABLE, { formula: `{Username} = "${escaped}"` });
  const rec = records[0];
  if (!rec) return null;
  const f = rec.fields || {};
  return { recordId: rec.id, username: f['Username'] || '', password: f['Password'] || '', fullName: f['Full Name'] || '', role: f['Role'] || '' };
}

// Builds a session-cookie-checking middleware for API routes: valid, unexpired session with a
// role in allowedRoles passes; anything else gets a 401 JSON response (never HTML) so the
// page's own JS can show the login form instead of the browser's native auth prompt. Staff role
// only passes the staffAuth gate; Admin passes both — same access model as before, just checked
// against a session token instead of a Basic Auth header on every request.
function makeRoleAuth(allowedRoles) {
  return function (req, res, next) {
    const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
    if (session && allowedRoles.includes(session.r)) {
      req.member = { username: session.u, role: session.r, fullName: session.n };
      return next();
    }
    return res.status(401).json({ error: 'not_authenticated' });
  };
}

const staffAuth = makeRoleAuth(['Admin', 'Staff']);
const dashboardAuth = makeRoleAuth(['Admin']);

// Single login endpoint for both /schedule and /dashboard: checks the submitted credentials
// against both break-glass env-var lists and the Staff-Members table, and issues one shared session
// cookie carrying whatever role the account actually has. Per-route access is then just
// "does this role appear in this route's allowedRoles" — identical semantics to the old
// Basic Auth gates, just evaluated from a cookie instead of a header.
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const breakGlassPass = BREAK_GLASS_STAFF[username] || BREAK_GLASS_DASHBOARD[username];
  if (breakGlassPass && safeEqual(password, breakGlassPass)) {
    setSessionCookie(res, { u: username, r: 'Admin', n: username, exp: Date.now() + SESSION_TTL_MS });
    return res.json({ ok: true, role: 'Admin', fullName: username });
  }

  try {
    const member = await findMember(username);
    if (member && member.password && MEMBER_ROLES.includes(member.role) && safeEqual(password, member.password)) {
      setSessionCookie(res, { u: member.username, r: member.role, n: member.fullName, exp: Date.now() + SESSION_TTL_MS });
      return res.json({ ok: true, role: member.role, fullName: member.fullName });
    }
  } catch (err) {
    console.error('Member lookup failed during login:', err.message);
  }
  return res.status(401).json({ error: 'Incorrect username or password.' });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Lets a page's own JS check "am I logged in, and as what role" on load, so it can decide
// whether to show the login form or the real content.
app.get('/api/whoami', (req, res) => {
  const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ username: session.u, role: session.r, fullName: session.n });
});

// ---------------------------------------------------------------------------
// Client portal (self-serve accounts)
// ---------------------------------------------------------------------------
// The Client Members record itself is created back in /api/submit (auto-enrollment: unverified,
// no password yet) the moment someone books for the first time. This section covers the rest of
// that record's lifecycle — the "set up your account" email link, verifying it, and setting a
// password. Login/the /account dashboard come in a later phase; kept deliberately separate from
// the Staff-Members session system above regardless — its own table, and eventually its own
// cookie and role, so a client account can never reach /schedule or /dashboard even by accident.

// Hashes a client-chosen password with scrypt (Node's built-in crypto, no new dependency —
// matches this app's habit of hand-rolling auth rather than pulling in bcrypt). Unlike the
// Staff-Members table's plaintext passwords (fine there: a small, admin-provisioned set),
// clients pick these themselves and likely reuse them elsewhere, so they're salted and hashed.
// Stored as "salt:hash", both hex.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuf = Buffer.from(hash, 'hex');
  const candidateBuf = crypto.scryptSync(password, salt, 64);
  if (hashBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, candidateBuf);
}

// Thin wrapper around the existing signSession/verifySession HMAC scheme for single-purpose,
// non-cookie links (the account-setup email). Reuses the same secret and signature format, but
// requires a matching `t` (type) field, so a token minted for this purpose can never be replayed
// as a staff session cookie, or vice versa.
function signPurposeToken(payload, ttlMs, purpose) {
  return signSession({ ...payload, t: purpose, exp: Date.now() + ttlMs });
}
function verifyPurposeToken(token, purpose) {
  const payload = verifySession(token);
  if (!payload || payload.t !== purpose) return null;
  return payload;
}
const ACCOUNT_SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours to click the email link
const OTP_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes to enter the code in the /intake popup

// signPurposeToken/verifySession sign a token but don't encrypt it — the payload is just
// base64, readable by anyone holding the token (fine for the email-link flow, where the
// payload is only an email address). The OTP code must NOT go in there in the clear, since the
// token is handed straight back to the browser in the /api/submit response — a client-visible
// plaintext code would let anyone skip checking their email entirely. Store this HMAC of the
// code instead; recovering the code from the hash requires SESSION_SECRET, which the browser
// never has, so a guess still has to go through the rate-limited server round-trip.
function hashOtpCode(code) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(code)).digest('hex');
}

async function findClientMemberByEmail(email) {
  if (!email) return null;
  const escaped = String(email).replace(/"/g, '\\"').toLowerCase();
  const records = await airtable.listAllForTable(CLIENT_MEMBERS_TABLE, { formula: `LOWER({Email}) = "${escaped}"` });
  const rec = records[0];
  if (!rec) return null;
  const f = rec.fields || {};
  let hiddenProperties = [];
  try { hiddenProperties = JSON.parse(f['Hidden Properties'] || '[]'); } catch { hiddenProperties = []; }
  return { recordId: rec.id, email: f['Email'] || '', clientId: f['Client ID'] || '', fullName: f['Full Name'] || '', passwordHash: f['Password Hash'] || '', verified: !!f['Verified'], hiddenProperties };
}

// Sends the "set up your account" email — called once per unverified enrollment, right after
// /api/submit (or /api/client/signup) creates (or re-finds still-unverified) the pending Client
// Members record. Carries both the instant 6-digit code (for the /intake or /client/login popup,
// expires in ~15 min) and the original 24h setup link (for anyone who closes the tab before
// entering the code — same link this function has always sent). Failure here is logged but
// never fails the calling request, same non-fatal treatment as the rest of enrollment.
// `context` swaps just the opening line: 'booking' (default) for someone who just submitted a
// booking, 'signup' for a prospect who signed up with no booking at all.
async function sendAccountSetupEmail({ to, firstName, baseUrl, code, context }) {
  const token = signPurposeToken({ email: to }, ACCOUNT_SETUP_TOKEN_TTL_MS, 'client-verify');
  const setupUrl = `${baseUrl}/create-account?token=${encodeURIComponent(token)}`;
  const subject = 'Set up your Primo Care account';
  const intro = context === 'signup'
    ? "Thanks for your interest in Primo Care! We've started an account for you so you can see your order history and book properties without filling out the form from scratch."
    : "Thanks for booking with Primo Care! We've started an account for you so next time you can see your order history and book your properties again without filling out the form from scratch.";
  const codeLine = code ? `Your code: ${code} (enter it on the page you just saw — expires in 15 minutes)\n\n` : '';
  const body = `Hi ${firstName},\n\n${intro}\n\n${codeLine}Or set up your password here: ${setupUrl}\n\nThe link expires in 24 hours.\n\nBest,\nPrimo Care Team`;
  const codeBlock = code ? `<p style="text-align:center; margin:20px 0;">
      <span style="display:inline-block; font-size:28px; font-weight:700; letter-spacing:6px; background:#f0fdfa; color:#0a5c64; padding:12px 24px; border-radius:8px;">${code}</span>
      <br><span style="color:#6b7280;font-size:13px;">Enter this on the page you just saw — expires in 15 minutes.</span>
    </p>` : '';
  const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
    <h2 style="color:#0a5c64;">Set up your account</h2>
    <p>Hi ${firstName},</p>
    <p>${intro}</p>
    ${codeBlock}
    <p style="text-align:center; margin:20px 0;">
      <a href="${setupUrl}" style="display:inline-block; background:#0e7c86; color:#fff; text-decoration:none; font-weight:700; padding:12px 28px; border-radius:8px;">Set Up Your Password</a>
    </p>
    <p style="color:#6b7280;font-size:13px;">This link expires in 24 hours.</p>
    <p>Best,<br>Primo Care Team</p>
  </div>`;
  await sendConfirmationEmail({ to, subject, body, htmlBody });
}

// Sends a "reset your password" email — reuses the exact same token purpose and /create-account
// page as the original setup email, since resetting is really just "set a (new) password" either
// way; only the email copy differs.
async function sendPasswordResetEmail({ to, firstName, baseUrl }) {
  const token = signPurposeToken({ email: to }, ACCOUNT_SETUP_TOKEN_TTL_MS, 'client-verify');
  const resetUrl = `${baseUrl}/create-account?token=${encodeURIComponent(token)}`;
  const subject = 'Reset your Primo Care password';
  const body = `Hi ${firstName},\n\nWe received a request to reset your Primo Care account password. Set a new one here:\n\n${resetUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can safely ignore this email.\n\nBest,\nPrimo Care Team`;
  const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
    <h2 style="color:#0a5c64;">Reset your password</h2>
    <p>Hi ${firstName},</p>
    <p>We received a request to reset your Primo Care account password. Set a new one below.</p>
    <p style="text-align:center; margin:20px 0;">
      <a href="${resetUrl}" style="display:inline-block; background:#0e7c86; color:#fff; text-decoration:none; font-weight:700; padding:12px 28px; border-radius:8px;">Reset Your Password</a>
    </p>
    <p style="color:#6b7280;font-size:13px;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
    <p>Best,<br>Primo Care Team</p>
  </div>`;
  await sendConfirmationEmail({ to, subject, body, htmlBody });
}

// Kicks off a password reset. Always responds ok regardless of whether the email matched an
// account, so this can't be used to check which emails have a Primo Care account — same
// never-reveal-which-part-was-wrong pattern used by findVerifiedRecord elsewhere in this app. An
// account that never finished initial setup (Verified still false) gets the original setup email
// resent instead of a "reset" email, since it never had a password to reset in the first place.
app.post('/api/client/forgot-password', async (req, res) => {
  try {
    const email = ((req.body && req.body.email) || '').trim();
    if (email) {
      const member = await findClientMemberByEmail(email);
      if (member) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const firstName = (member.fullName || 'there').split(' ')[0];
        if (member.verified) {
          await sendPasswordResetEmail({ to: member.email, firstName, baseUrl });
        } else {
          await sendAccountSetupEmail({ to: member.email, firstName, baseUrl });
        }
      }
    }
  } catch (err) {
    console.error('Forgot-password request failed:', err.message);
  }
  res.json({ ok: true });
});

// GET so /create-account's page JS can validate the token and greet the client by email before
// showing the password form — separate from the POST that actually sets the password, so a
// simple page load never mutates anything. Also reports whether this account was already
// verified, so the page can tell a first-time setup link apart from a password-reset link and
// adjust its copy — both land on the exact same form either way.
app.get('/api/client/verify-token', async (req, res) => {
  const payload = verifyPurposeToken(req.query.token, 'client-verify');
  if (!payload) return res.status(400).json({ error: 'This link is invalid or has expired.' });
  const member = await findClientMemberByEmail(payload.email);
  res.json({ email: payload.email, isReset: !!(member && member.verified) });
});

// Shared tail end of "finish setting up a client account" — marks the record Verified, stores
// the password hash, and logs them straight in. Used by both the email-link route below and the
// /intake popup's code-based route, since past that point (password + a proven-owned email) the
// two flows do the exact same thing.
async function finalizeClientAccount(res, member, password) {
  await airtable.updateRecordForTable(CLIENT_MEMBERS_TABLE, member.recordId, {
    'Password Hash': hashPassword(password),
    'Verified': true
  });
  setClientSessionCookie(res, { u: member.email, r: 'Client', n: member.fullName, cid: member.clientId, exp: Date.now() + CLIENT_SESSION_TTL_MS });
}

// Sets the client's password for the first time and marks the account Verified — this single
// step does double duty as both "verify this email" and "create your account", since the only
// way to reach it is by clicking the link sent to that address.
app.post('/api/client/create-account', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const payload = verifyPurposeToken(token, 'client-verify');
    if (!payload) return res.status(400).json({ error: 'This link is invalid or has expired.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const member = await findClientMemberByEmail(payload.email);
    if (!member) return res.status(404).json({ error: 'Account not found.' });

    // Log them straight in — they just proved they own the inbox and picked a password, no
    // reason to make them find the login page and re-enter it immediately after.
    await finalizeClientAccount(res, member, password);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Same as /api/client/create-account above, but for the instant /intake popup: instead of
// clicking a link, the client types back a 6-digit code that was emailed to them moments ago
// alongside that link. Proves the same thing (they control the inbox) without leaving the
// booking page. The code itself never leaves the server except in that email — it's not part
// of the /api/submit response, only the token is.
app.post('/api/client/verify-code', async (req, res) => {
  try {
    const { token, code, password } = req.body || {};
    const payload = verifyPurposeToken(token, 'client-verify-otp');
    if (!payload) return res.status(400).json({ error: 'This code has expired. Please request a new one.' });
    if (!code || !safeEqual(hashOtpCode(String(code).trim()), payload.codeHash)) {
      return res.status(400).json({ error: 'Incorrect code. Please check your email and try again.' });
    }
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const member = await findClientMemberByEmail(payload.email);
    if (!member) return res.status(404).json({ error: 'Account not found.' });

    await finalizeClientAccount(res, member, password);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Re-sends a fresh code + link for the /intake popup, in case the first email is slow to land
// or the original code expired. A new code means a new token (the old one still verifies
// against the old code, now wrong) — the popup must swap in the returned token before
// submitting, or the resent code will never match. Always responds ok regardless of whether the
// email matched an account — same non-disclosure pattern as /api/client/forgot-password — and
// silently no-ops (no new token) for an already-verified account (nothing to set up, this isn't
// a login/reset endpoint).
app.post('/api/client/resend-setup-code', async (req, res) => {
  let token = null;
  try {
    const email = ((req.body && req.body.email) || '').trim();
    if (email) {
      const member = await findClientMemberByEmail(email);
      if (member && !member.verified) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const firstName = (member.fullName || 'there').split(' ')[0];
        const code = String(crypto.randomInt(100000, 1000000));
        token = signPurposeToken({ email: member.email, codeHash: hashOtpCode(code) }, OTP_TOKEN_TTL_MS, 'client-verify-otp');
        await sendAccountSetupEmail({ to: member.email, firstName, baseUrl, code });
      }
    }
  } catch (err) {
    console.error('Resend setup code failed:', err.message);
  }
  res.json({ ok: true, token });
});

// Lets someone become a Client Member without ever booking — a prospect who's interested but
// not ready to schedule yet. Mirrors /api/submit's auto-enrollment block (server.js:~290) but
// stands alone with no Submissions record involved; mints its own Client ID (findClientIdByEmail
// only ever looks at Submissions, so a first-time prospect has nothing there to reuse — but see
// the Client ID resolution fix in /api/submit, which checks Client Members too, so this Client
// ID gets reused correctly once they do book). Returns the exact same `accountSetup` shape
// /api/submit does, so the frontend's existing code+password verification step needs no new
// branching — only the entry point differs.
app.post('/api/client/signup', async (req, res) => {
  try {
    const firstName = ((req.body && req.body.firstName) || '').trim();
    const lastName = ((req.body && req.body.lastName) || '').trim();
    const email = ((req.body && req.body.email) || '').trim();
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    const existingMember = await findClientMemberByEmail(email);
    if (existingMember && existingMember.verified) {
      return res.json({ alreadyMember: true });
    }

    if (!existingMember) {
      await airtable.createRecordForTable(CLIENT_MEMBERS_TABLE, {
        'Email': email,
        'Client ID': genRefId('CLI'),
        'Full Name': `${firstName} ${lastName}`,
        'Verified': false,
        'Account Created At': new Date().toISOString()
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const code = String(crypto.randomInt(100000, 1000000));
    const token = signPurposeToken({ email, codeHash: hashOtpCode(code) }, OTP_TOKEN_TTL_MS, 'client-verify-otp');
    await sendAccountSetupEmail({ to: email, firstName, baseUrl, code, context: 'signup' });
    res.json({ accountSetup: { token, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/create-account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-account.html'));
});

// Own cookie name, TTL, and role — kept fully independent of the Staff-Members session above so
// the two can coexist in the same browser (e.g. an admin who also books their own cleaning) and
// so a client session can never be mistaken for a staff one even under the shared HMAC secret.
// Longer-lived than the 12-hour staff session on purpose: this is a "stay logged in" convenience
// for repeat bookings, not a work-shift session.
const CLIENT_SESSION_COOKIE = 'pc_client_session';
const CLIENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function setClientSessionCookie(res, payload) {
  const token = signSession(payload);
  const maxAgeSec = Math.floor(CLIENT_SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${CLIENT_SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`);
}
function clearClientSessionCookie(res) {
  res.setHeader('Set-Cookie', `${CLIENT_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Session-cookie gate for the /account dashboard's data routes, once those ship — same
// 401-JSON-not-native-prompt pattern as staffAuth/dashboardAuth, just against the client
// cookie/role instead.
function clientAuth(req, res, next) {
  const session = verifySession(parseCookies(req)[CLIENT_SESSION_COOKIE]);
  if (session && session.r === 'Client') {
    req.clientSession = { email: session.u, clientId: session.cid, fullName: session.n };
    return next();
  }
  return res.status(401).json({ error: 'not_authenticated' });
}

app.post('/api/client/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const member = await findClientMemberByEmail(email);
    if (!member || !member.verified || !member.passwordHash || !verifyPassword(password, member.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    setClientSessionCookie(res, { u: member.email, r: 'Client', n: member.fullName, cid: member.clientId, exp: Date.now() + CLIENT_SESSION_TTL_MS });
    res.json({ ok: true, fullName: member.fullName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client/logout', (req, res) => {
  clearClientSessionCookie(res);
  res.json({ ok: true });
});

// Lets a page's own JS check "am I logged in as a client" on load — same purpose as the staff
// /api/whoami, just against the client cookie.
app.get('/api/client/whoami', (req, res) => {
  const session = verifySession(parseCookies(req)[CLIENT_SESSION_COOKIE]);
  if (!session || session.r !== 'Client') return res.status(401).json({ error: 'not_authenticated' });
  res.json({ email: session.u, fullName: session.n });
});

app.get('/client/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client-login.html'));
});

// Lists every booking under this client's Client ID, most recent first — the /account
// dashboard's order history.
app.get('/api/client/orders', clientAuth, async (req, res) => {
  try {
    const records = await airtable.findAllByField('Client ID', req.clientSession.clientId);
    const orders = records
      .map(rec => {
        const f = rec.fields || {};
        return {
          orderId: f['Order ID'] || '',
          address: f['Address'] || '',
          service: f['Service'] || '',
          propertyType: f['Property Type'] || '',
          status: f['Status'] || '',
          bookedDateTime: f['Booked Date/Time'] || '',
          submittedAt: f['Submitted At'] || '',
          total: f['Estimated Total per Visit'] || 0,
          subscription: f['Subscription'] || ''
        };
      })
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Distinct properties this client has booked before (deduped by address, most-recently-seen
// details winning) — backs the /account dashboard's saved-properties list and the "book this
// property again" flow. Excludes any address the client has hidden (e.g. moved out of a
// rental) — that's a per-client display preference on the Client Members record, and never
// touches the underlying Submissions records, so Order History is unaffected either way.
app.get('/api/client/properties', clientAuth, async (req, res) => {
  try {
    const [records, member] = await Promise.all([
      airtable.findAllByField('Client ID', req.clientSession.clientId),
      findClientMemberByEmail(req.clientSession.email)
    ]);
    const hidden = new Set((member && member.hiddenProperties || []).map(a => String(a).trim().toLowerCase()));
    const byAddress = new Map();
    records
      .slice()
      .sort((a, b) => new Date((a.fields || {})['Submitted At'] || 0) - new Date((b.fields || {})['Submitted At'] || 0))
      .forEach(rec => {
        const f = rec.fields || {};
        const key = String(f['Address'] || '').trim().toLowerCase();
        if (!key || hidden.has(key)) return;
        byAddress.set(key, {
          address: f['Address'] || '',
          zip: f['Zip Code'] || '',
          propertyType: f['Property Type'] || '',
          sqft: f['Property Size'] || '',
          sizeUnit: f['Property Size Unit'] || '',
          areas: f['Areas / Facility Type'] || '',
          service: f['Service'] || '',
          phone: f['Contact Number'] || '',
          mapPin: f['Map Pin (Lat,Lng)'] || ''
        });
      });
    res.json({ properties: Array.from(byAddress.values()) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Hides one address from this client's saved-properties/rebook list — for a renter who's moved
// out, say. Purely a display preference on their Client Members record; the underlying
// Submissions records (and Order History) are untouched, so nothing about their booking history
// is lost or hidden.
app.post('/api/client/properties/hide', clientAuth, async (req, res) => {
  try {
    const address = ((req.body && req.body.address) || '').trim();
    if (!address) return res.status(400).json({ error: 'Missing address.' });

    const member = await findClientMemberByEmail(req.clientSession.email);
    if (!member) return res.status(404).json({ error: 'Account not found.' });

    const key = address.toLowerCase();
    const already = member.hiddenProperties.some(a => String(a).trim().toLowerCase() === key);
    if (!already) {
      const updated = member.hiddenProperties.concat([address]);
      await airtable.updateRecordForTable(CLIENT_MEMBERS_TABLE, member.recordId, { 'Hidden Properties': JSON.stringify(updated) });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The page itself is always servable — its own JS calls /api/client/whoami on load and redirects
// to /client/login if that comes back 401, same "page always loads, data routes stay gated"
// pattern as /schedule.
app.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

// The page itself is always servable now (no server-side gate) — its own JS calls /api/whoami
// on load and shows a login form in place of the real content when that comes back 401. Only
// the data endpoints below stay behind staffAuth/dashboardAuth.
app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule.html'));
});

// Lists every booking that's still Scheduled or Ongoing (i.e. not yet Completed/Cancelled/
// Rescheduled-away), soonest first, for staff to pick from and mark done.
app.get('/api/staff/jobs', staffAuth, async (req, res) => {
  try {
    const records = await airtable.listByFormula(
      'OR({Status}="Scheduled",{Status}="Ongoing")',
      { sort: [{ field: 'Booked Start (ISO)', direction: 'asc' }] }
    );
    const jobs = records.map(rec => {
      const f = rec.fields || {};
      return {
        recordId: rec.id,
        orderId: f['Order ID'] || '',
        clientName: f['Client Name'] || '',
        phone: f['Contact Number'] || '',
        address: f['Address'] || '',
        propertyType: f['Property Type'] || '',
        service: f['Service'] || '',
        bookedDisplay: f['Booked Date/Time'] || '',
        status: f['Status'] || '',
        hasBeforePhoto: Array.isArray(f['Before Photo']) && f['Before Photo'].length > 0
      };
    });
    res.json({ jobs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Returns every Primo Care calendar event in the given month (year, 1-indexed month), for the
// staff calendar view. Reads straight from Google Calendar rather than Airtable, since Calendar
// is already the source of truth for individual occurrences of a recurring subscription (see
// the 48hr-notice task) — this avoids re-deriving that same occurrence logic here.
app.get('/api/staff/calendar', staffAuth, async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Missing or invalid year/month.' });
    }
    const timeMin = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const timeMax = new Date(Date.UTC(year, month, 1)).toISOString();
    const rawEvents = await gcal.listEventsInWindow(timeMin, timeMax, 'Primo Care');
    const events = rawEvents.map(ev => {
      const desc = ev.description || '';
      const orderMatch = desc.match(/Order ID:\s*(PC-ORD-[A-Za-z0-9]+)/);
      return {
        id: ev.id,
        title: ev.summary || '',
        start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
        end: (ev.end && (ev.end.dateTime || ev.end.date)) || '',
        location: ev.location || '',
        orderId: orderMatch ? orderMatch[1] : null
      };
    });
    res.json({ events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Formats a number as USD for the billing email; falls back to whatever's on file if the field
// isn't a plain number for some reason.
function fmtCurrency(total) {
  return typeof total === 'number'
    ? total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : (total || 'N/A');
}

// Attaches the "before" photo staff capture when they physically start a job on /schedule.
// Required before a job can later be marked Complete (enforced by /schedule only revealing the
// "Mark Complete" action once this has succeeded, and by this route requiring the file). Doesn't
// touch Status — that's still owned by the separate auto-ongoing-status scheduled task
// (time-based, not tied to a staff action).
app.post('/api/staff/start-job', staffAuth, upload.single('photo'), async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId.' });
    if (!req.file) return res.status(400).json({ error: 'Please attach a before photo to start this job.' });

    await airtable.uploadAttachment(
      recordId, 'Before Photo',
      req.file.buffer.toString('base64'),
      req.file.mimetype,
      req.file.originalname || 'before-photo'
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Marks one booking Completed and emails the client a billing statement for that visit. Trusts
// the recordId as given — unlike the public booking/cancel/reschedule endpoints, this route is
// already gated by staffAuth, so there's no need for the identity-verification dance used on
// the public-facing side. The billing email reuses the amount locked in at booking time
// (Estimated Total per Visit), so — like the cancel/reschedule confirmations — there's no new
// pricing judgment call here, and it sends for real rather than staying a draft. Requires an
// "after" photo (mirrors the before-photo requirement on /api/staff/start-job) — embedded
// directly in the billing email as proof-of-work.
app.post('/api/staff/complete', staffAuth, upload.single('photo'), async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId.' });
    if (!req.file) return res.status(400).json({ error: 'Please attach an after photo to mark this job complete.' });

    const rec = await airtable.getRecord(recordId);
    const f = rec.fields || {};

    const afterPhotoResult = await airtable.uploadAttachment(
      recordId, 'After Photo',
      req.file.buffer.toString('base64'),
      req.file.mimetype,
      req.file.originalname || 'after-photo'
    );
    const afterPhotoAttachment = (afterPhotoResult.fields && afterPhotoResult.fields['After Photo'] || [])[0];
    const afterPhotoUrl = afterPhotoAttachment ? afterPhotoAttachment.url : null;

    // Payment Status only becomes meaningful once a job is done, so it's left blank at booking
    // time and set to Pending here — "Unpaid" is reserved for a manual override in Airtable
    // itself, not something this app ever sets on its own.
    await airtable.updateRecord(recordId, { 'Status': 'Completed', 'Payment Status': 'Pending' });

    let emailSent = false;
    if (f['Email']) {
      const firstName = f['First Name'] || 'there';
      const amount = fmtCurrency(f['Estimated Total per Visit']);
      const payUrl = `${req.protocol}://${req.get('host')}/pay/${encodeURIComponent(f['Order ID'] || '')}`;
      const subject = 'Thank You From Primo Care — Your Billing Statement';
      const body = `Hi ${firstName},\n\nThank you for choosing Primo Care! Our team has completed your ${f['Service'] || 'cleaning'} service at ${f['Address'] || 'your property'}.\n\nBilling Statement\nOrder ID: ${f['Order ID'] || ''}\nService: ${f['Service'] || ''}\nProperty: ${f['Address'] || ''}\nAmount Due: ${amount}\n\nPay online: ${payUrl}\n\nIf you have any questions about this statement, just reply to this email.\n\nThank you again for trusting us with your space!\n\nBest,\nPrimo Care Team`;
      // Airtable's attachment URL is a signed link that expires after a few hours — fine here
      // since most email clients (Gmail included) fetch and cache remote images the first time
      // a message is opened, which for a billing email sent moments ago will be well within
      // that window. A client who never opens the email until days later could see a broken
      // image; low risk, not worth proxying/re-hosting the photo for.
      const photoBlock = afterPhotoUrl
        ? `<p style="text-align:center; margin:20px 0;"><img src="${afterPhotoUrl}" alt="After photo" style="max-width:100%; border-radius:10px; border:1px solid #e2e8f0;"></p>`
        : '';
      const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
        <h2 style="color:#0a5c64;">Thank You From Primo Care</h2>
        <p>Hi ${firstName},</p>
        <p>Our team has completed your <b>${f['Service'] || 'cleaning'}</b> service at <b>${f['Address'] || 'your property'}</b>. Here's your billing statement for this visit:</p>
        <table style="margin:14px 0; border-collapse:collapse; width:100%;">
          <tr><td style="color:#6b7280; padding:4px 10px 4px 0;">Order ID</td><td>${f['Order ID'] || ''}</td></tr>
          <tr><td style="color:#6b7280; padding:4px 10px 4px 0;">Service</td><td>${f['Service'] || ''}</td></tr>
          <tr><td style="color:#6b7280; padding:4px 10px 4px 0;">Property</td><td>${f['Address'] || ''}</td></tr>
          <tr><td style="color:#6b7280; padding:4px 10px 4px 0; font-weight:700;">Amount Due</td><td style="font-weight:700; color:#0a5c64;">${amount}</td></tr>
        </table>
        ${photoBlock}
        <p style="text-align:center; margin:20px 0;">
          <a href="${payUrl}" style="display:inline-block; background:#0e7c86; color:#fff; text-decoration:none; font-weight:700; padding:12px 28px; border-radius:8px;">Pay Now</a>
        </p>
        <p>You can also pay by cash, check, or bank transfer &mdash; just let us know.</p>
        <p>If you have any questions about this statement, just reply to this email.</p>
        <p>Thank you again for trusting us with your space!</p>
        <p>Best,<br>Primo Care Team</p>
      </div>`;
      await sendConfirmationEmail({ to: f['Email'], subject, body, htmlBody });
      emailSent = true;
    }

    // Review request — separate email from the billing statement above (asking to be paid and
    // asking for a review in the same breath reads as tone-deaf), sent once ever per client
    // rather than after every visit, so a weekly/monthly recurring client isn't asked repeatedly.
    // Stays inactive until GOOGLE_REVIEW_LINK is set, same "wired but inactive" pattern used
    // elsewhere in this app.
    let reviewRequested = false;
    const reviewLink = process.env.GOOGLE_REVIEW_LINK;
    if (f['Email'] && reviewLink) {
      let alreadyAsked = false;
      if (f['Client ID']) {
        const clientRecords = await airtable.findAllByField('Client ID', f['Client ID']);
        alreadyAsked = clientRecords.some(r => (r.fields || {})['Review Requested']);
      }
      if (!alreadyAsked) {
        const firstName = f['First Name'] || 'there';
        const subject = 'How did we do? Quick favor from Primo Care';
        const body = `Hi ${firstName},\n\nThanks again for choosing Primo Care! If you have a minute, a quick Google review would mean a lot to our small team and helps other folks in the area find us.\n\nLeave a review: ${reviewLink}\n\nThank you!\n\nBest,\nPrimo Care Team`;
        const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
          <h2 style="color:#0a5c64;">How did we do?</h2>
          <p>Hi ${firstName},</p>
          <p>Thanks again for choosing Primo Care! If you have a minute, a quick Google review would mean a lot to our small team and helps other folks in the area find us.</p>
          <p style="text-align:center; margin:20px 0;">
            <a href="${reviewLink}" style="display:inline-block; background:#0e7c86; color:#fff; text-decoration:none; font-weight:700; padding:12px 28px; border-radius:8px;">Leave a Review</a>
          </p>
          <p>Thank you!</p>
          <p>Best,<br>Primo Care Team</p>
        </div>`;
        await sendConfirmationEmail({ to: f['Email'], subject, body, htmlBody });
        await airtable.updateRecord(recordId, { 'Review Requested': true });
        reviewRequested = true;
      }
    }

    // Referral credit — if this client arrived via another client's referral link (see
    // 'Referred By (Client ID)', set at /api/submit time), and this is the FIRST job of theirs
    // ever completed, award the referrer a $10 credit. Checked against every record under this
    // client's Client ID (not just this one) so a multi-property client's second-ever completion
    // doesn't also trigger it.
    let referralCreditAwarded = false;
    if (f['Referred By (Client ID)'] && f['Client ID']) {
      const clientRecords = await airtable.findAllByField('Client ID', f['Client ID']);
      const completedCount = clientRecords.filter(r => (r.fields || {})['Status'] === 'Completed').length;
      if (completedCount === 1) { // just this one — this was their first
        await airtable.createRecordForTable('Referral Credits', {
          'Referrer Client ID': f['Referred By (Client ID)'],
          'Referred Client ID': f['Client ID'],
          'Earned At': new Date().toISOString(),
          'Used': false
        });
        referralCreditAwarded = true;
      }
    }

    res.json({ ok: true, emailSent, reviewRequested, referralCreditAwarded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Lists every Completed job that isn't marked Paid yet (Pending is the normal state a job lands
// in right after completion; Unpaid/blank are also included for any record set outside this
// app). Soonest-completed isn't tracked, so this just sorts by Booked Start (ISO) like the
// active-jobs list.
app.get('/api/staff/unpaid', staffAuth, async (req, res) => {
  try {
    const records = await airtable.listByFormula(
      'AND({Status}="Completed", OR({Payment Status}="Pending", {Payment Status}="Unpaid", {Payment Status}=""))',
      { sort: [{ field: 'Booked Start (ISO)', direction: 'asc' }] }
    );
    const jobs = records.map(rec => {
      const f = rec.fields || {};
      const proof = Array.isArray(f['Bank Transfer Proof']) ? f['Bank Transfer Proof'][0] : null;
      return {
        recordId: rec.id,
        orderId: f['Order ID'] || '',
        clientName: f['Client Name'] || '',
        phone: f['Contact Number'] || '',
        address: f['Address'] || '',
        service: f['Service'] || '',
        total: f['Estimated Total per Visit'],
        bookedDisplay: f['Booked Date/Time'] || '',
        clientSelectedMethod: f['Client Selected Payment Method'] || '',
        proofUrl: proof ? (proof.thumbnails && proof.thumbnails.large ? proof.thumbnails.large.url : proof.url) : null,
        proofFullUrl: proof ? proof.url : null
      };
    });
    res.json({ jobs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PAYMENT_METHODS = ['Cash', 'Online / Card', 'Check', 'Bank Transfer'];

// Marks one completed job's Payment Status as Paid, recording how the client paid, and mints its
// Transaction ID — deliberately generated here rather than at intake, since a Transaction ID is
// a proof-of-payment reference and shouldn't exist for a job nobody's paid for yet. Also sends
// the client an acknowledgement email confirming their payment was received and verified,
// separate from the billing statement that already went out when the job was marked Completed.
// Shared by the staff-facing "Mark Paid" button and the Stripe webhook — same rules apply
// whether a human confirms payment or Stripe does, so there's exactly one place this happens.
async function markJobPaid(recordId, method, receivedBy) {
  const transactionId = genRefId('TXN');
  const updated = await airtable.updateRecord(recordId, {
    'Payment Status': 'Paid',
    'Payment Method': method,
    'Transaction ID': transactionId,
    'Received By': receivedBy || ''
  });
  const f = updated.fields || {};

  let emailSent = false;
  if (f['Email']) {
    const firstName = f['First Name'] || 'there';
    const amount = fmtCurrency(f['Estimated Total per Visit']);
    const subject = 'Payment Received — Thank You From Primo Care';
    const body = `Hi ${firstName},\n\nThis confirms we've received and verified your payment for your ${f['Service'] || 'cleaning'} service at ${f['Address'] || 'your property'}.\n\nPayment Confirmation\nOrder ID: ${f['Order ID'] || ''}\nTransaction ID: ${transactionId}\nPayment Method: ${method}\nAmount Paid: ${amount}\n\nIf anything here looks off, just reply to this email.\n\nThank you for choosing Primo Care!\n\nBest,\nPrimo Care Team`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:600px;">
      <h2 style="color:#0a5c64;">Payment Received</h2>
      <p>Hi ${firstName},</p>
      <p>This confirms we've received and verified your payment for your <b>${f['Service'] || 'cleaning'}</b> service at <b>${f['Address'] || 'your property'}</b>.</p>
      <table style="margin:14px 0; border-collapse:collapse; width:100%;">
        <tr><td style="color:#6b7280; padding:4px 10px 4px 0;">Order ID</td><td>${f['Order ID'] || ''}</td></tr>
        <tr><td style="color:#6b7280; padding:4px 10px 4px 0;">Transaction ID</td><td>${transactionId}</td></tr>
        <tr><td style="color:#6b7280; padding:4px 10px 4px 0;">Payment Method</td><td>${method}</td></tr>
        <tr><td style="color:#6b7280; padding:4px 10px 4px 0; font-weight:700;">Amount Paid</td><td style="font-weight:700; color:#0a5c64;">${amount}</td></tr>
      </table>
      <p>If anything here looks off, just reply to this email.</p>
      <p>Thank you for choosing Primo Care!</p>
      <p>Best,<br>Primo Care Team</p>
    </div>`;
    await sendConfirmationEmail({ to: f['Email'], subject, body, htmlBody });
    emailSent = true;
  }

  return { transactionId, emailSent };
}

app.post('/api/staff/mark-paid', staffAuth, async (req, res) => {
  try {
    const { recordId, method } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId.' });
    if (!PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: 'Invalid or missing payment method.' });
    }
    const receivedBy = (req.member && (req.member.fullName || req.member.username)) || 'Staff';
    const { transactionId, emailSent } = await markJobPaid(recordId, method, receivedBy);
    res.json({ ok: true, transactionId, emailSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Payments — the "Pay Now" link in the billing statement email lands on /pay/:orderId, a small
// "how would you like to pay?" page. Paying online (if Stripe is configured) goes to a real
// Stripe Checkout session; Cash/Check just records the client's stated intent for staff to
// confirm in person; Bank Transfer additionally takes a screenshot as proof. None of the manual
// options mark a job Paid by themselves — that still only happens when staff confirm receipt
// (or, for Stripe, when the webhook confirms a real charge) via the shared markJobPaid() above.
// (`upload`, used here and by the staff before/after photo routes above, is declared near the
// top of the file since both sections need it.)
// ---------------------------------------------------------------------------

// Small, self-contained HTML wrapper for the handful of plain messages this section shows a
// client's browser (not the app's real UI, so no shared template — just enough styling to look
// intentional rather than like a stack trace).
function payMessagePage({ title, message, tone }) {
  const color = tone === 'error' ? '#dc2626' : tone === 'ok' ? '#16a34a' : '#0a5c64';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Primo Care</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f7f9fa;
      font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; padding:24px; -webkit-font-smoothing:antialiased; }
    .card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:36px 32px; max-width:440px; text-align:center;
      box-shadow:0 10px 30px rgba(0,0,0,0.06); }
    h1 { font-family:'Sora',sans-serif; font-weight:700; font-size:20px; color:${color}; margin:0 0 12px; }
    p { color:#374151; font-size:14.5px; line-height:1.6; margin:0; }
    a { color:#0e7c86; }
    button.close-tab {
      display:inline-block; margin-top:22px; background:#0e7c86; color:#fff; border:none; border-radius:8px;
      padding:11px 24px; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit;
    }
    button.close-tab:hover { background:#0a5c64; }
    .close-note { font-size:12px; color:#9ca3af; margin-top:10px; display:none; }
  </style></head><body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <div>
      <button class="close-tab" id="closeTabBtn" type="button">Close Tab</button>
      <p class="close-note" id="closeNote">This tab was opened from a link, so your browser may not let it close automatically &mdash; feel free to close it yourself.</p>
    </div>
  </div>
  <script>
    document.getElementById('closeTabBtn').addEventListener('click', function () {
      window.close();
      // window.close() only works for tabs a script opened; a tab reached by clicking an email
      // link usually won't close itself, and browsers give no error when that happens — so if
      // we're still here a moment later, say so instead of leaving the button looking broken.
      setTimeout(function () { document.getElementById('closeNote').style.display = 'block'; }, 400);
    });
  </script>
  </body></html>`;
}

// The "how would you like to pay?" landing page itself — plain HTML forms (no client-side JS
// needed), so Cash/Check submit as ordinary POSTs and Bank Transfer as a normal multipart file
// upload the browser handles natively.
function payOptionsPage({ orderId, service, amount, stripeConfigured, notice }) {
  const esc = escapeHtmlServer;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pay Your Invoice - Primo Care</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root { --teal:#0e7c86; --teal-dark:#0a5c64; --teal-light:#e6f4f5; --ink:#1f2937; --muted:#6b7280; --border:#e2e8f0;
      --font-display:'Sora',-apple-system,BlinkMacSystemFont,sans-serif; --font-body:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; background:#f7f9fa; color:var(--ink); font-family:var(--font-body);
      line-height:1.5; padding:32px 20px 60px; -webkit-font-smoothing:antialiased; }
    .wrap { max-width:480px; margin:0 auto; }
    header { background:linear-gradient(135deg,var(--teal),var(--teal-dark)); color:#fff; border-radius:14px; padding:22px 24px; margin-bottom:20px; box-shadow:0 10px 24px rgba(15,40,44,0.14); }
    header h1 { font-family:var(--font-display); font-weight:700; margin:0 0 4px; font-size:19px; }
    header p { margin:0; font-size:13px; opacity:0.9; }
    .amount-row { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.25); }
    .amount-row .label { font-size:12.5px; opacity:0.85; }
    .amount-row .value { font-family:var(--font-display); font-size:24px; font-weight:800; }
    .notice { background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px; }
    .card { background:#fff; border:1px solid var(--border); border-radius:12px; padding:18px 20px; margin-bottom:14px; }
    .card h2 { font-family:var(--font-display); font-weight:700; font-size:14px; margin:0 0 10px; color:var(--ink); }
    .card p.sub { font-size:12.5px; color:var(--muted); margin:0 0 12px; }
    button.pay-online {
      display:block; width:100%; background:var(--teal); color:#fff; border:none; border-radius:9px;
      padding:14px; font-size:15px; font-weight:700; cursor:pointer; text-align:center; text-decoration:none;
    }
    .manual-row { display:flex; gap:10px; }
    button.manual {
      flex:1; background:#fff; border:1.5px solid var(--teal); color:var(--teal-dark); border-radius:9px;
      padding:11px; font-size:13.5px; font-weight:700; cursor:pointer;
    }
    button.manual:hover, button.pay-online:hover { filter:brightness(0.96); }
    input[type=file] { width:100%; font-size:13px; margin-bottom:10px; }
    .footnote { text-align:center; font-size:12px; color:var(--muted); margin-top:18px; }
  </style></head><body>
  <div class="wrap">
    <header>
      <h1>Pay Your Invoice</h1>
      <p>Order ${esc(orderId)} &middot; ${esc(service || 'Service')}</p>
      <div class="amount-row"><span class="label">Amount Due</span><span class="value">${esc(amount)}</span></div>
    </header>
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    ${stripeConfigured ? `
    <div class="card">
      <h2>Pay Online</h2>
      <p class="sub">Fast and secure, by card.</p>
      <a class="pay-online" href="/pay/${encodeURIComponent(orderId)}/checkout">Pay ${esc(amount)} Now</a>
    </div>` : ''}
    <div class="card">
      <h2>Cash or Check</h2>
      <p class="sub">Let us know which you'll use — we'll confirm once we've received it.</p>
      <div class="manual-row">
        <form method="POST" action="/pay/${encodeURIComponent(orderId)}/method"><input type="hidden" name="method" value="Cash"><button class="manual" type="submit">I'll Pay Cash</button></form>
        <form method="POST" action="/pay/${encodeURIComponent(orderId)}/method"><input type="hidden" name="method" value="Check"><button class="manual" type="submit">I'll Pay by Check</button></form>
      </div>
    </div>
    <div class="card">
      <h2>Bank Transfer</h2>
      <p class="sub">Made a transfer already? Upload a screenshot of the confirmation and we'll verify it.</p>
      <form method="POST" action="/pay/${encodeURIComponent(orderId)}/bank-transfer" enctype="multipart/form-data">
        <input type="file" name="proof" accept="image/*,.pdf" required>
        <button class="manual" type="submit" style="width:100%;">Upload Proof of Transfer</button>
      </form>
    </div>
    <p class="footnote">Questions? Just reply to your billing email.</p>
  </div>
  </body></html>`;
}

async function loadPayableOrder(orderId) {
  const rec = await airtable.findByField('Order ID', orderId);
  if (!rec) return { error: 'not_found' };
  const f = rec.fields || {};
  if (f['Payment Status'] === 'Paid') return { error: 'already_paid', rec, f };
  return { rec, f };
}

// Registered before /pay/:orderId below: Express matches routes in registration order, and
// :orderId would otherwise swallow "success"/"cancel" as if they were literal Order IDs.

// Stripe redirects the browser here immediately after a successful checkout — before the webhook
// (a separate, async server-to-server call) has necessarily landed and updated Airtable. So this
// confirms the payment was submitted, not that it's been recorded yet, to avoid ever telling a
// client "you're paid up" before the record actually says so.
app.get('/pay/success', (req, res) => {
  res.send(payMessagePage({
    title: 'Payment submitted',
    message: `Thanks! We're confirming your payment now${req.query.orderId ? ' for Order ' + escapeHtmlServer(req.query.orderId) : ''} — you'll get an email receipt as soon as it's verified, usually within a few minutes.`,
    tone: 'ok'
  }));
});

app.get('/pay/cancel', (req, res) => {
  res.send(payMessagePage({
    title: 'Payment cancelled',
    message: 'No charge was made. You can try again any time using the Pay Now link in your billing email, or pay by cash, check, or bank transfer instead.',
    tone: 'info'
  }));
});

// The landing page itself.
app.get('/pay/:orderId', async (req, res) => {
  try {
    const { error, f } = await loadPayableOrder(req.params.orderId);
    if (error === 'not_found') {
      return res.status(404).send(payMessagePage({
        title: 'Order not found',
        message: 'We couldn\'t find a booking with that Order ID. Please check the link in your billing email, or reply to that email for help.',
        tone: 'error'
      }));
    }
    if (error === 'already_paid') {
      return res.send(payMessagePage({
        title: 'Already paid',
        message: `This order (${escapeHtmlServer(req.params.orderId)}) is already marked as paid. If that doesn't look right, just reply to your billing email.`,
        tone: 'ok'
      }));
    }
    const amount = fmtCurrency(f['Estimated Total per Visit']);
    let notice = null;
    if (f['Client Selected Payment Method'] === 'Bank Transfer' && !f['Received By']) {
      notice = 'We\'ve received your bank transfer proof and are verifying it — no need to submit again.';
    } else if (f['Client Selected Payment Method'] && !f['Received By']) {
      notice = `You told us you'd pay by ${f['Client Selected Payment Method']} — we're waiting to confirm we've received it.`;
    }
    res.send(payOptionsPage({
      orderId: req.params.orderId,
      service: f['Service'],
      amount,
      stripeConfigured: stripeLib.isConfigured(),
      notice
    }));
  } catch (err) {
    console.error(err);
    res.status(500).send(payMessagePage({
      title: 'Something went wrong',
      message: 'We couldn\'t load this invoice right now. Please try again shortly, or reply to your billing email.',
      tone: 'error'
    }));
  }
});

// Creates a Stripe Checkout session for the order's outstanding amount and redirects the client's
// browser straight to Stripe's hosted payment page. Split out from the landing page above so the
// landing page itself never has to talk to Stripe just to render.
app.get('/pay/:orderId/checkout', async (req, res) => {
  try {
    const { error, f } = await loadPayableOrder(req.params.orderId);
    if (error) {
      return res.status(error === 'not_found' ? 404 : 200).send(payMessagePage(
        error === 'not_found'
          ? { title: 'Order not found', message: 'We couldn\'t find a booking with that Order ID.', tone: 'error' }
          : { title: 'Already paid', message: 'This order is already marked as paid.', tone: 'ok' }
      ));
    }
    if (!stripeLib.isConfigured()) {
      return res.redirect(303, `/pay/${encodeURIComponent(req.params.orderId)}`);
    }
    const amount = f['Estimated Total per Visit'];
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).send(payMessagePage({
        title: 'Nothing to pay',
        message: 'This order doesn\'t have an amount due. Please reply to your billing email if you think this is a mistake.',
        tone: 'error'
      }));
    }
    const base = `${req.protocol}://${req.get('host')}`;
    const session = await stripeLib.createCheckoutSession({
      orderId: req.params.orderId,
      description: `Primo Care — ${f['Service'] || 'Service'} (Order ${req.params.orderId})`,
      amount,
      customerEmail: f['Email'],
      successUrl: `${base}/pay/success?orderId=${encodeURIComponent(req.params.orderId)}`,
      cancelUrl: `${base}/pay/cancel?orderId=${encodeURIComponent(req.params.orderId)}`
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    res.status(500).send(payMessagePage({
      title: 'Something went wrong',
      message: 'We couldn\'t start the payment right now. Please try again shortly, or reply to your billing email.',
      tone: 'error'
    }));
  }
});

// Client declares they'll pay by Cash or Check. This only records intent — Payment Status stays
// Pending until a staff member actually confirms the money's in hand via "Mark Paid", at which
// point Received By captures who (see markJobPaid above).
app.post('/pay/:orderId/method', async (req, res) => {
  try {
    const method = req.body && req.body.method;
    if (!['Cash', 'Check'].includes(method)) {
      return res.status(400).send(payMessagePage({ title: 'Invalid request', message: 'That payment method isn\'t recognized.', tone: 'error' }));
    }
    const { error, rec } = await loadPayableOrder(req.params.orderId);
    if (error) {
      return res.status(error === 'not_found' ? 404 : 200).send(payMessagePage(
        error === 'not_found'
          ? { title: 'Order not found', message: 'We couldn\'t find a booking with that Order ID.', tone: 'error' }
          : { title: 'Already paid', message: 'This order is already marked as paid.', tone: 'ok' }
      ));
    }
    await airtable.updateRecord(rec.id, { 'Client Selected Payment Method': method });
    res.send(payMessagePage({
      title: 'Got it!',
      message: `We've noted you'll pay by ${method}. A staff member will mark this order as paid once it's received — you'll get a confirmation email at that point.`,
      tone: 'ok'
    }));
  } catch (err) {
    console.error(err);
    res.status(500).send(payMessagePage({
      title: 'Something went wrong',
      message: 'We couldn\'t save that just now. Please try again, or reply to your billing email.',
      tone: 'error'
    }));
  }
});

// Client uploads a screenshot/photo of a bank transfer as proof. Stored as an Airtable
// attachment on the order's own record — no separate file host needed. Still doesn't mark the
// job Paid; staff verify the proof and confirm via "Mark Paid" like any other method.
app.post('/pay/:orderId/bank-transfer', upload.single('proof'), async (req, res) => {
  try {
    const { error, rec } = await loadPayableOrder(req.params.orderId);
    if (error) {
      return res.status(error === 'not_found' ? 404 : 200).send(payMessagePage(
        error === 'not_found'
          ? { title: 'Order not found', message: 'We couldn\'t find a booking with that Order ID.', tone: 'error' }
          : { title: 'Already paid', message: 'This order is already marked as paid.', tone: 'ok' }
      ));
    }
    if (!req.file) {
      return res.status(400).send(payMessagePage({
        title: 'Couldn\'t use that file',
        message: 'Please upload a photo (JPG, PNG, HEIC) or PDF of your transfer confirmation, under 8MB.',
        tone: 'error'
      }));
    }
    await airtable.uploadAttachment(
      rec.id, 'Bank Transfer Proof',
      req.file.buffer.toString('base64'),
      req.file.mimetype,
      req.file.originalname || 'transfer-proof'
    );
    await airtable.updateRecord(rec.id, { 'Client Selected Payment Method': 'Bank Transfer' });
    res.send(payMessagePage({
      title: 'Proof received',
      message: 'Thanks! We\'ll verify your transfer and mark this order as paid shortly — you\'ll get a confirmation email at that point.',
      tone: 'ok'
    }));
  } catch (err) {
    console.error(err);
    res.status(500).send(payMessagePage({
      title: 'Upload failed',
      message: 'We couldn\'t save that file just now. Please try again, or reply to your billing email.',
      tone: 'error'
    }));
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff-dashboard.html'));
});

// Aggregates business metrics from Airtable for the KPI dashboard. Reads both Submissions and
// Leads directly (no caching) since this base is small enough that a full scan on every load is
// cheap, and this page is pulled up infrequently.
app.get('/api/staff/dashboard', dashboardAuth, async (req, res) => {
  try {
    const [submissions, leads, verifiedMembers] = await Promise.all([
      airtable.listAllForTable(process.env.AIRTABLE_TABLE_NAME || 'Submissions'),
      airtable.listAllForTable('Leads'),
      airtable.listAllForTable(CLIENT_MEMBERS_TABLE, { formula: '{Verified}=TRUE()' })
    ]);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Last 6 calendar months (oldest first, ending with the current month), keyed the same way
    // as each submission's Submitted-At month so records can be bucketed by simple lookup.
    const monthBuckets = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthBuckets.push({ key: d.getFullYear() + '-' + d.getMonth(), label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), bookings: 0, value: 0 });
    }
    const monthByKey = {};
    monthBuckets.forEach(m => { monthByKey[m.key] = m; });

    let bookingsThisMonth = 0;
    let scheduledJobs = 0;
    let ongoingJobs = 0;
    let completedJobs = 0;
    let cancelledJobs = 0;
    let rescheduledJobs = 0;
    let revenueCollected = 0;
    let paidCount = 0;
    let unpaidAmount = 0;
    let unpaidCount = 0;
    let totalBookedValue = 0;
    const serviceStats = {};
    const propertyTypeCount = { Residential: 0, Commercial: 0 };
    const upcomingList = [];

    submissions.forEach(rec => {
      const f = rec.fields || {};
      const status = f['Status'] || '';
      const total = typeof f['Estimated Total per Visit'] === 'number' ? f['Estimated Total per Visit'] : 0;
      totalBookedValue += total;
      const submittedAt = f['Submitted At'] ? new Date(f['Submitted At']) : null;
      if (submittedAt && submittedAt >= startOfMonth) bookingsThisMonth++;
      if (submittedAt) {
        const bucket = monthByKey[submittedAt.getFullYear() + '-' + submittedAt.getMonth()];
        if (bucket) { bucket.bookings++; bucket.value += total; }
      }

      if (status === 'Scheduled' || status === 'Ongoing') {
        if (status === 'Scheduled') scheduledJobs++; else ongoingJobs++;
        upcomingList.push({
          clientName: f['Client Name'] || '',
          service: f['Service'] || '',
          bookedDisplay: f['Booked Date/Time'] || '',
          bookedIso: f['Booked Start (ISO)'] || '',
          status
        });
      } else if (status === 'Completed') {
        completedJobs++;
        if (f['Payment Status'] === 'Paid') {
          revenueCollected += total;
          paidCount++;
        } else {
          unpaidAmount += total;
          unpaidCount++;
        }
      } else if (status === 'Cancelled') {
        cancelledJobs++;
      } else if (status === 'Rescheduled') {
        rescheduledJobs++;
      }

      const svc = f['Service'] || 'Other';
      if (!serviceStats[svc]) serviceStats[svc] = { service: svc, bookings: 0, revenue: 0 };
      serviceStats[svc].bookings++;
      serviceStats[svc].revenue += total;

      const ptype = f['Property Type'];
      if (ptype === 'Residential' || ptype === 'Commercial') propertyTypeCount[ptype]++;
    });

    upcomingList.sort((a, b) => new Date(a.bookedIso || 0) - new Date(b.bookedIso || 0));

    const serviceBreakdown = Object.values(serviceStats)
      .map(s => ({ ...s, avg: s.bookings ? s.revenue / s.bookings : 0 }))
      .sort((a, b) => b.revenue - a.revenue);

    let leadsThisMonth = 0;
    let proposalsSent = 0;
    const recentLeads = [];
    leads.forEach(rec => {
      const f = rec.fields || {};
      const created = rec.createdTime ? new Date(rec.createdTime) : null;
      if (created && created >= startOfMonth) leadsThisMonth++;
      if (f['Proposal Letter Sent']) proposalsSent++;
      recentLeads.push({
        name: [f['Client First Name'], f['Client Last Name']].filter(Boolean).join(' ') || f['Business Name'] || '',
        email: f['Email'] || '',
        proposalSent: !!f['Proposal Letter Sent'],
        createdTime: rec.createdTime
      });
    });
    recentLeads.sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0));

    // Prospects — verified Client Members with zero bookings so far (signed up via
    // /api/client/signup or an abandoned/never-followed-through auto-enrollment, but never
    // actually submitted a job). Distinct from `leads` above, which are cold outreach-sourced
    // contacts, not self-signed-up members.
    const clientIdsWithBookings = new Set(submissions.map(r => r.fields['Client ID']).filter(Boolean));
    const prospects = verifiedMembers
      .filter(rec => !clientIdsWithBookings.has(rec.fields['Client ID']))
      .map(rec => ({
        name: rec.fields['Full Name'] || '',
        email: rec.fields['Email'] || '',
        accountCreatedAt: rec.fields['Account Created At'] || '',
        followUp48hrSent: !!rec.fields['48hr Follow-Up Sent'],
        followUp7DaySent: !!rec.fields['7-Day Follow-Up Sent']
      }))
      .sort((a, b) => new Date(b.accountCreatedAt || 0) - new Date(a.accountCreatedAt || 0));
    const followUp48hrSentCount = prospects.filter(p => p.followUp48hrSent).length;
    const followUp7DaySentCount = prospects.filter(p => p.followUp7DaySent).length;

    // Prospect conversion — a verified member whose *first-ever* booking happened meaningfully
    // later (10+ min) than their signup came in through the standalone sign-up flow, not the
    // traditional "auto-enrolled at first booking" path, where Account Created At and that
    // booking's Submitted At are set within the same request and are effectively simultaneous.
    // No new field needed — this falls straight out of comparing timestamps already on hand.
    const CONVERSION_GAP_MS = 10 * 60 * 1000;
    const earliestBookingByClientId = {};
    submissions.forEach(r => {
      const cid = r.fields['Client ID'];
      const submittedAt = r.fields['Submitted At'];
      if (!cid || !submittedAt) return;
      if (!earliestBookingByClientId[cid] || new Date(submittedAt) < new Date(earliestBookingByClientId[cid])) {
        earliestBookingByClientId[cid] = submittedAt;
      }
    });
    const convertedProspects = verifiedMembers
      .filter(rec => {
        const firstBooking = earliestBookingByClientId[rec.fields['Client ID']];
        const signedUp = rec.fields['Account Created At'];
        return !!(firstBooking && signedUp && new Date(firstBooking) - new Date(signedUp) > CONVERSION_GAP_MS);
      })
      .map(rec => ({
        name: rec.fields['Full Name'] || '',
        email: rec.fields['Email'] || '',
        accountCreatedAt: rec.fields['Account Created At'] || '',
        convertedAt: earliestBookingByClientId[rec.fields['Client ID']]
      }))
      .sort((a, b) => new Date(b.convertedAt || 0) - new Date(a.convertedAt || 0));

    res.json({
      totalLeads: leads.length,
      leadsThisMonth,
      proposalsSent,
      totalBookings: submissions.length,
      bookingsThisMonth,
      totalBookedValue,
      scheduledJobs,
      ongoingJobs,
      upcomingJobs: scheduledJobs + ongoingJobs,
      completedJobs,
      cancelledJobs,
      rescheduledJobs,
      revenueCollected,
      paidCount,
      unpaidAmount,
      unpaidCount,
      monthlyTrend: monthBuckets,
      serviceBreakdown,
      propertyTypeCount,
      upcomingList: upcomingList.slice(0, 6),
      recentLeads: recentLeads.slice(0, 6),
      prospectsCount: prospects.length,
      prospects: prospects.slice(0, 6),
      followUp48hrSentCount,
      followUp7DaySentCount,
      convertedProspectsCount: convertedProspects.length,
      convertedProspects: convertedProspects.slice(0, 6)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Member management (admin-only) — add/list/remove login accounts for /schedule and /dashboard.
// ---------------------------------------------------------------------------

const MEMBER_ROLES = ['Admin', 'Staff'];

app.get('/dashboard/members', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard-members.html'));
});

// Lists every member account (never returns Password).
app.get('/api/dashboard/members', dashboardAuth, async (req, res) => {
  try {
    const records = await airtable.listAllForTable(MEMBERS_TABLE, { sort: [{ field: 'Username', direction: 'asc' }] });
    const members = records.map(rec => {
      const f = rec.fields || {};
      return {
        recordId: rec.id,
        username: f['Username'] || '',
        fullName: f['Full Name'] || '',
        role: f['Role'] || '',
        addedAt: rec.createdTime
      };
    });
    res.json({ members });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Creates a new member account. Username must be unique (case-insensitive) so login lookups
// stay unambiguous.
app.post('/api/dashboard/members', dashboardAuth, async (req, res) => {
  try {
    const { username, password, fullName, role } = req.body || {};
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are all required.' });
    }
    if (!MEMBER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Role must be Admin or Staff.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const existing = await findMember(username);
    if (existing) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    const rec = await airtable.createRecordForTable(MEMBERS_TABLE, {
      'Username': username,
      'Password': password,
      'Full Name': fullName || '',
      'Role': role
    });
    res.json({ ok: true, recordId: rec.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Removing a member is deliberately gated tighter than everything else on this page: any Admin
// can view the list or add someone, but only whoever holds an owner (break-glass DASHBOARD_USERS)
// credential can actually remove an account — verified fresh on every request, separate from
// whatever session/Basic-Auth is already logged in. This stops a merely-logged-in Admin browser
// tab from being enough to remove someone; the real owner password has to be typed in each time.
function verifyOwnerCredentials(username, password) {
  if (!username || !password) return false;
  const expectedPass = BREAK_GLASS_DASHBOARD[username];
  return !!expectedPass && safeEqual(password, expectedPass);
}

// Changing a member's role (e.g. promoting Staff to Admin) is gated the same way as removal —
// owner credentials required fresh on every request, not just any Admin's own login. A role
// change is effectively as sensitive as add/remove: it can grant or revoke dashboard access.
app.patch('/api/dashboard/members/:recordId', dashboardAuth, async (req, res) => {
  try {
    const { role, ownerUsername, ownerPassword } = req.body || {};
    if (!MEMBER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Role must be Admin or Staff.' });
    }
    if (!verifyOwnerCredentials(ownerUsername, ownerPassword)) {
      return res.status(403).json({ error: 'Incorrect owner username or password.' });
    }
    await airtable.updateRecordForTable(MEMBERS_TABLE, req.params.recordId, { 'Role': role });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/dashboard/members/:recordId', dashboardAuth, async (req, res) => {
  try {
    const { ownerUsername, ownerPassword } = req.body || {};
    if (!verifyOwnerCredentials(ownerUsername, ownerPassword)) {
      return res.status(403).json({ error: 'Incorrect owner username or password.' });
    }
    await airtable.deleteRecordForTable(MEMBERS_TABLE, req.params.recordId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AI chat widget (marketing site). Answers questions about services, pricing model, and
// policies, and points visitors to the right page — it deliberately never books, cancels, or
// quotes an exact price itself, since those all require the identity/availability checks the
// real booking flow already does. Keeping it read-only keeps this both safe and cheap.
// ---------------------------------------------------------------------------

const CHAT_SYSTEM_PROMPT = `You are the friendly virtual assistant on the Primo Care Cleaning Services website, a professional cleaning company serving homes and businesses in the Frisco, TX area.

What Primo Care offers:
- Residential: Standard Cleaning (routine upkeep), Deep Cleaning (thorough, detail-oriented)
- Commercial: General Office, Medical & Healthcare Facilities, Retail, Industrial/Warehouse, Schools
- Optional add-ons for residential: Balcony & Lanai cleaning

Pricing: Custom, based on the property's actual square footage — never a flat rate. Visitors get an instant, itemized quote by filling out the form at /intake (takes about 2 minutes, no phone call needed). Recurring visits (weekly, every 2 weeks, monthly, quarterly, semi-annual, annually) are available.

Booking: New clients get a quote and book their first visit at /intake. Returning clients who already have a Client ID can book another visit at /book.

Cancelling or rescheduling: Log in at /account (created automatically from your first booking's confirmation email) and manage it right from your booking history there. Changes made 48 hours or more before the scheduled visit are free; changes made less than 48 hours before incur a fee of 20% of the Total Contract Price.

Contact: Phone +63 917 625 3896, email desk@primocare.com.

Your job: answer questions about services, the pricing model, booking, and policies briefly and warmly (2-4 sentences). Always direct people to the actual page (/intake, /book, or /account) for anything actionable — you cannot generate a price quote, place a booking, or cancel/reschedule one yourself, so never attempt to. If asked something unrelated to Primo Care or cleaning services, politely say that's outside what you can help with here. Never invent a detail you don't know — if unsure, suggest they call or email instead of guessing.`;

// Simple in-memory per-IP rate limit. This calls a paid, external API, so an unbounded public
// endpoint is a real cost-abuse risk — resets on server restart, which is fine at this scale.
const chatRateLimits = new Map();
const CHAT_RATE_LIMIT = 20;
const CHAT_RATE_WINDOW_MS = 60 * 60 * 1000;

function checkChatRateLimit(ip) {
  const now = Date.now();
  const entry = chatRateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    chatRateLimits.set(ip, { count: 1, resetAt: now + CHAT_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= CHAT_RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

app.post('/api/chat', async (req, res) => {
  try {
    if (!anthropicLib.isConfigured()) {
      return res.json({ reply: "Our AI assistant isn't switched on just yet — for now, please use the Get a Free Quote button, or call us at +63 917 625 3896 / email desk@primocare.com and we'll help right away." });
    }
    if (!checkChatRateLimit(req.ip)) {
      return res.status(429).json({ reply: "You've sent a lot of messages in a short time — please try again in a bit, or reach us directly at +63 917 625 3896." });
    }
    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    // Bound both the conversation length and each message's size — keeps token cost predictable
    // and blocks someone from pasting a huge blob to run up the bill.
    const messages = incoming
      .slice(-8)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'No user message to respond to.' });
    }
    const reply = await anthropicLib.chat(messages, CHAT_SYSTEM_PROMPT);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Sorry, something went wrong on our end. Please try again, or reach us at +63 917 625 3896 / desk@primocare.com." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Primo Care web app listening on port ${PORT}`);
});
