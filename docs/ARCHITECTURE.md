# Architecture

## Components

### Telegram Bot API
Receives user commands and button clicks. The webhook URL points to the Cloudflare Worker.

### Cloudflare Worker
The latency-sensitive edge layer. It authenticates the Telegram chat, parses callbacks, immediately calls `answerCallbackQuery`, and uses `ctx.waitUntil()` to call Apps Script without blocking the user-facing response.

### Google Apps Script Web App
The spreadsheet and analytics backend. It validates a shared secret, updates logs and colors, generates reports, and sends scheduled Telegram messages.

### Google Sheets
The persistent data store and visual dashboard.

## Request flow: task button

```mermaid
sequenceDiagram
    participant U as User
    participant T as Telegram
    participant W as Cloudflare Worker
    participant A as Apps Script
    participant S as Google Sheets

    U->>T: Press Done
    T->>W: callback_query
    W->>T: answerCallbackQuery immediately
    T-->>U: Done registered
    W-->>A: Background POST with shared secret
    A->>S: Add Action_Log row and color task cell
    A-->>W: JSON success
```

## Request flow: scheduled reminder

```mermaid
sequenceDiagram
    participant G as Apps Script Trigger
    participant S as Google Sheets
    participant T as Telegram Bot API
    participant U as User

    G->>S: Read today's schedule
    G->>G: Select tasks overlapping next four hours
    G->>S: Mark cells Pending and write logs
    G->>T: Send task messages with inline buttons
    T-->>U: Upcoming schedule
```

## Trust boundaries

1. Telegram signs no shared secret in the update. Security at the Worker relies on the unguessable webhook URL plus configured chat-ID validation.
2. Worker-to-Apps-Script requests use `WORKER_API_SECRET`.
3. Apps Script stores Telegram credentials in Script Properties.
4. Worker stores credentials with Wrangler secrets.

## Why Apps Script is retained

Apps Script is excellent for spreadsheet-native operations, triggers, and formatting, but less suitable for latency-sensitive Telegram acknowledgements. The split architecture uses each platform for its strongest role.
