/**
 * PulseTask — Cloudflare Worker
 *
 * Required secrets:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 * - APPS_SCRIPT_URL
 * - WORKER_API_SECRET
 */

export default {
  async fetch(request, env, ctx) {
    const missingEnvironment = getMissingEnvironmentVariables(env);

    if (missingEnvironment.length > 0) {
      console.error(
        `Missing Worker environment variables: ${missingEnvironment.join(", ")}`
      );

      return Response.json(
        {
          ok: false,
          error: "Worker configuration is incomplete.",
          missing: missingEnvironment,
        },
        { status: 500 }
      );
    }

    if (request.method === "GET") {
      return Response.json({
        ok: true,
        service: "PulseTask Telegram Worker",
        version: "2.1-telegram-drafts",
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        {
          ok: false,
          error: "Method not allowed",
        },
        {
          status: 405,
        }
      );
    }

    try {
      const update = await request.json();

      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env, ctx);
      } else if (update.message?.text) {
        await handleIncomingMessage(update.message, env, ctx);
      }

      return Response.json({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);

      return Response.json({ ok: false, error: error.message });
    }
  },
};

function getMissingEnvironmentVariables(env) {
  return [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "APPS_SCRIPT_URL",
    "WORKER_API_SECRET",
  ].filter((key) => !String(env[key] || "").trim());
}

async function handleCallbackQuery(callbackQuery, env, ctx) {
  const callbackId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat?.id || "");
  const messageId = callbackQuery.message?.message_id;
  const data = String(callbackQuery.data || "").trim();

  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    await answerCallbackQuery(env, callbackId, "Not allowed.");
    return;
  }

  const parsed = parseCallbackData(data);

  if (!parsed.ok) {
    await answerCallbackQuery(env, callbackId, parsed.message);
    return;
  }

  await answerCallbackQuery(env, callbackId, parsed.confirmation);

  ctx.waitUntil(
    processCallbackAction(env, parsed, chatId, messageId, {
      action: parsed.action,
      draftId: parsed.draftId,
      taskRef: parsed.taskRef,
      energyValue: parsed.energyValue,
      callbackId: callbackId,
      telegramChatId: chatId,
      createdAt: new Date().toISOString(),
    })
  );
}

async function processCallbackAction(env, parsed, chatId, messageId, actionData) {
  const result = await sendToAppsScript(env, actionData);

  if (parsed.draftId && messageId) {
    try {
      await callTelegramApi(env, "deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      console.error("Could not delete the completed draft message:", error);
    }
  }

  return result;
}

function parseCallbackData(data) {
  const parts = data.split(":");
  const action = parts[0];

  const taskActions = ["done", "skip", "start", "pause", "later30", "reschedule"];

  if (taskActions.includes(action)) {
    const taskRef = normalizeTaskRef(parts[1]);

    if (!isValidTaskRef(taskRef)) {
      return { ok: false, message: "Invalid task reference." };
    }

    const confirmations = {
      done: "✅ Task marked as done.",
      skip: "⏭ Task marked as skipped.",
      start: "⏱ Task started.",
      pause: "⏸ Task paused.",
      later30: "🔁 Task postponed for 30 minutes.",
      reschedule: "🔄 Finding the nearest free time...",
    };

    return {
      ok: true,
      action: action,
      draftId: null,
      taskRef: taskRef,
      energyValue: null,
      confirmation: confirmations[action],
    };
  }

  if (action === "energyval") {
    const taskRef = normalizeTaskRef(parts[1]);
    const energyValue = Number(parts[2]);

    if (!isValidTaskRef(taskRef) || !Number.isInteger(energyValue) || energyValue < 1 || energyValue > 5) {
      return { ok: false, message: "Invalid energy value." };
    }

    return {
      ok: true,
      action: "energy",
      draftId: null,
      taskRef: taskRef,
      energyValue: energyValue,
      confirmation: `🔥 Energy level ${energyValue}/5 was recorded.`,
    };
  }

  if (action === "report") {
    const reportType = parts[1];

    if (reportType === "today") {
      return {
        ok: true,
        action: "report_today",
        draftId: null,
        taskRef: null,
        energyValue: null,
        confirmation: "📊 Today’s report is being prepared.",
      };
    }

    if (reportType === "week") {
      return {
        ok: true,
        action: "report_week",
        draftId: null,
        taskRef: null,
        energyValue: null,
        confirmation: "📈 The weekly report is being prepared.",
      };
    }

    if (reportType === "heatmap") {
      return {
        ok: true,
        action: "heatmap",
        draftId: null,
        taskRef: null,
        energyValue: null,
        confirmation: "🟩 The energy heatmap is being updated.",
      };
    }
  }

  if (["taskconfirm", "taskstart", "taskcancel"].includes(action)) {
    const draftId = String(parts[1] || "").trim();

    if (!draftId) {
      return { ok: false, message: "Invalid draft reference." };
    }

    const confirmations = {
      taskconfirm: "⏳ Adding task...",
      taskstart: "⏳ Adding and starting task...",
      taskcancel: "⏳ Cancelling draft...",
    };

    return {
      ok: true,
      action: action === "taskconfirm" ? "confirm_task_draft" : action === "taskstart" ? "start_task_draft" : "cancel_task_draft",
      draftId: draftId,
      taskRef: null,
      energyValue: null,
      confirmation: confirmations[action],
    };
  }

  return { ok: false, message: "Unknown action." };
}

function normalizeTaskRef(value) {
  const raw = String(value || "").trim();

  if (/^\d+$/.test(raw)) {
    return `S${raw}`;
  }

  return raw;
}

function isValidTaskRef(taskRef) {
  return /^(S\d+|D[A-Za-z0-9-]+)$/.test(taskRef);
}

async function handleIncomingMessage(message, env, ctx) {
  const chatId = String(message.chat?.id || "");
  const rawText = String(message.text || "").trim();
  const text = rawText.toLowerCase();

  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    return;
  }

  if (text.startsWith("/start")) {
    await callTelegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: [
        "Hello 👋",
        "",
        "PulseTask is online.",
        "Use the ➕ Add Task button below whenever you want to add a task.",
        "",
        "/today — Generate today’s report",
        "/week — Generate the weekly report",
        "/heatmap — Update the energy heatmap",
        "/test — Send test buttons",
        "/help — Show examples",
      ].join("\n"),
      reply_markup: getMainMenuKeyboard(),
    });
    return;
  }

  if (text.startsWith("/help")) {
    await sendTelegramMessage(env, chatId, [
      "🧭 PulseTask help",
      "",
      "Examples:",
      "/add Review PulseTask changes",
      "/add 18:30-20:00 | PulseTask | Improve Telegram integration",
      "/add 90m | Research | Read robotics paper",
      "",
      "You can also send plain text directly and I will suggest the next available free slot automatically.",
    ].join("\n"));
    return;
  }

  if (text.startsWith("/add")) {
    const result = await sendToAppsScript(env, {
      action: "prepare_task_draft",
      taskInput: rawText,
      inputType: "slash_add",
      telegramChatId: chatId,
      createdAt: new Date().toISOString(),
    });

    if (result?.preview && result?.draftId) {
      await sendTelegramMessageWithKeyboard(env, chatId, result.preview, {
        inline_keyboard: [
          [
            { text: "✅ Add", callback_data: `taskconfirm:${result.draftId}` },
            { text: "▶️ Add & Start", callback_data: `taskstart:${result.draftId}` },
          ],
          [
            { text: "❌ Cancel", callback_data: `taskcancel:${result.draftId}` },
          ],
        ],
      });
    }
    return;
  }

  if (rawText === "➕ Add Task") {
    await callTelegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📝 Send me the task description.",
      reply_markup: getMainMenuKeyboard("Write your task..."),
    });
    return;
  }

  if (text.startsWith("/test")) {
    await sendTestTask(env, chatId);
    return;
  }

  if (text.startsWith("/today")) {
    await sendTelegramMessage(env, chatId, "📊 Today’s report is being prepared.");
    ctx.waitUntil(sendToAppsScript(env, { action: "report_today", createdAt: new Date().toISOString() }));
    return;
  }

  if (text.startsWith("/week")) {
    await sendTelegramMessage(env, chatId, "📈 The weekly report is being prepared.");
    ctx.waitUntil(sendToAppsScript(env, { action: "report_week", createdAt: new Date().toISOString() }));
    return;
  }

  if (text.startsWith("/heatmap")) {
    await sendTelegramMessage(env, chatId, "🟩 The energy heatmap is being updated.");
    ctx.waitUntil(sendToAppsScript(env, { action: "heatmap", createdAt: new Date().toISOString() }));
    return;
  }

  if (text.startsWith("/")) {
    await sendTelegramMessage(env, chatId, [
      "⚠️ Unknown command.",
      "",
      "Use /add to create a task, /today for a report, /week for the weekly report, or /help for examples.",
    ].join("\n"));
    return;
  }

  if (rawText) {
    const result = await sendToAppsScript(env, {
      action: "prepare_task_draft",
      taskInput: rawText,
      inputType: "text",
      telegramChatId: chatId,
      createdAt: new Date().toISOString(),
    });

    if (result?.preview && result?.draftId) {
      await sendTelegramMessageWithKeyboard(env, chatId, result.preview, {
        inline_keyboard: [
          [
            { text: "✅ Add", callback_data: `taskconfirm:${result.draftId}` },
            { text: "▶️ Add & Start", callback_data: `taskstart:${result.draftId}` },
          ],
          [
            { text: "❌ Cancel", callback_data: `taskcancel:${result.draftId}` },
          ],
        ],
      });
    }
  }
}

function getMainMenuKeyboard(inputPlaceholder) {
  return {
    keyboard: [[{ text: "➕ Add Task" }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: inputPlaceholder || "Choose an action...",
  };
}

async function sendTestTask(env, chatId) {
  const TEST_ROW = 12;
  const taskRef = `S${TEST_ROW}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Done", callback_data: `done:${taskRef}` },
        { text: "⏭ Skip", callback_data: `skip:${taskRef}` },
      ],
      [
        { text: "⏱ Start", callback_data: `start:${taskRef}` },
        { text: "⏸ Pause", callback_data: `pause:${taskRef}` },
        { text: "🔁 Later", callback_data: `later30:${taskRef}` },
      ],
      [
        { text: "🔄 Reschedule to Free Time", callback_data: `reschedule:${taskRef}` },
      ],
      [
        { text: "🔥1", callback_data: `energyval:${taskRef}:1` },
        { text: "🔥2", callback_data: `energyval:${taskRef}:2` },
        { text: "🔥3", callback_data: `energyval:${taskRef}:3` },
        { text: "🔥4", callback_data: `energyval:${taskRef}:4` },
        { text: "🔥5", callback_data: `energyval:${taskRef}:5` },
      ],
      [
        { text: "📊 Today", callback_data: "report:today" },
        { text: "📈 Week", callback_data: "report:week" },
        { text: "🟩 Heatmap", callback_data: "report:heatmap" },
      ],
    ],
  };

  await callTelegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: [
      "🧪 PulseTask Smart Reschedule Test",
      "",
      `Test schedule row: ${TEST_ROW}`,
      "Change TEST_ROW in src/index.js if this row is empty today.",
    ].join("\n"),
    reply_markup: keyboard,
  });
}

async function sendToAppsScript(env, actionData) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.WORKER_API_SECRET, ...actionData }),
      signal: controller.signal,
      redirect: "follow",
    });

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(`Apps Script returned non-JSON: ${responseText.slice(0, 200)}`);
    }

    if (!response.ok || !result.ok) {
      throw new Error(result.error || result.message || `Apps Script HTTP error: ${response.status}`);
    }

    console.log("Apps Script action completed:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Apps Script background request failed:", error);
    const friendlyMessage = formatAppsScriptError(error.message);
    await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, friendlyMessage);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatAppsScriptError(message) {
  const raw = String(message || "").trim();

  if (!raw) {
    return "⚠️ The operation could not be completed.";
  }

  if (/draft.*(expired|not found|no longer available)/i.test(raw)) {
    return "⚠️ This draft is no longer available. Please create a new task.";
  }

  if (/usage:/i.test(raw)) {
    return raw;
  }

  return ["⚠️ The operation could not be completed.", "", raw].join("\n");
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  return callTelegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: false,
  });
}

async function sendTelegramMessage(env, chatId, text) {
  return callTelegramApi(env, "sendMessage", { chat_id: chatId, text: text });
}

async function sendTelegramMessageWithKeyboard(env, chatId, text, keyboard) {
  return callTelegramApi(env, "sendMessage", { chat_id: chatId, text: text, reply_markup: keyboard });
}

async function callTelegramApi(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  }

  return result;
}
