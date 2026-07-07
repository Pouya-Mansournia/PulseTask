# Complete Setup Guide

## 1. Create the Telegram bot

1. Open `@BotFather`.
2. Run `/newbot`.
3. Choose the bot name and username.
4. Copy the token.
5. Send `/start` to the bot.

To identify the chat ID during initial setup, temporarily call Telegram `getUpdates` before setting a webhook, or use a trusted chat-ID bot. After obtaining it, treat it as private configuration.

## 2. Create the Google Sheet

Create the following exact headers in row 1:

```text
Start, Finish, Time Duration, State, Saturday, Sunday, Monday, Tuesday, Wednesday, Thursday, Friday
```

Use time values such as `06:30` and `08:30`.

For a duration cell that supports midnight crossing, use:

```excel
=IF(OR(A2="",B2=""),"",IF(B2<A2,B2+1-A2,B2-A2))
```

Format the duration column as `[h]:mm:ss`.

## 3. Add Apps Script code

Open:

```text
Extensions → Apps Script
```

Replace the editor contents with `apps-script/Code.gs`.

Optionally enable the manifest editor and use `apps-script/appsscript.json`.

## 4. Configure Script Properties

Go to:

```text
Project Settings → Script Properties
```

Add:

```text
TELEGRAM_BOT_TOKEN = your bot token
TELEGRAM_CHAT_ID = your numeric chat ID
WORKER_API_SECRET = a random 32+ character secret
MAIN_SHEET_NAME = Sheet1
TIMEZONE = Asia/Tehran
```

Generate a secret locally with PowerShell:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

Store the generated value in both Apps Script and Cloudflare.

## 5. Authorize Apps Script

Manually run:

```javascript
testTelegram
```

Accept the requested permissions. Then run:

```javascript
fullResetSystem
```

This creates the generated sheets while preserving the main schedule.

## 6. Deploy Apps Script

Use:

```text
Deploy → New deployment → Web app
Execute as: Me
Who has access: Anyone
```

Copy the `/exec` URL.

When code changes later:

```text
Deploy → Manage deployments → Edit → New version → Deploy
```

## 7. Prepare Cloudflare Worker

Install Node.js 22 or newer. Verify:

```powershell
node -v
npm -v
```

Then:

```powershell
cd cloudflare-worker
npm install
npx wrangler login
```

## 8. Add Worker secrets

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put APPS_SCRIPT_URL
npx wrangler secret put WORKER_API_SECRET
```

- `APPS_SCRIPT_URL` is the Apps Script `/exec` URL.
- `WORKER_API_SECRET` must be identical to the Script Property.

## 9. Deploy Worker

```powershell
npx wrangler deploy
```

Copy the resulting `workers.dev` URL.

## 10. Set Telegram webhook

```powershell
$BOT_TOKEN = "YOUR_BOT_TOKEN"
$WORKER_URL = "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev"
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" -Method Post -ContentType "application/json" -Body (@{url=$WORKER_URL; drop_pending_updates=$true} | ConvertTo-Json)
```

Verify:

```powershell
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

## 11. Install Apps Script triggers

Run once:

```javascript
installProjectTriggers
```

Expected triggers:

```text
sendNext4HoursPlanToTelegram — every four hours
sendWeeklyFinanceReport — Friday around 23:30
sendWeeklyWellbeingReport — Friday around 23:45
```

Do not create triggers for `doPost`.

## 12. End-to-end test

1. Send `/start`.
2. Send `/test`.
3. Click Done.
4. Confirm immediate Telegram acknowledgement.
5. Confirm the task cell becomes green.
6. Confirm `Action_Log` receives a row.
7. Click an energy value.
8. Confirm `Mood_Log` receives a row.
9. Send `/today`.
10. Send `/heatmap` and inspect `Energy_Heatmap`.
