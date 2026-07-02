const CONFIG = {
  // Telegram credentials
  BOT_TOKEN: getScriptPropertyOrFallback_('TELEGRAM_BOT_TOKEN', 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE'),
  CHAT_ID: getScriptPropertyOrFallback_('TELEGRAM_CHAT_ID', 'PUT_YOUR_TELEGRAM_CHAT_ID_HERE'),

  // Must exactly match WORKER_API_SECRET stored in Cloudflare
  WORKER_API_SECRET: getScriptPropertyOrFallback_('WORKER_API_SECRET', 'PUT_YOUR_LONG_SHARED_SECRET_HERE'),

  // Main schedule sheet
  SHEET_NAME: getScriptPropertyOrFallback_('MAIN_SHEET_NAME', 'Sheet1'),

  // Generated sheets
  ACTION_LOG_SHEET_NAME: 'Action_Log',
  MOOD_LOG_SHEET_NAME: 'Mood_Log',
  WEEKLY_REPORT_SHEET_NAME: 'Weekly_Report',
  ENERGY_HEATMAP_SHEET_NAME: 'Energy_Heatmap',
  REMINDER_LOG_SHEET_NAME: 'Reminder_Log',
  DYNAMIC_SCHEDULE_SHEET_NAME: 'Dynamic_Schedule',

  // Time configuration
  TIMEZONE: getScriptPropertyOrFallback_('TIMEZONE', 'Asia/Tehran'),

  // Reminder configuration
  REMINDER_MINUTES_BEFORE: 60,
  REMINDER_WINDOW_MINUTES: 5,

  // Smart rescheduling configuration
  RESCHEDULE_DAY_START: '06:00',
  RESCHEDULE_DAY_END: '23:00',
  RESCHEDULE_BUFFER_MINUTES: 5,
  RESCHEDULE_STEP_MINUTES: 5,
  RESCHEDULE_SEARCH_DAYS: 7,

  // Status colors
  DONE_COLOR: '#b7e1cd',
  PENDING_COLOR: '#f4c7c3',
  SKIPPED_COLOR: '#fce8b2',
  STARTED_COLOR: '#cfe2f3',
  PAUSED_COLOR: '#d9d2e9',
  DEFAULT_COLOR: '#ffffff'
};

/**
 * Secure API endpoint called by Cloudflare Worker.
 * Telegram webhook must point to Cloudflare Worker, not Apps Script.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ ok: false, error: 'Missing request body' });
    }

    const payload = JSON.parse(e.postData.contents);

    if (!payload.secret || payload.secret !== CONFIG.WORKER_API_SECRET) {
      return createJsonResponse({ ok: false, error: 'Unauthorized' });
    }

    const action = cleanCell(payload.action);
    const taskRef = normalizeTaskRef(payload.taskRef, payload.rowNumber);
    const energyValue = Number(payload.energyValue || 0);

    if (action === 'done') {
      validateTaskRef(taskRef);
      markTaskAsDone(taskRef);

    } else if (action === 'skip') {
      validateTaskRef(taskRef);
      markTaskAsSkipped(taskRef);

    } else if (action === 'start') {
      validateTaskRef(taskRef);
      markTaskAsStarted(taskRef);

    } else if (action === 'pause') {
      validateTaskRef(taskRef);
      markTaskAsPaused(taskRef);

    } else if (action === 'later30') {
      validateTaskRef(taskRef);
      markTaskAsLater(taskRef, 30);

    } else if (action === 'energy') {
      validateTaskRef(taskRef);

      if (!Number.isInteger(energyValue) || energyValue < 1 || energyValue > 5) {
        throw new Error('Energy value must be between 1 and 5.');
      }

      markTaskEnergy(taskRef, energyValue);

    } else if (action === 'reschedule') {
      validateTaskRef(taskRef);
      rescheduleTaskToNearestFreeTime(taskRef);

    } else if (action === 'report_today') {
      sendTodayReportToTelegram();

    } else if (action === 'report_week') {
      sendWeeklyReportTextOnlyToTelegram();

    } else if (action === 'heatmap') {
      buildEnergyHeatmapSheet(7);
      sendTelegramMessage('🟩 The energy heatmap was updated successfully.');

    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    return createJsonResponse({
      ok: true,
      action: action,
      taskRef: taskRef || null,
      energyValue: energyValue || null
    });

  } catch (error) {
    Logger.log(`Worker API error: ${error.stack || error.message}`);
    return createJsonResponse({ ok: false, error: error.message });
  }
}

/** Apps Script API health check. */
function doGet() {
  return createJsonResponse({
    ok: true,
    service: 'PulseTask Apps Script API',
    timezone: CONFIG.TIMEZONE
  });
}

/** Creates a JSON API response. */
function createJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Converts old row-number callbacks into the new task-reference format. */
function normalizeTaskRef(taskRef, rowNumber) {
  const explicitRef = cleanCell(taskRef);
  if (explicitRef) return explicitRef;

  const numericRow = Number(rowNumber || 0);
  return Number.isInteger(numericRow) && numericRow >= 2
    ? `S${numericRow}`
    : '';
}

/** Validates a static or dynamic task reference. */
function validateTaskRef(taskRef) {
  if (!/^(S\d+|D[A-Za-z0-9-]+)$/.test(cleanCell(taskRef))) {
    throw new Error(`Invalid task reference: ${taskRef}`);
  }
}

/**
 * Checks today's schedule and sends each task once,
 * approximately one hour before its start time.
 */
function checkUpcomingTaskReminders() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    Logger.log('Reminder checker skipped because another run is active.');
    return;
  }

  try {
    const now = getNowInConfiguredTimezone();
    const todayDate = formatDateKey(now);
    const todayName = getWeekdayNameForDate(now);
    const tasks = getEffectiveTasksForDate(todayDate);

    const reminderTarget = new Date(
      now.getTime() + CONFIG.REMINDER_MINUTES_BEFORE * 60 * 1000
    );
    const windowStart = new Date(
      reminderTarget.getTime() - CONFIG.REMINDER_WINDOW_MINUTES * 60 * 1000
    );
    const windowEnd = new Date(
      reminderTarget.getTime() + CONFIG.REMINDER_WINDOW_MINUTES * 60 * 1000
    );

    tasks.forEach(item => {
      const startDateTime = combineDateKeyWithTime(todayDate, item.start);

      if (startDateTime < windowStart || startDateTime > windowEnd) return;

      if (wasReminderAlreadySent(todayDate, item.taskRef, item.start)) {
        Logger.log(`Reminder already sent for ${item.taskRef} at ${item.start}.`);
        return;
      }

      sendSingleUpcomingTaskReminder(todayName, item);
      setTaskCellStatusColor(item.originalRow, 'pending');

      saveActionLog({
        action: 'Pending',
        taskRef: item.taskRef,
        rowNumber: item.originalRow,
        day: todayName,
        start: item.start,
        finish: item.finish,
        state: item.state,
        task: item.task,
        commandType: item.isDynamic
          ? 'dynamic one-hour reminder'
          : 'one-hour reminder'
      }, true);

      saveReminderSentLog(
        item.taskRef,
        item.originalRow,
        item.start,
        todayName,
        item.task,
        todayDate
      );
    });
  } finally {
    lock.releaseLock();
  }
}

/** Sends one task reminder with Telegram inline buttons. */
function sendSingleUpcomingTaskReminder(todayName, item) {
  const message = [
    item.isDynamic ? '🔄 Rescheduled Task Reminder' : '⏰ One-Hour Reminder',
    '',
    `🗓 ${todayName}`,
    `🕐 ${item.start} to ${item.finish}`,
    !isEmptyTask(item.state) ? `▪️ Category: ${item.state}` : '',
    '',
    '🔹 Task:',
    item.task
  ].filter(line => line !== '').join('\n');

  const ref = item.taskRef;
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Done', callback_data: `done:${ref}` },
        { text: '⏭ Skip', callback_data: `skip:${ref}` }
      ],
      [
        { text: '⏱ Start', callback_data: `start:${ref}` },
        { text: '⏸ Pause', callback_data: `pause:${ref}` },
        { text: '🔁 Later', callback_data: `later30:${ref}` }
      ],
      [
        { text: '🔄 Reschedule to Free Time', callback_data: `reschedule:${ref}` }
      ],
      [
        { text: '🔥1', callback_data: `energyval:${ref}:1` },
        { text: '🔥2', callback_data: `energyval:${ref}:2` },
        { text: '🔥3', callback_data: `energyval:${ref}:3` },
        { text: '🔥4', callback_data: `energyval:${ref}:4` },
        { text: '🔥5', callback_data: `energyval:${ref}:5` }
      ],
      [
        { text: '📊 Today', callback_data: 'report:today' },
        { text: '📈 Week', callback_data: 'report:week' },
        { text: '🟩 Heatmap', callback_data: 'report:heatmap' }
      ]
    ]
  };

  sendTelegramMessageWithKeyboard(message, keyboard);
}

/** Checks whether a reminder was already sent for a date and task reference. */
function wasReminderAlreadySent(dateKey, taskRef, startTime) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.REMINDER_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return false;

  const data = sheet.getDataRange().getDisplayValues();

  for (let i = 1; i < data.length; i++) {
    if (
      cleanCell(data[i][1]) === dateKey &&
      cleanCell(data[i][3]) === taskRef &&
      cleanCell(data[i][5]) === cleanCell(startTime)
    ) {
      return true;
    }
  }

  return false;
}

/** Saves a sent reminder record. */
function saveReminderSentLog(taskRef, rowNumber, startTime, day, task, dateKey) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.REMINDER_LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.REMINDER_LOG_SHEET_NAME);
    createReminderLogHeader(sheet);
  }

  const now = new Date();

  sheet.appendRow([
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    dateKey || formatDateKey(now),
    day,
    taskRef,
    rowNumber,
    startTime,
    task
  ]);
}


function markTaskAsDone(taskRef) {
  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  if (!isAlreadyLoggedToday(taskRef, 'Done')) {
    saveTaskAction(taskInfo, 'Done', 'cloudflare done button');
  }

  completeDynamicTaskIfNeeded(taskInfo);
  setTaskCellStatusColor(taskInfo.originalRow, 'done');
}

function markTaskAsSkipped(taskRef) {
  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  if (!isAlreadyLoggedToday(taskRef, 'Skipped')) {
    saveTaskAction(taskInfo, 'Skipped', 'cloudflare skip button');
  }

  completeDynamicTaskIfNeeded(taskInfo, 'Skipped');
  setTaskCellStatusColor(taskInfo.originalRow, 'skipped');
}

function markTaskAsStarted(taskRef) {
  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) throw new Error(taskInfo.message);
  saveTaskAction(taskInfo, 'Started', 'cloudflare start button');
  setTaskCellStatusColor(taskInfo.originalRow, 'started');
}

function markTaskAsPaused(taskRef) {
  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) throw new Error(taskInfo.message);
  saveTaskAction(taskInfo, 'Paused', 'cloudflare pause button');
  setTaskCellStatusColor(taskInfo.originalRow, 'paused');
}

function markTaskAsLater(taskRef, minutes) {
  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) throw new Error(taskInfo.message);
  saveTaskAction(taskInfo, `Later ${minutes}m`, 'cloudflare later button');
  setTaskCellStatusColor(taskInfo.originalRow, 'skipped');
}

function markTaskEnergy(taskRef, energyValue) {
  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  const mood = energyToMoodLabel(energyValue);

  saveMoodLog({
    taskRef: taskRef,
    rowNumber: taskInfo.originalRow,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    energy: energyValue,
    mood: mood,
    source: 'cloudflare energy button'
  });

  saveActionLog({
    action: `Energy ${energyValue}/5`,
    taskRef: taskRef,
    rowNumber: taskInfo.originalRow,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    energy: energyValue,
    mood: mood,
    commandType: 'cloudflare energy button'
  }, false);
}

function saveTaskAction(taskInfo, action, commandType) {
  saveActionLog({
    action: action,
    taskRef: taskInfo.taskRef,
    rowNumber: taskInfo.originalRow,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    commandType: commandType
  }, false);
}

function getTaskInfoByRef(taskRef) {
  validateTaskRef(taskRef);

  if (taskRef.startsWith('D')) {
    const dynamicId = taskRef.substring(1);
    const item = getDynamicTaskById(dynamicId);

    if (!item || item.status !== 'Active') {
      return { ok: false, message: `Active dynamic task not found: ${dynamicId}` };
    }

    return {
      ok: true,
      taskRef: taskRef,
      originalRow: Number(item.originalRow),
      day: getWeekdayNameForDate(parseDateKey(item.scheduleDate)),
      dateKey: item.scheduleDate,
      start: item.newStart,
      finish: item.newFinish,
      state: item.state,
      task: item.task,
      isDynamic: true,
      dynamicId: item.dynamicId,
      dynamicSheetRow: item.sheetRow,
      originalDate: item.originalDate
    };
  }

  const rowNumber = Number(taskRef.substring(1));
  return getStaticTaskInfoByRow(rowNumber, formatDateKey(new Date()));
}

function getStaticTaskInfoByRow(rowNumber, dateKey) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) return { ok: false, message: `Sheet not found: ${CONFIG.SHEET_NAME}` };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > lastRow) {
    return { ok: false, message: `Invalid schedule row: ${rowNumber}` };
  }

  const headers = sheet.getRange(1, 1, 1, lastCol)
    .getDisplayValues()[0].map(value => cleanCell(value));
  const row = sheet.getRange(rowNumber, 1, 1, lastCol).getDisplayValues()[0];
  const day = getWeekdayNameForDate(parseDateKey(dateKey));

  const startCol = headers.indexOf('Start');
  const finishCol = headers.indexOf('Finish');
  const stateCol = headers.indexOf('State');
  const dayCol = headers.indexOf(day);

  if (startCol === -1 || finishCol === -1 || stateCol === -1 || dayCol === -1) {
    return { ok: false, message: 'Required schedule columns were not found.' };
  }

  const task = cleanCell(row[dayCol]);
  if (isEmptyTask(task)) {
    return { ok: false, message: `Row ${rowNumber} has no task for ${day}.` };
  }

  return {
    ok: true,
    taskRef: `S${rowNumber}`,
    originalRow: rowNumber,
    day: day,
    dateKey: dateKey,
    start: cleanCell(row[startCol]),
    finish: cleanCell(row[finishCol]),
    state: cleanCell(row[stateCol]),
    task: task,
    isDynamic: false
  };
}

function completeDynamicTaskIfNeeded(taskInfo, status) {
  if (!taskInfo.isDynamic || !taskInfo.dynamicSheetRow) return;
  getDynamicScheduleSheet()
    .getRange(taskInfo.dynamicSheetRow, 12)
    .setValue(status || 'Completed');
}

function saveActionLog(item, preventDuplicate) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ACTION_LOG_SHEET_NAME);
    createActionLogHeader(sheet);
  }

  if (preventDuplicate && isAlreadyLoggedToday(item.taskRef || `S${item.rowNumber}`, item.action)) {
    return;
  }

  const now = new Date();

  sheet.appendRow([
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    item.action || '',
    item.taskRef || `S${item.rowNumber}`,
    item.day || '',
    item.rowNumber || '',
    item.start || '',
    item.finish || '',
    item.state || '',
    item.task || '',
    item.energy || '',
    item.mood || '',
    item.commandType || ''
  ]);
}

function saveMoodLog(item) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.MOOD_LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.MOOD_LOG_SHEET_NAME);
    createMoodLogHeader(sheet);
  }

  const now = new Date();

  sheet.appendRow([
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    item.day,
    extractHourFromTime(item.start),
    item.taskRef || `S${item.rowNumber}`,
    item.rowNumber,
    item.start,
    item.finish,
    item.state,
    item.task,
    item.energy,
    item.mood,
    item.source || ''
  ]);
}

function isAlreadyLoggedToday(taskRef, action) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return false;

  const data = sheet.getDataRange().getDisplayValues();
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');

  for (let i = 1; i < data.length; i++) {
    const actionDate = cleanCell(data[i][1]);
    const loggedAction = cleanCell(data[i][2]);
    const loggedTaskRef = cleanCell(data[i][3]);

    if (
      actionDate === today &&
      loggedAction === action &&
      loggedTaskRef === taskRef
    ) {
      return true;
    }
  }

  return false;
}


/** Reschedules a task into the nearest available slot. */
function rescheduleTaskToNearestFreeTime(taskRef) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const taskInfo = getTaskInfoByRef(taskRef);
    if (!taskInfo.ok) throw new Error(taskInfo.message);

    const now = getNowInConfiguredTimezone();
    const durationMinutes = calculateDurationMinutes(taskInfo.start, taskInfo.finish);
    if (durationMinutes <= 0) throw new Error('Task duration could not be calculated.');

    const slot = findNearestFreeSlot(
      taskInfo,
      durationMinutes,
      now,
      CONFIG.RESCHEDULE_SEARCH_DAYS
    );

    if (!slot) {
      saveTaskAction(taskInfo, 'Reschedule Failed', 'smart reschedule');
      sendTelegramMessage([
        '⚠️ No suitable free time was found.',
        '',
        `📌 Task: ${taskInfo.task}`,
        `⏱ Required duration: ${formatMinutes(durationMinutes)}`,
        '',
        `The system searched the next ${CONFIG.RESCHEDULE_SEARCH_DAYS} day(s).`
      ].join('\n'));
      return null;
    }

    if (taskInfo.isDynamic) {
      setDynamicTaskStatus(taskInfo.dynamicSheetRow, 'Superseded');
    }

    const count = getNextRescheduleCount(taskInfo.originalRow, taskInfo.originalDate || taskInfo.dateKey);
    const dynamicId = `${slot.dateKey.replace(/-/g, '')}-R${taskInfo.originalRow}-V${count}`;

    appendDynamicScheduleRow({
      dynamicId: dynamicId,
      originalDate: taskInfo.originalDate || taskInfo.dateKey,
      scheduleDate: slot.dateKey,
      originalRow: taskInfo.originalRow,
      originalStart: taskInfo.isDynamic ? getOriginalTimes(taskInfo).start : taskInfo.start,
      originalFinish: taskInfo.isDynamic ? getOriginalTimes(taskInfo).finish : taskInfo.finish,
      previousTaskRef: taskRef,
      newStart: slot.start,
      newFinish: slot.finish,
      state: taskInfo.state,
      task: taskInfo.task,
      status: 'Active',
      reason: 'Nearest free time',
      rescheduleCount: count
    });

    const newTaskRef = `D${dynamicId}`;
    saveActionLog({
      action: 'Rescheduled',
      taskRef: newTaskRef,
      rowNumber: taskInfo.originalRow,
      day: slot.dayName,
      start: slot.start,
      finish: slot.finish,
      state: taskInfo.state,
      task: taskInfo.task,
      commandType: `from ${taskInfo.dateKey} ${taskInfo.start}-${taskInfo.finish}`
    }, false);

    setTaskCellStatusColor(taskInfo.originalRow, 'paused');

    const dateLabel = slot.dateKey === formatDateKey(now) ? 'Today' : slot.dateKey;
    sendTelegramMessage([
      '✅ Task Rescheduled',
      '',
      `📌 ${taskInfo.task}`,
      !isEmptyTask(taskInfo.state) ? `▪️ Category: ${taskInfo.state}` : '',
      '',
      `Previous: ${taskInfo.dateKey}, ${taskInfo.start}–${taskInfo.finish}`,
      `New: ${dateLabel}, ${slot.start}–${slot.finish}`,
      '',
      'A new reminder will be sent one hour before the rescheduled task.'
    ].filter(Boolean).join('\n'));

    return { ...slot, taskRef: newTaskRef };
  } finally {
    lock.releaseLock();
  }
}

function findNearestFreeSlot(
  taskInfo,
  durationMinutes,
  now,
  searchDays
) {
  if (!taskInfo || !taskInfo.taskRef) {
    throw new Error('Task information is missing.');
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error(`Invalid task duration: ${durationMinutes}`);
  }

  const daysToSearch = Math.max(1, Number(searchDays) || 1);

  for (let dayOffset = 0; dayOffset < daysToSearch; dayOffset++) {
    const targetDate = new Date(now);
    targetDate.setHours(12, 0, 0, 0);
    targetDate.setDate(targetDate.getDate() + dayOffset);

    const dateKey = formatDateKey(targetDate);
    const dayStart = combineDateKeyWithTime(
      dateKey,
      CONFIG.RESCHEDULE_DAY_START
    );
    const dayEnd = combineDateKeyWithTime(
      dateKey,
      CONFIG.RESCHEDULE_DAY_END
    );

    let earliest = new Date(dayStart);

    if (dayOffset === 0) {
      earliest = roundDateUpToMinutes(
        new Date(
          now.getTime() +
          CONFIG.RESCHEDULE_BUFFER_MINUTES * 60000
        ),
        CONFIG.RESCHEDULE_STEP_MINUTES
      );

      if (earliest < dayStart) {
        earliest = new Date(dayStart);
      }
    }

    if (earliest >= dayEnd) {
      Logger.log(
        `Reschedule search skipped ${dateKey}: earliest time is after day end.`
      );
      continue;
    }

    // Exclude the task only from the date where it is currently scheduled.
    // A recurring weekly row on another date must still remain busy.
    const excludedTaskRef =
      dateKey === taskInfo.dateKey
        ? taskInfo.taskRef
        : '';

    const busyIntervals = getBusyIntervalsForDate(
      dateKey,
      excludedTaskRef
    );

    Logger.log(
      `Searching ${dateKey} from ${formatTime(earliest)} to ` +
      `${formatTime(dayEnd)} for ${durationMinutes} minutes. ` +
      `Busy intervals: ${busyIntervals.length}.`
    );

    const gap = findGapInIntervals(
      earliest,
      dayEnd,
      durationMinutes,
      busyIntervals,
      CONFIG.RESCHEDULE_BUFFER_MINUTES
    );

    if (gap) {
      return {
        dateKey: dateKey,
        dayName: getWeekdayNameForDate(targetDate),
        start: formatTime(gap.start),
        finish: formatTime(gap.finish)
      };
    }
  }

  return null;
}

function getBusyIntervalsForDate(dateKey, excludedTaskRef) {
  const tasks = getEffectiveTasksForDate(dateKey);
  const intervals = [];

  tasks.forEach(item => {
    if (
      excludedTaskRef &&
      item.taskRef === excludedTaskRef
    ) {
      return;
    }

    try {
      const start = combineDateKeyWithTime(
        dateKey,
        item.start
      );

      let finish = combineDateKeyWithTime(
        dateKey,
        item.finish
      );

      if (finish <= start) {
        finish.setDate(finish.getDate() + 1);
      }

      intervals.push({
        taskRef: item.taskRef,
        start: start,
        finish: finish
      });
    } catch (error) {
      Logger.log(
        `Invalid busy interval ignored for ${item.taskRef}: ${error.message}`
      );
    }
  });

  return intervals.sort(
    (a, b) => a.start.getTime() - b.start.getTime()
  );
}

function findGapInIntervals(
  earliestStart,
  dayEnd,
  durationMinutes,
  intervals,
  bufferMinutes
) {
  const durationMs = Number(durationMinutes) * 60000;
  const bufferMs = Math.max(0, Number(bufferMinutes) || 0) * 60000;

  if (
    !(earliestStart instanceof Date) ||
    isNaN(earliestStart.getTime()) ||
    !(dayEnd instanceof Date) ||
    isNaN(dayEnd.getTime()) ||
    durationMs <= 0 ||
    earliestStart >= dayEnd
  ) {
    return null;
  }

  /*
   * Expand every busy interval by the configured buffer,
   * clip it to the searchable day, and merge overlaps.
   */
  const normalized = (intervals || [])
    .filter(interval =>
      interval &&
      interval.start instanceof Date &&
      !isNaN(interval.start.getTime()) &&
      interval.finish instanceof Date &&
      !isNaN(interval.finish.getTime())
    )
    .map(interval => ({
      start: new Date(
        Math.max(
          earliestStart.getTime(),
          interval.start.getTime() - bufferMs
        )
      ),
      finish: new Date(
        Math.min(
          dayEnd.getTime(),
          interval.finish.getTime() + bufferMs
        )
      )
    }))
    .filter(interval =>
      interval.finish > earliestStart &&
      interval.start < dayEnd &&
      interval.finish > interval.start
    )
    .sort(
      (a, b) => a.start.getTime() - b.start.getTime()
    );

  const merged = [];

  normalized.forEach(interval => {
    const last = merged[merged.length - 1];

    if (
      !last ||
      interval.start.getTime() > last.finish.getTime()
    ) {
      merged.push({
        start: new Date(interval.start),
        finish: new Date(interval.finish)
      });
      return;
    }

    if (interval.finish > last.finish) {
      last.finish = new Date(interval.finish);
    }
  });

  let candidateStart = roundDateUpToMinutes(
    new Date(earliestStart),
    CONFIG.RESCHEDULE_STEP_MINUTES
  );

  for (const interval of merged) {
    if (interval.finish <= candidateStart) {
      continue;
    }

    const candidateFinish = new Date(
      candidateStart.getTime() + durationMs
    );

    // The current candidate fits before the next blocked interval.
    if (candidateFinish <= interval.start) {
      return {
        start: candidateStart,
        finish: candidateFinish
      };
    }

    // Continue searching after the blocked interval.
    candidateStart = roundDateUpToMinutes(
      new Date(
        Math.max(
          candidateStart.getTime(),
          interval.finish.getTime()
        )
      ),
      CONFIG.RESCHEDULE_STEP_MINUTES
    );

    if (candidateStart >= dayEnd) {
      return null;
    }
  }

  // Critical final check: free time after the last busy interval.
  const finalCandidateFinish = new Date(
    candidateStart.getTime() + durationMs
  );

  if (finalCandidateFinish <= dayEnd) {
    return {
      start: candidateStart,
      finish: finalCandidateFinish
    };
  }

  return null;
}

function getEffectiveTasksForDate(dateKey) {
  const originals = getOriginalTasksForDate(dateKey);
  const dynamics = getActiveDynamicTasksForDate(dateKey);
  const overriddenStaticRefs = {};

  getAllActiveDynamicTasks()
    .filter(item => item.originalDate === dateKey)
    .forEach(item => {
      overriddenStaticRefs[`S${item.originalRow}`] = true;
    });

  const staticTasks = originals.filter(item => !overriddenStaticRefs[item.taskRef]);
  const dynamicTasks = dynamics.map(item => ({
    taskRef: `D${item.dynamicId}`,
    originalRow: Number(item.originalRow),
    start: item.newStart,
    finish: item.newFinish,
    state: item.state,
    task: item.task,
    isDynamic: true,
    dateKey: item.scheduleDate
  }));

  return staticTasks.concat(dynamicTasks).sort((a, b) => {
    const at = parseTimeString(a.start);
    const bt = parseTimeString(b.start);
    return (at.hours * 60 + at.minutes) - (bt.hours * 60 + bt.minutes);
  });
}

function getOriginalTasksForDate(dateKey) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);

  const data = sheet.getDataRange().getDisplayValues();
  if (!data || data.length < 2) return [];

  const headers = data[0].map(cleanCell);
  const startCol = headers.indexOf('Start');
  const finishCol = headers.indexOf('Finish');
  const stateCol = headers.indexOf('State');
  const dayName = getWeekdayNameForDate(parseDateKey(dateKey));
  const dayCol = headers.indexOf(dayName);

  if (startCol === -1 || finishCol === -1 || stateCol === -1 || dayCol === -1) {
    throw new Error('Required schedule columns were not found.');
  }

  const result = [];
  for (let i = 1; i < data.length; i++) {
    const start = cleanCell(data[i][startCol]);
    const finish = cleanCell(data[i][finishCol]);
    const task = cleanCell(data[i][dayCol]);
    if (isEmptyTask(start) || isEmptyTask(finish) || isEmptyTask(task)) continue;

    result.push({
      taskRef: `S${i + 1}`,
      originalRow: i + 1,
      start: start,
      finish: finish,
      state: cleanCell(data[i][stateCol]),
      task: task,
      isDynamic: false,
      dateKey: dateKey
    });
  }
  return result;
}

function getDynamicScheduleSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.DYNAMIC_SCHEDULE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.DYNAMIC_SCHEDULE_SHEET_NAME);
    createDynamicScheduleHeader(sheet);
  }
  return sheet;
}

function getAllDynamicTasks() {
  const sheet = getDynamicScheduleSheet();
  if (sheet.getLastRow() < 2) return [];

  return sheet.getDataRange().getDisplayValues().slice(1).map((row, index) => ({
    sheetRow: index + 2,
    dynamicId: row[0],
    createdAt: row[1],
    originalDate: row[2],
    scheduleDate: row[3],
    originalRow: Number(row[4]),
    originalStart: row[5],
    originalFinish: row[6],
    previousTaskRef: row[7],
    newStart: row[8],
    newFinish: row[9],
    state: row[10],
    status: row[11],
    task: row[12],
    reason: row[13],
    rescheduleCount: Number(row[14] || 0)
  }));
}

function getAllActiveDynamicTasks() {
  return getAllDynamicTasks().filter(item => item.status === 'Active');
}

function getActiveDynamicTasksForDate(dateKey) {
  return getAllActiveDynamicTasks().filter(item => item.scheduleDate === dateKey);
}

function getDynamicTaskById(dynamicId) {
  const matches = getAllDynamicTasks().filter(item => item.dynamicId === dynamicId);
  return matches.length ? matches[matches.length - 1] : null;
}

function setDynamicTaskStatus(sheetRow, status) {
  getDynamicScheduleSheet().getRange(sheetRow, 12).setValue(status);
}

function getNextRescheduleCount(originalRow, originalDate) {
  const matches = getAllDynamicTasks().filter(item =>
    Number(item.originalRow) === Number(originalRow) &&
    item.originalDate === originalDate
  );
  return matches.length + 1;
}

function getOriginalTimes(taskInfo) {
  const item = getDynamicTaskById(taskInfo.dynamicId);
  return item
    ? { start: item.originalStart, finish: item.originalFinish }
    : { start: taskInfo.start, finish: taskInfo.finish };
}

function appendDynamicScheduleRow(item) {
  getDynamicScheduleSheet().appendRow([
    item.dynamicId,
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    item.originalDate,
    item.scheduleDate,
    item.originalRow,
    item.originalStart,
    item.originalFinish,
    item.previousTaskRef,
    item.newStart,
    item.newFinish,
    item.state,
    item.status,
    item.task,
    item.reason,
    item.rescheduleCount
  ]);
}

function setTaskCellStatusColor(rowNumber, status) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);

  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getDisplayValues()[0]
    .map(value => cleanCell(value));

  const todayName = getTodayColumnName();
  const todayCol = headers.indexOf(todayName);

  if (todayCol === -1) {
    throw new Error(`Today column not found: ${todayName}`);
  }

  const colorMap = {
    done: CONFIG.DONE_COLOR,
    pending: CONFIG.PENDING_COLOR,
    skipped: CONFIG.SKIPPED_COLOR,
    started: CONFIG.STARTED_COLOR,
    paused: CONFIG.PAUSED_COLOR,
    default: CONFIG.DEFAULT_COLOR
  };

  sheet
    .getRange(rowNumber, todayCol + 1)
    .setBackground(colorMap[status] || CONFIG.DEFAULT_COLOR);
}

function sendTodayReportToTelegram() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const report = buildReportForDateRange(today, today);
  sendTelegramMessage(report.message);
}

function sendWeeklyReportTextOnlyToTelegram() {
  const range = getLastNDaysRange(7);
  const report = buildReportForDateRange(range.start, range.end);
  sendTelegramMessage(report.message);
}

function sendWeeklyWellbeingReport() {
  const range = getLastNDaysRange(7);
  const report = buildReportForDateRange(range.start, range.end);

  saveWeeklyReport(report);
  buildEnergyHeatmapSheet(7);

  sendTelegramMessage(
    report.message + '\n\n🟩 The energy heatmap was also updated.'
  );
}

function buildReportForDateRange(startDate, endDate) {
  const actionRows = getActionLogRows();
  const moodRows = getMoodLogRows();

  const uniquePending = {};
  const uniqueDone = {};
  const uniqueSkipped = {};

  let started = 0;
  let paused = 0;
  let later = 0;
  let productiveMinutes = 0;

  const stateMinutes = {};
  const energyValues = [];
  const hourlyEnergy = {};

  actionRows.forEach(row => {
    if (!isDateInRange(row.actionDate, startDate, endDate)) return;

    const taskKey = `${row.actionDate}:${row.taskRef || row.rowNumber}`;

    if (row.action === 'Pending') uniquePending[taskKey] = true;

    if (row.action === 'Done' && !uniqueDone[taskKey]) {
      uniqueDone[taskKey] = true;

      const duration = calculateDurationMinutes(row.start, row.finish);
      productiveMinutes += duration;

      const stateName = row.state || 'Uncategorized';
      stateMinutes[stateName] = (stateMinutes[stateName] || 0) + duration;
    }

    if (row.action === 'Skipped') uniqueSkipped[taskKey] = true;
    if (row.action === 'Started') started++;
    if (row.action === 'Paused') paused++;
    if (String(row.action).startsWith('Later')) later++;
  });

  moodRows.forEach(row => {
    if (!isDateInRange(row.date, startDate, endDate)) return;

    const energy = Number(row.energy);
    if (isNaN(energy)) return;

    energyValues.push(energy);

    const key = `${row.date} ${pad2(row.hour)}:00`;
    if (!hourlyEnergy[key]) hourlyEnergy[key] = [];
    hourlyEnergy[key].push(energy);
  });

  const pending = Object.keys(uniquePending).length;
  const done = Object.keys(uniqueDone).length;
  const skipped = Object.keys(uniqueSkipped).length;
  const completionRate = pending > 0 ? Math.round((done / pending) * 100) : 0;
  const averageEnergy = energyValues.length > 0
    ? roundToOne(energyValues.reduce((sum, value) => sum + value, 0) / energyValues.length)
    : 0;

  const bestState = getBestStateByMinutes(stateMinutes);
  const bestHour = getBestEnergyHour(hourlyEnergy);
  const title = startDate === endDate ? '📊 Today’s Report' : '📈 Last 7 Days Report';

  const lines = [
    title,
    `🗓 Period: ${startDate} to ${endDate}`,
    '',
    `✅ Done: ${done}`,
    `⏭ Skipped: ${skipped}`,
    `⏳ Reminders Sent: ${pending}`,
    `⏱ Started: ${started}`,
    `⏸ Paused: ${paused}`,
    `🔁 Postponed: ${later}`,
    '',
    `🎯 Completion Rate: ${completionRate}%`,
    `⏱ Productive Time: ${formatMinutes(productiveMinutes)}`,
    `🔥 Average Energy: ${averageEnergy}/5`
  ];

  if (bestState.name) {
    lines.push(
      '',
      '🏆 Best Performing Category:',
      `${bestState.name} — ${formatMinutes(bestState.minutes)}`
    );
  }

  if (bestHour.label) {
    lines.push(
      '',
      '🟩 Best Energy Time:',
      `${bestHour.label} — Energy ${bestHour.energy}/5`
    );
  }

  return {
    startDate,
    endDate,
    pending,
    done,
    skipped,
    started,
    paused,
    later,
    completionRate,
    productiveMinutes,
    avgEnergy: averageEnergy,
    bestState,
    bestHour,
    message: lines.join('\n')
  };
}

function saveWeeklyReport(report) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.WEEKLY_REPORT_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.WEEKLY_REPORT_SHEET_NAME);
    createWeeklyReportHeader(sheet);
  }

  sheet.appendRow([
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    report.startDate,
    report.endDate,
    report.pending,
    report.done,
    report.skipped,
    report.started,
    report.paused,
    report.later,
    report.completionRate,
    report.productiveMinutes,
    report.avgEnergy,
    report.bestState.name || '',
    report.bestState.minutes || '',
    report.bestHour.label || '',
    report.bestHour.energy || ''
  ]);
}

function buildEnergyHeatmapSheet(days) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.ENERGY_HEATMAP_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(CONFIG.ENERGY_HEATMAP_SHEET_NAME);
  sheet.clear();

  const range = getLastNDaysRange(days);
  const dates = getDateList(range.start, range.end);
  const moodRows = getMoodLogRows();
  const header = ['Date / Hour'];

  for (let hour = 0; hour < 24; hour++) {
    header.push(`${pad2(hour)}:00`);
  }

  const output = [header];

  dates.forEach(date => {
    const row = [date];

    for (let hour = 0; hour < 24; hour++) {
      const values = moodRows
        .filter(item => item.date === date && Number(item.hour) === hour)
        .map(item => Number(item.energy))
        .filter(value => !isNaN(value));

      row.push(
        values.length === 0
          ? ''
          : roundToOne(values.reduce((sum, value) => sum + value, 0) / values.length)
      );
    }

    output.push(row);
  });

  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
  sheet.getRange(1, 1, 1, output[0].length).setFontWeight('bold').setBackground('#eeeeee');

  if (output.length > 1) {
    const colorValues = [];

    for (let row = 1; row < output.length; row++) {
      const colorRow = ['#ffffff'];
      for (let col = 1; col < output[row].length; col++) {
        colorRow.push(getEnergyColor(output[row][col]));
      }
      colorValues.push(colorRow);
    }

    sheet
      .getRange(2, 1, colorValues.length, colorValues[0].length)
      .setBackgrounds(colorValues);
  }

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  sheet.autoResizeColumns(1, output[0].length);
}

function getActionLogRows() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return [];

  return sheet.getDataRange().getDisplayValues().slice(1).map(row => ({
    actionAt: row[0],
    actionDate: row[1],
    action: row[2],
    taskRef: row[3],
    day: row[4],
    rowNumber: row[5],
    start: row[6],
    finish: row[7],
    state: row[8],
    task: row[9],
    energy: row[10],
    mood: row[11],
    commandType: row[12]
  }));
}

function getMoodLogRows() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.MOOD_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return [];

  return sheet.getDataRange().getDisplayValues().slice(1).map(row => ({
    loggedAt: row[0],
    date: row[1],
    day: row[2],
    hour: row[3],
    taskRef: row[4],
    rowNumber: row[5],
    start: row[6],
    finish: row[7],
    state: row[8],
    task: row[9],
    energy: row[10],
    mood: row[11],
    source: row[12]
  }));
}

function sendTelegramMessageWithKeyboard(message, keyboard) {
  const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: CONFIG.CHAT_ID,
      text: message,
      reply_markup: keyboard
    }),
    muteHttpExceptions: true
  });

  validateTelegramResponse(response);
}

function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: CONFIG.CHAT_ID,
      text: message
    }),
    muteHttpExceptions: true
  });

  validateTelegramResponse(response);
}

function validateTelegramResponse(response) {
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();
  Logger.log(responseText);

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(`Telegram API error ${responseCode}: ${responseText}`);
  }

  const result = JSON.parse(responseText);
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description || responseText}`);
  }
}

/** Installs the final project triggers. */
function installProjectTriggers() {
  deleteProjectTriggers();

  ScriptApp
    .newTrigger('checkUpcomingTaskReminders')
    .timeBased()
    .everyMinutes(5)
    .create();

  ScriptApp
    .newTrigger('sendWeeklyWellbeingReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(23)
    .nearMinute(45)
    .create();

  Logger.log('Project triggers installed successfully.');
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function fullResetSystem() {
  resetGeneratedSheets();
  createAllGeneratedSheets();
  resetAllScheduleColors();

  sendTelegramMessage([
    '🧹 The system was fully reset.',
    '',
    '✅ Action_Log was recreated',
    '✅ Mood_Log was recreated',
    '✅ Reminder_Log was recreated',
    '✅ Dynamic_Schedule was recreated',
    '✅ Weekly_Report was recreated',
    '✅ Energy_Heatmap was recreated',
    '✅ Schedule colors were reset',
    '',
    'Your main schedule data was not deleted.'
  ].join('\n'));
}

function resetGeneratedSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [
    CONFIG.ACTION_LOG_SHEET_NAME,
    CONFIG.MOOD_LOG_SHEET_NAME,
    CONFIG.REMINDER_LOG_SHEET_NAME,
    CONFIG.DYNAMIC_SCHEDULE_SHEET_NAME,
    CONFIG.WEEKLY_REPORT_SHEET_NAME,
    CONFIG.ENERGY_HEATMAP_SHEET_NAME
  ].forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) ss.deleteSheet(sheet);
  });
}

function createAllGeneratedSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const actionLog = ss.insertSheet(CONFIG.ACTION_LOG_SHEET_NAME);
  createActionLogHeader(actionLog);

  const moodLog = ss.insertSheet(CONFIG.MOOD_LOG_SHEET_NAME);
  createMoodLogHeader(moodLog);

  const reminderLog = ss.insertSheet(CONFIG.REMINDER_LOG_SHEET_NAME);
  createReminderLogHeader(reminderLog);

  const dynamicSchedule = ss.insertSheet(CONFIG.DYNAMIC_SCHEDULE_SHEET_NAME);
  createDynamicScheduleHeader(dynamicSchedule);

  const weeklyReport = ss.insertSheet(CONFIG.WEEKLY_REPORT_SHEET_NAME);
  createWeeklyReportHeader(weeklyReport);

  const heatmap = ss.insertSheet(CONFIG.ENERGY_HEATMAP_SHEET_NAME);
  createEnergyHeatmapHeader(heatmap);
}

function createActionLogHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Action At', 'Action Date', 'Action', 'Task Ref', 'Day', 'Row Number',
    'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Command Type'
  ]);
  formatHeaderRow(sheet);
}

function createMoodLogHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Logged At', 'Date', 'Day', 'Hour', 'Task Ref', 'Row Number',
    'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Source'
  ]);
  formatHeaderRow(sheet);
}

function createReminderLogHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Sent At', 'Reminder Date', 'Day', 'Task Ref', 'Row Number', 'Start', 'Task'
  ]);
  formatHeaderRow(sheet);
}

function createDynamicScheduleHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Dynamic ID', 'Created At', 'Original Date', 'Schedule Date',
    'Original Row', 'Original Start', 'Original Finish', 'Previous Task Ref',
    'New Start', 'New Finish', 'State', 'Status', 'Task', 'Reason',
    'Reschedule Count'
  ]);
  formatHeaderRow(sheet);
}

function createWeeklyReportHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Created At', 'Start Date', 'End Date', 'Pending', 'Done', 'Skipped',
    'Started', 'Paused', 'Later', 'Completion Rate', 'Productive Minutes',
    'Average Energy', 'Best State', 'Best State Minutes', 'Best Hour',
    'Best Hour Energy'
  ]);
  formatHeaderRow(sheet);
}

function createEnergyHeatmapHeader(sheet) {
  const header = ['Date / Hour'];
  for (let hour = 0; hour < 24; hour++) header.push(`${pad2(hour)}:00`);

  sheet.clear();
  sheet.appendRow(header);
  formatHeaderRow(sheet);
  sheet.setFrozenColumns(1);
}

function formatHeaderRow(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;

  sheet
    .getRange(1, 1, 1, lastCol)
    .setFontWeight('bold')
    .setBackground('#eeeeee');

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, lastCol);
}

function resetAllScheduleColors() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);

  const data = sheet.getDataRange().getDisplayValues();
  if (!data || data.length < 2) return;

  const headers = data[0].map(value => cleanCell(value));
  const dayColumns = [
    'Saturday', 'Sunday', 'Monday', 'Tuesday',
    'Wednesday', 'Thursday', 'Friday'
  ];

  dayColumns.forEach(day => {
    const colIndex = headers.indexOf(day);
    if (colIndex === -1) return;

    sheet
      .getRange(2, colIndex + 1, data.length - 1, 1)
      .setBackground(CONFIG.DEFAULT_COLOR);
  });
}

/** Sends the next upcoming effective task immediately for testing. */
function testNextUpcomingReminder() {
  const now = getNowInConfiguredTimezone();
  const dateKey = formatDateKey(now);
  const candidates = getEffectiveTasksForDate(dateKey)
    .map(item => ({ ...item, startDateTime: combineDateKeyWithTime(dateKey, item.start) }))
    .filter(item => item.startDateTime > now)
    .sort((a, b) => a.startDateTime - b.startDateTime);

  if (!candidates.length) {
    sendTelegramMessage('⚠️ No upcoming task was found for today.');
    return;
  }

  sendSingleUpcomingTaskReminder(getWeekdayNameForDate(now), candidates[0]);
}

function testSmartReschedule() {
  const now = getNowInConfiguredTimezone();
  const dateKey = formatDateKey(now);
  const candidates = getEffectiveTasksForDate(dateKey)
    .map(item => ({ ...item, startDateTime: combineDateKeyWithTime(dateKey, item.start) }))
    .filter(item => item.startDateTime > now)
    .sort((a, b) => a.startDateTime - b.startDateTime);

  if (!candidates.length) throw new Error('No upcoming task was found.');
  rescheduleTaskToNearestFreeTime(candidates[0].taskRef);
}

function testTelegram() {
  sendTelegramMessage('✅ The Apps Script connection to Telegram is working correctly.');
}

function testReminderChecker() {
  checkUpcomingTaskReminders();
}

function testTodayReport() {
  sendTodayReportToTelegram();
}

function testWeeklyReport() {
  sendWeeklyWellbeingReport();
}

function testHeatmap() {
  buildEnergyHeatmapSheet(7);
}

function getNowInConfiguredTimezone() {
  return new Date();
}

function getTodayColumnName() {
  return getWeekdayNameForDate(new Date());
}

function combineTodayWithTime(timeValue, baseDate) {
  const parsed = parseTimeString(timeValue);
  const result = new Date(baseDate);
  result.setHours(parsed.hours, parsed.minutes, 0, 0);
  return result;
}

function parseTimeString(timeString) {
  const value = cleanCell(timeString);
  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);

  if (!match) throw new Error(`Invalid time format: ${timeString}`);

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const ampm = match[3] ? match[3].toUpperCase() : null;

  if (minutes < 0 || minutes > 59) {
    throw new Error(`Invalid minutes: ${timeString}`);
  }

  if (ampm) {
    if (hours < 1 || hours > 12) {
      throw new Error(`Invalid 12-hour time: ${timeString}`);
    }

    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  } else if (hours < 0 || hours > 23) {
    throw new Error(`Invalid 24-hour time: ${timeString}`);
  }

  return { hours, minutes };
}

function formatDateKey(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function parseDateKey(dateKey) {
  const parts = String(dateKey).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

function getWeekdayNameForDate(date) {
  const number = Number(Utilities.formatDate(date, CONFIG.TIMEZONE, 'u'));
  return {
    1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday',
    5: 'Friday', 6: 'Saturday', 7: 'Sunday'
  }[number];
}

function combineDateKeyWithTime(dateKey, timeValue) {
  const date = parseDateKey(dateKey);
  const parsed = parseTimeString(timeValue);
  date.setHours(parsed.hours, parsed.minutes, 0, 0);
  return date;
}

function roundDateUpToMinutes(date, stepMinutes) {
  const stepMs = stepMinutes * 60000;
  return new Date(Math.ceil(date.getTime() / stepMs) * stepMs);
}

function calculateDurationMinutes(startTime, finishTime) {
  if (isEmptyTask(startTime) || isEmptyTask(finishTime)) return 0;

  const baseDate = getNowInConfiguredTimezone();
  const start = combineTodayWithTime(startTime, baseDate);
  const finish = combineTodayWithTime(finishTime, baseDate);

  if (finish <= start) finish.setDate(finish.getDate() + 1);
  return Math.round((finish.getTime() - start.getTime()) / 60000);
}

function extractHourFromTime(timeString) {
  return parseTimeString(timeString).hours;
}

function cleanCell(value) {
  return String(value ?? '').replace(/\r/g, '').trim();
}

function isEmptyTask(value) {
  const normalized = cleanCell(value).toLowerCase();
  return ['', '-', '—', 'n/a', 'na', 'null', 'undefined'].includes(normalized);
}

function formatTime(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'HH:mm');
}

function energyToMoodLabel(value) {
  return {
    1: 'Very Low',
    2: 'Low',
    3: 'Medium',
    4: 'Good',
    5: 'High'
  }[value] || '';
}

function getEnergyColor(value) {
  if (value === '' || value === null || value === undefined) return '#ffffff';

  const numberValue = Number(value);
  if (isNaN(numberValue)) return '#ffffff';
  if (numberValue <= 1) return '#f4c7c3';
  if (numberValue <= 2) return '#fce8b2';
  if (numberValue <= 3) return '#fff2cc';
  if (numberValue <= 4) return '#d9ead3';
  return '#b7e1cd';
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) return `${remainingMinutes}m`;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

function getBestStateByMinutes(stateMinutes) {
  let bestName = '';
  let bestMinutes = 0;

  Object.keys(stateMinutes).forEach(name => {
    if (stateMinutes[name] > bestMinutes) {
      bestName = name;
      bestMinutes = stateMinutes[name];
    }
  });

  return { name: bestName, minutes: bestMinutes };
}

function getBestEnergyHour(hourlyEnergy) {
  let bestLabel = '';
  let bestEnergy = 0;

  Object.keys(hourlyEnergy).forEach(key => {
    const values = hourlyEnergy[key];
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;

    if (average > bestEnergy) {
      bestLabel = key;
      bestEnergy = average;
    }
  });

  return { label: bestLabel, energy: roundToOne(bestEnergy) };
}

function isDateInRange(date, startDate, endDate) {
  return String(date) >= String(startDate) && String(date) <= String(endDate);
}

function getLastNDaysRange(days) {
  const now = new Date();
  const end = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days + 1);
  const start = Utilities.formatDate(startDate, CONFIG.TIMEZONE, 'yyyy-MM-dd');

  return { start, end };
}

function getDateList(startDate, endDate) {
  const result = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (current <= end) {
    result.push(Utilities.formatDate(current, CONFIG.TIMEZONE, 'yyyy-MM-dd'));
    current.setDate(current.getDate() + 1);
  }

  return result;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}


/**
 * Reads a Script Property and falls back to a safe placeholder/default.
 * Real credentials must be stored in Apps Script Project Settings.
 */
function getScriptPropertyOrFallback_(key, fallbackValue) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value === null || value === undefined || String(value).trim() === ''
    ? fallbackValue
    : String(value).trim();
}

/**
 * Initializes the complete PulseTask system without deleting existing data.
 */
function initializePulseTask() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    validatePulseTaskConfiguration_();
    ensureGeneratedSheetsExist_();
    installProjectTriggers();
    buildEnergyHeatmapSheet(7);

    sendTelegramMessage([
      '✅ PulseTask initialized successfully.',
      '',
      'Created or verified:',
      '• Action_Log',
      '• Mood_Log',
      '• Reminder_Log',
      '• Dynamic_Schedule',
      '• Weekly_Report',
      '• Energy_Heatmap',
      '',
      'Installed triggers:',
      '• Task reminder check every 5 minutes',
      '• Weekly report every Friday',
      '',
      'Smart rescheduling is ready.'
    ].join('\n'));

    Logger.log('PulseTask initialization completed successfully.');
  } finally {
    lock.releaseLock();
  }
}

/** Validates configuration, the main sheet, and required headers. */
function validatePulseTaskConfiguration_() {
  const requiredValues = {
    TELEGRAM_BOT_TOKEN: CONFIG.BOT_TOKEN,
    TELEGRAM_CHAT_ID: CONFIG.CHAT_ID,
    WORKER_API_SECRET: CONFIG.WORKER_API_SECRET,
    MAIN_SHEET_NAME: CONFIG.SHEET_NAME,
    TIMEZONE: CONFIG.TIMEZONE
  };

  Object.keys(requiredValues).forEach(key => {
    const value = cleanCell(requiredValues[key]);

    if (!value || value.startsWith('PUT_') || value.startsWith('YOUR_')) {
      throw new Error(`Missing or invalid Script Property: ${key}`);
    }
  });

  const mainSheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!mainSheet) {
    throw new Error(`Main schedule sheet not found: ${CONFIG.SHEET_NAME}`);
  }

  const headers = mainSheet
    .getRange(1, 1, 1, mainSheet.getLastColumn())
    .getDisplayValues()[0]
    .map(value => cleanCell(value));

  const requiredHeaders = [
    'Start',
    'Finish',
    'State',
    'Saturday',
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday'
  ];

  const missingHeaders = requiredHeaders.filter(header => !headers.includes(header));

  if (missingHeaders.length > 0) {
    throw new Error(`Missing schedule headers: ${missingHeaders.join(', ')}`);
  }
}

/** Creates only missing generated sheets and preserves all existing data. */
function ensureGeneratedSheetsExist_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sheetDefinitions = [
    [CONFIG.ACTION_LOG_SHEET_NAME, createActionLogHeader],
    [CONFIG.MOOD_LOG_SHEET_NAME, createMoodLogHeader],
    [CONFIG.REMINDER_LOG_SHEET_NAME, createReminderLogHeader],
    [CONFIG.DYNAMIC_SCHEDULE_SHEET_NAME, createDynamicScheduleHeader],
    [CONFIG.WEEKLY_REPORT_SHEET_NAME, createWeeklyReportHeader],
    [CONFIG.ENERGY_HEATMAP_SHEET_NAME, createEnergyHeatmapHeader]
  ];

  sheetDefinitions.forEach(([sheetName, headerFunction]) => {
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      headerFunction(sheet);
    }
  });
}
