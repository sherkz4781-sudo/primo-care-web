// The site's AI chat widget, via the Claude API directly (a hand-rolled fetch call, same pattern
// as lib/stripe.js and lib/airtable.js — no SDK needed for one simple non-streaming endpoint).
// This is billed separately from any Claude subscription — it's its own pay-per-token API
// account — and stays inert until ANTHROPIC_API_KEY is set, same "wired but inactive" pattern as
// Stripe: ship it now, flip it on later with no code changes.

const fetch = require('node-fetch');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Haiku, deliberately — cheapest model, plenty capable for answering FAQs and pointing people to
// the right page. This is a chatbot for "what services do you offer," not a reasoning engine.
const MODEL = 'claude-haiku-4-5-20251001';

function isConfigured() {
  return !!ANTHROPIC_API_KEY;
}

// messages: [{role: 'user'|'assistant', content: string}, ...]. Returns the assistant's reply
// text. max_tokens is capped deliberately short — this is a chat widget, not a document
// generator, and every output token is money.
async function chat(messages, systemPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('The AI assistant is not configured.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 350,
      system: systemPrompt,
      messages
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Claude API request failed (${res.status})`;
    throw new Error(msg);
  }
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

module.exports = { isConfigured, chat };
