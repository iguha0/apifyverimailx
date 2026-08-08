# Email Verifier — Apify Actor

Validates email addresses by calling the [Verimailx](https://api.verimailx.com) `/bulk-validate` API. Verimailx runs each address through:

1. **Regex syntax check** — local-part + domain structure
2. **DNS MX record lookup** — does the domain accept email?
3. **SMTP validation** — does the mail server accept the address?
4. **Disposable / role-based detection** — flags throwaway and role mailboxes

Emails are sent in batches of up to 1,000 per request, with duplicates de-duplicated before submission.

## Environment variables

| Name                     | Required | Description                                                                                  |
|--------------------------|----------|----------------------------------------------------------------------------------------------|
| `APIFY-VERIMAILX-API-KEY`| yes      | Verimailx API key (starts with `vk_`). Set it in the Apify console under **Secrets**.       |

The actor exits with an error if this variable is missing.

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

The actor exposes a 3-state verdict (`valid` / `invalid` / `unknown`) plus the raw Verimailx result and deliverability score, so consumers can distinguish between risky and unknown if needed:

| Actor `overall` | Verimailx `result` | Notes                                                       |
|-----------------|--------------------|-------------------------------------------------------------|
| `valid`         | `valid`            | Email is deliverable and safe to send.                     |
| `invalid`       | `invalid`          | Email does not exist or cannot receive mail.               |
| `unknown`       | `risky`            | Disposable, role-based, or catch-all — treat with caution. |
| `unknown`       | `unknown`          | Server timeout or ambiguous response.                      |

## Local development

```bash
npm install
APIFY-VERIMAILX-API-KEY=vk_your_api_key node src/main.js   # run the actor locally
```

Set `APIFY-VERIMAILX-API-KEY` in your shell before running. The actor reads from `storage/key_value_stores/default/INPUT.json` when running locally and writes per-email results to `storage/datasets/default/`.

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
