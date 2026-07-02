# Troubleshooting

## Worker deploy requires Node.js 22

Check:

```powershell
node -v
```

Install or upgrade to Node.js 22+.

## `winget` is not recognized

Install Node.js directly using the official Windows x64 MSI, or install a version manager manually. Reopen PowerShell afterward.

## Telegram returns 404 while setting webhook

The token placeholder was not replaced, or the token is invalid. The URL must contain:

```text
https://api.telegram.org/botACTUAL_TOKEN/setWebhook
```

If a token was pasted publicly, revoke it immediately.

## PowerShell says `-Uri` is not recognized

A multiline command was pasted with broken backticks. Use the one-line commands in `examples/powershell_commands.md`.

## `/start` works but buttons do not update Sheets

1. Run `npx wrangler tail`.
2. Verify `APPS_SCRIPT_URL` ends in `/exec`.
3. Verify both sides use the same `WORKER_API_SECRET`.
4. Deploy a new Apps Script version.
5. Confirm the test row contains a task today.

## Immediate feedback works but Sheet update fails

This indicates the Worker is healthy and the background Apps Script request failed. Read the warning message sent by the Worker and inspect Worker logs.

## Duplicate Telegram responses

- Confirm Telegram webhook points only to the Worker.
- Remove old Apps Script Telegram polling triggers.
- Set webhook with `drop_pending_updates=true`.
- Return HTTP 200 from the Worker after parsing an update.

## Scheduled reminders do not arrive

- Check Apps Script Triggers.
- Run `testSendScheduleManually`.
- Confirm the project timezone.
- Confirm today's day-column spelling.
- Confirm tasks overlap the next four-hour window.

## Energy heatmap is empty

Energy must first be recorded through the 1–5 buttons. Heatmap data comes from `Mood_Log`.
