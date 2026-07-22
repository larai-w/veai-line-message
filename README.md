# veai-line-message

**A serverless voice-to-LINE bridge: speak a message to Alexa and it is pushed to LINE.**

An AWS Lambda function that backs a custom Alexa skill. When the skill hears the
`LineMessageIntent` (with a spoken `message` slot), the handler forwards that text to the
[LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/) as a push message —
a hands-free way to send a LINE note by voice. Part of the [VEAI LAB.](https://veai.jp) ecosystem.

## How it works

```
Alexa device (voice)
  └─ Custom Alexa skill  (alexa-interaction-model.json — LineMessageIntent + message slot)
        └─ AWS Lambda  (index.mjs, Node.js ESM, zero runtime deps — uses built-in https)
              └─ LINE Messaging API  POST /v2/bot/message/push
                    └─ Push text to LINE_USER_ID
```

- `index.mjs` — the Lambda handler: parses the Alexa request, extracts the message slot, calls the
  LINE push endpoint, and returns an Alexa speech response.
- `alexa-interaction-model.json` — the skill's interaction model (intents, slots, sample utterances).
- `.github/workflows/deploy.yml` — CI/CD: packages and deploys the Lambda.
- No external npm dependencies at runtime; the LINE call uses Node's built-in `https`.

## Configuration

Copy `.env.example` and set:

| Variable | Purpose |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API channel access token |
| `LINE_USER_ID` | Destination LINE user ID for the push message |

Secrets are provided as Lambda environment variables — never hardcoded. `.env` is gitignored.

## Deploy

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`). The handler is packaged
into `function.zip` (gitignored) and uploaded to the Lambda function.

## License

MIT — Part of the [VEAI LAB.](https://veai.jp) ecosystem.
