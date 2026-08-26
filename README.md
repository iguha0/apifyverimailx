# 📧 Email Verifier — Bulk Email Validation on Apify

**Validate thousands of email addresses per run with 99.9% accuracy — at $0.30 per 1,000 validations, the cheapest email verification on the Apify marketplace.**

Powered by [Verimailx](https://api.verimailx.com) and wrapped as a plug-and-play Apify Actor. No SMTP servers to maintain, no MX lookups to debug, no proxies to manage. Just hand it a list of emails, hit Run, and get a clean, structured verdict per address in your dataset.

---

## Why Email Verifier?

| | |
|---|---|
| 🎯 **Accuracy** | 99.9% across valid, invalid, and catch-all detection |
| 💸 **Price** | $0.30 / 1,000 validations — cheapest on Apify |
| ⚡ **Throughput** | Asynchronous jobs — submit the whole list at once, no size ceiling |
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

> **Running without credentials.** If `APIFY-VERIMAILX-API-KEY` isn't configured, the Actor performs **syntax checks only**, marks every record with `validationMode: "syntax-only"` and a `warning` field, returns `null` for MX / SMTP / disposable / role-based, and **charges nothing**. You are never billed for a check that wasn't performed.

Each address gets one of these verdicts:

| Verdict | Meaning |
|---|---|
| **`valid`** | Safe to send. Mailbox exists and accepts mail. |
| **`invalid`** | Will bounce. Bad syntax, no MX, or SMTP explicitly rejected. |
| **`risky`** | May be disposable, role-based, or catch-all. Treat with caution. |
| **`unknown`** | Server timeout or ambiguous response. Retry later. |

---

## Input — four ways to hand over your list

Give the Actor addresses in whichever form you already have them. Sources can be combined; everything is merged and de-duplicated before verification.

### A pasted list

```json
{
  "emails": ["founder@stripe.com", "sales@shopify.com", "info@example.com"]
}
```

### A single address

```json
{ "email": "founder@stripe.com" }
```

### A CSV or TXT file

Point the Actor at a public link — a Google Sheets CSV export, an S3 object, a Dropbox direct link. Every address in the file is picked up no matter which column it sits in, so you can upload your export untouched. Maximum 10 MB.

```json
{ "emailFileUrl": "https://example.com/leads-export.csv" }
```

### The output of another Actor

Chain this straight onto a scraper without exporting anything in between.

```json
{ "datasetId": "aBcDeF123456", "datasetField": "email" }
```

Leave `datasetField` out and every text field on each record is scanned for addresses.

No proxy config and no schema to learn. The Actor reads the Verimailx API key from its environment — set once in the Apify console.

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
    "roleBased":  false,
    "catchAll":   false
  },
  "checkedAt": "2026-08-09T10:14:22.418Z"
}
```

### Output fields

| Field | Type | Description |
|---|---|---|
| `email` | string | The address you submitted |
| `overall` | string | `valid` / `invalid` / `risky` / `unknown` / `error` |
| `result` | string | Raw Verimailx verdict, passed through unchanged (`valid`, `invalid`, `catch_all`, `unknown`, …) |
| `deliverabilityScore` | number | 0–100 confidence score from Verimailx (null in syntax-only mode) |
| `validationMode` | string | `full` when Verimailx was called, `syntax-only` when only local RFC checks ran |
| `syntax.passed` | bool | RFC-compliant structure |
| `mx.passed` | bool / null | Domain has usable MX records (null in syntax-only mode) |
| `mx.records` | array | Sorted MX records (lowest priority first) |
| `smtp.passed` | bool / null | Receiving server confirmed the address (null in syntax-only mode) |
| `flags.disposable` | bool / null | Throwaway / temp-mail provider |
| `flags.roleBased` | bool / null | Generic role (info@, support@, admin@) |
| `flags.dnsValid` | bool / null | Domain resolves in DNS |
| `flags.catchAll` | bool / null | Domain accepts mail for any address |
| `raw` | object | The results-file row exactly as returned, so no column is lost |
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

> You pay per address verified. Apify's platform fee (20%) is included in the per-email rate, and a job that fails on the verification side is refunded automatically.

### How the price compares

| Service | Per 1,000 validations |
|---|---:|
| **Email Verifier (this Actor)** | **$0.30** |
| ZeroBounce | $1.50 – $4.00 |
| NeverBounce | $0.80 – $2.00 |
| Hunter | $1.00 |
| Snovio | $0.50 |

Competitor rates are list prices at the time of writing and change over time — check them before you switch.

---

## How to use it

### Option 1 — Apify Console (no code)

1. Open the [Actor](https://apify.com/cold_email_master/bulk-email-verifier-validator) in your browser.
2. Paste your list, or drop in a link to your CSV.
3. Click **Start**.
4. Wait for the run to finish — the log shows live progress (see [How long a run takes](#how-long-a-run-takes)).
5. Download the results as CSV or JSON from the **Output** tab.

### Option 2 — Apify API (sync run, single HTTP call)

```bash
curl -X POST \
  "https://api.apify.com/v2/acts/cold_email_master~bulk-email-verifier-validator/run-sync-get-dataset-items?token=<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"emails":["founder@stripe.com","sales@shopify.com"]}'
```

You'll get the verified records back in one HTTP response.

### Option 3 — Apify API client (Node.js)

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: '<your-token>' });

const run = await client.actor('cold_email_master/bulk-email-verifier-validator').call({
  emailFileUrl: 'https://example.com/leads-export.csv'
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items);
```

---

## How long a run takes

Verification is **asynchronous**. The Actor submits your whole list as one job, the verification service works through it server-side, and the Actor polls until it finishes — nothing holds a connection open, so there is no request-size ceiling and no batching to think about.

Throughput depends on the list: addresses at fast, well-known providers resolve quickly, while slow or dead domains have to time out. Watch the progress line in the log:

```
INFO Job 8f1c…c92 accepted: 5000 address(es), 5000 credit(s) reserved, 20000 remaining.
INFO Verifying… 34% (1700/5000)
```

**Set the run timeout to cover the job.** Apify's default is 300 seconds. The Actor waits for a job for up to six hours, but the run's own timeout is the real limit — raise it in the run options before starting a large list.

Credits are reserved when the job is submitted and **refunded automatically if the job fails**, so a failed job costs you nothing.

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

**Q: How do I verify a CSV of emails?**
A: Upload the CSV somewhere with a public link — a Google Sheets CSV export or an S3 object both work — and pass that link as `emailFileUrl`. Every address in the file is picked up regardless of which column holds it, so there's no need to reshape your export first. Files up to 10 MB.

**Q: Does this Actor send any email?**
A: No. Verification stops at the SMTP handshake, which asks the receiving server whether the mailbox exists without ever delivering a message. Nobody on your list is contacted.

**Q: Can I run it on the output of a scraper?**
A: Yes — pass the scraper run's `datasetId` and the Actor reads the addresses straight out of it, no export step in between.

---

## Support

- **Issues with this Actor:** open an issue in this repository
- **Bulk pricing (100k+ emails):** contact us through Apify messaging
- **Verimailx API questions:** see [api.verimailx.com](https://api.verimailx.com)

---

## Changelog

### 0.1.0 — Asynchronous verification
- Rewritten for the async bulk API. The Actor now submits the entire list in one request, receives a `job_id`, polls for progress, and downloads the signed results file when the job completes. **All batching, splitting and retry logic is gone** — it existed only to dodge the old 150-second gateway timeout, which no longer applies.
- Live progress is logged as the job runs.
- Credits are reserved at submission and refunded by the service if a job fails.
- `catch_all`, `disposable` and `role_based` now map to **risky**. An address behind a catch-all domain cannot be confirmed, and that is the distinction that decides whether it is safe to send to.
- Each record now carries a `raw` field holding the results-file row exactly as returned, so no column is lost.
- The `batchSize` input is removed; it no longer means anything.

### 0.0.7 — Batch sizing and error handling
- Batches are now **20 addresses** by default, not 1,000. The verification service drops any single request idle for 150 seconds, and at ~5s per address a 1,000-address request could never complete — it returned `504 IDLE_TIMEOUT` every time. A `batchSize` input allows up to 40.
- Requests carry a 140-second client-side timeout, and a batch that times out is **split in half and retried** instead of failing outright.
- Error records now carry the same field shape as every other record. Previously they were rejected by the dataset schema, which threw mid-run and discarded every result gathered up to that point.
- A run where nothing could be verified now **fails** instead of reporting success with an empty dataset.
- Every dataset write is guarded, so one rejected record can no longer end the run.
- README run-time expectations corrected: the old "5–30 seconds per 1,000 emails" claim was wrong by three orders of magnitude.

### 0.0.6 — Input flexibility and honest billing
- Added three new ways to supply addresses: a single `email`, a link to a CSV or TXT file (`emailFileUrl`), and an existing Apify dataset (`datasetId` / `datasetField`). Sources can be combined and are de-duplicated together.
- The Actor now charges the **Email Verified** event for each address that reaches a real verdict. Previously the event was defined but never fired, so full verifications were delivered without being billed.
- Syntax-only runs (no API key configured) and failed batches are explicitly **not charged**, and syntax-only records carry a `warning` field saying which checks were skipped.
- Empty input now fails with a message naming the four accepted input fields instead of exiting quietly.

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
