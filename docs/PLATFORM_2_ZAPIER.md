# Distribution Guide — Platform 2/4: Zapier

## What this gives you

A Zap that triggers from anything (Typeform, Gmail, Google Sheets, etc.),
sends emails to your email-verifier, and lets you do something with the
verdicts (log them, email results, push to a CRM, etc.).

No app approval needed. Anyone can build a Zap with the Webhooks app in minutes.

## Before you start

You need:
- A free Zapier account (https://zapier.com)
- The URL from **Platform 1** above (your Apify `run-sync` URL)
- 10 minutes

---

## Step-by-step: "Verify emails submitted via Google Form"

This Zap:
1. Watches a Google Sheet for new rows of email addresses
2. Sends them to the email verifier
3. Writes the verdict back to the same sheet

### Step 1 — Sign in to Zapier and start a Zap

Go to https://zapier.com/app/zaps → click **Create Zap**.

### Step 2 — Pick the trigger app: Google Sheets

- **App:** Google Sheets
- **Event:** New Spreadsheet Row
- **Sign in** to your Google account
- Pick the spreadsheet + worksheet where you'll dump emails
- Zapier will create a "test row" — paste a sample email like `user@example.com` if you have to.

### Step 3 — Add an action: Webhooks by Zapier (POST)

- **App:** Webhooks by Zapier
- **Action:** POST
- **Method:** POST
- **URL:** paste your Apify `run-sync` URL from Platform 1
- **Headers:** leave default
- **Data:** set `Payload Type = JSON`, body:
  ```json
  {
    "emails": ["{{Sheet Row -- email}}"]
  }
  ```
  (Use Zapier's variable picker for `email` from the spreadsheet.)
- **Unflatten:** yes

### Step 4 — Test the action

Click **Test & Continue**. Zapier actually calls your URL.

Expected response:
```json
{
  "data": {
    "items": [
      { "email": "...", "overall": "valid", ... }
    ]
  }
}
```

If it fails:
- 401 → wrong API token (check Apify URL)
- 400 → the JSON body has a typo (Zapier will show payload preview — look for typos)
- timeout → Apify actor took longer than 30s; either reduce email batch or use Platform 4 (RapidAPI) where you control the timeout

### Step 5 — Add an action: Parse the response (Formatter by Zapier)

The response is nested: `data.items[0].overall`.

- **App:** Formatter by Zapier
- **Action:** Text → Extract Pattern, OR use **Code by Zapier** to run JS:
  ```js
  const items = inputData.data.items;
  return items.map(i => ({ email: i.email, overall: i.overall }));
  ```

### Step 6 — Add an action: Write back to Google Sheets

- **App:** Google Sheets
- **Action:** Update Row
- Pick the same spreadsheet / worksheet
- Map the parsed email/verdict into columns

### Step 7 — Name it, turn it on

Name it **"Verify submitted emails"** → flip the toggle to **ON**.

### Step 8 — Test end-to-end

Drop a real email in the sheet. Zap fires within ~5 min (Zapier's polling delay on free plan; 1 min on paid).

---

## Variations

### Variation A — Single email at a time (Typeform → verify → email results)

1. **Trigger:** Typeform → New Entry
2. **Action:** Webhooks POST to Apify `run-sync` with `{"emails": ["{{Typeform -- Email field}}"]}`
3. **Action:** Gmail → Send Email with the verdict

### Variation B — Bulk: form drops 100 emails, Zap processes all of them

- Add **Formatter by Zapier → Utilities → Line-Item Iterator** between Trigger and Webhook.
- Zapier passes each email to your actor one-by-one. (For real bulk, use Platform 4 — RapidAPI — instead, since per-row Zapier runs cost money.)

---

## Common pitfalls

| Pitfall | Fix |
|---|---|
| POST returns 401 | Re-paste the Apify URL with `?token=` |
| Empty `data.items` array | The actor didn't finish in time → check Apify logs |
| Zap fires but writes nothing | Step 5 (Formatter) may have returned empty; test it directly |
| Cost blows up | Each verified email = 1 Zap task. Add a filter on the trigger so bad data doesn't trigger the Zap. |

---

## Monetizing through Zapier

You can't sell directly on Zapier as an "app" without weeks of approval, BUT you can:
- Publish a **Public Zap Template** so others clone your Zap → discoverability
- Drive traffic to your **Apify actor** which is monetized directly

That's the realistic play: Zapier for reach, Apify for revenue.
