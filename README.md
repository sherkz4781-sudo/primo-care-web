# Primo Care Web — public, self-serve intake & booking

This is a standalone version of the Primo Care Cowork tool, rebuilt so it can be deployed to a
real public URL. Clients fill out the intake form themselves; it books directly on the real
Google Calendar, logs to the real Airtable base, and emails the client a proposal — no Cowork
session or human in the loop required for a normal booking.

It replaces the Cowork MCP connectors (`window.cowork.callMcpTool`) with direct API calls:
Google Calendar + Gmail via OAuth2 (`googleapis`), and Airtable via its REST API.

**Two pages:**
- `/` — intake, live pricing, proposal, booking
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

Point clients to `https://<your-domain>/` for the intake form and
`https://<your-domain>/cancel-reschedule` for cancellations, or add a custom domain in your
host's settings.

## Important notes

- **Draft emails, not auto-send.** Unlike the Cowork MCP Gmail connector (which had no send capability at all), this app uses the real Gmail API — which *can* send directly. It's currently wired to only create a **draft** in `sherkz4781@gmail.com`'s Drafts folder, matching the safe default used throughout this whole project. If you want it to send the proposal/reminder emails automatically without review, that's a small change in `lib/google.js` (`createGmailDraft` → `gmail.users.messages.send`) — flag it and it can be flipped once you've tested the app for a while.
- **No attendee invites.** Bookings never add the client as a calendar attendee, so no Google Calendar invite email goes out automatically — consistent with the original tool.
- **Server-side ID generation.** Client ID / Order ID / Transaction ID are now generated server-side (`/api/submit`), not in the browser, so they can't be spoofed by a client-side request.
- **Identity verification for cancel/reschedule.** A client must supply first name, last name, email, and Order ID that all match an existing Airtable record — a guessed Order ID alone can't touch someone else's booking, and the app never reveals which specific field mismatched.
- **The `48-hour notice` and `auto-Ongoing status` scheduled tasks from the Cowork build are not part of this app.** Those ran as Cowork scheduled tasks against the MCP connectors. If you want the same behavior here, they'd need to become a small recurring job (e.g. a cron-triggered endpoint, or a `node-cron` job inside `server.js`) — ask if you'd like this added.
- **`node_modules/` is disposable.** Don't deploy it — hosts run `npm install` themselves from `package.json`.
