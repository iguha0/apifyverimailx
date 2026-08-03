# Distribution Guide — Platform 4/4: RapidAPI

## What this gives you

A real, monetizable, public HTTP API listed on RapidAPI's marketplace.
Developers worldwide can discover it, subscribe, and call it. You set the
price; RapidAPI handles billing and takes a cut.

## Important context

RapidAPI doesn't run your code — **you** must deploy your own HTTP endpoint
somewhere. The simplest setup: deploy a tiny Express server that forwards
requests to your Apify actor (Platform 1). That gives you:

- Public URL (e.g. `https://email-verifier.onrender.com/verify`)
- OpenAPI spec describing the API
- Pricing tiers you control
- Auth, rate limiting, billing handled by RapidAPI

This guide walks through deploying it on **Render** (free tier, no credit card).

---

## Architecture

```
   RapidAPI Hub (marketplace + auth + billing)
              │
              │  authenticated request with subscriber's key
              ▼
   https://your-app.onrender.com/verify
              │
              │  internal call (synchronous, no extra hop in latency — same server runs it)
              ▼
       email-verifier logic (src/main.js)
              │
              ▼
       JSON response
```

---

## Part 1 — Wrap the actor in a tiny Express server

### Step 1.1 — Initialize a new project alongside your actor

In your parent `work/` folder:
```bash
mkdir email-verifier-api
cd email-verifier-api
npm init -y
npm install express cors
```

### Step 1.2 — Copy the actor logic into the API

You have two options:
- **Option A (recommended): Copy src/main.js** — same code, no re-implementation.
- **Option B: Keep it as a separate npm package**, just `import` from the actor folder.

For simplicity I'll use Option A. Copy the file:
```bash
cp ../email-verifier/src/main.js ./verifier.js
```

### Step 1.3 — Refactor `verifier.js` to expose functions

At the bottom of the copied file, change:
```js
// OLD (top-level):
await Actor.init();
// ... main code ...
```

to:
```js
// NEW — only run when called directly
async function verifyEmails(emails) {
    const results = [];
    for (const email of emails) {
        try { results.push(await verifyEmail(email)); }
        catch (err) { results.push({ email, overall: 'error', error: err.message }); }
    }
    return results;
}

// If someone runs this file directly, do the original main()
if (import.meta.url === `file://${process.argv[1]}`) {
    // keep the original main() body here
    main().catch(...);
}

export { verifyEmails, verifyEmail };
```

### Step 1.4 — Write the Express server (`server.js`)

```javascript
import express from 'express';
import cors from 'cors';
import { verifyEmails } from './verifier.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/', (req, res) => {
    res.json({
        name: 'Email Verifier API',
        version: '1.0.0',
        endpoint: 'POST /verify',
    });
});

// Main endpoint
app.post('/verify', async (req, res) => {
    const { emails } = req.body || {};

    if (!Array.isArray(emails)) {
        return res.status(400).json({ error: 'Body must be { emails: string[] }' });
    }
    if (emails.length === 0) {
        return res.status(400).json({ error: 'emails array cannot be empty' });
    }
    if (emails.length > 100) {
        return res.status(400).json({ error: 'Max 100 emails per request' });
    }

    try {
        const results = await verifyEmails(emails);
        res.json({ count: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Email Verifier API listening on :${PORT}`));
```

### Step 1.5 — Test locally

```bash
node server.js &
curl -X POST http://localhost:3000/verify \
  -H "Content-Type: application/json" \
  -d '{"emails":["[email protected]","broken-email"]}'
```

Expected response shape:
```json
{
  "count": 2,
  "results": [
    { "email": "[email protected]", "syntax": {...}, "mx": {...}, "smtp": {...}, "overall": "unknown" },
    { "email": "broken-email", "syntax": {...}, "overall": "invalid" }
  ]
}
```

Stop the server when done: `jobs -p` then `kill <pid>` (in Git Bash), or just Ctrl+C.

---

## Part 2 — Deploy to Render

### Step 2.1 — Sign up
Go to https://render.com → sign up with GitHub (recommended) or email.

### Step 2.2 — Push the API to GitHub
```bash
cd email-verifier-api
git init
git add .
git commit -m "Initial commit"
gh repo create email-verifier-api --public --source=. --remote=origin --push
```
(If you don't have `gh`: create the repo at https://github.com/new and `git remote add origin https://github.com/YOU/email-verifier-api.git && git push -u origin main`.)

### Step 2.3 — Connect Render to GitHub
- Render dashboard → **New +** → **Web Service**
- Pick your `email-verifier-api` repo
- **Environment:** Node
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Instance type:** Free
- Click **Create Web Service**

Wait ~2 min. Render assigns a URL like `https://email-verifier-api.onrender.com`.

### Step 2.4 — Sanity test the deployed API
```bash
curl -X POST https://email-verifier-api.onrender.com/verify \
  -H "Content-Type: application/json" \
  -d '{"emails":["[email protected]"]}'
```

If you get a result, you're good. The free tier sleeps after 15 min of inactivity — first request after a sleep takes ~30s to wake up.

---

## Part 3 — Write the OpenAPI spec

Save `openapi.yaml` in your `email-verifier-api/` folder:
```yaml
openapi: 3.0.3
info:
  title: Email Verifier API
  description: |
    Validates email addresses through regex, DNS/MX lookup, and simulated SMTP handshake.
    Returns per-email verdict (valid, invalid, unknown) plus MX records and SMTP dialog.
  version: 1.0.0
  contact:
    name: Your name / company
    email: you@example.com

servers:
  - url: https://email-verifier-api.onrender.com
    description: Production

paths:
  /verify:
    post:
      summary: Verify a batch of email addresses
      operationId: verifyEmails
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [emails]
              properties:
                emails:
                  type: array
                  minItems: 1
                  maxItems: 100
                  items:
                    type: string
                    format: email
                    example: "[email protected]"
      responses:
        '200':
          description: Per-email verification results
          content:
            application/json:
              schema:
                type: object
                properties:
                  count:
                    type: integer
                  results:
                    type: array
                    items:
                      $ref: '#/components/schemas/VerificationResult'
        '400':
          description: Bad input
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '500':
          description: Server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

components:
  schemas:
    VerificationResult:
      type: object
      properties:
        email: { type: string }
        overall:
          type: string
          enum: [valid, invalid, unknown, error]
        syntax:
          type: object
          properties:
            passed: { type: boolean }
            value: { type: string }
        mx:
          type: object
          properties:
            passed: { type: boolean }
            domain: { type: string }
            records:
              type: array
              items:
                type: object
                properties:
                  exchange: { type: string }
                  priority: { type: integer }
        smtp:
          type: object
          properties:
            passed: { type: boolean }
            rejectionCode: { type: integer, nullable: true }
            error: { type: string, nullable: true }
        checkedAt: { type: string, format: date-time }
    Error:
      type: object
      properties:
        error: { type: string }
```

---

## Part 4 — Submit to RapidAPI

### Step 4.1 — Sign up as a provider
Go to https://rapidapi.com/provider → **Sign up** (free).

### Step 4.2 — Add your API
- Click **Add a New API** (or **My APIs** → **Add New**).
- **API Name:** "Email Verifier"
- **Short description:** "Validate emails via regex, DNS/MX, and SMTP handshake."
- **Category:** Tools or Developer Tools
- **Base URL:** `https://email-verifier-api.onrender.com`

### Step 4.3 — Upload the OpenAPI spec
- RapidAPI asks for endpoints + parameters. Either:
  - Paste in the UI (define `/verify`, POST, body schema manually), OR
  - Upload your `openapi.yaml` (this is faster and less error-prone).

### Step 4.4 — Define pricing
RapidAPI offers pricing models:
- **Free tier** — N free calls/month, then paid.
- **Paid per call** — set a price like $0.002/call.
- **Monthly subscription** — flat fee for unlimited.

Recommended for getting started:
```
Basic (Free):   100 calls/month
Pro ($9.99/mo): 10,000 calls/month
Ultra ($49.99/mo): unlimited
```
Plus a **metered** option: $0.001 per call over the limit.

### Step 4.5 — Test
RapidAPI gives you a "Test Endpoint" console in your dashboard. Run a sample `/verify` call. Confirm:
- Status 200
- Body shape matches your schema
- Latency is reasonable (first call after Render sleep = ~30s; subsequent = ~5s)

### Step 4.6 — Submit for review
Click **Submit for Review**. RapidAPI's verification team:
- Tests your endpoint
- Validates the OpenAPI spec
- Approves within 1–3 business days

You may get feedback like "your API description is too short" — fix and resubmit, takes minutes.

---

## Part 5 — Once approved

Your API now appears in https://rapidapi.com/hub under "Email Verifier" (or whatever you named it).

### What subscribers see

```
+--------------------------------------+
| Email Verifier                  ★ 4.2 |
+--------------------------------------+
| Provider: Your Name                  |
| Base URL: rapidapi.com/...           |
| Pricing: Free / Pro $9.99 / Ultra $49|
+--------------------------------------+
| Try it now [input emails here]       |
| [Send Request]                       |
+--------------------------------------+
| Response:                            |
| { "count": 1, "results": [...] }     |
+--------------------------------------+
```

### Marketing it

- Share the link on Twitter, Reddit r/SideProject, IndieHackers.
- Add a link to the README of your actor (already in the zip).
- Cross-promote from your Apify actor page.

---

## Pricing reality check

| Plan | Calls/mo | Price | Your net (≈80% after RapidAPI's cut) |
|---|---:|---:|---:|
| Free | 100 | $0 | $0 |
| Pro | 10,000 | $9.99 | ~$8 |
| Ultra | unlimited | $49.99 | ~$40 |

A few dozen paying customers in different tiers → $200–$1,000/mo.
Email-verification APIs consistently rank in RapidAPI's top 50 utilities — there is real demand.

---

## Optional: harden for production

Once you have paying customers, you'll want to:
- Move off Render's free tier (cold starts kill users)
- Add per-key rate limiting (RapidAPI sends an `X-RapidAPI-Key` header you can rate-limit on)
- Add a database to log usage for debugging
- Consider switching to **Apify** as the backend instead of running the SMTP code in-process (cheaper at scale, since Apify charges per compute second and can run many concurrent jobs).

But for the launch? Render free + Apify fallback = $0 to try.

---

## See also

- **Platform 1**: Apify webhook (you can skip the Express server if you want and just proxy calls through Apify's `run-sync` URL)
- **Platform 2** / **3**: Zapier / Make for users who don't want to call APIs directly
