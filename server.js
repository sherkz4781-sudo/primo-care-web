require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const gcal = require('./lib/google');
const airtable = require('./lib/airtable');
const stripeLib = require('./lib/stripe');
const multer = require('multer');

const app = express();

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

// ---- ID generation (moved server-side so a client can't forge/replay reference numbers) ----
function genRefId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PC-${prefix}-${ts}${rand}`;
}

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

// ---------------------------------------------------------------------------
// Intake form endpoints
// ---------------------------------------------------------------------------

// Accepts one client + an array of properties (one client can book multiple properties in a
// single submission). A Client ID is resolved server-side (reused if this name already has one
// on file, minted fresh otherwise — never trusted from the client, same as Order ID) and shared
// across every property record created here; each property gets its own fresh Order ID so it
// can be individually cancelled/rescheduled later. Transaction ID is intentionally NOT minted
// here — it's a proof-of-payment reference, so it's only generated once staff actually confirm
// the client paid (see /api/staff/mark-paid).
app.post('/api/submit', async (req, res) => {
  try {
    const b = req.body || {};
    const firstName = (b.firstName || '').trim();
    const lastName = (b.lastName || '').trim();
    const fullName = `${firstName} ${lastName}`;
    const properties = Array.isArray(b.properties) ? b.properties : [];
    if (!properties.length) return res.status(400).json({ error: 'At least one property is required.' });

    let clientId;
    try {
      const existing = await airtable.findClientIdByName(fullName);
      clientId = (existing && existing.fields && existing.fields['Client ID']) || genRefId('CLI');
    } catch (err) {
      console.error('Client ID lookup failed, minting a new one:', err.message);
      clientId = genRefId('CLI');
    }

    const results = [];
    for (const p of properties) {
      const orderId = genRefId('ORD');

      const fields = {
        'Client Name': fullName,
        'Submitted At': new Date().toISOString(),
        'First Name': firstName,
        'Last Name': lastName,
        'Email': b.email,
        'Contact Number': b.phone,
        'Address': p.address,
        'Zip Code': p.zip,
        'Property Type': p.propertyType === 'residential' ? 'Residential' : 'Commercial',
        'Property Size': p.sqft,
        'Property Size Unit': p.sizeUnit === 'sqm' ? 'sq m' : 'sq ft',
        'Areas / Facility Type': p.propertyType === 'residential' ? (p.areasFormatted || (p.areas || []).join(', ')) : p.service,
        'Service': p.service,
        'Estimated Total per Visit': p.total,
        'Draft Email Created': false,
        'Client ID': clientId,
        'Order ID': orderId,
        'Status': 'Scheduled'
      };
      if (b.prefix) fields['Prefix'] = b.prefix;
      if (b.suffix) fields['Suffix'] = b.suffix;
      const combinedAddonSqft = (p.balconySqftEquiv || 0) + (p.lanaiSqftEquiv || 0);
      if (combinedAddonSqft) fields['Balcony-Lanai Size (sq ft)'] = combinedAddonSqft;
      if (p.addonNote) fields['Balcony-Lanai Add-on'] = p.addonNote;
      if (p.othersSpecify) fields['Others Area Specify'] = p.othersSpecify;
      if (p.frequency) fields['Subscription'] = p.frequency;
      if (p.subscriptionDuration) fields['Duration'] = p.subscriptionDuration;

      const rec = await airtable.createRecord(fields);
      results.push({ orderId, recordId: rec.id });
    }

    res.json({ clientId, properties: results });
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

app.post('/api/cancel', async (req, res) => {
  try {
    const { firstName, lastName, email, orderId, note } = req.body || {};
    const rec = await findVerifiedRecord({ firstName, lastName, email, orderId });
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find a booking matching those details.' });

    const f = rec.fields || {};
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

app.post('/api/reschedule/find-times', async (req, res) => {
  try {
    const { firstName, lastName, email, orderId, date } = req.body || {};
    const rec = await findVerifiedRecord({ firstName, lastName, email, orderId });
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find a booking matching those details.' });
    if (!date) return res.status(400).json({ error: 'Missing date.' });

    const slots = await gcal.findAvailableSlots(date);
    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reschedule/submit', async (req, res) => {
  try {
    const { firstName, lastName, email, orderId, slot, note } = req.body || {};
    const rec = await findVerifiedRecord({ firstName, lastName, email, orderId });
    if (!rec) return res.status(404).json({ error: 'We couldn\'t find a booking matching those details.' });

    const f = rec.fields || {};
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

app.get('/cancel-reschedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cancel-reschedule.html'));
});

// ---------------------------------------------------------------------------
// Staff-only: job completion
// ---------------------------------------------------------------------------

// HTTP Basic Auth gate for everything under /staff and /api/staff. Credentials live in env vars,
// never in code. Compared with timingSafeEqual so a slow string compare can't leak how many
// characters matched.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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

// Break-glass accounts that always work regardless of what's in the Members table — protects
// against ever being locked out if Airtable is briefly unreachable, or the Members table is
// accidentally emptied. Not shown anywhere in the UI; just env vars.
const BREAK_GLASS_STAFF = parseCredentialList(process.env.STAFF_USERS);
if (process.env.STAFF_USERNAME && process.env.STAFF_PASSWORD) {
  BREAK_GLASS_STAFF[process.env.STAFF_USERNAME] = process.env.STAFF_PASSWORD;
}
const BREAK_GLASS_DASHBOARD = parseCredentialList(process.env.DASHBOARD_USERS);

const MEMBERS_TABLE = 'Members';

// Looks up one login account by username in the Members table. Returns null if not found —
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

// Builds a Basic Auth middleware that accepts either a break-glass env-var login, or a Members
// table account whose Role is in allowedRoles. Staff role can only pass the staffAuth gate;
// Admin role passes both — that's the entire access model, driven by one field per person.
function makeRoleAuth(breakGlassUsers, allowedRoles, realm) {
  return async function (req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const reqUser = sep === -1 ? decoded : decoded.slice(0, sep);
      const reqPass = sep === -1 ? '' : decoded.slice(sep + 1);

      const breakGlassPass = breakGlassUsers[reqUser];
      if (breakGlassPass && safeEqual(reqPass, breakGlassPass)) {
        req.member = { username: reqUser, role: 'Admin', fullName: reqUser };
        return next();
      }

      try {
        const member = await findMember(reqUser);
        if (member && member.password && allowedRoles.includes(member.role) && safeEqual(reqPass, member.password)) {
          req.member = member;
          return next();
        }
      } catch (err) {
        console.error('Member lookup failed during auth:', err.message);
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="' + realm + '"');
    return res.status(401).send('Authentication required.');
  };
}

const staffAuth = makeRoleAuth(BREAK_GLASS_STAFF, ['Admin', 'Staff'], 'Primo Care Staff');
const dashboardAuth = makeRoleAuth(BREAK_GLASS_DASHBOARD, ['Admin'], 'Primo Care Dashboard');

app.get('/staff', staffAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff.html'));
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
        status: f['Status'] || ''
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

// Marks one booking Completed and emails the client a billing statement for that visit. Trusts
// the recordId as given — unlike the public booking/cancel/reschedule endpoints, this route is
// already gated by staffAuth, so there's no need for the identity-verification dance used on
// the public-facing side. The billing email reuses the amount locked in at booking time
// (Estimated Total per Visit), so — like the cancel/reschedule confirmations — there's no new
// pricing judgment call here, and it sends for real rather than staying a draft.
app.post('/api/staff/complete', staffAuth, async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId.' });

    const rec = await airtable.getRecord(recordId);
    const f = rec.fields || {};

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

    res.json({ ok: true, emailSent });
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
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|heic|heif)$|^application\/pdf$/.test(file.mimetype))
});

// Small, self-contained HTML wrapper for the handful of plain messages this section shows a
// client's browser (not the app's real UI, so no shared template — just enough styling to look
// intentional rather than like a stack trace).
function payMessagePage({ title, message, tone }) {
  const color = tone === 'error' ? '#dc2626' : tone === 'ok' ? '#16a34a' : '#0a5c64';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Primo Care</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f7f9fa;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; padding:24px; }
    .card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:36px 32px; max-width:440px; text-align:center;
      box-shadow:0 10px 30px rgba(0,0,0,0.06); }
    h1 { font-size:20px; color:${color}; margin:0 0 12px; }
    p { color:#374151; font-size:14.5px; line-height:1.6; margin:0; }
    a { color:#0e7c86; }
  </style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// The "how would you like to pay?" landing page itself — plain HTML forms (no client-side JS
// needed), so Cash/Check submit as ordinary POSTs and Bank Transfer as a normal multipart file
// upload the browser handles natively.
function payOptionsPage({ orderId, service, amount, stripeConfigured, notice }) {
  const esc = escapeHtmlServer;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pay Your Invoice - Primo Care</title>
  <style>
    :root { --teal:#0e7c86; --teal-dark:#0a5c64; --teal-light:#e6f4f5; --ink:#1f2937; --muted:#6b7280; --border:#e2e8f0; }
    * { box-sizing:border-box; }
    body { margin:0; background:#f7f9fa; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      line-height:1.5; padding:32px 20px 60px; }
    .wrap { max-width:480px; margin:0 auto; }
    header { background:linear-gradient(135deg,var(--teal),var(--teal-dark)); color:#fff; border-radius:14px; padding:22px 24px; margin-bottom:20px; }
    header h1 { margin:0 0 4px; font-size:19px; }
    header p { margin:0; font-size:13px; opacity:0.9; }
    .amount-row { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.25); }
    .amount-row .label { font-size:12.5px; opacity:0.85; }
    .amount-row .value { font-size:24px; font-weight:800; }
    .notice { background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px; }
    .card { background:#fff; border:1px solid var(--border); border-radius:12px; padding:18px 20px; margin-bottom:14px; }
    .card h2 { font-size:14px; margin:0 0 10px; color:var(--ink); }
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

app.get('/dashboard', dashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff-dashboard.html'));
});

// Aggregates business metrics from Airtable for the KPI dashboard. Reads both Submissions and
// Leads directly (no caching) since this base is small enough that a full scan on every load is
// cheap, and this page is pulled up infrequently.
app.get('/api/staff/dashboard', dashboardAuth, async (req, res) => {
  try {
    const [submissions, leads] = await Promise.all([
      airtable.listAllForTable(process.env.AIRTABLE_TABLE_NAME || 'Submissions'),
      airtable.listAllForTable('Leads')
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
      recentLeads: recentLeads.slice(0, 6)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Member management (admin-only) — add/list/remove login accounts for /staff and /dashboard.
// ---------------------------------------------------------------------------

const MEMBER_ROLES = ['Admin', 'Staff'];

app.get('/dashboard/members', dashboardAuth, (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Primo Care web app listening on port ${PORT}`);
});
