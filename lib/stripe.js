// Online payments via Stripe Checkout. Deliberately built to stay inert until real credentials
// are added — every function here checks isConfigured() first, so the rest of the app can wire
// up "Pay Now" links and a webhook route today, ship them, and only start actually processing
// money once STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set (e.g. on Render). No code
// changes needed to flip it on later.

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// The `stripe` package is a real dependency (see package.json) but only instantiated if a key
// is present, so a deployment with no Stripe key at all never even loads it at request time.
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

function isConfigured() {
  return !!stripe;
}

// Creates a Stripe-hosted Checkout page for one order. Amount is a plain dollar number (e.g.
// 150.00) — Stripe wants integer cents, so the conversion happens here, once, rather than at
// every call site.
async function createCheckoutSession({ orderId, description, amount, customerEmail, successUrl, cancelUrl }) {
  if (!stripe) throw new Error('Stripe is not configured.');
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: description },
        unit_amount: Math.round(amount * 100)
      },
      quantity: 1
    }],
    customer_email: customerEmail || undefined,
    metadata: { orderId },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

// Verifies a webhook request actually came from Stripe (not a forged POST) using the raw request
// body and the signature Stripe sends in the stripe-signature header. Throws if the signature is
// missing/invalid, or if the webhook secret isn't configured — callers should treat any throw as
// "reject this request," never as "treat it as unverified but process it anyway."
function constructWebhookEvent(rawBody, signature) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook is not configured.');
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

module.exports = { isConfigured, createCheckoutSession, constructWebhookEvent };
