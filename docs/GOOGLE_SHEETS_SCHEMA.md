# Google Sheets Schema

## Main schedule sheet

Required headers:

```text
Start
Finish
Time Duration
State
Saturday
Sunday
Monday
Tuesday
Wednesday
Thursday
Friday
```

`State` is the task category, such as `Health/GYM`, `Deep Work`, or `Personal`.

### Telegram Queue

The main schedule sheet also contains a lightweight inbox beginning at `L1`.
Confirmed tasks added without immediately starting them are appended to it;
cancelled drafts and **Add & Start** tasks are not.
The normal `Dynamic_Schedule` record is still created, so existing scheduling,
tracking, and **Add & Start** behavior remain unchanged.
Queue records use status `Queued` and are excluded from busy-time calculations
until selected, so pending ideas cannot delay new free-slot suggestions.

| Column | Header | Meaning |
|---|---|---|
| L | Added At | Telegram confirmation timestamp |
| M | Category | Detected or supplied category |
| N | Task | Task description |
| O | Duration | Planned duration |
| P | Suggested Slot | Slot selected by the existing scheduler |
| Q | Task Ref | Reference used to prevent duplicate Queue rows |

Use the persistent **📥 Queue** Telegram button (or `/queue`) to list pending
items. Selecting one starts its timer and clears it from the visible Queue.
Rows can still be removed manually when needed.

### Active Sessions

The same main sheet contains date-specific execution blocks beginning at `R1`.
Selecting a Queue task writes a one-hour session here without overwriting the
recurring weekday plan. Telegram immediately shows **Done / Continue 1h**
controls, and `/active` can reopen them for any running Queue task. Telegram
also checks in after one hour; **Continue 1h** extends the Finish value and
schedules another check-in, while **Done** records the actual finish time and
closes the session.

| Column | Header | Meaning |
|---|---|---|
| R | Date | Date the task was started |
| S | Start | Actual session start |
| T | Finish | Current planned or actual finish |
| U | Category | Task category |
| V | Task | Task description |
| W | Task Ref | Dynamic task reference |
| X | Status | `In Progress` or `Done` |

## Action_Log

| Column | Meaning |
|---|---|
| Action At | Local timestamp |
| Action Date | Local date |
| Action | Pending, Done, Skipped, Started, Paused, Later, or Energy |
| Day | Day name |
| Row Number | Source schedule row |
| Start | Planned start |
| Finish | Planned finish |
| State | Category |
| Task | Task text |
| Energy | Optional 1–5 value |
| Mood | Derived label |
| Command Type | Event source |

## Mood_Log

Stores energy observations by task and planned start hour.

## Weekly_Report

Stores one row per generated weekly report.

## Energy_Heatmap

Rows are dates. Columns are hourly buckets from 00:00 to 23:00. Values are average energy ratings.

## Finance_Log

Stores personal finance transactions created from Telegram. Use **💰 Finance**,
`/finance`, `/expense`, or `/income` to create drafts. Expenses reduce the
balance and income increases it. The optional Apps Script property
`FINANCE_STARTING_BALANCE` sets the opening balance; otherwise the balance
starts at zero.

| Column | Meaning |
|---|---|
| Logged At | Local timestamp |
| Date | Local date |
| Type | `income` or `expense` |
| Amount | Positive transaction amount |
| Signed Amount | Positive for income, negative for expense |
| Category | User supplied category such as Food, Loan, Salary, Rent |
| Note | Optional description |
| Source | Usually Telegram |
| Telegram Chat ID | Source chat |
| Balance After | Running balance after this transaction |
| Transaction ID | Stable finance log reference |

Weekly finance reports summarize income, expenses, net change, current balance,
and expense totals by category.
