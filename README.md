# Email Verifier — Apify Actor

Validates email addresses using three checks, in order:

1. **Regex syntax check** — local-part + domain structure
2. **DNS MX record lookup** — does the domain accept email?
3. **Simulated SMTP handshake** — dial the primary MX server, send `EHLO` → `MAIL FROM` → `RCPT TO` → `QUIT`, capture every server reply

## Input

```json
{
  "emails": [
    "user@example.com",
    "another@domain.org"
  ]
}
```

| Field   | Type            | Required | Description                              |
|---------|-----------------|----------|------------------------------------------|
| emails  | array of string | yes      | List of email addresses to verify.       |

## Output (per email, pushed to dataset)

```json
{
  "email": "user@gmail.com",
  "syntax": { "passed": true, "value": "user@gmail.com" },
  "mx": {
    "passed": true,
    "domain": "gmail.com",
    "records": [
      { "exchange": "gmail-smtp-in.l.google.com", "priority": 5 }
    ]
  },
  "smtp": {
    "passed": false,
    "steps": [
      { "step": "connect", "sent": null, "response": "220 ..." },
      { "step": "ehlo",    "sent": "EHLO email-verifier.local", "response": "250 ..." },
      { "step": "mail_from","sent": "MAIL FROM:<verifier@email-verifier.local>", "response": "250 2.1.0 Ok" },
      { "step": "rcpt_to", "sent": "RCPT TO:<user@gmail.com>", "response": "454 4.7.1 Relay access denied" }
    ],
    "rejectionCode": 454,
    "error": "SMTP rejected recipient (code 454)."
  },
  "overall": "invalid",
  "checkedAt": "2026-07-19T06:52:11.737Z"
}
```

### Overall verdict

| Verdict   | Condition                                                                            |
|-----------|--------------------------------------------------------------------------------------|
| `valid`   | Syntax ✓, MX ✓, **SMTP explicitly accepted** the recipient                            |
| `invalid` | Any of: bad syntax, no MX records, SMTP replied 5xx (recipient rejected), input error |
| `unknown` | Syntax + MX pass, but SMTP timed out, returned a 4xx (transient), or errored          |

Most real-world mail servers (Gmail, Outlook, Yahoo, corporate) reject
unauthenticated probes with `4xx Relay access denied` — so `unknown` is
the **most common production outcome** for legitimate-looking addresses.
This is by design: the SMTP step is best treated as "did the server
respond sensibly", not a definitive deliverability verdict.

## Local development

```bash
npm install
node test.js              # run unit tests (syntax)
node src/main.js          # run the actor
```

The actor reads from `storage/key_value_stores/default/INPUT.json` when
running locally and writes per-email results to `storage/datasets/default/`.

## Deploy to Apify

```bash
npx apify-cli login
npx apify-cli push
```

## Project structure

```
email-verifier/
├── .actor/
│   ├── actor.json          Apify actor metadata
│   └── INPUT_SCHEMA.json   UI input schema
├── src/
│   └── main.js             Entry point
├── storage/                Local emulator of Apify storage (input + dataset)
├── test.js                 Unit tests for the syntax checker
├── Dockerfile              Build recipe for Apify platform
├── package.json
└── README.md
```

## Timeouts

| Stage         | Timeout | Notes                                       |
|---------------|--------:|---------------------------------------------|
| DNS MX lookup |  5 000ms| Hard race against dns.resolveMx             |
| SMTP handshake|  8 000ms| Whole handshake from connect to QUIT        |
| SMTP buffer   | 64 KB   | Hard cap to prevent unbounded reply growth  |

## Limitations

- SMTP is best-effort. Many mail providers (Gmail, Outlook, Yahoo, etc.)
  block unauthenticated probes by design.
- Does not handle IP-literal domains (`user@[2001:db8::1]`).
- Does not check whether the local-part matches mailbox naming rules
  (e.g. `info@`, `abuse@`, postmaster conventions).
- For authoritative deliverability checks, pair this with a service like
  ZeroBounce, NeverBounce, or Hunter.
