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

module.exports = { createRecord, updateRecord, findByField };
