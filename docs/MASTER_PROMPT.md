# Master Prompt for Rebuilding or Extending This Project

You are a senior serverless architect and JavaScript/Google Apps Script engineer.

Build or extend an open-source project named **Telegram Life Tracker** with the following architecture:

- Telegram Bot API for user interaction
- Cloudflare Worker as the only Telegram webhook
- Immediate `answerCallbackQuery` feedback for inline buttons
- `ctx.waitUntil()` for background calls
- Google Apps Script Web App as an authenticated spreadsheet backend
- Google Sheets as schedule, event-log, mood-log, report, and heatmap storage
- Shared secret authentication between Worker and Apps Script
- Cloudflare Secrets and Apps Script Script Properties for credentials
- No VPS and no requirement for the user's computer to stay on

Required task actions:

- Done
- Skip
- Start
- Pause
- Later 30 minutes
- Energy 1–5

Required commands:

- `/start`
- `/test`
- `/today`
- `/week`
- `/heatmap`

Required scheduled behavior:

- Send the next four hours of the current day's schedule every four hours
- Send a weekly wellbeing report on Friday night

Required generated sheets:

- Action_Log
- Mood_Log
- Weekly_Report
- Energy_Heatmap

Required analytics:

- Done count
- Skipped count
- Pending count
- Started count
- Paused count
- Later count
- Completion rate
- Productive time
- Average energy
- Best category by completed duration
- Best date-hour energy bucket
- Seven-day hourly heatmap

Engineering constraints:

1. Never put real tokens in source code.
2. The Worker must confirm Telegram callbacks before calling Apps Script.
3. The Apps Script endpoint must reject an invalid shared secret.
4. Telegram webhook must never point directly to Apps Script in the final architecture.
5. Apps Script `doPost` must be treated as an API endpoint, not manually executed.
6. Google Sheets time cells must be read with display values or safely parsed.
7. Time ranges crossing midnight must be supported.
8. Existing Done actions must not be duplicated for the same schedule row and date.
9. Documentation must include Windows PowerShell commands.
10. Output must be GitHub-ready with README, setup, architecture, security, testing, troubleshooting, contributing, license, examples, and issue templates.

When modifying the project, preserve the separation of concerns and update all affected documentation.
