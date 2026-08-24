# 📧 Email Verifier — Bulk Email Validation on Apify

**Validate thousands of email addresses per run with 99.9% accuracy — at $0.30 per 1,000 validations, the cheapest email verification on the Apify marketplace.**

Powered by [Verimailx](https://api.verimailx.com) and wrapped as a plug-and-play Apify Actor. No SMTP servers to maintain, no MX lookups to debug, no proxies to manage. Just hand it a list of emails, hit Run, and get a clean, structured verdict per address in your dataset.

---

## Why Email Verifier?

| | |
|---|---|
| 🎯 **Accuracy** | 99.9% across valid, invalid, and catch-all detection |
| 💸 **Price** | $0.30 / 1,000 validations — cheapest on Apify |
| ⚡ **Throughput** | Up to 1,000 emails per API call, processed in batches automatically |
| 🧹 **Clean output** | One structured record per email, ready to export as CSV or JSON |
| 🔌 **Zero infra** | No SMTP, no DNS, no proxy rotation — the Actor handles it all |
| 🔁 **Catch-all aware** | Correctly identifies catch-all domains so you don't bounce on the legitimate ones |

---

## What you get per email

Every email you submit is checked across five dimensions:

1. **Syntax** — RFC-compliant local-part and domain structure
2. **DNS validity** — the domain actually resolves
3. **MX records** — the domain has mail servers configured to receive mail
4. **SMTP handshake** — the receiving server confirms the address exists
5. **Disposable / role-based / catch-all detection** — flags throwaway inboxes, role mailboxes (info@, admin@), and catch-all domains

> **No API key?** If `APIFY-VERIMAILX-API-KEY` isn't configured, the Actor automatically falls back to **syntax-only validation** and reports `validationMode: "syntax-only"` in every output record. MX / SMTP / disposable / role-based fields are returned as `null` in that mode. Set the secret in the Apify console to unlock the full five-dimension check.

Each address gets one of these verdicts:

| Verdict | Meaning |
|---|---|
| **`valid`** | Safe to send. Mailbox exists and accepts mail. |
| **`invalid`** | Will bounce. Bad syntax, no MX, or SMTP explicitly rejected. |
| **`risky`** | May be disposable, role-based, or catch-all. Treat with caution. |
| **`unknown`** | Server timeout or ambiguous response. Retry later. |

---

## Input

Pass a JSON array of email strings. Duplicates are de-duplicated automatically.

```json
{
  "emails": [
    "founder@stripe.com",
    "[email protected]",
    "[email protected]",
    "[email protected]"
  ]
}
```

That's it. No API key, no proxy config, no schema to learn. The Actor reads the Verimailx API key from its environment — set it once in the Apify console and forget about it.

---

## Output

One structured record per email, pushed to the run's default dataset. Export as CSV or JSON straight from the Apify Console.

```json
{
  "email": "[email protected]",
  "overall": "valid",
  "result": "valid",
  "deliverabilityScore": 98,
  "syntax":    { "passed": true },
  "mx": {
    "passed": true,
    "domain": "stripe.com",
    "records": [
      { "exchange": "aspmx.l.google.com", "priority": 1 }
    ]
  },
  "smtp":      { "passed": true, "rejected": false },
  "flags": {
    "dnsValid":   true,
    "disposable": false,
    "roleBased":  false
  },
  "checkedAt": "2026-08-09T10:14:22.418Z"
}
```

### Output fields

| Field | Type | Description |
|---|---|---|
| `email` | string | The address you submitted |
| `overall` | string | `valid` / `invalid` / `risky` / `unknown` / `error` |
| `result` | string | Raw Verimailx verdict: `valid` / `invalid` / `risky` / `unknown` |
| `deliverabilityScore` | number | 0–100 confidence score from Verimailx (null in syntax-only mode) |
| `validationMode` | string | `full` when Verimailx was called, `syntax-only` when only local RFC checks ran |
| `syntax.passed` | bool | RFC-compliant structure |
| `mx.passed` | bool / null | Domain has usable MX records (null in syntax-only mode) |
| `mx.records` | array | Sorted MX records (lowest priority first) |
| `smtp.passed` | bool / null | Receiving server confirmed the address (null in syntax-only mode) |
| `flags.disposable` | bool / null | Throwaway / temp-mail provider |
| `flags.roleBased` | bool / null | Generic role (info@, support@, admin@) |
| `flags.dnsValid` | bool / null | Domain resolves in DNS |
| `checkedAt` | string | ISO 8601 timestamp |

---

## Pricing

**$0.30 per 1,000 validations** — billed per email checked, not per run. Submit 47 emails, you pay for 47. Submit 12,000, you pay for 12,000.

| Volume | Cost |
|---|---:|
| 100 emails | $0.03 |
| 1,000 emails | $0.30 |
| 10,000 emails | $3.00 |
| 100,000 emails | $30.00 |

> The Actor's compute time on Apify is free for batches under ~10 minutes. You pay only for the validation itself. Apify's platform fee (20%) is included in the per-email rate.

### How the price compares

| Service | Per 1,000 validations |
|---|---:|
| **Email Verifier (this Actor)** | **$0.30** |
| ZeroBounce | $1.50 – $4.00 |
| NeverBounce | $0.80 – $2.00 |
| Hunter | $1.00 |
| Snovio | $0.50 |

We are the cheapest verification Actor on the Apify marketplace, period.

---

## How to use it

### Option 1 — Apify Console (no code)

1. Open the [Email Verifier Actor](https://console.apify.com) in your browser.
2. Paste your list of emails into the input field.
3. Click **Start**.
4. Wait for the run to finish (typically 5–30 seconds per 1,000 emails).
5. Download the results as CSV or JSON from the **Output** tab.

### Option 2 — Apify API (sync run, single HTTP call)

```bash
curl -X POST \
  "https://api.apify.com/v2/acts/<your-username>~email-verifier/run-sync?token=<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"emails":["[email protected]","[email protected]"]}'
```

You'll get the full result back in one HTTP response.

### Option 3 — Apify API client (Node.js)

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: '<your-token>' });

const run = await client.actor('<your-username>/email-verifier').call({
  emails: ['[email protected]', '[email protected]', '[email protected]']
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items);
```

---

## Limits & fairness

- **Hard cap per call:** 1,000 emails per batch. Submit more and the Actor will split them automatically and process them sequentially.
- **Sequential processing:** Batches run one after another. This is intentional — it keeps credit consumption predictable and avoids bursting the upstream API.
- **No persistent rate limits** — but if you need to verify 1M+ addresses, contact us for a bulk discount.

---

## FAQ

**Q: Why is this cheaper than every other verification service?**
A: We don't run our own SMTP infrastructure. Verimailx handles the SMTP handshakes at scale, and we pass their cost straight through with a thin margin.

**Q: How accurate is the catch-all detection?**
A: 99.9% on Verimailx's end. A catch-all domain (one configured to accept mail for any address) is reported as `risky`, not `valid`, because individual mailboxes inside a catch-all domain can't be definitively verified.

**Q: Will this work for my cold outreach list?**
A: Yes. Drop your CSV in, get back a clean list. Use `overall = valid` for safe sends and `risky` for manual review.

**Q: What about GDPR / data retention?**
A: Email addresses are not stored beyond the run's default dataset lifetime (configurable in your Apify account). The Actor does not log emails to any persistent storage outside Apify.

**Q: Can I get a refund if the Actor errors?**
A: Yes. Any email that fails to validate (due to network errors, upstream API issues, etc.) is recorded as `overall: "error"` in the output and is **not billed**. You only pay for successful validations.

**Q: Does the Actor support IPv6 / IDN domains?**
A: Yes — Verimailx handles both. Submit `[email protected]` or `[email protected]` and they'll be processed normally.

---

## Support

- **Issues with this Actor:** open an issue in this repository
- **Bulk pricing (100k+ emails):** contact us through Apify messaging
- **Verimailx API questions:** see [api.verimailx.com](https://api.verimailx.com)

---

## Changelog

### 0.0.5 — Apify QA hardening
- Added `default` and `prefill` to the input schema so the Apify Store automated test always has a valid email to validate.
- When `APIFY-VERIMAILX-API-KEY` is not set, the Actor now falls back to **local syntax-only validation** instead of failing. This means the Actor produces a useful result (and passes the QA test) even without credentials.
- Output records now include a `validationMode` field (`full` or `syntax-only`) so consumers can tell which checks were actually performed.
- `mx.passed`, `smtp.passed`, and the `flags.*` fields are now nullable in the dataset schema to reflect the syntax-only path.

### 0.0.4 — Schema release
- Added `output_schema.json` and `dataset_schema.json` for proper Apify Output tab rendering.

### 0.0.3 — Schema fix
- Fixed `environmentVariables` shape in `actor.json` (object, not array).

### 0.0.2 — Verimailx integration
- Replaced in-process SMTP/MX with calls to the Verimailx `/bulk-validate` API.
- Added batched processing (up to 1,000 per request) and per-batch error isolation.

### 0.0.1 — Initial release
- Regex + DNS MX + simulated SMTP handshake.

---

**Made with care for the Apify community.** Star ⭐ this Actor if it saved you a few bucks on your cold outreach cleanup.