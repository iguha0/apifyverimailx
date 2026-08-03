# Distribution Guide — Platform 1/4: Apify Webhook (HTTP Sync Run)

## What this is

Apify can be used as the backend HTTP API for everything else in this guide.
You do **not** need a separate server — Apify gives you a public URL you can
call from Zapier, Make, RapidAPI, or any other system.

The flow:

```
   Zapier / Make / your-app / curl
              │ POST
              ▼
   https://api.apify.com/v2/acts/<your-username>~email-verifier/run-sync?token=<token>
              │
              ▼
      Apify cloud
        starts the actor
        runs the checks
        returns the dataset JSON
              │
              ▼
         JSON response
   { "items": [ {email, syntax, mx, smtp, overall}, ... ] }
```

## Why "run-sync" instead of just "run"

| Endpoint | Behavior |
|---|---|
| `/runs`              | Kicks off run, returns immediately with a run id — you have to poll for completion. |
| `/run-sync`          | Blocks for up to ~5 minutes, returns the dataset when done. |
| `/run-sync-get-dataset-items` | Same, but waits an even longer max. |

Use `/run-sync`. The full result is in one HTTP call.

---

## Step-by-step

### Step 1 — Push the actor to Apify

```bash
cd "C:/Users/User/OneDrive/Desktop/work/email-verifier"
npx apify-cli login
npx apify-cli push
```

After push succeeds, your actor's full ID looks like:
`YOUR_USERNAME~email-verifier` (or similar with random suffix).

Confirm it on https://console.apify.com/actors.

### Step 2 — Build the request URL

Template:
```
https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync?token=<API_TOKEN>
```

Where:
- `<ACTOR_ID>` = the slug of the pushed actor, e.g. `johndoe~email-verifier`
- `<API_TOKEN>` = your Personal API token (Settings → Integrations)

### Step 3 — Call it with curl (sanity check)

```bash
curl -X POST "https://api.apify.com/v2/acts/YOUR_USERNAME~email-verifier/run-sync?token=YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"emails":["[email protected]","broken-email"]}'
```

You'll get back:
```json
{
  "data": {
    "items": [
      { "email": "[email protected]", "syntax": {...}, "mx": {...}, "smtp": {...}, "overall": "unknown", ... },
      { "email": "broken-email", "syntax": {...}, "overall": "invalid", ... }
    ]
  }
}
```

If you get an error, check:
- HTTP 401 → wrong token
- HTTP 404 → wrong actor ID
- HTTP 400 → malformed JSON

### Step 4 — Use this URL in Zapier / Make / anywhere

The same URL accepts:
- `application/json` body with `{ "emails": [...] }`
- Optional `?timeout=60` query parameter (default 30s)
- Optional `?memory=512` to scale up for big batches

### Step 5 — Lock it down (recommended)

For production:
- Create a **dedicated token** in console (Settings → Integrations → New token).
- Scope it to the email-verifier actor only — even if leaked, useless for the rest of your account.

---

## Cost reference

- Each `/run-sync` call charges for actor compute time.
- For ~10 emails × ~30s SMTP timeouts worst case = a few seconds of compute.
- Apify's free tier gives you ~$5/month — enough for ~1000 single-email verifications.

## Use this URL with...

- Platform 2 (Zapier) — paste into the Webhooks app
- Platform 3 (Make.com) — paste into the HTTP module
- Platform 4 (RapidAPI) — use as the backend proxy
