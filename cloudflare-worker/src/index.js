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
    if (request.method === "GET") {
      return Response.json({
        ok: true,
        service: "PulseTask Telegram Worker",
        version: "2.0-smart-reschedule",
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        { ok: false, error: "Method not allowed" },
        { status: 405 }
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

async function handleCallbackQuery(callbackQuery, env, ctx) {
  const callbackId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat?.id || "");
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
    sendToAppsScript(env, {
      action: parsed.action,
      taskRef: parsed.taskRef,
      energyValue: parsed.energyValue,
      callbackId,
      telegramChatId: chatId,
      createdAt: new Date().toISOString(),
    })
  );
}

function parseCallbackData(data) {
  const parts = data.split(":");
  const action = parts[0];

  if (
    ["done", "skip", "start", "pause", "later30", "reschedule"].includes(
      action
    )
  ) {
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
      action,
      taskRef,
      energyValue: null,
      confirmation: confirmations[action],
    };
  }

  if (action === "energyval") {
    const taskRef = normalizeTaskRef(parts[1]);
    const energyValue = Number(parts[2]);

    if (
      !isValidTaskRef(taskRef) ||
      !Number.isInteger(energyValue) ||
      energyValue < 1 ||
      energyValue > 5
    ) {
      return { ok: false, message: "Invalid energy value." };
    }

    return {
      ok: true,
      action: "energy",
      taskRef,
      energyValue,
      confirmation: `🔥 Energy level ${energyValue}/5 was recorded.`,
    };
  }

  if (action === "report") {
    const reportType = parts[1];

    if (reportType === "today") {
      return {
        ok: true,
        action: "report_today",
        taskRef: null,
        energyValue: null,
        confirmation: "📊 Today’s report is being prepared.",
      };
    }

    if (reportType === "week") {
      return {
        ok: true,
        action: "report_week",
        taskRef: null,
        energyValue: null,
        confirmation: "📈 The weekly report is being prepared.",
      };
    }

    if (reportType === "heatmap") {
      return {
        ok: true,
        action: "heatmap",
        taskRef: null,
        energyValue: null,
        confirmation: "🟩 The energy heatmap is being updated.",
      };
    }
  }

  return { ok: false, message: "Unknown action." };
}

function normalizeTaskRef(value) {
  const raw = String(value || "").trim();

  // Backward compatibility with old callback data such as done:12.
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
  const text = String(message.text || "").trim().toLowerCase();

  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

  if (text.startsWith("/start")) {
    await sendTelegramMessage(
      env,
      chatId,
      [
        "Hello 👋",
        "",
        "PulseTask is online.",
        "",
        "/test — Send test buttons",
        "/today — Generate today’s report",
        "/week — Generate the weekly report",
        "/heatmap — Update the energy heatmap",
      ].join("\n")
    );
    return;
  }

  if (text.startsWith("/test")) {
    await sendTestTask(env, chatId);
    return;
  }

  if (text.startsWith("/today")) {
    await sendTelegramMessage(
      env,
      chatId,
      "📊 Today’s report is being prepared."
    );
    ctx.waitUntil(
      sendToAppsScript(env, {
        action: "report_today",
        createdAt: new Date().toISOString(),
      })
    );
    return;
  }

  if (text.startsWith("/week")) {
    await sendTelegramMessage(
      env,
      chatId,
      "📈 The weekly report is being prepared."
    );
    ctx.waitUntil(
      sendToAppsScript(env, {
        action: "report_week",
        createdAt: new Date().toISOString(),
      })
    );
    return;
  }

  if (text.startsWith("/heatmap")) {
    await sendTelegramMessage(
      env,
      chatId,
      "🟩 The energy heatmap is being updated."
    );
    ctx.waitUntil(
      sendToAppsScript(env, {
        action: "heatmap",
        createdAt: new Date().toISOString(),
      })
    );
  }
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
        {
          text: "🔄 Reschedule to Free Time",
          callback_data: `reschedule:${taskRef}`,
        },
      ],
      [1, 2, 3, 4, 5].map((value) => ({
        text: `🔥${value}`,
        callback_data: `energyval:${taskRef}:${value}`,
      })),
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
      body: JSON.stringify({
        secret: env.WORKER_API_SECRET,
        ...actionData,
      }),
      signal: controller.signal,
      redirect: "follow",
    });

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Apps Script returned non-JSON: ${responseText.slice(0, 200)}`
      );
    }

    if (!response.ok || !result.ok) {
      throw new Error(
        result.error || `Apps Script HTTP error: ${response.status}`
      );
    }

    console.log("Apps Script action completed:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Apps Script background request failed:", error);

    await sendTelegramMessage(
      env,
      env.TELEGRAM_CHAT_ID,
      `⚠️ The Google Sheets operation failed.\n\n${error.message}`
    );

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  return callTelegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function sendTelegramMessage(env, chatId, text) {
  return callTelegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
  });
}

async function callTelegramApi(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram ${method} failed: ${result.description || response.status}`
    );
  }

  return result;
}
