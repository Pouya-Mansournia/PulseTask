# Testing

## Apps Script tests

Run manually:

```javascript
testTelegram
testSendScheduleManually
testTodayReportManually
testWeeklyReportManually
testHeatmapManually
```

Do not manually run `doPost` without an event payload.

## Worker tests

### Health check

Open the Worker URL or run:

```powershell
Invoke-RestMethod -Uri "https://YOUR-WORKER.workers.dev"
```

### Live logs

```powershell
npx wrangler tail
```

### Telegram test card

Send:

```text
/test
```

Ensure `TEST_ROW` in `src/index.js` contains a task today.

## API test without Telegram

```powershell
$APPS_SCRIPT_URL = "https://script.google.com/macros/s/REPLACE/exec"
$SECRET = "YOUR_SHARED_SECRET"
$BODY = @{secret=$SECRET; action="done"; rowNumber=12} | ConvertTo-Json
Invoke-RestMethod -Uri $APPS_SCRIPT_URL -Method Post -ContentType "application/json" -Body $BODY
```

Expected:

```json
{"ok":true,"action":"done","rowNumber":12}
```
