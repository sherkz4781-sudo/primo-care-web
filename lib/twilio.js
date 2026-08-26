// SMS reminders, via Twilio directly (a hand-rolled fetch call, same pattern as lib/stripe.js
// and lib/anthropic.js — no SDK needed for one simple endpoint). Stays inert until
// TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER are all set, same "wired but
// inactive" pattern as Stripe/Anthropic: ship it now, flip it on later with no code changes.

const fetch = require('node-fetch');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

function isConfigured() {
  return !!(ACCOUNT_SID && AUTH_TOKEN && FROM_NUMBER);
}

// Converts however a client typed their number on /intake (with spaces/dashes, a leading 0,
// or already in +63 form) into the E.164 format Twilio requires. Philippine numbers only —
// this business's clients are all PH-based (see CAL_TIMEZONE). Returns null on anything that
// doesn't look like a recognizable PH mobile number, so the caller can skip rather than guess
// wrong and burn a Twilio credit on an undeliverable send.
function toE164PH(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+63') && digits.length === 13) return digits;
  if (digits.startsWith('63') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 11) return '+63' + digits.slice(1);
  if (digits.startsWith('9') && digits.length === 10) return '+63' + digits;
  return null;
}

async function sendSms(toRaw, body) {
  if (!isConfigured()) throw new Error('Twilio is not configured.');
  const to = toE164PH(toRaw);
  if (!to) throw new Error(`Could not parse "${toRaw}" into a PH E.164 phone number.`);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: FROM_NUMBER, Body: body });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `Twilio send failed (${res.status}).`);
  }
  return data;
}

module.exports = { isConfigured, sendSms, toE164PH };
