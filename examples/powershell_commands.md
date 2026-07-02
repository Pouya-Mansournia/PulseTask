# PowerShell Command Reference

## Check Node

```powershell
node -v
npm -v
```

## Worker secrets

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put APPS_SCRIPT_URL
npx wrangler secret put WORKER_API_SECRET
```

## Deploy and logs

```powershell
npx wrangler deploy
npx wrangler tail
```

## Set webhook

```powershell
$BOT_TOKEN = "YOUR_BOT_TOKEN"
$WORKER_URL = "https://YOUR-WORKER.workers.dev"
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" -Method Post -ContentType "application/json" -Body (@{url=$WORKER_URL; drop_pending_updates=$true} | ConvertTo-Json)
```

## Get webhook info

```powershell
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

## Generate a shared secret

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```
