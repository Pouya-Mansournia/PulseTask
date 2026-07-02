const CONFIG = {
  // Telegram credentials
  BOT_TOKEN: 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE',
  CHAT_ID: 'PUT_YOUR_TELEGRAM_CHAT_ID_HERE',

  // Must exactly match WORKER_API_SECRET stored in Cloudflare
  WORKER_API_SECRET: 'PUT_YOUR_LONG_SHARED_SECRET_HERE',

  // Main schedule sheet
  SHEET_NAME: 'Sheet1',

  // Generated sheets
  ACTION_LOG_SHEET_NAME: 'Action_Log',
  MOOD_LOG_SHEET_NAME: 'Mood_Log',
  WEEKLY_REPORT_SHEET_NAME: 'Weekly_Report',
  ENERGY_HEATMAP_SHEET_NAME: 'Energy_Heatmap',
  REMINDER_LOG_SHEET_NAME: 'Reminder_Log',

  // Time configuration
  TIMEZONE: 'Asia/Tehran',

  // Reminder configuration
  REMINDER_MINUTES_BEFORE: 60,
  REMINDER_WINDOW_MINUTES: 5,

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
      return createJsonResponse({
        ok: false,
        error: 'Missing request body'
      });
    }

    const payload = JSON.parse(e.postData.contents);

    if (!payload.secret || payload.secret !== CONFIG.WORKER_API_SECRET) {
      return createJsonResponse({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const action = cleanCell(payload.action);
    const rowNumber = Number(payload.rowNumber || 0);
    const energyValue = Number(payload.energyValue || 0);

    if (action === 'done') {
      validateTaskRow(rowNumber);
      markSpecificRowAsDone(rowNumber);

    } else if (action === 'skip') {
      validateTaskRow(rowNumber);
      markSpecificRowAsSkipped(rowNumber);

    } else if (action === 'start') {
      validateTaskRow(rowNumber);
      markSpecificRowAsStarted(rowNumber);

    } else if (action === 'pause') {
      validateTaskRow(rowNumber);
      markSpecificRowAsPaused(rowNumber);

    } else if (action === 'later30') {
      validateTaskRow(rowNumber);
      markSpecificRowAsLater(rowNumber, 30);

    } else if (action === 'energy') {
      validateTaskRow(rowNumber);

      if (!Number.isInteger(energyValue) || energyValue < 1 || energyValue > 5) {
        throw new Error('Energy value must be between 1 and 5.');
      }

      markSpecificRowEnergy(rowNumber, energyValue);

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
      rowNumber: rowNumber || null,
      energyValue: energyValue || null
    });

  } catch (error) {
    Logger.log(`Worker API error: ${error.stack || error.message}`);

    return createJsonResponse({
      ok: false,
      error: error.message
    });
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

/** Validates a schedule row number. */
function validateTaskRow(rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error(`Invalid row number: ${rowNumber}`);
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
    const sheet = SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(CONFIG.SHEET_NAME);

    if (!sheet) {
      throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);
    }

    const data = sheet.getDataRange().getDisplayValues();

    if (!data || data.length < 2) {
      Logger.log('Schedule sheet is empty.');
      return;
    }

    const headers = data[0].map(value => cleanCell(value));
    const startCol = headers.indexOf('Start');
    const finishCol = headers.indexOf('Finish');
    const stateCol = headers.indexOf('State');
    const todayName = getTodayColumnName();
    const todayCol = headers.indexOf(todayName);

    if (startCol === -1 || finishCol === -1 || stateCol === -1 || todayCol === -1) {
      throw new Error(
        'Required columns were not found. Required: Start, Finish, State, and weekday columns.'
      );
    }

    const now = getNowInConfiguredTimezone();
    const reminderTarget = new Date(
      now.getTime() + CONFIG.REMINDER_MINUTES_BEFORE * 60 * 1000
    );
    const windowStart = new Date(
      reminderTarget.getTime() - CONFIG.REMINDER_WINDOW_MINUTES * 60 * 1000
    );
    const windowEnd = new Date(
      reminderTarget.getTime() + CONFIG.REMINDER_WINDOW_MINUTES * 60 * 1000
    );

    for (let i = 1; i < data.length; i++) {
      const rowNumber = i + 1;
      const row = data[i];
      const startTime = cleanCell(row[startCol]);
      const finishTime = cleanCell(row[finishCol]);
      const state = cleanCell(row[stateCol]);
      const task = cleanCell(row[todayCol]);

      if (isEmptyTask(startTime) || isEmptyTask(finishTime) || isEmptyTask(task)) {
        continue;
      }

      let startDateTime;
      let finishDateTime;

      try {
        startDateTime = combineTodayWithTime(startTime, now);
        finishDateTime = combineTodayWithTime(finishTime, now);
      } catch (error) {
        Logger.log(`Skipped schedule row ${rowNumber}: ${error.message}`);
        continue;
      }

      if (finishDateTime <= startDateTime) {
        finishDateTime.setDate(finishDateTime.getDate() + 1);
      }

      const shouldSend = startDateTime >= windowStart && startDateTime <= windowEnd;
      if (!shouldSend) continue;

      if (wasReminderAlreadySentToday(rowNumber, startTime)) {
        Logger.log(`Reminder already sent for row ${rowNumber} at ${startTime}.`);
        continue;
      }

      const item = {
        rowNumber: rowNumber,
        start: formatTime(startDateTime),
        finish: formatTime(finishDateTime),
        state: state,
        task: task
      };

      sendSingleUpcomingTaskReminder(todayName, item);
      setTaskCellStatusColor(rowNumber, 'pending');

      saveActionLog({
        action: 'Pending',
        rowNumber: rowNumber,
        day: todayName,
        start: item.start,
        finish: item.finish,
        state: item.state,
        task: item.task,
        commandType: 'one-hour reminder'
      }, true);

      saveReminderSentLog(rowNumber, startTime, todayName, task);
    }

  } finally {
    lock.releaseLock();
  }
}

/** Sends one task reminder with Telegram inline buttons. */
function sendSingleUpcomingTaskReminder(todayName, item) {
  const message = [
    '⏰ One-Hour Reminder',
    '',
    `🗓 ${todayName}`,
    `🕐 ${item.start} to ${item.finish}`,
    !isEmptyTask(item.state) ? `▪️ Category: ${item.state}` : '',
    '',
    '🔹 Task:',
    item.task
  ]
    .filter(line => line !== '')
    .join('\n');

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Done', callback_data: `done:${item.rowNumber}` },
        { text: '⏭ Skip', callback_data: `skip:${item.rowNumber}` }
      ],
      [
        { text: '⏱ Start', callback_data: `start:${item.rowNumber}` },
        { text: '⏸ Pause', callback_data: `pause:${item.rowNumber}` },
        { text: '🔁 Later', callback_data: `later30:${item.rowNumber}` }
      ],
      [
        { text: '🔥1', callback_data: `energyval:${item.rowNumber}:1` },
        { text: '🔥2', callback_data: `energyval:${item.rowNumber}:2` },
        { text: '🔥3', callback_data: `energyval:${item.rowNumber}:3` },
        { text: '🔥4', callback_data: `energyval:${item.rowNumber}:4` },
        { text: '🔥5', callback_data: `energyval:${item.rowNumber}:5` }
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

/** Checks whether a reminder was already sent today. */
function wasReminderAlreadySentToday(rowNumber, startTime) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.REMINDER_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return false;

  const data = sheet.getDataRange().getDisplayValues();
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');

  for (let i = 1; i < data.length; i++) {
    const reminderDate = cleanCell(data[i][1]);
    const loggedRow = Number(data[i][3]);
    const loggedStart = cleanCell(data[i][4]);

    if (
      reminderDate === today &&
      loggedRow === Number(rowNumber) &&
      loggedStart === cleanCell(startTime)
    ) {
      return true;
    }
  }

  return false;
}

/** Saves a sent reminder record. */
function saveReminderSentLog(rowNumber, startTime, day, task) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.REMINDER_LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.REMINDER_LOG_SHEET_NAME);
    createReminderLogHeader(sheet);
  }

  const now = new Date();

  sheet.appendRow([
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    day,
    rowNumber,
    startTime,
    task
  ]);
}

function markSpecificRowAsDone(rowNumber) {
  const taskInfo = getTaskInfoByRow(rowNumber);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  if (!isAlreadyLoggedToday(rowNumber, 'Done')) {
    saveActionLog({
      action: 'Done',
      rowNumber,
      day: taskInfo.day,
      start: taskInfo.start,
      finish: taskInfo.finish,
      state: taskInfo.state,
      task: taskInfo.task,
      commandType: 'cloudflare done button'
    }, false);
  }

  setTaskCellStatusColor(rowNumber, 'done');
}

function markSpecificRowAsSkipped(rowNumber) {
  const taskInfo = getTaskInfoByRow(rowNumber);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  if (!isAlreadyLoggedToday(rowNumber, 'Skipped')) {
    saveActionLog({
      action: 'Skipped',
      rowNumber,
      day: taskInfo.day,
      start: taskInfo.start,
      finish: taskInfo.finish,
      state: taskInfo.state,
      task: taskInfo.task,
      commandType: 'cloudflare skip button'
    }, false);
  }

  setTaskCellStatusColor(rowNumber, 'skipped');
}

function markSpecificRowAsStarted(rowNumber) {
  const taskInfo = getTaskInfoByRow(rowNumber);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  saveActionLog({
    action: 'Started',
    rowNumber,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    commandType: 'cloudflare start button'
  }, false);

  setTaskCellStatusColor(rowNumber, 'started');
}

function markSpecificRowAsPaused(rowNumber) {
  const taskInfo = getTaskInfoByRow(rowNumber);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  saveActionLog({
    action: 'Paused',
    rowNumber,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    commandType: 'cloudflare pause button'
  }, false);

  setTaskCellStatusColor(rowNumber, 'paused');
}

function markSpecificRowAsLater(rowNumber, minutes) {
  const taskInfo = getTaskInfoByRow(rowNumber);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  saveActionLog({
    action: `Later ${minutes}m`,
    rowNumber,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    commandType: 'cloudflare later button'
  }, false);

  setTaskCellStatusColor(rowNumber, 'skipped');
}

function markSpecificRowEnergy(rowNumber, energyValue) {
  const taskInfo = getTaskInfoByRow(rowNumber);
  if (!taskInfo.ok) throw new Error(taskInfo.message);

  const mood = energyToMoodLabel(energyValue);

  saveMoodLog({
    rowNumber,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    energy: energyValue,
    mood,
    source: 'cloudflare energy button'
  });

  saveActionLog({
    action: `Energy ${energyValue}/5`,
    rowNumber,
    day: taskInfo.day,
    start: taskInfo.start,
    finish: taskInfo.finish,
    state: taskInfo.state,
    task: taskInfo.task,
    energy: energyValue,
    mood,
    commandType: 'cloudflare energy button'
  }, false);
}

function getTaskInfoByRow(rowNumber) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    return { ok: false, message: `Sheet not found: ${CONFIG.SHEET_NAME}` };
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > lastRow) {
    return { ok: false, message: `Invalid schedule row: ${rowNumber}` };
  }

  const headers = sheet
    .getRange(1, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map(value => cleanCell(value));

  const row = sheet
    .getRange(rowNumber, 1, 1, lastCol)
    .getDisplayValues()[0];

  const startCol = headers.indexOf('Start');
  const finishCol = headers.indexOf('Finish');
  const stateCol = headers.indexOf('State');
  const todayName = getTodayColumnName();
  const todayCol = headers.indexOf(todayName);

  if (startCol === -1 || finishCol === -1 || stateCol === -1 || todayCol === -1) {
    return { ok: false, message: 'Required schedule columns were not found.' };
  }

  const start = cleanCell(row[startCol]);
  const finish = cleanCell(row[finishCol]);
  const state = cleanCell(row[stateCol]);
  const task = cleanCell(row[todayCol]);

  if (isEmptyTask(task)) {
    return { ok: false, message: `Row ${rowNumber} has no task for ${todayName}.` };
  }

  return {
    ok: true,
    rowNumber,
    day: todayName,
    start,
    finish,
    state,
    task
  };
}

function saveActionLog(item, preventDuplicate) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ACTION_LOG_SHEET_NAME);
    createActionLogHeader(sheet);
  }

  if (preventDuplicate && isAlreadyLoggedToday(item.rowNumber, item.action)) {
    return;
  }

  const now = new Date();

  sheet.appendRow([
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    item.action || '',
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

function isAlreadyLoggedToday(rowNumber, action) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return false;

  const data = sheet.getDataRange().getDisplayValues();
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');

  for (let i = 1; i < data.length; i++) {
    const actionDate = cleanCell(data[i][1]);
    const loggedAction = cleanCell(data[i][2]);
    const loggedRow = Number(data[i][4]);

    if (
      actionDate === today &&
      loggedAction === action &&
      loggedRow === Number(rowNumber)
    ) {
      return true;
    }
  }

  return false;
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

    const taskKey = `${row.actionDate}:${row.rowNumber}`;

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
    day: row[3],
    rowNumber: row[4],
    start: row[5],
    finish: row[6],
    state: row[7],
    task: row[8],
    energy: row[9],
    mood: row[10],
    commandType: row[11]
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
    rowNumber: row[4],
    start: row[5],
    finish: row[6],
    state: row[7],
    task: row[8],
    energy: row[9],
    mood: row[10],
    source: row[11]
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

  const weeklyReport = ss.insertSheet(CONFIG.WEEKLY_REPORT_SHEET_NAME);
  createWeeklyReportHeader(weeklyReport);

  const heatmap = ss.insertSheet(CONFIG.ENERGY_HEATMAP_SHEET_NAME);
  createEnergyHeatmapHeader(heatmap);
}

function createActionLogHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Action At', 'Action Date', 'Action', 'Day', 'Row Number',
    'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Command Type'
  ]);
  formatHeaderRow(sheet);
}

function createMoodLogHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Logged At', 'Date', 'Day', 'Hour', 'Row Number',
    'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Source'
  ]);
  formatHeaderRow(sheet);
}

function createReminderLogHeader(sheet) {
  sheet.clear();
  sheet.appendRow([
    'Sent At', 'Reminder Date', 'Day', 'Row Number', 'Start', 'Task'
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

/** Sends the next upcoming task immediately for testing. */
function testNextUpcomingReminder() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) throw new Error(`Sheet not found: ${CONFIG.SHEET_NAME}`);

  const data = sheet.getDataRange().getDisplayValues();
  const headers = data[0].map(value => cleanCell(value));
  const startCol = headers.indexOf('Start');
  const finishCol = headers.indexOf('Finish');
  const stateCol = headers.indexOf('State');
  const todayName = getTodayColumnName();
  const todayCol = headers.indexOf(todayName);
  const now = getNowInConfiguredTimezone();
  const candidates = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const startTime = cleanCell(row[startCol]);
    const finishTime = cleanCell(row[finishCol]);
    const state = cleanCell(row[stateCol]);
    const task = cleanCell(row[todayCol]);

    if (isEmptyTask(startTime) || isEmptyTask(finishTime) || isEmptyTask(task)) {
      continue;
    }

    const startDateTime = combineTodayWithTime(startTime, now);
    let finishDateTime = combineTodayWithTime(finishTime, now);

    if (finishDateTime <= startDateTime) {
      finishDateTime.setDate(finishDateTime.getDate() + 1);
    }

    if (startDateTime > now) {
      candidates.push({
        rowNumber: i + 1,
        startDateTime,
        start: formatTime(startDateTime),
        finish: formatTime(finishDateTime),
        state,
        task
      });
    }
  }

  candidates.sort((a, b) => a.startDateTime.getTime() - b.startDateTime.getTime());

  if (candidates.length === 0) {
    sendTelegramMessage('⚠️ No upcoming task was found for today.');
    return;
  }

  sendSingleUpcomingTaskReminder(todayName, candidates[0]);
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
  const dayNumber = Number(
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'u')
  );

  return {
    1: 'Monday',
    2: 'Tuesday',
    3: 'Wednesday',
    4: 'Thursday',
    5: 'Friday',
    6: 'Saturday',
    7: 'Sunday'
  }[dayNumber];
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
