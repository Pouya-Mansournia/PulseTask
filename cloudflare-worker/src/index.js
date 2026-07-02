/**
 * Telegram Life Tracker — Cloudflare Worker
 *
 * Responsibilities:
 * - Receive Telegram webhook updates
 * - Validate the allowed chat ID
 * - Acknowledge inline-button clicks immediately
 * - Continue Google Sheets processing through Apps Script in the background
 * - Expose /start, /test, /today, /week, and /heatmap commands
 *
 * Required Cloudflare secrets:
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
        service: "Telegram Life Tracker Worker",
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

      // Always return HTTP 200 after parsing a Telegram update.
      // This prevents Telegram from retrying the same update because
      // an internal background operation failed.
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

  // This is the critical UX step: Telegram receives confirmation first.
  await answerCallbackQuery(env, callbackId, parsed.confirmation);

  // The slower Google Sheets work continues after the user receives feedback.
  ctx.waitUntil(
    sendToAppsScript(env, {
      action: parsed.action,
      rowNumber: parsed.rowNumber,
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

  if (["done", "skip", "start", "pause", "later30"].includes(action)) {
    const rowNumber = Number(parts[1]);

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      return { ok: false, message: "Invalid task row." };
    }

    const confirmations = {
      done: "✅ Done logged.",
      skip: "⏭ Skip logged.",
      start: "⏱ Start logged.",
      pause: "⏸ Pause logged.",
      later30: "🔁 Later 30m logged.",
    };

    return {
      ok: true,
      action,
      rowNumber,
      energyValue: null,
      confirmation: confirmations[action],
    };
  }

  if (action === "energyval") {
    const rowNumber = Number(parts[1]);
    const energyValue = Number(parts[2]);

    if (
      !Number.isInteger(rowNumber) ||
      rowNumber < 2 ||
      !Number.isInteger(energyValue) ||
      energyValue < 1 ||
      energyValue > 5
    ) {
      return { ok: false, message: "Invalid energy value." };
    }

    return {
      ok: true,
      action: "energy",
      rowNumber,
      energyValue,
      confirmation: `🔥 Energy ${energyValue}/5 logged.`,
    };
  }

  if (action === "report") {
    const reportType = parts[1];

    if (reportType === "today") {
      return {
        ok: true,
        action: "report_today",
        rowNumber: null,
        energyValue: null,
        confirmation: "📊 Preparing today's report...",
      };
    }

    if (reportType === "week") {
      return {
        ok: true,
        action: "report_week",
        rowNumber: null,
        energyValue: null,
        confirmation: "📈 Preparing the weekly report...",
      };
    }

    if (reportType === "heatmap") {
      return {
        ok: true,
        action: "heatmap",
        rowNumber: null,
        energyValue: null,
        confirmation: "🟩 Preparing the heatmap...",
      };
    }
  }

  return { ok: false, message: "Unknown action." };
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
        "Hi 👋",
        "",
        "Telegram Life Tracker is online.",
        "",
        "/test — Send test buttons",
        "/today — Today report",
        "/week — Weekly report",
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
    await sendTelegramMessage(env, chatId, "📊 Preparing today's report...");
    ctx.waitUntil(sendToAppsScript(env, { action: "report_today", createdAt: new Date().toISOString() }));
    return;
  }

  if (text.startsWith("/week")) {
    await sendTelegramMessage(env, chatId, "📈 Preparing the weekly report...");
    ctx.waitUntil(sendToAppsScript(env, { action: "report_week", createdAt: new Date().toISOString() }));
    return;
  }

  if (text.startsWith("/heatmap")) {
    await sendTelegramMessage(env, chatId, "🟩 Preparing the heatmap...");
    ctx.waitUntil(sendToAppsScript(env, { action: "heatmap", createdAt: new Date().toISOString() }));
  }
}

/**
 * Sends a manual test card.
 * Change TEST_ROW to a row that contains a task in today's schedule column.
 */
async function sendTestTask(env, chatId) {
  const TEST_ROW = 12;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Done", callback_data: `done:${TEST_ROW}` },
        { text: "⏭ Skip", callback_data: `skip:${TEST_ROW}` },
      ],
      [
        { text: "⏱ Start", callback_data: `start:${TEST_ROW}` },
        { text: "⏸ Pause", callback_data: `pause:${TEST_ROW}` },
        { text: "🔁 Later", callback_data: `later30:${TEST_ROW}` },
      ],
      [1, 2, 3, 4, 5].map((value) => ({
        text: `🔥${value}`,
        callback_data: `energyval:${TEST_ROW}:${value}`,
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
      "🧪 Cloudflare + Google Sheets Test",
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
    });

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(`Apps Script returned non-JSON: ${responseText.slice(0, 200)}`);
    }

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Apps Script HTTP error: ${response.status}`);
    }

    console.log("Apps Script action completed:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Apps Script background request failed:", error);

    await sendTelegramMessage(
      env,
      env.TELEGRAM_CHAT_ID,
      `⚠️ Google Sheet update failed.\n\n${error.message}`
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
    throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  }

  return result;
}
