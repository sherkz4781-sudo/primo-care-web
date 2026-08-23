# Primo Care Web — public, self-serve intake & booking

This is a standalone version of the Primo Care Cowork tool, rebuilt so it can be deployed to a
real public URL. Clients fill out the intake form themselves; it books directly on the real
Google Calendar, logs to the real Airtable base, and emails the client a proposal — no Cowork
session or human in the loop required for a normal booking.

It replaces the Cowork MCP connectors (`window.cowork.callMcpTool`) with direct API calls:
Google Calendar + Gmail via OAuth2 (`googleapis`), and Airtable via its REST API.

**Three pages:**
- `/intake` — intake, live pricing, proposal, and inline per-property booking (sends the proposal email directly to the client; `/` is the public marketing homepage instead)
- `/book` — public booking page. Reached via the link in the proposal email (`?clientId=&firstName=&lastName=&email=` pre-fills the identity form). Looks up every property on file for a Client ID and lets the client book each one independently; ends with a Submit → Thank You → Close Page flow.
- `/cancel-reschedule` — client self-serve cancel/reschedule, gated by the Cancellation & Reschedule Policy checkbox

## What you'll need before deploying

1. A Google Cloud project with the Calendar API and Gmail API enabled, and an OAuth client (Desktop app type).
2. A one-time OAuth login as `sherkz4781@gmail.com` to mint a refresh token (script included, see below).
3. An Airtable personal access token with read/write access to the "Primo Care - Client Submissions" base.
4. A place to host a small Node.js web service (Render, Railway, Fly.io, a VPS, etc. — anything that runs `node server.js` continuously and lets you set environment variables).

## Step 1 — Google Cloud credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create (or reuse) a project.
2. **APIs & Services → Library**: enable "Google Calendar API" and "Gmail API."
3. **APIs & Services → OAuth consent screen**: set it up in "External" mode (or "Internal" if you have Workspace), add your Gmail address as a test user if prompted.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type **Desktop app**. Copy the Client ID and Client Secret.
5. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Step 2 — Get a refresh token (one-time, run locally)

```
npm install
npm run get-refresh-token
```

This opens a URL — sign in as `sherkz4781@gmail.com` and approve access. The script prints a
`GOOGLE_REFRESH_TOKEN` value; paste it into your `.env` file. You only need to do this once —
the refresh token doesn't expire under normal use.

## Step 3 — Airtable token

Go to [airtable.com/create/tokens](https://airtable.com/create/tokens), create a token scoped to
`data.records:read` and `data.records:write` on the "Primo Care - Client Submissions" base.
Put it in `.env` as `AIRTABLE_API_TOKEN`. The base ID and table name are already filled in
`.env.example` — leave them as-is unless you've renamed things.

## Step 4 — Run it locally to test

```
npm install
npm start
```

Visit `http://localhost:3000` for the intake form and `http://localhost:3000/cancel-reschedule`
for the cancel/reschedule form. Submit a real test booking and confirm it shows up on the
calendar and in Airtable before deploying publicly.

## Step 5 — Deploy publicly

Any Node host works. A simple option:

**Render.com** (free tier available):
1. Push this folder to a GitHub repo.
2. New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add the same environment variables from your `.env` file in Render's dashboard (never commit `.env` itself).
5. Deploy — Render gives you a public URL like `https://primo-care.onrender.com`.

Point clients to `https://<your-domain>/` for the intake form,
`https://<your-domain>/book` for booking (this is what the proposal email links to), and
`https://<your-domain>/cancel-reschedule` for cancellations, or add a custom domain in your
host's settings.

**Pushing updates:** use SSH, not HTTPS/password auth — GitHub rejects password auth outright, and
personal access tokens have been unreliable here. One-time setup: `ssh-keygen -t ed25519 -C "you@example.com"`,
add the public key under GitHub → Settings → SSH and GPG keys, then
`git remote set-url origin git@github.com:<user>/<repo>.git`. After that, `git push` just works —
Render auto-redeploys on every push to `main`. Give the free-tier instance a few seconds to wake up
after a quiet period; the site itself auto-retries failed requests once for this reason (see below).

## Important notes

- **Every client-facing email sends for real, no draft step.** The proposal (from `/api/create-draft` — route name is now a slight misnomer, kept to avoid an unnecessary rename) sends immediately via the real Gmail API (`gmail.users.messages.send`), same as cancel/reschedule confirmations and the billing-statement email sent when staff mark a job Completed. This used to stage a **draft** in `sherkz4781@gmail.com`'s Drafts folder for a human to review first, but that review step was removed by request — the proposal's content is fully computed from the client's own submitted inputs, so there's no separate judgment call left to make before it goes out.
- **No attendee invites.** Bookings never add the client as a calendar attendee, so no Google Calendar invite email goes out automatically — consistent with the original tool.
- **Server-side ID generation and identity checks.** Client ID / Order ID / Transaction ID are generated server-side, never trusted from the browser. Booking on `/book` and cancel/reschedule both require first name, last name, email (and Client ID or Order ID respectively) to all match an existing Airtable record before anything happens — the app never reveals which specific field mismatched.
- **Cold-start auto-retry.** Render's free tier sleeps after ~15 min idle; the first request after that can fail with a network-level error before the container wakes up. Every POST call in `public/index.html` and `public/book.html` retries once automatically after a short delay before surfacing any error to the client.
- **The `48-hour notice` and `auto-Ongoing status` scheduled tasks from the Cowork build are not part of this app.** Those ran as Cowork scheduled tasks against the MCP connectors. If you want the same behavior here, they'd need to become a small recurring job (e.g. a cron-triggered endpoint, or a `node-cron` job inside `server.js`) — ask if you'd like this added.
- **`node_modules/` is disposable.** Don't deploy it — hosts run `npm install` themselves from `package.json`.

## Payments

Every billing statement email includes a **Pay Now** link to `/pay/<Order ID>` — a page where the
client picks how they'll pay:

- **Pay Online** — only shown once Stripe is configured (see below); a real Stripe Checkout
  session for the exact amount due.
- **Cash or Check** — one click records which one the client intends to use. This is just a
  stated intent, not a confirmed payment — `Payment Status` stays `Pending` until a staff member
  actually has the money in hand and clicks **Mark Paid** on `/schedule`.
- **Bank Transfer** — the client uploads a screenshot/photo of their transfer confirmation
  (stored as an Airtable attachment on the order, no separate file host needed). Staff see that
  image right on the "Awaiting Payment" card on `/schedule` before confirming — so Mark Paid there
  means "verified against real proof," not just trusting the client's word.

**Every "Mark Paid" — however the payment arrived — records who confirmed it.** The `Received By`
field is set automatically from whichever staff account is logged in when the button's clicked
(or `"Stripe (automatic)"` for a webhook-confirmed online payment), so there's always a record of
who received a cash or check payment.

### Turning on Stripe (off by default)

Right now the Pay Online option simply doesn't appear — cash/check/bank-transfer still work fully
without it. To add real card payments:

1. Create a [Stripe](https://dashboard.stripe.com) account (or use an existing one).
2. **Dashboard → Developers → API keys** — copy the secret key into `STRIPE_SECRET_KEY` in your
   `.env` (or Render's environment variables). Use the `sk_test_...` key first to try it with
   [Stripe's test card numbers](https://stripe.com/docs/testing) before going live with `sk_live_...`.
3. **Dashboard → Developers → Webhooks → Add endpoint**, pointed at
   `https://<your-domain>/api/stripe/webhook`, listening for the `checkout.session.completed`
   event. Stripe shows a signing secret (`whsec_...`) once the endpoint is created — put that in
   `STRIPE_WEBHOOK_SECRET`.
4. Redeploy. That's it — no code changes. Pay Online now appears on `/pay/<Order ID>`, and a
   successful payment automatically marks the job Paid, mints a Transaction ID, and sends the same
   payment-confirmation email staff's manual Mark Paid sends — Stripe and staff both funnel
   through the identical `markJobPaid()` path in `server.js`.

## AI chat widget (homepage)

A floating chat bubble on `/` answers visitor questions about services, the pricing model, and
policies, and points them to `/intake`, `/book`, or `/cancel-reschedule` for anything actionable —
it never generates a quote, books, or cancels anything itself. It's built, styled, and visible
right now; without a key it just tells visitors it isn't switched on yet instead of erroring.

**This is billed completely separately from any Claude subscription** — it's a pay-per-token API
account, its own payment method, unrelated to a claude.ai plan. To turn it on:

1. Create an account at [console.anthropic.com](https://console.anthropic.com) and add a payment
   method there.
2. Generate an API key and put it in `ANTHROPIC_API_KEY` (`.env` locally, or Render's environment
   variables).
3. Redeploy. No code changes — the widget starts actually replying immediately.

It runs on Haiku (the cheapest model) with a capped reply length, and a built-in per-visitor rate
limit (20 messages/hour) so the endpoint can't be abused into running up a bill. What the assistant
knows — services, pricing model, contact info, cancellation policy — is defined in
`CHAT_SYSTEM_PROMPT` near the bottom of `server.js`; update it there if the business details in
this README ever change.

## Staff & dashboard logins

`/schedule` (job list + calendar) and `/dashboard` (business KPIs) each show a branded Log In
form — username and password, no browser popup — backed by a signed session cookie, role-driven
by a **Members** table in Airtable:

- Go to **`/dashboard/members`** (Admin login required) to add, view, or remove accounts.
- Each member has a Username, Password, Full Name, and Role (`Admin` or `Staff`).
- **Staff** role unlocks `/schedule` only. **Admin** role unlocks both `/schedule` and
  `/dashboard` (including the members page itself, so only admins can manage other accounts).
- Sessions last 12 hours and are cleared with the **Log Out** button in the header. Set
  `SESSION_SECRET` in your environment (any long random string) so logins survive a
  redeploy/restart — without it, the app still works, but a fresh secret is generated on every
  boot and everyone gets logged out.
- **Removing a member or changing their role requires the owner's credentials, entered fresh,
  every time.** Any Admin can view the list or add someone, but clicking Remove or Edit Role
  opens a prompt for an owner username/password that must match a `DASHBOARD_USERS` break-glass
  account — a logged-in Admin's own credentials don't count, even their own. Deliberate extra
  gate on the two actions here that can grant, revoke, or destroy access.
- Passwords are stored in plain text in Airtable, same as the rest of the app's data — this is
  an internal tool, not a security-hardened product, so there's no hashing. Don't reuse a
  password here that matters anywhere else.

**Break-glass fallback (env vars).** `STAFF_USERS` / `STAFF_USERNAME`+`STAFF_PASSWORD` /
`DASHBOARD_USERS` (same `username:password` format as before) still work as always-on accounts,
independent of the Members table — so a misconfigured or emptied Members table, or a brief
Airtable outage, can never lock everyone out. Every break-glass account gets full (Admin-level)
access. Keep at least one set on Render as an emergency account; day-to-day staff should go
through the Members table instead.
