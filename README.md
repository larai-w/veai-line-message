# veai-line-message

**A serverless LINE notification bridge: voice notes from Alexa, and the daily
care summary from the microduck care bridge, both pushed to LINE.**

An AWS Lambda function with two entries:

1. **Voice → LINE** — a custom Alexa skill. When the skill hears the
   `LineMessageIntent` (with a spoken `message` slot), the handler forwards that
   text to the [LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/)
   as a push message — a hands-free way to send a LINE note by voice.
2. **Webhook → LINE** — the daily care summary and monitoring-event receiver. The
   [microduck-alexa-bridge](https://github.com/larai-w/microduck-alexa-bridge)
   home-care bridge POSTs one `daily_summary` JSON per day; the handler validates
   it, formats it into a fixed Japanese template, and pushes it to the family's
   LINE. Part of the [VEAI LAB.](https://veai.jp) ecosystem.

## How it works

```
Alexa device (voice)
  └─ Custom Alexa skill  (alexa-interaction-model.json — LineMessageIntent + message slot)
        └─ AWS Lambda  (index.mjs, Node.js ESM, zero runtime deps — uses built-in https)
              └─ LINE Messaging API  POST /v2/bot/message/push
                    └─ Push text to LINE_USER_ID

microduck-alexa-bridge (daily report scheduler)
  └─ POST {"type": "daily_summary", ...}  (Lambda function URL + x-report-secret)
        └─ Same AWS Lambda  (function-URL branch)
              └─ validate → formatDailySummary (deterministic template)
                    └─ LINE Messaging API push → LINE_USER_ID (family)

  microduck-alexa-bridge (monitoring event)
    └─ POST {"type":"fall_detected"|"battery_low"|"duck_unhealthy"|"duck_offline"|"duck_online", ...}
       (Lambda function URL + x-event-secret)
          └─ validate → fixed Japanese alert → LINE push → LINE_USER_ID
```

- `index.mjs` — the Lambda handler: parses the Alexa request or the report
  webhook, calls the LINE push endpoint.
- `alexa-interaction-model.json` — the skill's interaction model (intents, slots, sample utterances).
- `tests/` — node:test suite. Fixes the webhook auth (fail-closed) and the
  summary formatting; never calls the real LINE API.
- `.github/workflows/deploy.yml` — CI/CD: packages and deploys the Lambda.
- No external npm dependencies at runtime; the LINE call uses Node's built-in `https`.

## Configuration

Copy `.env.example` and set:

| Variable | Purpose |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API channel access token |
| `LINE_USER_ID` | Destination LINE user ID for the push message |
| `REPORT_WEBHOOK_SECRET` | Shared secret for the daily-summary webhook. **Unset = the webhook entry is disabled (fail closed).** |
| `EVENT_WEBHOOK_SECRET` | Shared secret for Microduck monitoring events. **Unset = the event entry is disabled (fail closed).** |

Secrets are provided as Lambda environment variables — never hardcoded. `.env` is gitignored.

## Daily care summary receiver

The microduck bridge sends one summary per day (default 18:00,
`DUCKBRIDGE_REPORT_TIME`). Wiring:

1. Deploy this Lambda with a **function URL** and set
   `REPORT_WEBHOOK_SECRET` to a fresh secret
   (`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`).
2. On the bridge side set the same value as `DUCKBRIDGE_REPORT_SECRET` and
   `DUCKBRIDGE_REPORT_WEBHOOK` to the function URL.

The entry is fail-closed on every layer:

| Condition | Response |
|---|---|
| `REPORT_WEBHOOK_SECRET` unset | `503` (entry disabled) |
| Missing/wrong `x-report-secret` (or `?secret=`) | `401` |
| Body not a valid `daily_summary` (bad JSON, wrong type, bad date, negative/missing numbers) | `400` |
| LINE push fails | `502` — the bridge retries within the same report minute |
| Delivered | `200 {"ok": true, "date": ...}` |

Message format (deterministic, no GenAI):

```
【介護サマリー】2026-09-02
歩行: 3回・計5.5分・約320m
リマインド: 4回（うち安否確認1回）
ナースコール記録: システム受付1件・処理中0件・結果不明0件・呼び出し先未設定0件
人の確認: 未確認1件（確認情報の連携なし）
※件数は再送を含む記録の集計で、現在の対応状況ではありません。
※受付は人の対応完了を意味しません。記録0件でも異常なしとは判断できません。
その他コマンド: 2回
```

Numbers are reported as-is. Zero records do not establish that no event occurred
or that someone is safe. Counts summarize audit rows, including retries; they
are neither unique calls nor a query of current response status.

The optional `call_status` object uses version `1` and nonnegative safe-integer
counts: `acknowledged`, `pending`, `unknown`, `not_configured`, and
`human_unknown`. The last count must equal the sum of the first four. A present
but malformed object is rejected with `400`; it never silently falls back to
legacy formatting. System acknowledgement does not prove a human has seen or
responded to a call. This report has no authenticated human-confirmation feed.

Reports without `call_status` remain accepted. Their legacy success/failure
counters are labelled as system response / unconfirmed delivery, with human
confirmation unknown. Update the receiver before enabling the sender's new
format; an older receiver ignores the additional field and retains its older
wording.

## Test

```bash
npm test   # node --test 'tests/*.test.mjs'
```

## Deploy

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`). The handler is packaged
into `function.zip` (gitignored) and uploaded to the Lambda function.

## License

MIT — Part of the [VEAI LAB.](https://veai.jp) ecosystem.
