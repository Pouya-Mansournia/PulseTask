# Security Guide

## Never commit

- Telegram bot tokens
- Telegram chat IDs
- Apps Script deployment URLs when privacy is important
- Shared API secrets
- `.dev.vars`
- Screenshots containing credentials or personal schedule data

## Credential storage

Use:

```text
Cloudflare Wrangler Secrets
Google Apps Script Script Properties
```

## If a Telegram token leaks

1. Open `@BotFather`.
2. Revoke the token.
3. Generate a new token.
4. Update both Cloudflare and Apps Script.
5. Reset the webhook.

## Shared secret requirements

Use at least 32 random characters. Do not reuse a personal password.

## Access model

The Apps Script Web App must be publicly reachable for Cloudflare to call it, so the shared secret is mandatory. Every POST without the correct secret is rejected.

## Git history

Deleting a token from the current file is not enough if it was committed. Rewrite Git history or rotate the credential.
