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

The main schedule sheet also contains a lightweight inbox beginning at `N2`.
Only confirmed Telegram tasks are appended to it; cancelled drafts are not.
The normal `Dynamic_Schedule` record is still created, so existing scheduling,
tracking, and **Add & Start** behavior remain unchanged.

| Column | Header | Meaning |
|---|---|---|
| N | Added At | Telegram confirmation timestamp |
| O | Category | Detected or supplied category |
| P | Task | Task description |
| Q | Duration | Planned duration |
| R | Suggested Slot | Slot selected by the existing scheduler |
| S | Task Ref | Reference used to prevent duplicate Queue rows |

Move or copy Queue items into the weekday plan when you decide where they
belong, then remove the Queue row manually.

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
