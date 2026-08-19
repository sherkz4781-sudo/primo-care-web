// Google Calendar + Gmail helpers, replacing the Cowork MCP calendar/Gmail connectors with
// direct googleapis calls authenticated as the Primo Care owner via a stored OAuth refresh token.

const { google } = require('googleapis');
const https = require('https');

const CAL_TIMEZONE = process.env.CAL_TIMEZONE || 'Asia/Manila';
const OWNER_EMAIL = process.env.OWNER_EMAIL;

// Some Node.js versions have a regression (nodejs/node#63989) where keep-alive HTTP agent
// socket reuse makes gaxios (the HTTP layer under googleapis/google-auth-library) throw a
// false "Premature close" error — this hits token refreshes and API calls to
// googleapis.com particularly often. Passing a plain, non-keep-alive https.Agent as the
// transporter default sidesteps the bug for every request made through this client.
const NO_KEEPALIVE_AGENT = new https.Agent({ keepAlive: false });

function getOAuthClient() {
  const client = new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    transporterOptions: { agent: NO_KEEPALIVE_AGENT }
  });
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function getCalendar() {
  return google.calendar({ version: 'v3', auth: getOAuthClient() });
}

function getGmail() {
  return google.gmail({ version: 'v1', auth: getOAuthClient() });
}

// Formats an absolute JS Date as a "floating" local wall-clock string (no Z/offset) for the
// given IANA zone — matches the timezone-fix used in the original Cowork artifact. Passing a
// floating string alongside timeZone (rather than a UTC "Z" timestamp) avoids the Calendar
// API reinterpreting/double-converting the time.
function toZonedLocalString(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = {};
  fmt.formatToParts(date).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}`;
}

function toRRuleUntil(date) {
  const iso = date.toISOString();
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + 'T' + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z';
}

const FREQ_RRULE = {
  'Weekly': 'FREQ=WEEKLY',
  'Every 2 Weeks': 'FREQ=WEEKLY;INTERVAL=2',
  'Monthly': 'FREQ=MONTHLY',
  'Quarterly': 'FREQ=MONTHLY;INTERVAL=3',
  'Semi-Annual': 'FREQ=MONTHLY;INTERVAL=6',
  'Annually': 'FREQ=YEARLY'
};

const CALL_DURATION_MIN = 30;
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;

// Finds open CALL_DURATION_MIN-minute slots on the given date (YYYY-MM-DD, interpreted in
// CAL_TIMEZONE) during business hours on weekdays, by pulling the owner's busy blocks via
// freebusy.query and walking the gaps.
async function findAvailableSlots(dateStr) {
  const calendar = getCalendar();

  // The Calendar API's freebusy.query endpoint requires timeMin/timeMax to be full RFC3339
  // timestamps *with an explicit UTC offset* — unlike events.insert's start/end objects,
  // there's no separate per-field timeZone here, so a plain floating "no offset" string
  // (which worked for events.insert) is rejected as a 400 Bad Request here. Compute the
  // zone's offset for this date up front and embed it directly in the timestamp.
  const offsetMinutes = getTimezoneOffsetMinutes(CAL_TIMEZONE, new Date(`${dateStr}T12:00:00Z`));
  const offsetStr = formatOffset(offsetMinutes);
  const timeMin = `${dateStr}T00:00:00${offsetStr}`;
  const timeMax = `${dateStr}T23:59:59${offsetStr}`;

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: CAL_TIMEZONE,
      items: [{ id: OWNER_EMAIL }]
    }
  });

  const busy = (fb.data.calendars && fb.data.calendars[OWNER_EMAIL] && fb.data.calendars[OWNER_EMAIL].busy) || [];
  const busyRanges = busy.map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));

  // Business-hour window in real UTC instants: build via zoned local string + Date parsing of
  // an ISO string with an explicit offset would need the zone's UTC offset for that date. The
  // simplest correct approach: ask freebusy for busy blocks (already correct instants above),
  // then generate slot instants by walking whole-minute increments across the local business
  // window and converting each candidate slot's *local* wall-clock time to a real instant using
  // the same Intl-based technique in reverse (construct a Date from the local string with a
  // computed offset).
  const slotStartLocalMinutes = BUSINESS_START_HOUR * 60;
  const slotEndLocalMinutes = BUSINESS_END_HOUR * 60;

  const dateOnlyUTC = Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10))
  );

  // Skip weekends (Saturday=6, Sunday=0) based on the local calendar date.
  const localWeekday = new Date(dateOnlyUTC).getUTCDay();
  if (localWeekday === 0 || localWeekday === 6) return [];

  const slots = [];
  for (let m = slotStartLocalMinutes; m + CALL_DURATION_MIN <= slotEndLocalMinutes; m += CALL_DURATION_MIN) {
    const startInstantMs = dateOnlyUTC + (m - offsetMinutes) * 60000;
    const endInstantMs = startInstantMs + CALL_DURATION_MIN * 60000;
    const overlapsBusy = busyRanges.some(b => startInstantMs < b.end && endInstantMs > b.start);
    // Don't offer slots that have already passed.
    if (!overlapsBusy && startInstantMs > Date.now()) {
      slots.push({ start: new Date(startInstantMs).toISOString(), end: new Date(endInstantMs).toISOString() });
    }
  }
  return slots;
}

// Returns the UTC offset (in minutes, e.g. +480 for UTC+8 Manila) of the given IANA zone on
// the given date, accounting for any DST the zone might observe.
function getTimezoneOffsetMinutes(tz, date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, timeZoneName: 'shortOffset'
  });
  const parts = fmt.formatToParts(date);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  const match = tzPart && tzPart.value.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -mins : mins);
}

// Formats a UTC offset in minutes (e.g. 480) as an RFC3339 offset suffix (e.g. "+08:00").
function formatOffset(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function fmtSlotTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CAL_TIMEZONE });
}

// Creates a one-off or recurring calendar event. `params` mirrors the shape used by the
// original Cowork artifact: { summary, description, location, startIso, endIso, recurrence: {freqName, untilDate} | null }
async function createEvent(params) {
  const calendar = getCalendar();
  const zonedStart = toZonedLocalString(new Date(params.startIso), CAL_TIMEZONE);
  const zonedEnd = toZonedLocalString(new Date(params.endIso), CAL_TIMEZONE);

  const requestBody = {
    summary: params.summary,
    description: params.description,
    location: params.location || '',
    start: { dateTime: zonedStart, timeZone: CAL_TIMEZONE },
    end: { dateTime: zonedEnd, timeZone: CAL_TIMEZONE }
  };

  if (params.recurrence) {
    const rrule = FREQ_RRULE[params.recurrence.freqName];
    if (rrule) {
      requestBody.recurrence = ['RRULE:' + rrule + ';UNTIL=' + toRRuleUntil(params.recurrence.untilDate)];
    }
  }

  const res = await calendar.events.insert({ calendarId: OWNER_EMAIL, requestBody });
  return res.data; // includes .id
}

async function deleteEvent(eventId) {
  const calendar = getCalendar();
  try {
    await calendar.events.delete({ calendarId: OWNER_EMAIL, eventId });
    return true;
  } catch (err) {
    // Already deleted / not found — treat as success for idempotency.
    if (err.code === 410 || err.code === 404) return true;
    throw err;
  }
}

// Full-text search fallback for events predating the stored Calendar Event ID field.
async function searchEventsByText(query, timeMinIso, timeMaxIso) {
  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: OWNER_EMAIL,
    q: query,
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: true,
    orderBy: 'startTime'
  });
  return res.data.items || [];
}

async function listEventsInWindow(timeMinIso, timeMaxIso, fullText) {
  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: OWNER_EMAIL,
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    q: fullText,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50
  });
  return res.data.items || [];
}

// RFC 822 headers are ASCII-only; a raw non-ASCII character (e.g. an em dash "—" in a Subject
// line) gets misinterpreted by mail clients as Latin-1/etc, producing mojibake ("Ã¢Â€Â”").
// RFC 2047 encoded-words are the standard fix: wrap the UTF-8 bytes as base64 inside
// "=?UTF-8?B?...?=" whenever the value isn't already plain ASCII.
function encodeHeaderValue(value) {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}

function buildEncodedMimeMessage({ to, subject, body, htmlBody }) {
  const boundary = 'primo_care_boundary';
  const messageParts = [
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    htmlBody,
    '',
    `--${boundary}--`
  ].join('\r\n');

  return Buffer.from(messageParts)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Creates a Gmail draft (the Gmail API has no restriction here, unlike the Cowork MCP
// connector this app replaces — but the full proposal email still only creates a draft by
// design, so a human reviews and sends it. Short transactional confirmations, like the
// cancel/reschedule notice, use sendGmailMessage below instead since those don't need review.)
async function createGmailDraft({ to, subject, body, htmlBody }) {
  const gmail = getGmail();
  const encodedMessage = buildEncodedMimeMessage({ to, subject, body, htmlBody });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: encodedMessage } }
  });
  return res.data;
}

// Actually sends an email immediately (not a draft). Used only for short, low-risk
// transactional confirmations (cancel/reschedule receipts) where a human review step before
// send isn't warranted — unlike the full proposal email, which stays draft-only.
async function sendGmailMessage({ to, subject, body, htmlBody }) {
  const gmail = getGmail();
  const encodedMessage = buildEncodedMimeMessage({ to, subject, body, htmlBody });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage }
  });
  return res.data;
}

module.exports = {
  CAL_TIMEZONE, OWNER_EMAIL, CALL_DURATION_MIN,
  findAvailableSlots, fmtSlotTime, createEvent, deleteEvent,
  searchEventsByText, listEventsInWindow, createGmailDraft, sendGmailMessage
};
