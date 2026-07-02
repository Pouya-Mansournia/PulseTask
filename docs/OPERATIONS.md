# Operations

## Normal production state

Telegram webhook:

```text
Cloudflare Worker URL
```

Apps Script Web App:

```text
Worker-only authenticated backend endpoint
```

Apps Script triggers:

```text
sendNext4HoursPlanToTelegram — every four hours
sendWeeklyWellbeingReport — weekly
```

## Deploying Apps Script changes

1. Save the code.
2. Deploy a new Web App version.
3. The `/exec` URL usually remains unchanged for the existing deployment.
4. Test the health endpoint.

## Deploying Worker changes

```powershell
npx wrangler deploy
```

## Viewing Worker logs

```powershell
npx wrangler tail
```

## Rotating the shared secret

1. Generate a new secret.
2. Update Apps Script `WORKER_API_SECRET` Script Property.
3. Run:

```powershell
npx wrangler secret put WORKER_API_SECRET
npx wrangler deploy
```

4. Test immediately.

## Rotating Telegram token

1. Revoke the old token in `@BotFather`.
2. Update the Apps Script Script Property.
3. Update the Cloudflare secret.
4. Deploy the Worker.
5. Re-set the Telegram webhook using the new token.
