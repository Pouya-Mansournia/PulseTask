# Development

## Worker local development

```powershell
cd cloudflare-worker
copy .dev.vars.example .dev.vars
npm install
npm run dev
```

Add local secrets only to `.dev.vars`. It is ignored by Git.

## Apps Script development

The simplest workflow is direct editing in the Apps Script browser editor. Advanced contributors may use `clasp`.

## Adding a new task action

1. Add a Telegram button with a compact `callback_data` value.
2. Extend `parseCallbackData()` in the Worker.
3. Extend the Apps Script `doPost()` switch.
4. Add log behavior.
5. Add a test.
6. Update documentation.

## Design rule

Latency-sensitive confirmation belongs in the Worker. Spreadsheet work belongs in Apps Script.
