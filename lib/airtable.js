// Direct Airtable REST API helpers, replacing the Cowork MCP Airtable connector. Uses field
// NAMES (not the fld... IDs the MCP tool used) since that's simpler for hand-written REST calls
// and Airtable's REST API accepts either.

const fetch = require('node-fetch');

const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Submissions';

const BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

function authHeaders() {
  return {
    'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function airtableRequest(method, path, body) {
  const res = await fetch(BASE_URL + (path || ''), {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.type)) || `Airtable request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function createRecord(fields) {
  const data = await airtableRequest('POST', '', { records: [{ fields }] });
  return data.records[0]; // { id, fields, createdTime }
}

async function updateRecord(recordId, fields) {
  const data = await airtableRequest('PATCH', '', { records: [{ id: recordId, fields }] });
  return data.records[0];
}

// Looks up a single record by an exact-match field value, e.g. findByField('Order ID', 'PC-ORD-XXXX').
async function findByField(fieldName, value) {
  const formula = `{${fieldName}} = "${String(value).replace(/"/g, '\\"')}"`;
  const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
  const data = await airtableRequest('GET', '?' + qs.toString());
  return (data.records && data.records[0]) || null;
}

// Looks up whether a client already has a Client ID on file, matched by full name
// (case-insensitive) — a Client ID is issued once per client name and must always match their
// name on our records, so repeat bookings reuse it instead of minting a new one.
async function findClientIdByName(fullName) {
  const escaped = String(fullName).replace(/"/g, '\\"').toLowerCase();
  const formula = `LOWER({Client Name}) = "${escaped}"`;
  const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
  const data = await airtableRequest('GET', '?' + qs.toString());
  return (data.records && data.records[0]) || null;
}

// Returns every record matching an exact field value, e.g. findAllByField('Client ID',
// 'PC-CLI-XXXX') to pull up every property a client has on file. Used by the "Book a Schedule"
// page, which looks up all of a client's properties in one shot rather than one Order ID at a
// time.
async function findAllByField(fieldName, value) {
  const formula = `{${fieldName}} = "${String(value).replace(/"/g, '\\"')}"`;
  const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '100' });
  const data = await airtableRequest('GET', '?' + qs.toString());
  return data.records || [];
}

// Returns every record matching a raw Airtable formula, e.g.
// 'OR({Status}="Scheduled",{Status}="Ongoing")'. Paginates through all pages (Airtable caps
// each response at 100 records), so this can return more than 100 rows total.
async function listByFormula(formula, { sort } = {}) {
  let all = [];
  let offset;
  do {
    const qs = new URLSearchParams({ filterByFormula: formula, pageSize: '100' });
    (sort || []).forEach((s, i) => {
      qs.append(`sort[${i}][field]`, s.field);
      qs.append(`sort[${i}][direction]`, s.direction || 'asc');
    });
    if (offset) qs.set('offset', offset);
    const data = await airtableRequest('GET', '?' + qs.toString());
    all = all.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return all;
}

module.exports = { createRecord, updateRecord, findByField, findAllByField, findClientIdByName, listByFormula };
