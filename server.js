require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const gcal = require('./lib/google');
const airtable = require('./lib/airtable');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CAL_TIMEZONE = gcal.CAL_TIMEZONE;

// ---- ID generation (moved server-side so a client can't forge/replay reference numbers) ----
function genRefId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PC-${prefix}-${ts}${rand}`;
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

// HTTP Basic Auth gate for everything under /staff and /api/staff. Credentials live in
// STAFF_USERNAME/STAFF_PASSWORD (env vars, never in code). Compared with timingSafeEqual so a
// slow string compare can't leak how many characters matched.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function staffAuth(req, res, next) {
  const user = process.env.STAFF_USERNAME;
  const pass = process.env.STAFF_PASSWORD;
  if (!user || !pass) {
    return res.status(500).send('Staff login is not configured on this server.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const reqUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const reqPass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (safeEqual(reqUser, user) && safeEqual(reqPass, pass)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Primo Care Staff"');
  return res.status(401).send('Authentication required.');
}

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
      const subject = 'Thank You From Primo Care — Your Billing Statement';
      const body = `Hi ${firstName},\n\nThank you for choosing Primo Care! Our team has completed your ${f['Service'] || 'cleaning'} service at ${f['Address'] || 'your property'}.\n\nBilling Statement\nOrder ID: ${f['Order ID'] || ''}\nService: ${f['Service'] || ''}\nProperty: ${f['Address'] || ''}\nAmount Due: ${amount}\n\nIf you have any questions about this statement, just reply to this email.\n\nThank you again for trusting us with your space!\n\nBest,\nPrimo Care Team`;
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
      return {
        recordId: rec.id,
        orderId: f['Order ID'] || '',
        clientName: f['Client Name'] || '',
        phone: f['Contact Number'] || '',
        address: f['Address'] || '',
        service: f['Service'] || '',
        total: f['Estimated Total per Visit'],
        bookedDisplay: f['Booked Date/Time'] || ''
      };
    });
    res.json({ jobs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PAYMENT_METHODS = ['Cash', 'Online / Card', 'Check', 'Bank Transfer'];

// Marks one completed job's Payment Status as Paid, recording how the client paid, and mints
// its Transaction ID — deliberately generated here rather than at intake, since a Transaction
// ID is a proof-of-payment reference and shouldn't exist for a job nobody's paid for yet. Also
// sends the client an acknowledgement email confirming their payment was received and verified,
// separate from the billing statement that already went out when the job was marked Completed.
app.post('/api/staff/mark-paid', staffAuth, async (req, res) => {
  try {
    const { recordId, method } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId.' });
    if (!PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: 'Invalid or missing payment method.' });
    }
    const transactionId = genRefId('TXN');
    const updated = await airtable.updateRecord(recordId, {
      'Payment Status': 'Paid',
      'Payment Method': method,
      'Transaction ID': transactionId
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

    res.json({ ok: true, transactionId, emailSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/staff/dashboard', staffAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff-dashboard.html'));
});

// Aggregates business metrics from Airtable for the staff dashboard. Reads both Submissions and
// Leads directly (no caching) since this base is small enough that a full scan on every load is
// cheap, and staff pull this up infrequently.
app.get('/api/staff/dashboard', staffAuth, async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Primo Care web app listening on port ${PORT}`);
});
