require('dotenv').config();
const express = require('express');
const path = require('path');
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
// on file, minted fresh otherwise — never trusted from the client, same as Order/Transaction
// IDs) and shared across every property record created here; each property gets its own fresh
// Order ID + Transaction ID so it can be individually cancelled/rescheduled later.
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
      const transactionId = genRefId('TXN');

      const fields = {
        'Client Name': fullName,
        'Submitted At': new Date().toISOString(),
        'First Name': firstName,
        'Last Name': lastName,
        'Email': b.email,
        'Phone': b.phone,
        'Address': p.address,
        'Zip Code': p.zip,
        'Property Type': p.propertyType === 'residential' ? 'Residential' : 'Commercial',
        'Property Size (sq ft)': p.sqft,
        'Property Size Unit': p.sizeUnit === 'sqm' ? 'sq m' : 'sq ft',
        'Areas / Facility Type': p.propertyType === 'residential' ? (p.areasFormatted || (p.areas || []).join(', ')) : p.service,
        'Service': p.service,
        'Estimated Total per Visit': p.total,
        'Draft Email Created': false,
        'Client ID': clientId,
        'Order ID': orderId,
        'Transaction ID': transactionId,
        'Status': 'Scheduled'
      };
      if (b.prefix) fields['Prefix'] = b.prefix;
      if (b.suffix) fields['Suffix'] = b.suffix;
      const combinedAddonSqft = (p.balconySqftEquiv || 0) + (p.lanaiSqftEquiv || 0);
      if (combinedAddonSqft) fields['Balcony-Lanai Size (sq ft)'] = combinedAddonSqft;
      if (p.addonNote) fields['Balcony-Lanai Add-on'] = p.addonNote;
      if (p.othersSpecify) fields['Others Area Specify'] = p.othersSpecify;
      if (p.frequency) fields['Subscription Frequency'] = p.frequency;
      if (p.subscriptionDuration) fields['Subscription Duration (months)'] = p.subscriptionDuration;

      const rec = await airtable.createRecord(fields);
      results.push({ orderId, transactionId, recordId: rec.id });
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
      sqft: f['Property Size (sq ft)'] || '',
      sizeUnit: f['Property Size Unit'] || 'sq ft',
      service: f['Service'] || '',
      total: f['Estimated Total per Visit'] || 0,
      frequency: f['Subscription Frequency'] || '',
      subscriptionDuration: f['Subscription Duration (months)'] || '',
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
        sqft: f['Property Size (sq ft)'] || '',
        sizeUnit: f['Property Size Unit'] || 'sq ft',
        service: f['Service'] || '',
        total: f['Estimated Total per Visit'] || 0,
        frequency: f['Subscription Frequency'] || '',
        subscriptionDuration: f['Subscription Duration (months)'] || '',
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

    const freqName = f['Subscription Frequency'];
    const duration = f['Subscription Duration (months)'];
    const isSubscription = !!(freqName && duration);
    const clientLine = `${firstName} ${lastName} — ${f['Phone'] || ''} — ${email}`;

    const summary = isSubscription
      ? `Primo Care Cleaning (${freqName}) — ${firstName} ${lastName}`
      : `Primo Care Call — ${firstName} ${lastName}`;
    const description = [
      `Primo Care ${isSubscription ? 'subscription cleaning' : 'service call'}.`,
      `Client: ${clientLine}`,
      `Order ID: ${orderId}`,
      `Property: ${f['Address'] || ''} (${f['Property Size (sq ft)'] || ''} ${f['Property Size Unit'] || 'sq ft'})`,
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

// Creates a single Gmail draft covering one or more properties (accepts either `orderId`
// for a single property or `orderIds` for a combined multi-property submission), and marks
// every referenced property record as draft-created.
app.post('/api/create-draft', async (req, res) => {
  try {
    const { orderId, orderIds, to, subject, body, htmlBody } = req.body || {};
    const ids = Array.isArray(orderIds) ? orderIds : (orderId ? [orderId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Missing orderId(s).' });

    for (const id of ids) {
      const rec = await airtable.findByField('Order ID', id);
      if (rec) await airtable.updateRecord(rec.id, { 'Draft Email Created': true });
    }

    await gcal.createGmailDraft({ to, subject, body, htmlBody });
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
    const freqName = f['Subscription Frequency'];
    const duration = f['Subscription Duration (months)'];
    const isSubscription = !!(freqName && duration);
    const originalBookedDisplay = f['Booked Date/Time'] || '';
    const feeNote = feeApplicabilityNote(f['Booked Start (ISO)']);

    await deleteBookingEvent(rec, orderId);

    const clientLine = `${firstName} ${lastName} — ${f['Phone'] || ''} — ${email}`;
    const summary = isSubscription
      ? `Primo Care Cleaning (${freqName}) — ${firstName} ${lastName}`
      : `Primo Care Call — ${firstName} ${lastName}`;
    const description = [
      `Primo Care ${isSubscription ? 'subscription cleaning' : 'service call'} (rescheduled).`,
      `Client: ${clientLine}`,
      `Order ID: ${orderId}`,
      `Property: ${f['Address'] || ''} (${f['Property Size (sq ft)'] || ''} sq ft)`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Primo Care web app listening on port ${PORT}`);
});
