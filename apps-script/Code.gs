/**
 * Telegram Life Tracker — Google Apps Script Backend
 *
 * Responsibilities:
 * - Read the weekly schedule from Google Sheets
 * - Send the next 4-hour schedule to Telegram
 * - Receive authenticated actions from Cloudflare Worker
 * - Store task actions and mood/energy logs
 * - Produce daily/weekly analytics and an hourly energy heatmap
 *
 * Required Script Properties:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 * - WORKER_API_SECRET
 *
 * Optional Script Properties:
 * - MAIN_SHEET_NAME (default: Sheet1)
 * - TIMEZONE (default: Asia/Tehran)
 */

const CONFIG = {
  SHEET_NAME: getScriptProperty_('MAIN_SHEET_NAME', 'Sheet1'),
  ACTION_LOG_SHEET_NAME: 'Action_Log',
  MOOD_LOG_SHEET_NAME: 'Mood_Log',
  WEEKLY_REPORT_SHEET_NAME: 'Weekly_Report',
  ENERGY_HEATMAP_SHEET_NAME: 'Energy_Heatmap',

  TIMEZONE: getScriptProperty_('TIMEZONE', 'Asia/Tehran'),
  HOURS_AHEAD: 4,

  DONE_COLOR: '#b7e1cd',
  PENDING_COLOR: '#f4c7c3',
  SKIPPED_COLOR: '#fce8b2',
  STARTED_COLOR: '#cfe2f3',
  PAUSED_COLOR: '#d9d2e9',
  DEFAULT_COLOR: '#ffffff'
};

/**
 * Secure API endpoint called by Cloudflare Worker.
 * Telegram must point to the Worker URL, not this Apps Script URL.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: 'Missing request body' });
    }

    const payload = JSON.parse(e.postData.contents);
    const expectedSecret = requireScriptProperty_('WORKER_API_SECRET');

    if (!payload.secret || payload.secret !== expectedSecret) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    const action = String(payload.action || '').trim();
    const rowNumber = Number(payload.rowNumber || 0);
    const energyValue = Number(payload.energyValue || 0);

    switch (action) {
      case 'done':
        validateTaskRow_(rowNumber);
        markSpecificRowAsDone(rowNumber);
        break;
      case 'skip':
        validateTaskRow_(rowNumber);
        markSpecificRowAsSkipped(rowNumber);
        break;
      case 'start':
        validateTaskRow_(rowNumber);
        markSpecificRowAsStarted(rowNumber);
        break;
      case 'pause':
        validateTaskRow_(rowNumber);
        markSpecificRowAsPaused(rowNumber);
        break;
      case 'later30':
        validateTaskRow_(rowNumber);
        markSpecificRowAsLater(rowNumber, 30);
        break;
      case 'energy':
        validateTaskRow_(rowNumber);
        if (!Number.isInteger(energyValue) || energyValue < 1 || energyValue > 5) {
          throw new Error('Energy value must be an integer between 1 and 5.');
        }
        markSpecificRowEnergy(rowNumber, energyValue);
        break;
      case 'report_today':
        sendTodayReportToTelegram();
        break;
      case 'report_week':
        sendWeeklyReportTextOnlyToTelegram();
        break;
      case 'heatmap':
        buildEnergyHeatmapSheet(7);
        sendTelegramMessage('🟩 Energy heatmap was updated successfully.');
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return jsonResponse_({
      ok: true,
      action,
      rowNumber: rowNumber || null,
      processedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
    });
  } catch (error) {
    console.error(error.stack || error.message);
    return jsonResponse_({ ok: false, error: error.message });
  }
}

/** Health-check endpoint. */
function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'Telegram Life Tracker Apps Script Backend',
    timezone: CONFIG.TIMEZONE
  });
}

/**
 * Reads today's schedule and sends tasks overlapping the next 4 hours.
 * Install this as an every-4-hours time trigger.
 */
function sendNext4HoursPlanToTelegram() {
  const sheet = getMainSheet_();
  const data = sheet.getDataRange().getDisplayValues();

  if (data.length < 2) {
    console.log('Main schedule sheet is empty.');
    return;
  }

  const headers = normalizeHeaders_(data[0]);
  const startCol = headers.indexOf('Start');
  const finishCol = headers.indexOf('Finish');
  const stateCol = headers.indexOf('State');
  const todayName = getTodayColumnName();
  const todayCol = headers.indexOf(todayName);

  if ([startCol, finishCol, stateCol, todayCol].some(index => index === -1)) {
    throw new Error(`Required columns not found. Today column: ${todayName}`);
  }

  const now = getNowInConfiguredTimezone();
  const windowEnd = new Date(now.getTime() + CONFIG.HOURS_AHEAD * 60 * 60 * 1000);
  const items = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const startTime = cleanCell(row[startCol]);
    const finishTime = cleanCell(row[finishCol]);
    const state = cleanCell(row[stateCol]);
    const task = cleanCell(row[todayCol]);

    if (isEmptyTask(startTime) || isEmptyTask(finishTime) || isEmptyTask(task)) continue;

    try {
      const startDateTime = combineTodayWithTime(startTime, now);
      const finishDateTime = combineTodayWithTime(finishTime, now);

      if (finishDateTime <= startDateTime) {
        finishDateTime.setDate(finishDateTime.getDate() + 1);
      }

      if (finishDateTime > now && startDateTime < windowEnd) {
        items.push({
          rowNumber: i + 1,
          start: formatTime(startDateTime),
          finish: formatTime(finishDateTime),
          state,
          task
        });
      }
    } catch (error) {
      console.warn(`Skipped schedule row ${i + 1}: ${error.message}`);
    }
  }

  if (items.length === 0) {
    console.log('No tasks overlap the next schedule window.');
    return;
  }

  markSentItemsAsPending(items);

  sendTelegramMessage(
    `🗓 Next ${CONFIG.HOURS_AHEAD}-hour plan\n` +
    `Day: ${todayName}\n` +
    `⏰ Window: ${formatTime(now)} to ${formatTime(windowEnd)}\n\n` +
    `Log each task's status using the buttons below.`
  );

  items.forEach(item => {
    saveActionLog({
      action: 'Pending',
      rowNumber: item.rowNumber,
      day: todayName,
      start: item.start,
      finish: item.finish,
      state: item.state,
      task: item.task,
      commandType: 'scheduled reminder'
    }, true);

    sendTaskMessageWithButtons(todayName, item);
  });
}

/** Sends one task with inline buttons that are handled by Cloudflare Worker. */
function sendTaskMessageWithButtons(todayName, item) {
  const message = [
    `🗓 ${todayName}`,
    `⏰ ${item.start} to ${item.finish}`,
    !isEmptyTask(item.state) ? `▪️ Section: ${item.state}` : '',
    '',
    '🔹 Task:',
    item.task
  ].filter(Boolean).join('\n');

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
      [1, 2, 3, 4, 5].map(value => ({
        text: `🔥${value}`,
        callback_data: `energyval:${item.rowNumber}:${value}`
      })),
      [
        { text: '📊 Today', callback_data: 'report:today' },
        { text: '📈 Week', callback_data: 'report:week' },
        { text: '🟩 Heatmap', callback_data: 'report:heatmap' }
      ]
    ]
  };

  sendTelegramMessageWithKeyboard(message, keyboard);
}

function markSpecificRowAsDone(rowNumber) {
  const task = requireTaskInfo_(rowNumber);
  if (!isAlreadyLoggedToday(rowNumber, 'Done')) {
    saveActionLog({ ...task, action: 'Done', commandType: 'Telegram button' }, false);
  }
  setTaskCellStatusColor(rowNumber, 'done');
}

function markSpecificRowAsSkipped(rowNumber) {
  const task = requireTaskInfo_(rowNumber);
  if (!isAlreadyLoggedToday(rowNumber, 'Skipped')) {
    saveActionLog({ ...task, action: 'Skipped', commandType: 'Telegram button' }, false);
  }
  setTaskCellStatusColor(rowNumber, 'skipped');
}

function markSpecificRowAsStarted(rowNumber) {
  const task = requireTaskInfo_(rowNumber);
  saveActionLog({ ...task, action: 'Started', commandType: 'Telegram button' }, false);
  setTaskCellStatusColor(rowNumber, 'started');
}

function markSpecificRowAsPaused(rowNumber) {
  const task = requireTaskInfo_(rowNumber);
  saveActionLog({ ...task, action: 'Paused', commandType: 'Telegram button' }, false);
  setTaskCellStatusColor(rowNumber, 'paused');
}

function markSpecificRowAsLater(rowNumber, minutes) {
  const task = requireTaskInfo_(rowNumber);
  saveActionLog({ ...task, action: `Later ${minutes}m`, commandType: 'Telegram button' }, false);
  setTaskCellStatusColor(rowNumber, 'skipped');
}

function markSpecificRowEnergy(rowNumber, energyValue) {
  const task = requireTaskInfo_(rowNumber);
  const mood = energyToMoodLabel(energyValue);

  saveMoodLog({
    ...task,
    energy: energyValue,
    mood,
    source: 'Telegram energy button'
  });

  saveActionLog({
    ...task,
    action: `Energy ${energyValue}/5`,
    energy: energyValue,
    mood,
    commandType: 'Telegram energy button'
  }, false);
}

function getTaskInfoByRow(rowNumber) {
  const sheet = getMainSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > lastRow) {
    return { ok: false, message: `Invalid schedule row: ${rowNumber}` };
  }

  const headers = normalizeHeaders_(sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0]);
  const row = sheet.getRange(rowNumber, 1, 1, lastCol).getDisplayValues()[0];
  const todayName = getTodayColumnName();

  const startCol = headers.indexOf('Start');
  const finishCol = headers.indexOf('Finish');
  const stateCol = headers.indexOf('State');
  const todayCol = headers.indexOf(todayName);

  if ([startCol, finishCol, stateCol, todayCol].some(index => index === -1)) {
    return { ok: false, message: 'Required schedule columns are missing.' };
  }

  const task = cleanCell(row[todayCol]);
  if (isEmptyTask(task)) {
    return { ok: false, message: `Row ${rowNumber} has no task for ${todayName}.` };
  }

  return {
    ok: true,
    rowNumber,
    day: todayName,
    start: cleanCell(row[startCol]),
    finish: cleanCell(row[finishCol]),
    state: cleanCell(row[stateCol]),
    task
  };
}

function saveActionLog(item, preventDuplicate) {
  const sheet = getOrCreateSheet_(CONFIG.ACTION_LOG_SHEET_NAME, createActionLogHeader_);
  if (preventDuplicate && isAlreadyLoggedToday(item.rowNumber, item.action)) return;

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
  const sheet = getOrCreateSheet_(CONFIG.MOOD_LOG_SHEET_NAME, createMoodLogHeader_);
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return false;

  const data = sheet.getDataRange().getDisplayValues();
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');

  return data.slice(1).some(row =>
    String(row[1]).trim() === today &&
    String(row[2]).trim() === action &&
    Number(row[4]) === Number(rowNumber)
  );
}

function sendTodayReportToTelegram() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  sendTelegramMessage(buildReportForDateRange(today, today).message);
}

function sendWeeklyReportTextOnlyToTelegram() {
  const range = getLastNDaysRange(7);
  sendTelegramMessage(buildReportForDateRange(range.start, range.end).message);
}

function sendWeeklyWellbeingReport() {
  const range = getLastNDaysRange(7);
  const report = buildReportForDateRange(range.start, range.end);
  saveWeeklyReport(report);
  buildEnergyHeatmapSheet(7);
  sendTelegramMessage(`${report.message}\n\n🟩 Energy heatmap updated.`);
}

function buildReportForDateRange(startDate, endDate) {
  const actions = getActionLogRows_().filter(row => isDateInRange(row.actionDate, startDate, endDate));
  const moods = getMoodLogRows_().filter(row => isDateInRange(row.date, startDate, endDate));

  const stats = { pending: 0, done: 0, skipped: 0, started: 0, paused: 0, later: 0 };
  let doneMinutes = 0;
  const stateMinutes = {};
  const energyValues = [];
  const hourlyEnergy = {};

  actions.forEach(row => {
    const duration = calculateDurationMinutes(row.start, row.finish);
    if (row.action === 'Pending') stats.pending++;
    if (row.action === 'Done') {
      stats.done++;
      doneMinutes += duration;
      const stateName = row.state || 'Uncategorized';
      stateMinutes[stateName] = (stateMinutes[stateName] || 0) + duration;
    }
    if (row.action === 'Skipped') stats.skipped++;
    if (row.action === 'Started') stats.started++;
    if (row.action === 'Paused') stats.paused++;
    if (String(row.action).startsWith('Later')) stats.later++;
  });

  moods.forEach(row => {
    const energy = Number(row.energy);
    if (Number.isNaN(energy)) return;
    energyValues.push(energy);
    const key = `${row.date} ${pad2(row.hour)}:00`;
    hourlyEnergy[key] = hourlyEnergy[key] || [];
    hourlyEnergy[key].push(energy);
  });

  const completionRate = stats.pending > 0 ? Math.round((stats.done / stats.pending) * 100) : 0;
  const avgEnergy = energyValues.length
    ? roundToOne(energyValues.reduce((a, b) => a + b, 0) / energyValues.length)
    : 0;
  const bestState = getBestStateByMinutes(stateMinutes);
  const bestHour = getBestEnergyHour(hourlyEnergy);
  const title = startDate === endDate ? "📊 Today's Report" : '📈 Last 7 Days Report';

  let message = `${title}\n🗓 Range: ${startDate} to ${endDate}\n\n`;
  message += `✅ Done: ${stats.done}\n`;
  message += `⏭ Skipped: ${stats.skipped}\n`;
  message += `⏳ Pending Sent: ${stats.pending}\n`;
  message += `⏱ Started: ${stats.started}\n`;
  message += `⏸ Paused: ${stats.paused}\n`;
  message += `🔁 Later: ${stats.later}\n\n`;
  message += `🎯 Completion Rate: ${completionRate}%\n`;
  message += `⏱ Productive Time: ${formatMinutes(doneMinutes)}\n`;
  message += `🔥 Average Energy: ${avgEnergy}/5\n`;

  if (bestState.name) message += `\n🏆 Best work section:\n${bestState.name} — ${formatMinutes(bestState.minutes)}\n`;
  if (bestHour.label) message += `\n🟩 Best mood/energy hour:\n${bestHour.label} — Energy ${bestHour.energy}/5\n`;

  return {
    startDate,
    endDate,
    ...stats,
    completionRate,
    productiveMinutes: doneMinutes,
    avgEnergy,
    bestState,
    bestHour,
    message
  };
}

function saveWeeklyReport(report) {
  const sheet = getOrCreateSheet_(CONFIG.WEEKLY_REPORT_SHEET_NAME, createWeeklyReportHeader_);
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
  const sheet = ss.getSheetByName(CONFIG.ENERGY_HEATMAP_SHEET_NAME) || ss.insertSheet(CONFIG.ENERGY_HEATMAP_SHEET_NAME);
  sheet.clear();

  const range = getLastNDaysRange(days);
  const moods = getMoodLogRows_();
  const dates = getDateList(range.start, range.end);
  const hours = Array.from({ length: 24 }, (_, index) => index);

  sheet.appendRow(['Date / Hour', ...hours.map(hour => `${pad2(hour)}:00`)]);

  dates.forEach(date => {
    const row = [date];
    hours.forEach(hour => {
      const values = moods
        .filter(item => item.date === date && Number(item.hour) === hour)
        .map(item => Number(item.energy))
        .filter(value => !Number.isNaN(value));
      row.push(values.length ? roundToOne(values.reduce((a, b) => a + b, 0) / values.length) : '');
    });
    sheet.appendRow(row);
  });

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  formatHeaderRow_(sheet);
  sheet.setFrozenColumns(1);

  if (lastRow > 1 && lastCol > 1) {
    const rangeValues = sheet.getRange(2, 2, lastRow - 1, lastCol - 1).getValues();
    const backgrounds = rangeValues.map(row => row.map(value => getEnergyColor(value)));
    sheet.getRange(2, 2, lastRow - 1, lastCol - 1).setBackgrounds(backgrounds);
  }

  sheet.autoResizeColumns(1, lastCol);
}

function markSentItemsAsPending(items) {
  items.forEach(item => {
    if (!isAlreadyLoggedToday(item.rowNumber, 'Done')) setTaskCellStatusColor(item.rowNumber, 'pending');
  });
}

function setTaskCellStatusColor(rowNumber, status) {
  const sheet = getMainSheet_();
  const headers = normalizeHeaders_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]);
  const todayCol = headers.indexOf(getTodayColumnName());
  if (todayCol === -1) throw new Error('Today column was not found.');

  const colorMap = {
    done: CONFIG.DONE_COLOR,
    pending: CONFIG.PENDING_COLOR,
    skipped: CONFIG.SKIPPED_COLOR,
    started: CONFIG.STARTED_COLOR,
    paused: CONFIG.PAUSED_COLOR
  };

  sheet.getRange(rowNumber, todayCol + 1).setBackground(colorMap[status] || CONFIG.DEFAULT_COLOR);
}

/** Installs only the triggers still needed in the Cloudflare architecture. */
function installProjectTriggers() {
  deleteProjectTriggers();

  ScriptApp.newTrigger('sendNext4HoursPlanToTelegram')
    .timeBased()
    .everyHours(4)
    .create();

  ScriptApp.newTrigger('sendWeeklyWellbeingReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(23)
    .nearMinute(45)
    .create();
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

/** Creates/clears all generated tables without deleting the main schedule. */
function fullResetSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [
    CONFIG.ACTION_LOG_SHEET_NAME,
    CONFIG.MOOD_LOG_SHEET_NAME,
    CONFIG.WEEKLY_REPORT_SHEET_NAME,
    CONFIG.ENERGY_HEATMAP_SHEET_NAME
  ].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet) ss.deleteSheet(sheet);
  });

  getOrCreateSheet_(CONFIG.ACTION_LOG_SHEET_NAME, createActionLogHeader_);
  getOrCreateSheet_(CONFIG.MOOD_LOG_SHEET_NAME, createMoodLogHeader_);
  getOrCreateSheet_(CONFIG.WEEKLY_REPORT_SHEET_NAME, createWeeklyReportHeader_);
  const heatmap = ss.insertSheet(CONFIG.ENERGY_HEATMAP_SHEET_NAME);
  createEnergyHeatmapHeader_(heatmap);
  resetAllScheduleColors();
}

function resetAllScheduleColors() {
  const sheet = getMainSheet_();
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return;

  const headers = normalizeHeaders_(data[0]);
  ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].forEach(day => {
    const index = headers.indexOf(day);
    if (index !== -1) sheet.getRange(2, index + 1, data.length - 1, 1).setBackground(CONFIG.DEFAULT_COLOR);
  });
}

/** One-time helper: set all required Script Properties without committing secrets. */
function configureScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    TELEGRAM_BOT_TOKEN: 'PASTE_BOT_TOKEN_HERE',
    TELEGRAM_CHAT_ID: 'PASTE_CHAT_ID_HERE',
    WORKER_API_SECRET: 'PASTE_THE_SAME_SHARED_SECRET_USED_IN_CLOUDFLARE',
    MAIN_SHEET_NAME: 'Sheet1',
    TIMEZONE: 'Asia/Tehran'
  }, true);

  console.log('Properties saved. Replace placeholder values before running this function.');
}

function testTelegram() {
  sendTelegramMessage('✅ Google Apps Script can send Telegram messages.');
}

function testSendScheduleManually() {
  sendNext4HoursPlanToTelegram();
}

function testTodayReportManually() {
  sendTodayReportToTelegram();
}

function testWeeklyReportManually() {
  sendWeeklyWellbeingReport();
}

function testHeatmapManually() {
  buildEnergyHeatmapSheet(7);
}

// -------------------- Telegram helpers --------------------

function sendTelegramMessage(message) {
  return callTelegramApi_('sendMessage', {
    chat_id: requireScriptProperty_('TELEGRAM_CHAT_ID'),
    text: message
  });
}

function sendTelegramMessageWithKeyboard(message, keyboard) {
  return callTelegramApi_('sendMessage', {
    chat_id: requireScriptProperty_('TELEGRAM_CHAT_ID'),
    text: message,
    reply_markup: keyboard
  });
}

function callTelegramApi_(method, payload) {
  const token = requireScriptProperty_('TELEGRAM_BOT_TOKEN');
  const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.getContentText()}`);
  }
  return result;
}

// -------------------- Sheet helpers --------------------

function getMainSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Main schedule sheet not found: ${CONFIG.SHEET_NAME}`);
  return sheet;
}

function getOrCreateSheet_(name, headerCreator) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    headerCreator(sheet);
  }
  return sheet;
}

function createActionLogHeader_(sheet) {
  sheet.clear();
  sheet.appendRow(['Action At', 'Action Date', 'Action', 'Day', 'Row Number', 'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Command Type']);
  formatHeaderRow_(sheet);
}

function createMoodLogHeader_(sheet) {
  sheet.clear();
  sheet.appendRow(['Logged At', 'Date', 'Day', 'Hour', 'Row Number', 'Start', 'Finish', 'State', 'Task', 'Energy', 'Mood', 'Source']);
  formatHeaderRow_(sheet);
}

function createWeeklyReportHeader_(sheet) {
  sheet.clear();
  sheet.appendRow(['Created At', 'Start Date', 'End Date', 'Pending', 'Done', 'Skipped', 'Started', 'Paused', 'Later', 'Completion Rate', 'Productive Minutes', 'Average Energy', 'Best State', 'Best State Minutes', 'Best Hour', 'Best Hour Energy']);
  formatHeaderRow_(sheet);
}

function createEnergyHeatmapHeader_(sheet) {
  sheet.clear();
  sheet.appendRow(['Date / Hour', ...Array.from({ length: 24 }, (_, hour) => `${pad2(hour)}:00`)]);
  formatHeaderRow_(sheet);
  sheet.setFrozenColumns(1);
}

function formatHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  sheet.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#eeeeee');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, lastCol);
}

function getActionLogRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.ACTION_LOG_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getDisplayValues().slice(1).map(row => ({
    actionAt: row[0], actionDate: row[1], action: row[2], day: row[3], rowNumber: row[4],
    start: row[5], finish: row[6], state: row[7], task: row[8], energy: row[9], mood: row[10], commandType: row[11]
  }));
}

function getMoodLogRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MOOD_LOG_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getDisplayValues().slice(1).map(row => ({
    loggedAt: row[0], date: row[1], day: row[2], hour: row[3], rowNumber: row[4],
    start: row[5], finish: row[6], state: row[7], task: row[8], energy: row[9], mood: row[10], source: row[11]
  }));
}

// -------------------- General utilities --------------------

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function validateTaskRow_(rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error(`Invalid row number: ${rowNumber}`);
}

function requireTaskInfo_(rowNumber) {
  const result = getTaskInfoByRow(rowNumber);
  if (!result.ok) throw new Error(result.message);
  return result;
}

function getScriptProperty_(name, fallback) {
  return PropertiesService.getScriptProperties().getProperty(name) || fallback;
}

function requireScriptProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value || value.includes('PASTE_')) throw new Error(`Missing Script Property: ${name}`);
  return value;
}

function normalizeHeaders_(headers) {
  return headers.map(value => String(value).trim());
}

function getNowInConfiguredTimezone() {
  return new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss'));
}

function getTodayColumnName() {
  const dayNumber = Number(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'u'));
  return ({ 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' })[dayNumber];
}

function combineTodayWithTime(timeValue, baseDate) {
  const parsed = parseTimeString(timeValue);
  const result = new Date(baseDate);
  result.setHours(parsed.hours, parsed.minutes, 0, 0);
  return result;
}

function parseTimeString(timeString) {
  const clean = String(timeString).trim();
  const match = clean.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) throw new Error(`Invalid time format: ${timeString}`);

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const ampm = match[3] ? match[3].toUpperCase() : null;

  if (minutes < 0 || minutes > 59) throw new Error(`Invalid minutes: ${timeString}`);
  if (ampm) {
    if (hours < 1 || hours > 12) throw new Error(`Invalid 12-hour time: ${timeString}`);
    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  } else if (hours < 0 || hours > 23) {
    throw new Error(`Invalid 24-hour time: ${timeString}`);
  }

  return { hours, minutes };
}

function calculateDurationMinutes(startTime, finishTime) {
  if (isEmptyTask(startTime) || isEmptyTask(finishTime)) return 0;
  const base = getNowInConfiguredTimezone();
  const start = combineTodayWithTime(startTime, base);
  const finish = combineTodayWithTime(finishTime, base);
  if (finish <= start) finish.setDate(finish.getDate() + 1);
  return Math.round((finish.getTime() - start.getTime()) / 60000);
}

function extractHourFromTime(timeString) {
  return parseTimeString(timeString).hours;
}

function cleanCell(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function isEmptyTask(value) {
  const clean = cleanCell(value).toLowerCase();
  return ['', '-', '—', 'n/a', 'na', 'null', 'undefined'].includes(clean);
}

function formatTime(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'HH:mm');
}

function energyToMoodLabel(value) {
  return ({ 1: 'Very Low', 2: 'Low', 3: 'Medium', 4: 'Good', 5: 'High' })[value] || '';
}

function getEnergyColor(value) {
  const number = Number(value);
  if (Number.isNaN(number) || value === '') return '#ffffff';
  if (number <= 1) return '#f4c7c3';
  if (number <= 2) return '#fce8b2';
  if (number <= 3) return '#fff2cc';
  if (number <= 4) return '#d9ead3';
  return '#b7e1cd';
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

function getBestStateByMinutes(stateMinutes) {
  return Object.entries(stateMinutes).reduce(
    (best, [name, minutes]) => minutes > best.minutes ? { name, minutes } : best,
    { name: '', minutes: 0 }
  );
}

function getBestEnergyHour(hourlyEnergy) {
  return Object.entries(hourlyEnergy).reduce((best, [label, values]) => {
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    return average > best.energy ? { label, energy: roundToOne(average) } : best;
  }, { label: '', energy: 0 });
}

function isDateInRange(date, startDate, endDate) {
  return String(date) >= String(startDate) && String(date) <= String(endDate);
}

function getLastNDaysRange(days) {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days + 1);
  return {
    start: Utilities.formatDate(startDate, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    end: Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd')
  };
}

function getDateList(startDate, endDate) {
  const list = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (current <= end) {
    list.push(Utilities.formatDate(current, CONFIG.TIMEZONE, 'yyyy-MM-dd'));
    current.setDate(current.getDate() + 1);
  }
  return list;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
