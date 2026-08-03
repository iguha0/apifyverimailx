# Distributing the Email Verifier — Platform Guides

This folder has step-by-step guides for putting the email-verifier actor on four platforms.

| # | Platform | Effort | Best for |
|---|---|---|---|
| 1 | [Apify Webhook](PLATFORM_1_APIFY_WEBHOOK.md) | Done (5 min) | Anyone with an Apify account; foundation for the others |
| 2 | [Zapier](PLATFORM_2_ZAPIER.md) | 30 min | Non-technical users, GUI workflow builders |
| 3 | [Make.com](PLATFORM_3_MAKE.md) | 30 min | Larger batches, parallel workflows, error handling |
| 4 | [RapidAPI](PLATFORM_4_RAPIDAPI.md) | Half-day | Public marketplace listing, monetization |

## Recommended order

1. **Start with Platform 1** — without it, none of the others can talk to the actor.
2. **Add Platform 2** if you want a Zapier demo for colleagues.
3. **Add Platform 3** if you need batch / parallel processing with proper error handling.
4. **Add Platform 4** if you want to monetize publicly on RapidAPI's developer marketplace.

## The shared backend

Platforms 2, 3, and 4 all reach the actor via the same URL exposed by Platform 1:

```
POST https://api.apify.com/v2/acts/<YOUR_USERNAME>~email-verifier/run-sync?token=<YOUR_TOKEN>
Content-Type: application/json

{ "emails": ["a@b.com", "c@d.com"] }
```

That's it. Build it once, reuse it everywhere.

## Common monetization model

- **Apify runs** = $0.001–$0.01 per call (charged to subscriber)
- **Zapier / Make** = free marketing channel driving traffic to your Apify actor or your RapidAPI listing
- **RapidAPI** = recurring subscriptions (Basic / Pro / Ultra tiers) — RapidAPI takes 20% platform cut, you keep ~80%

## Full system diagram

```
                               ┌────────────────────────┐
                               │      Zapier Zaps      │
                               │      Make scenarios   │
                               │   RapidAPI consumers  │
                               └──────────┬─────────────┘
                                          │ HTTPS
                                          ▼
                              ┌──────────────────────────┐
                              │       Apify (your       │
                              │   actor URL — shared)   │
                              └─────────────┬────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────┐
                              │   email-verifier actor   │
                              │  regex / DNS / SMTP      │
                              └──────────────────────────┘
```
