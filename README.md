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

## Staff logins

`/staff` (job list + calendar) and `/dashboard` (business KPIs) are separate HTTP Basic
Auth logins — a staff account does **not** also unlock the dashboard, and vice versa. There's no
link between the two pages by design, since they're meant for different audiences.

- **`STAFF_USERS`** — comma-separated `username:password` pairs, one per staff member:
  `STAFF_USERS=alice:sOmEpAsS,bob:anotherPass`. To add or remove someone, edit this value in
  Render's environment variables and redeploy (Render → your service → Environment).
- **`DASHBOARD_USERS`** — same format, for whoever should see `/dashboard`. Keep this list
  short (owner/manager only) since it's business-wide revenue and lead data.
- **`STAFF_USERNAME`/`STAFF_PASSWORD`** — the original single-account variables still work if
  set, in addition to `STAFF_USERS`, so existing setups don't break.

There's no in-app UI for managing these — they're plain env vars, not stored in Airtable, so
adding a staff member always means a Render env var edit + redeploy.
