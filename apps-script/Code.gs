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

  // Telegram draft and task configuration
  DEFAULT_TASK_DURATION_MINUTES: 60,
  DRAFT_EXPIRY_MINUTES: 15,
  MAX_CATEGORY_LENGTH: 80,
  MAX_TASK_LENGTH: 1000,

  // Telegram inbox on the main Time/Plan sheet (starts at L1)
  TELEGRAM_QUEUE_START_ROW: 1,
  TELEGRAM_QUEUE_START_COLUMN: 12,

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

    } else if (action === 'prepare_task_draft') {
      const result = createTaskDraft(payload);
      return createJsonResponse(result);

    } else if (action === 'confirm_task_draft') {
      const result = confirmTaskDraft(payload.draftId, false, payload.telegramChatId || payload.chatId);
      return createJsonResponse(result);

    } else if (action === 'start_task_draft') {
      const result = confirmTaskDraft(payload.draftId, true, payload.telegramChatId || payload.chatId);
      return createJsonResponse(result);

    } else if (action === 'cancel_task_draft') {
      const result = cancelTaskDraft(payload.draftId, payload.telegramChatId || payload.chatId);
      return createJsonResponse(result);

    } else if (action === 'list_queue') {
      return createJsonResponse(getTelegramQueueItems_());

    } else if (action === 'start_queue_task') {
      validateTaskRef(taskRef);
      return createJsonResponse(startTelegramQueueTask_(taskRef));

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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const taskInfo = getTaskInfoByRef(taskRef);
    if (!taskInfo.ok) throw new Error(taskInfo.message);

    if (isAlreadyLoggedToday(taskRef, 'Done')) {
      return { ok: true, message: 'Already completed.' };
    }

    const state = getTrackedTaskState(taskInfo);
    const sessionMinutes = taskInfo.isDynamic && state.status === 'Started' && state.startedAt
      ? calculateSessionMinutesFromTimestamp(state.startedAt, new Date())
      : 0;
    const cumulativeActualMinutes = Number(state.actualMinutes || 0) + sessionMinutes;

    updateTrackedTaskState(taskInfo, {
      status: 'Done',
      startedAt: '',
      pausedAt: '',
      completedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
      actualMinutes: cumulativeActualMinutes
    });

    saveTaskAction(taskInfo, 'Done', 'cloudflare done button', true, sessionMinutes, cumulativeActualMinutes);
    completeDynamicTaskIfNeeded(taskInfo, 'Completed');
    setTaskCellStatusColor(taskInfo.originalRow, 'done');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function markTaskAsSkipped(taskRef) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const taskInfo = getTaskInfoByRef(taskRef);
    if (!taskInfo.ok) throw new Error(taskInfo.message);

    if (!isAlreadyLoggedToday(taskRef, 'Skipped')) {
      saveTaskAction(taskInfo, 'Skipped', 'cloudflare skip button', true, 0, Number(getTrackedTaskState(taskInfo).actualMinutes || 0));
    }

    completeDynamicTaskIfNeeded(taskInfo, 'Skipped');
    setTaskCellStatusColor(taskInfo.originalRow, 'skipped');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function markTaskAsStarted(taskRef) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const taskInfo = getTaskInfoByRef(taskRef);
    if (!taskInfo.ok) throw new Error(taskInfo.message);

    const state = getTrackedTaskState(taskInfo);
    if (taskInfo.isDynamic && (state.status === 'Started' || state.startedAt)) {
      return { ok: true, message: 'Already started.' };
    }

    const nowText = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    updateTrackedTaskState(taskInfo, {
      status: 'Started',
      startedAt: nowText,
      pausedAt: '',
      completedAt: '',
      actualMinutes: Number(state.actualMinutes || 0)
    });

    saveTaskAction(taskInfo, 'Started', 'cloudflare start button', false, 0, Number(state.actualMinutes || 0));
    setTaskCellStatusColor(taskInfo.originalRow, 'started');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function markTaskAsPaused(taskRef) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const taskInfo = getTaskInfoByRef(taskRef);
    if (!taskInfo.ok) throw new Error(taskInfo.message);

    const state = getTrackedTaskState(taskInfo);
    if (taskInfo.isDynamic && state.status !== 'Started') {
      return { ok: true, message: 'No active session to pause.' };
    }

    const now = new Date();
    const nowText = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const sessionMinutes = taskInfo.isDynamic && state.startedAt
      ? calculateSessionMinutesFromTimestamp(state.startedAt, now)
      : 0;
    const cumulativeActualMinutes = Number(state.actualMinutes || 0) + sessionMinutes;

    updateTrackedTaskState(taskInfo, {
      status: 'Paused',
      startedAt: '',
      pausedAt: nowText,
      completedAt: '',
      actualMinutes: cumulativeActualMinutes
    });

    saveTaskAction(taskInfo, 'Paused', 'cloudflare pause button', true, sessionMinutes, cumulativeActualMinutes);
    setTaskCellStatusColor(taskInfo.originalRow, 'paused');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function markTaskAsLater(taskRef, minutes) {
  const delayMinutes = Math.max(1, Number(minutes) || 30);
  return postponeTaskByMinutes_(taskRef, delayMinutes);
}

/**
 * Moves a task to the nearest available slot after a requested delay.
 * Unlike the previous implementation, this creates a real dynamic override.
 */
function postponeTaskByMinutes_(taskRef, delayMinutes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const taskInfo = getTaskInfoByRef(taskRef);
    if (!taskInfo.ok) throw new Error(taskInfo.message);

    const now = getNowInConfiguredTimezone();
    const durationMinutes = calculateDurationMinutes(taskInfo.start, taskInfo.finish);

    if (durationMinutes <= 0) {
      throw new Error('Task duration could not be calculated.');
    }

    const notBefore = roundDateUpToMinutes(
      new Date(now.getTime() + delayMinutes * 60000),
      CONFIG.RESCHEDULE_STEP_MINUTES
    );

    const slot = findNearestFreeSlot(
      taskInfo,
      durationMinutes,
      now,
      CONFIG.RESCHEDULE_SEARCH_DAYS,
      notBefore
    );

    if (!slot) {
      saveTaskAction(taskInfo, `Later ${delayMinutes}m Failed`, 'real postpone');
      sendTelegramMessage([
        '⚠️ The task could not be postponed.',
        '',
        `📌 ${taskInfo.task}`,
        `⏱ Required duration: ${formatMinutes(durationMinutes)}`,
        `🔁 Requested delay: ${delayMinutes} minutes`,
        '',
        `The system searched the next ${CONFIG.RESCHEDULE_SEARCH_DAYS} day(s).`
      ].join('\n'));
      return null;
    }

    if (taskInfo.isDynamic) {
      setDynamicTaskStatus(taskInfo.dynamicSheetRow, 'Superseded');
    }

    const originalDate = taskInfo.originalDate || taskInfo.dateKey;
    const count = getNextRescheduleCount(taskInfo.originalRow, originalDate);
    const dynamicId = `${slot.dateKey.replace(/-/g, '')}-R${taskInfo.originalRow}-V${count}`;
    const originalTimes = taskInfo.isDynamic
      ? getOriginalTimes(taskInfo)
      : { start: taskInfo.start, finish: taskInfo.finish };

    appendDynamicScheduleRow({
      dynamicId: dynamicId,
      originalDate: originalDate,
      scheduleDate: slot.dateKey,
      originalRow: taskInfo.originalRow,
      originalStart: originalTimes.start,
      originalFinish: originalTimes.finish,
      previousTaskRef: taskRef,
      newStart: slot.start,
      newFinish: slot.finish,
      state: taskInfo.state,
      task: taskInfo.task,
      status: 'Active',
      reason: `Postponed ${delayMinutes} minutes`,
      rescheduleCount: count
    });

    const newTaskRef = `D${dynamicId}`;

    saveActionLog({
      action: `Later ${delayMinutes}m`,
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
      `✅ Task postponed by ${delayMinutes} minutes`,
      '',
      `📌 ${taskInfo.task}`,
      !isEmptyTask(taskInfo.state) ? `▪️ Category: ${taskInfo.state}` : '',
      '',
      `Previous: ${taskInfo.dateKey}, ${taskInfo.start}–${taskInfo.finish}`,
      `New: ${dateLabel}, ${slot.start}–${slot.finish}`,
      '',
      'A new reminder will be sent one hour before the task.'
    ].filter(Boolean).join('\n'));

    return { ...slot, taskRef: newTaskRef };
  } finally {
    lock.releaseLock();
  }
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

function createTaskDraft(payload) {
  const chatId = cleanCell(payload.telegramChatId || payload.chatId || '');
  if (!chatId) {
    throw new Error('Telegram chat ID is missing.');
  }

  const rawInput = cleanCell(payload.taskInput || '');
  if (!rawInput) {
    throw new Error('Task input is empty.');
  }

  const now = getNowInConfiguredTimezone();
  const draft = parseTaskInputToDraft(rawInput, now, chatId);
  draft.createdAt = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  draft.telegramChatId = chatId;

  const draftId = generateDraftId();
  draft.draftId = draftId;

  CacheService.getScriptCache().put(
    draftId,
    JSON.stringify(draft),
    Math.max(1, Number(CONFIG.DRAFT_EXPIRY_MINUTES || 15) * 60)
  );

  return {
    ok: true,
    draftId: draftId,
    preview: buildDraftPreview(draft)
  };
}

function parseTaskInputToDraft(rawInput, now, chatId) {
  const input = cleanCell(rawInput);

  if (/^\/add/i.test(input)) {
    const body = input.replace(/^\/add\s*/i, '').trim();
    if (!body) {
      throw new Error('Please send a task description after /add.');
    }

    const parts = body.split('|').map(value => cleanCell(value));

    if (parts.length === 3) {
      const timeSpec = parts[0];
      const category = parts[1] || 'Uncategorized';
      const task = parts[2];

      if (!task) {
        throw new Error('Task description is required.');
      }

      if (category.length > CONFIG.MAX_CATEGORY_LENGTH) {
        throw new Error('Category is too long.');
      }

      if (task.length > CONFIG.MAX_TASK_LENGTH) {
        throw new Error('Task is too long.');
      }

      const window = parseTaskWindowSpec(timeSpec, now);
      return {
        date: formatDateKey(now),
        start: window.start,
        finish: window.finish,
        category: category,
        task: task,
        source: 'Telegram',
        telegramChatId: chatId
      };
    }

    if (parts.length === 2) {
      const category = parts[0] || 'Uncategorized';
      const task = parts[1];

      if (!task) {
        throw new Error('Task description is required.');
      }

      if (category.length > CONFIG.MAX_CATEGORY_LENGTH) {
        throw new Error('Category is too long.');
      }

      if (task.length > CONFIG.MAX_TASK_LENGTH) {
        throw new Error('Task is too long.');
      }

      const slot = suggestNextFreeTaskSlot(now, CONFIG.DEFAULT_TASK_DURATION_MINUTES);
      return {
        date: slot.dateKey,
        start: slot.start,
        finish: slot.finish,
        category: category,
        task: task,
        source: 'Telegram',
        telegramChatId: chatId,
        slotMode: 'suggested'
      };
    }

    const taskText = parts[0];
    if (!taskText) {
      throw new Error('Task description is required.');
    }

    if (taskText.length > CONFIG.MAX_TASK_LENGTH) {
      throw new Error('Task is too long.');
    }

    const slot = suggestNextFreeTaskSlot(now, CONFIG.DEFAULT_TASK_DURATION_MINUTES);
    return {
      date: slot.dateKey,
      start: slot.start,
      finish: slot.finish,
      category: detectCategory(taskText),
      task: taskText,
      source: 'Telegram',
      telegramChatId: chatId,
      slotMode: 'suggested'
    };
  }

  const category = detectCategory(rawInput);
  const durationMinutes = CONFIG.DEFAULT_TASK_DURATION_MINUTES;

  if (rawInput.length > CONFIG.MAX_TASK_LENGTH) {
    throw new Error('Task is too long.');
  }

  const slot = suggestNextFreeTaskSlot(now, durationMinutes);

  return {
    date: slot.dateKey,
    start: slot.start,
    finish: slot.finish,
    category: category,
    task: rawInput,
    source: 'Telegram',
    telegramChatId: chatId,
    slotMode: 'suggested'
  };
}

function suggestNextFreeTaskSlot(now, durationMinutes) {
  const taskInfo = {
    taskRef: 'AUTO',
    dateKey: formatDateKey(now)
  };

  const slot = findNearestFreeSlot(
    taskInfo,
    durationMinutes,
    now,
    CONFIG.RESCHEDULE_SEARCH_DAYS,
    new Date(now.getTime() + CONFIG.RESCHEDULE_BUFFER_MINUTES * 60000)
  );

  if (slot) {
    return slot;
  }

  const fallbackStart = new Date(now.getTime() + CONFIG.RESCHEDULE_BUFFER_MINUTES * 60000);
  const fallbackFinish = new Date(fallbackStart.getTime() + durationMinutes * 60000);

  return {
    dateKey: formatDateKey(now),
    start: formatTime(fallbackStart),
    finish: formatTime(fallbackFinish)
  };
}

function parseTaskWindowSpec(spec, now) {
  const value = cleanCell(spec);
  if (!value) {
    throw new Error('Missing time value.');
  }

  const normalized = value.toLowerCase();
  if (/^\d+(h|m)$/i.test(normalized) || /^\d+h\d+m$/i.test(normalized)) {
    const minutes = parseDurationMinutes(value);
    const startDate = new Date(now);
    const finishDate = new Date(startDate.getTime() + minutes * 60000);
    return {
      start: formatTime(startDate),
      finish: formatTime(finishDate)
    };
  }

  if (value.includes('-')) {
    const parts = value.split('-').map(part => cleanCell(part));
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error('Usage: /add START-FINISH | CATEGORY | TASK');
    }

    const startDate = parseTimeToken(parts[0], now);
    const finishDate = parseTimeToken(parts[1], now);

    if (finishDate <= startDate) {
      finishDate.setDate(finishDate.getDate() + 1);
    }

    return {
      start: formatTime(startDate),
      finish: formatTime(finishDate)
    };
  }

  throw new Error('Usage: /add START-FINISH | CATEGORY | TASK or /add DURATION | CATEGORY | TASK');
}

function parseTimeToken(token, now) {
  const value = cleanCell(token).toLowerCase();
  if (value === 'now') {
    return new Date(now);
  }

  const parts = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!parts) {
    throw new Error(`Invalid time value: ${token}`);
  }

  const parsed = parseTimeString(value);
  const result = new Date(now);
  result.setHours(parsed.hours, parsed.minutes, 0, 0);
  return result;
}

function parseDurationMinutes(value) {
  const normalized = cleanCell(value).toLowerCase();
  const hourMatch = normalized.match(/^(\d+)h(\d+)m$/i);
  if (hourMatch) {
    return Number(hourMatch[1]) * 60 + Number(hourMatch[2]);
  }

  const minuteMatch = normalized.match(/^(\d+)m$/i);
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }

  const hourOnlyMatch = normalized.match(/^(\d+)h$/i);
  if (hourOnlyMatch) {
    return Number(hourOnlyMatch[1]) * 60;
  }

  throw new Error(`Unsupported duration: ${value}`);
}

function detectCategory(text) {
  const normalized = cleanCell(text).toLowerCase();
  if (normalized.includes('pulse') || normalized.includes('telegram') || normalized.includes('readme')) {
    return 'PulseTask';
  }
  if (normalized.includes('research') || normalized.includes('paper') || normalized.includes('robot')) {
    return 'Research';
  }
  if (normalized.includes('gym') || normalized.includes('workout')) {
    return 'Gym';
  }
  if (normalized.includes('dev') || normalized.includes('code') || normalized.includes('app') || normalized.includes('script')) {
    return 'Development';
  }
  return 'Uncategorized';
}

function buildDraftPreview(draft) {
  const dateLabel = draft.date || formatDateKey(new Date());
  const category = draft.category || 'Uncategorized';
  const task = draft.task || '';
  const timeLabel = draft.slotMode === 'suggested'
    ? `🕐 Suggested: ${draft.start}–${draft.finish}`
    : `🕐 ${draft.start}–${draft.finish}`;

  return [
    '📝 New Unplanned Task',
    '',
    `🗓 ${dateLabel}`,
    timeLabel,
    `▪️ Category: ${category}`,
    '',
    '🔹 Task:',
    task
  ].join('\n');
}

function generateDraftId() {
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMddHHmmss');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TG${stamp}${suffix}`;
}

function confirmTaskDraft(draftId, startImmediately, chatId) {
  const cached = CacheService.getScriptCache().get(draftId);
  if (!cached) {
    return { ok: false, error: 'This draft is no longer available. Please create a new task.' };
  }

  const draft = JSON.parse(cached);
  if (chatId && draft.telegramChatId && String(draft.telegramChatId) !== String(chatId)) {
    return { ok: false, error: 'This draft belongs to a different chat.' };
  }

  const durationMinutes = calculateDurationMinutes(draft.start, draft.finish);
  if (durationMinutes <= 0) {
    return { ok: false, error: 'The task duration must be greater than zero.' };
  }

  const taskId = createTelegramDynamicTask(draft, startImmediately);
  CacheService.getScriptCache().remove(draftId);

  return {
    ok: true,
    draftId: draftId,
    taskRef: taskId,
    message: startImmediately ? '▶️ Task added and started.' : '✅ Task added.'
  };
}

function cancelTaskDraft(draftId, chatId) {
  const cached = CacheService.getScriptCache().get(draftId);
  if (!cached) {
    return { ok: false, error: 'This draft is no longer available. Please create a new task.' };
  }

  const draft = JSON.parse(cached);
  if (chatId && draft.telegramChatId && String(draft.telegramChatId) !== String(chatId)) {
    return { ok: false, error: 'This draft belongs to a different chat.' };
  }

  CacheService.getScriptCache().remove(draftId);
  return { ok: true, message: 'Draft cancelled.' };
}

function createTelegramDynamicTask(draft, startImmediately) {
  const now = getNowInConfiguredTimezone();
  const dateKey = draft.date || formatDateKey(now);
  const startTime = draft.start || formatTime(now);
  const finishTime = draft.finish || formatTime(new Date(now.getTime() + CONFIG.DEFAULT_TASK_DURATION_MINUTES * 60000));
  const durationMinutes = calculateDurationMinutes(startTime, finishTime);
  const taskId = generateTelegramTaskId(dateKey, startTime, draft.draftId);

  const item = {
    dynamicId: taskId,
    createdAt: Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    originalDate: dateKey,
    scheduleDate: dateKey,
    originalRow: '',
    originalStart: startTime,
    originalFinish: finishTime,
    previousTaskRef: '',
    newStart: startTime,
    newFinish: finishTime,
    state: draft.category || 'Uncategorized',
    status: 'Active',
    task: draft.task || '',
    reason: 'Telegram unplanned task',
    rescheduleCount: 0,
    taskType: 'Unplanned',
    source: draft.source || 'Telegram',
    startedAt: '',
    pausedAt: '',
    completedAt: '',
    actualMinutes: 0,
    plannedMinutes: durationMinutes
  };

  // Validate/create the visible inbox before committing the generated record.
  ensureTelegramQueueSection_();
  appendDynamicScheduleRow(item);
  if (!startImmediately) {
    appendTelegramQueueItem_(item, `D${taskId}`);
  }

  if (startImmediately) {
    const taskInfo = {
      taskRef: `D${taskId}`,
      originalRow: '',
      day: getWeekdayNameForDate(parseDateKey(dateKey)),
      dateKey: dateKey,
      start: startTime,
      finish: finishTime,
      state: item.state,
      task: item.task,
      isDynamic: true,
      dynamicId: taskId,
      dynamicSheetRow: getLastDynamicSheetRowById(taskId),
      originalDate: dateKey,
      taskType: item.taskType,
      source: item.source,
      plannedMinutes: durationMinutes,
      actualMinutes: 0
    };

    markTaskAsStarted(taskInfo.taskRef);
  }

  return `D${taskId}`;
}

/**
 * Creates the Telegram task inbox at L1 on the main schedule sheet.
 * Existing queue rows are preserved. Conflicting values are never overwritten.
 */
function ensureTelegramQueueSection_() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);

  const startRow = CONFIG.TELEGRAM_QUEUE_START_ROW;
  const startColumn = CONFIG.TELEGRAM_QUEUE_START_COLUMN;
  const headers = [
    'Added At',
    'Category',
    'Task',
    'Duration',
    'Suggested Slot',
    'Task Ref'
  ];
  const requiredLastColumn = startColumn + headers.length - 1;

  if (sheet.getMaxColumns() < requiredLastColumn) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      requiredLastColumn - sheet.getMaxColumns()
    );
  }

  const titleCell = sheet.getRange(startRow, startColumn);
  const currentTitle = cleanCell(titleCell.getDisplayValue());
  if (currentTitle && currentTitle !== 'Queue') {
    throw new Error('Cannot create Queue: cell L1 already contains other data.');
  }

  const headerRange = sheet.getRange(startRow + 1, startColumn, 1, headers.length);
  const currentHeaders = headerRange.getDisplayValues()[0].map(cleanCell);
  const conflictingHeader = currentHeaders.find((value, index) => value && value !== headers[index]);
  if (conflictingHeader) {
    throw new Error('Cannot create Queue: cells L2:Q2 already contain other data.');
  }

  titleCell
    .setValue('Queue')
    .setFontWeight('bold')
    .setFontSize(12)
    .setFontColor('#ffffff')
    .setBackground('#3c4043');

  sheet
    .getRange(startRow, startColumn, 1, headers.length)
    .setBackground('#3c4043');

  headerRange
    .setValues([headers])
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#5f6368')
    .setHorizontalAlignment('center');

  sheet.setColumnWidth(startColumn, 145);
  sheet.setColumnWidth(startColumn + 1, 120);
  sheet.setColumnWidth(startColumn + 2, 320);
  sheet.setColumnWidth(startColumn + 3, 90);
  sheet.setColumnWidth(startColumn + 4, 165);
  sheet.setColumnWidth(startColumn + 5, 190);

  return sheet;
}

/** Appends one confirmed Telegram task to the main-sheet Queue. */
function appendTelegramQueueItem_(item, taskRef) {
  const sheet = ensureTelegramQueueSection_();
  const startRow = CONFIG.TELEGRAM_QUEUE_START_ROW;
  const startColumn = CONFIG.TELEGRAM_QUEUE_START_COLUMN;
  const columnCount = 6;
  const firstDataRow = startRow + 2;
  const lastSheetRow = Math.max(firstDataRow - 1, sheet.getLastRow());
  const existingRows = lastSheetRow < firstDataRow
    ? []
    : sheet
      .getRange(firstDataRow, startColumn, lastSheetRow - firstDataRow + 1, columnCount)
      .getDisplayValues();

  // The task reference makes retries idempotent for the visible Queue.
  if (existingRows.some(row => cleanCell(row[5]) === cleanCell(taskRef))) return;

  let targetRow = firstDataRow;
  existingRows.forEach((row, index) => {
    if (row.some(value => cleanCell(value))) targetRow = firstDataRow + index + 1;
  });

  const suggestedSlot = `${item.scheduleDate} ${item.newStart}-${item.newFinish}`;
  const values = [[
    item.createdAt || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    item.state || 'Uncategorized',
    item.task || '',
    formatMinutes(Number(item.plannedMinutes || 0)),
    suggestedSlot,
    taskRef
  ]];

  sheet
    .getRange(targetRow, startColumn, 1, columnCount)
    .setValues(values)
    .setVerticalAlignment('top')
    .setWrap(true)
    .setBorder(true, true, true, true, true, true, '#dadce0', SpreadsheetApp.BorderStyle.SOLID);
}

/** Returns active Queue tasks for Telegram, newest additions first. */
function getTelegramQueueItems_() {
  const sheet = ensureTelegramQueueSection_();
  const firstDataRow = CONFIG.TELEGRAM_QUEUE_START_ROW + 2;
  const startColumn = CONFIG.TELEGRAM_QUEUE_START_COLUMN;
  const lastRow = sheet.getLastRow();

  if (lastRow < firstDataRow) {
    return { ok: true, items: [], total: 0 };
  }

  const activeDynamicIds = {};
  getAllDynamicTasks().forEach(item => {
    activeDynamicIds[`D${item.dynamicId}`] = item.status === 'Active';
  });

  const items = sheet
    .getRange(firstDataRow, startColumn, lastRow - firstDataRow + 1, 6)
    .getDisplayValues()
    .map((row, index) => ({
      rowNumber: firstDataRow + index,
      addedAt: cleanCell(row[0]),
      category: cleanCell(row[1]),
      task: cleanCell(row[2]),
      duration: cleanCell(row[3]),
      suggestedSlot: cleanCell(row[4]),
      taskRef: cleanCell(row[5])
    }))
    .filter(item => item.task && /^(D[A-Za-z0-9-]+)$/.test(item.taskRef) && activeDynamicIds[item.taskRef])
    .reverse();

  return {
    ok: true,
    items: items.slice(0, 12).map(item => ({
      taskRef: item.taskRef,
      category: item.category,
      task: item.task,
      duration: item.duration,
      suggestedSlot: item.suggestedSlot
    })),
    total: items.length
  };
}

/** Starts a selected Queue task and removes it from the visible inbox. */
function startTelegramQueueTask_(taskRef) {
  const queueItem = findTelegramQueueItem_(taskRef);
  if (!queueItem) {
    return { ok: false, error: 'This task is no longer available in Queue.' };
  }

  const taskInfo = getTaskInfoByRef(taskRef);
  if (!taskInfo.ok) {
    return { ok: false, error: taskInfo.message };
  }

  const result = markTaskAsStarted(taskRef);
  removeTelegramQueueItem_(queueItem.rowNumber);

  return {
    ok: true,
    taskRef: taskRef,
    task: taskInfo.task,
    message: result && result.message ? result.message : 'Task started from Queue.'
  };
}

function findTelegramQueueItem_(taskRef) {
  const sheet = ensureTelegramQueueSection_();
  const firstDataRow = CONFIG.TELEGRAM_QUEUE_START_ROW + 2;
  const startColumn = CONFIG.TELEGRAM_QUEUE_START_COLUMN;
  const lastRow = sheet.getLastRow();
  if (lastRow < firstDataRow) return null;

  const refs = sheet
    .getRange(firstDataRow, startColumn + 5, lastRow - firstDataRow + 1, 1)
    .getDisplayValues();

  for (let index = 0; index < refs.length; index++) {
    if (cleanCell(refs[index][0]) === cleanCell(taskRef)) {
      return { rowNumber: firstDataRow + index, taskRef: taskRef };
    }
  }

  return null;
}

function removeTelegramQueueItem_(rowNumber) {
  const numericRow = Number(rowNumber || 0);
  if (!Number.isInteger(numericRow) || numericRow < CONFIG.TELEGRAM_QUEUE_START_ROW + 2) return;

  ensureTelegramQueueSection_()
    .getRange(numericRow, CONFIG.TELEGRAM_QUEUE_START_COLUMN, 1, 6)
    .clearContent()
    .clearFormat();
}

function generateTelegramTaskId(dateKey, startTime, stableSeed) {
  const normalizedDate = String(dateKey || '').replace(/-/g, '');
  const normalizedStart = String(startTime || '').replace(/:/g, '');
  const stableSuffix = String(stableSeed || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-6)
    .toUpperCase();
  const suffix = stableSuffix || Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${normalizedDate}-${normalizedStart}-TG${suffix}`;
}

function getLastDynamicSheetRowById(dynamicId) {
  const sheet = getDynamicScheduleSheet();
  if (sheet.getLastRow() < 2) return null;

  const rows = sheet.getDataRange().getDisplayValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (cleanCell(rows[i][0]) === dynamicId) {
      return i + 1;
    }
  }
  return null;
}

function saveTaskAction(taskInfo, action, commandType, preventDuplicate, sessionMinutes, cumulativeActualMinutes) {
  saveActionLog({
    action: action,
    taskRef: taskInfo.taskRef,
    rowNumber: taskInfo.originalRow,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    commandType: commandType,
    source: taskInfo.source || (taskInfo.isDynamic ? 'Telegram' : ''),
    taskType: taskInfo.taskType || (taskInfo.isDynamic ? 'Rescheduled' : ''),
    plannedMinutes: taskInfo.plannedMinutes || calculateDurationMinutes(taskInfo.start, taskInfo.finish),
    actualMinutes: taskInfo.actualMinutes || 0,
    status: action,
    sessionMinutes: sessionMinutes || 0,
    cumulativeActualMinutes: cumulativeActualMinutes || 0
  }, preventDuplicate || false);
}

function getTaskInfoByRef(taskRef) {
  validateTaskRef(taskRef);

  if (taskRef.startsWith('D')) {
    const dynamicId = taskRef.substring(1);
    const item = getDynamicTaskById(dynamicId);

    if (!item || !isOpenDynamicTaskStatus_(item.status)) {
      return { ok: false, message: `Open dynamic task not found: ${dynamicId}` };
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
    item.commandType || '',
    item.source || '',
    item.taskType || '',
    item.sessionMinutes || '',
    item.cumulativeActualMinutes || '',
    item.status || '',
    item.plannedMinutes || ''
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
  searchDays,
  minimumStart
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
      const defaultEarliest = new Date(
        now.getTime() + CONFIG.RESCHEDULE_BUFFER_MINUTES * 60000
      );

      const requestedEarliest = minimumStart instanceof Date
        ? minimumStart
        : defaultEarliest;

      earliest = roundDateUpToMinutes(
        requestedEarliest > defaultEarliest
          ? requestedEarliest
          : defaultEarliest,
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
    rescheduleCount: Number(row[14] || 0),
    taskType: row[15] || '',
    source: row[16] || '',
    startedAt: row[17] || '',
    pausedAt: row[18] || '',
    completedAt: row[19] || '',
    actualMinutes: Number(row[20] || 0),
    plannedMinutes: Number(row[21] || 0)
  }));
}

function getAllActiveDynamicTasks() {
  return getAllDynamicTasks().filter(item => isOpenDynamicTaskStatus_(item.status));
}

function isOpenDynamicTaskStatus_(status) {
  return ['Active', 'Started', 'Paused'].includes(cleanCell(status));
}

function getActiveDynamicTasksForDate(dateKey) {
  return getAllActiveDynamicTasks().filter(item => item.scheduleDate === dateKey);
}

function getDynamicTaskById(dynamicId) {
  const matches = getAllDynamicTasks().filter(item => item.dynamicId === dynamicId);
  return matches.length ? matches[matches.length - 1] : null;
}

function getTrackedTaskState(taskInfo) {
  if (!taskInfo || !taskInfo.isDynamic || !taskInfo.dynamicId) {
    return { status: '', startedAt: '', pausedAt: '', completedAt: '', actualMinutes: 0 };
  }

  const current = getDynamicTaskById(taskInfo.dynamicId);
  return {
    status: current ? current.status : '',
    startedAt: current ? current.startedAt : '',
    pausedAt: current ? current.pausedAt : '',
    completedAt: current ? current.completedAt : '',
    actualMinutes: current ? Number(current.actualMinutes || 0) : 0
  };
}

function updateTrackedTaskState(taskInfo, changes) {
  if (!taskInfo || !taskInfo.isDynamic || !taskInfo.dynamicId) {
    return;
  }

  const sheet = getDynamicScheduleSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(cleanCell);
  const row = taskInfo.dynamicSheetRow || getLastDynamicSheetRowById(taskInfo.dynamicId);
  if (!row) return;

  const mapping = {
    status: 'Status',
    startedAt: 'Started At',
    pausedAt: 'Paused At',
    completedAt: 'Completed At',
    actualMinutes: 'Actual Minutes',
    plannedMinutes: 'Planned Minutes',
    taskType: 'Task Type',
    source: 'Source'
  };

  Object.keys(changes).forEach(key => {
    const header = mapping[key];
    if (!header) return;
    const columnIndex = headers.indexOf(header);
    if (columnIndex >= 0) {
      sheet.getRange(row, columnIndex + 1).setValue(changes[key]);
    }
  });
}

function calculateSessionMinutesFromTimestamp(startedAt, finishedAt) {
  if (!startedAt) return 0;
  const start = new Date(startedAt);
  const finish = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  if (isNaN(start.getTime()) || isNaN(finish.getTime())) return 0;
  return Math.max(0, Math.round((finish.getTime() - start.getTime()) / 60000));
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
    item.rescheduleCount,
    item.taskType || '',
    item.source || '',
    item.startedAt || '',
    item.pausedAt || '',
    item.completedAt || '',
    item.actualMinutes || 0,
    item.plannedMinutes || ''
  ]);
}

function setTaskCellStatusColor(rowNumber, status) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);

  const numericRow = Number(rowNumber || 0);
  if (!Number.isInteger(numericRow) || numericRow < 2) {
    return;
  }

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
    .getRange(numericRow, todayCol + 1)
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
  let actualMinutes = 0;
  let plannedMinutes = 0;
  let unplannedMinutes = 0;

  const stateMinutes = {};
  const energyValues = [];
  const hourlyEnergy = {};
  const categoryTotals = {};
  const categoryBreakdown = {};

  actionRows.forEach(row => {
    if (!isDateInRange(row.actionDate, startDate, endDate)) return;

    const taskKey = `${row.actionDate}:${row.taskRef || row.rowNumber}`;

    if (row.action === 'Pending') uniquePending[taskKey] = true;

    if (row.action === 'Done' && !uniqueDone[taskKey]) {
      uniqueDone[taskKey] = true;

      const duration = Number(row.cumulativeActualMinutes || row.sessionMinutes || 0);
      const plannedDuration = Number(row.plannedMinutes || 0);
      actualMinutes += duration;
      plannedMinutes += plannedDuration;

      const stateName = row.state || 'Uncategorized';
      stateMinutes[stateName] = (stateMinutes[stateName] || 0) + duration;
      categoryTotals[stateName] = (categoryTotals[stateName] || 0) + duration;

      if (!categoryBreakdown[stateName]) {
        categoryBreakdown[stateName] = {
          category: stateName,
          plannedMinutes: 0,
          actualMinutes: 0,
          completedTasks: 0,
          skippedTasks: 0,
          unplannedTasks: 0
        };
      }

      categoryBreakdown[stateName].plannedMinutes += plannedDuration;
      categoryBreakdown[stateName].actualMinutes += duration;
      categoryBreakdown[stateName].completedTasks += 1;

      if (String(row.taskType || '').toLowerCase() === 'unplanned' || String(row.source || '').toLowerCase() === 'telegram') {
        categoryBreakdown[stateName].unplannedTasks += 1;
        unplannedMinutes += duration;
      }
    }

    if (row.action === 'Skipped' && !uniqueSkipped[taskKey]) {
      uniqueSkipped[taskKey] = true;

      const stateName = row.state || 'Uncategorized';
      if (!categoryBreakdown[stateName]) {
        categoryBreakdown[stateName] = {
          category: stateName,
          plannedMinutes: 0,
          actualMinutes: 0,
          completedTasks: 0,
          skippedTasks: 0,
          unplannedTasks: 0
        };
      }

      categoryBreakdown[stateName].skippedTasks += 1;

      if (String(row.taskType || '').toLowerCase() === 'unplanned' || String(row.source || '').toLowerCase() === 'telegram') {
        categoryBreakdown[stateName].unplannedTasks += 1;
      }
    }
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
    `⏱ Actual Time: ${formatMinutes(actualMinutes)}`,
    `🗓 Planned Time: ${formatMinutes(plannedMinutes)}`,
    `🧩 Unplanned Time: ${formatMinutes(unplannedMinutes)}`,
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

  const categorySummary = Object.keys(categoryTotals).map(name => `${name}: ${formatMinutes(categoryTotals[name])}`).join(', ');
  if (categorySummary) {
    lines.push('', '📂 Time by category:', categorySummary);
  }

  const categoryRows = Object.keys(categoryBreakdown)
    .map(name => {
      const entry = categoryBreakdown[name];
      const denominator = entry.completedTasks + entry.skippedTasks;
      return {
        category: entry.category,
        plannedMinutes: entry.plannedMinutes,
        actualMinutes: entry.actualMinutes,
        completedTasks: entry.completedTasks,
        skippedTasks: entry.skippedTasks,
        unplannedTasks: entry.unplannedTasks,
        completionRate: denominator > 0 ? Math.round((entry.completedTasks / denominator) * 100) : 0
      };
    })
    .sort((a, b) => b.actualMinutes - a.actualMinutes);

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
    productiveMinutes: actualMinutes,
    actualMinutes: actualMinutes,
    plannedMinutes: plannedMinutes,
    unplannedMinutes: unplannedMinutes,
    avgEnergy: averageEnergy,
    bestState,
    bestHour,
    categoryTotals,
    categoryBreakdown: categoryRows,
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

  ensureWeeklyReportColumns(sheet);

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
    report.actualMinutes,
    report.plannedMinutes,
    report.unplannedMinutes,
    report.avgEnergy,
    report.bestState.name || '',
    report.bestState.minutes || '',
    report.bestHour.label || '',
    report.bestHour.energy || ''
  ]);

  sheet.appendRow(['Category Breakdown', '', '', '', '', '', '']);
  sheet.appendRow(['Category', 'Planned Minutes', 'Actual Minutes', 'Completed Tasks', 'Skipped Tasks', 'Unplanned Tasks', 'Completion Rate']);

  (report.categoryBreakdown || []).forEach(item => {
    sheet.appendRow([
      item.category || '',
      item.plannedMinutes || 0,
      item.actualMinutes || 0,
      item.completedTasks || 0,
      item.skippedTasks || 0,
      item.unplannedTasks || 0,
      `${item.completionRate || 0}%`
    ]);
  });

  sheet.appendRow([]);
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
    commandType: row[12],
    source: row[13],
    taskType: row[14],
    sessionMinutes: row[15],
    cumulativeActualMinutes: row[16],
    status: row[17],
    plannedMinutes: row[18]
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
    'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Command Type',
    'Source', 'Task Type', 'Session Minutes', 'Cumulative Actual Minutes',
    'Status', 'Planned Minutes'
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
    'Reschedule Count', 'Task Type', 'Source', 'Started At', 'Paused At',
    'Completed At', 'Actual Minutes', 'Planned Minutes'
  ]);
  formatHeaderRow(sheet);
}

function createWeeklyReportHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Created At', 'Start Date', 'End Date', 'Pending', 'Done', 'Skipped',
    'Started', 'Paused', 'Later', 'Completion Rate', 'Productive Minutes',
    'Actual Minutes', 'Planned Minutes', 'Unplanned Minutes', 'Average Energy',
    'Best State', 'Best State Minutes', 'Best Hour', 'Best Hour Energy'
  ]);
  formatHeaderRow(sheet);
}

function ensureWeeklyReportColumns(sheet) {
  const requiredHeaders = [
    'Created At', 'Start Date', 'End Date', 'Pending', 'Done', 'Skipped',
    'Started', 'Paused', 'Later', 'Completion Rate', 'Productive Minutes',
    'Actual Minutes', 'Planned Minutes', 'Unplanned Minutes', 'Average Energy',
    'Best State', 'Best State Minutes', 'Best Hour', 'Best Hour Energy'
  ];

  const currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(cleanCell);
  const missing = requiredHeaders.filter(header => !currentHeaders.includes(header));

  if (missing.length === 0) return;

  const newHeaders = currentHeaders.concat(missing);
  sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
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
 * Runs lightweight internal checks without modifying schedule data.
 */
function runPulseTaskTests() {
  const results = [];

  function assert_(name, condition) {
    if (!condition) throw new Error(`Test failed: ${name}`);
    results.push(`✅ ${name}`);
  }

  const time24 = parseTimeString('17:30');
  assert_('24-hour time parsing', time24.hours === 17 && time24.minutes === 30);

  const time12 = parseTimeString('6:30 PM');
  assert_('12-hour time parsing', time12.hours === 18 && time12.minutes === 30);

  assert_('normal duration', calculateDurationMinutes('09:00', '10:30') === 90);
  assert_('cross-midnight duration', calculateDurationMinutes('23:30', '00:30') === 60);
  assert_('static task reference', /^(S\d+)$/.test('S12'));
  assert_('dynamic task reference', /^(D[A-Za-z0-9-]+)$/.test('D20260702-R12-V1'));
  assert_('started task remains open', isOpenDynamicTaskStatus_('Started'));
  assert_('completed task is closed', !isOpenDynamicTaskStatus_('Completed'));
  assert_(
    'stable Telegram task reference',
    generateTelegramTaskId('2026-07-02', '09:30', 'TG20260702093000ABC123') === '20260702-0930-TGABC123'
  );

  const start = combineDateKeyWithTime('2026-07-02', '09:00');
  const end = combineDateKeyWithTime('2026-07-02', '18:00');
  const intervals = [{
    start: combineDateKeyWithTime('2026-07-02', '09:00'),
    finish: combineDateKeyWithTime('2026-07-02', '11:00')
  }];
  const gap = findGapInIntervals(start, end, 60, intervals, 5);
  assert_('free-slot detection', gap && formatTime(gap.start) === '11:05');

  Logger.log(results.join('\n'));
  return results;
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
    ensureTelegramQueueSection_();
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
