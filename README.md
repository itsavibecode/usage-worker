# usage-worker

Cloudflare Worker backend for [itsavibecode/usage](https://github.com/itsavibecode/usage). Runs a daily cron that reads the user's products from Firestore via service account, computes which actives are approaching their average finished lifespan, and emails a digest via Resend.

This is the email-reminders companion to the in-app reorder reminders panel — same algorithm, but pushed to your inbox so you don't have to open the app to know it's time to reorder.

## What it does

- **Daily cron `0 13 * * *`** (13:00 UTC, 8am US Eastern / 9am EDT). Intentionally one hour before stocks-worker's 14:00 cron to spread load.
- Reads `/users/{OWNER_UID}/products/*` from the `product-usage-37f1d` Firebase project.
- For each product type that has at least 2 finished products, computes the mean finished lifespan in days.
- Surfaces active products whose age-since-purchase is at or above 85% of that mean (`REMINDER_THRESHOLD = 0.85`).
- Sorts by ratio descending, caps at 10 reminders per email.
- Sends a single digest email via Resend, but only if the user has opted in (`reorderEmailsEnabled = true` on the prefs doc) and the last reminder email was at least 7 days ago.
- Records the send on the prefs doc so we don't spam the user when reminders persist.

## Endpoints

| Method | Path | Headers | Returns |
|---|---|---|---|
| `POST` | `/trigger` | `x-trigger-key: <MANUAL_TRIGGER_KEY>` | `{ok, sent, to, resendId, count}` — manually fires the cron logic without waiting for 13:00 UTC |
| `GET` | `/` | — | `{ok: true, name: "usage-worker", version, cron}` |

The `/trigger` endpoint is optional — only enabled if you set the `MANUAL_TRIGGER_KEY` secret. Useful for verifying wiring after deploy.

## Required vars and secrets

Vars (in `wrangler.toml`, public):
- `FIREBASE_PROJECT_ID = "product-usage-37f1d"`
- `OWNER_UID` — your Firebase UID for the usage-tracker app (Firebase console → Authentication → Users → User UID column). **Must be filled in before deploy.**
- `SENDER_FROM = "Usage Tracker <usage@stocks.bookhockeys.com>"` — reuses the verified `stocks.bookhockeys.com` domain on Resend so we don't need a second domain verification.

Secrets (set via `wrangler secret put`, never committed):
- `FIREBASE_SERVICE_ACCOUNT_JSON` — full service account JSON for the `product-usage-37f1d` project (different project than stocks; you'll need a new service account here).
- `RESEND_API_KEY` — same Resend key as stocks-worker (single Resend account, free tier covers 100/day combined).
- `MANUAL_TRIGGER_KEY` — optional random string for the `/trigger` endpoint.

## Setup (one-time)

```bash
# in this folder
npm install
wrangler login           # if not already

# replace OWNER_UID in wrangler.toml first
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
wrangler secret put RESEND_API_KEY
wrangler secret put MANUAL_TRIGGER_KEY    # optional
wrangler deploy
```

`wrangler secret put` opens an interactive stdin prompt — paste the secret directly. Secrets never appear in source, in chat, or on disk outside Cloudflare's encrypted secret store.

To get the service account JSON: Firebase console for `product-usage-37f1d` → Project settings → Service accounts → Generate new private key. Paste the entire contents of the downloaded file into the `wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON` prompt.

## Verifying the deploy

```bash
# Smoke test the info endpoint
curl https://usage-worker.<your-account>.workers.dev/

# Manually fire the cron logic (requires MANUAL_TRIGGER_KEY)
curl -X POST -H "x-trigger-key: <key>" https://usage-worker.<your-account>.workers.dev/trigger
```

A successful trigger returns either `{ok: true, sent: true, ...}` (email went out) or `{ok: true, sent: false, reason: "..."}` (one of: not opted in, no qualifying reminders, cooldown, no email on file).

`wrangler tail` streams logs in real time if you want to watch the next cron run.

## User prefs doc shape

The worker reads (and writes back) `/users/{OWNER_UID}/meta/emailPrefs`:

```json
{
  "reorderEmailsEnabled": true,
  "notifyEmail": "you@example.com",
  "lastReorderEmailSentAt": "2026-05-03T13:00:14.000Z",
  "lastReorderEmailRecipientCount": 4,
  "lastResendId": "..."
}
```

- `reorderEmailsEnabled` — master switch. The cron does nothing if this is `false` or missing.
- `notifyEmail` — optional override. If unset, the worker falls back to the email on the Firebase auth user via Identity Toolkit lookup.
- `lastReorderEmailSentAt` — written by the worker. Drives the 7-day cooldown so persistent reminders don't spam daily.
- `lastReorderEmailRecipientCount` / `lastResendId` — written by the worker, useful for debugging.

The in-app UI (v0.16.0+) writes the first two fields when the user toggles the preference and saves an email address.

## Why a worker

GitHub Pages can't run a daily cron and can't keep a Resend API key private. Cloudflare Workers run on a free-tier cron schedule and store secrets in an encrypted runtime env. The same pattern as stocks-worker — separate worker so the two projects' cron logic and prefs stay independent.

## Free-tier ceilings

- Cloudflare Workers: 100k requests/day combined across all workers on the account. A daily cron is 1 request/day; comfortable.
- Resend: 100 emails/day, 3000/month, 1 verified domain (multiple from-addresses per domain). We send at most one digest/day per user.
