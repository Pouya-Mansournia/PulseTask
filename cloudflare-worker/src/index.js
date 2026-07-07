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
        version: "2.7-persistent-finance-keyboard",
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

  if (data === "finance:add_expense" || data === "finance:add_income") {
    const transactionType = data.endsWith("income") ? "income" : "expense";
    await answerCallbackQuery(env, callbackId, transactionType === "income" ? "Income entry opened." : "Expense entry opened.");
    await setFinanceSession(chatId, { kind: "amount", transactionType });
    await sendFinanceAmountPrompt(env, chatId, transactionType);
    return;
  }

  if (data.startsWith("fincat:")) {
    const categorySelection = parseFinanceCategoryCallback(data);

    if (!categorySelection.ok) {
      await answerCallbackQuery(env, callbackId, categorySelection.message);
      return;
    }

    await answerCallbackQuery(env, callbackId, "Category selected.");

    if (categorySelection.categoryKey === "other") {
      await setFinanceSession(chatId, {
        kind: "category",
        transactionType: categorySelection.transactionType,
        amount: categorySelection.amount,
      });
      await sendFinanceCustomCategoryPrompt(
        env,
        chatId,
        categorySelection.transactionType,
        categorySelection.amount
      );
      return;
    }

    await setFinanceSession(chatId, {
      kind: "note",
      transactionType: categorySelection.transactionType,
      amount: categorySelection.amount,
      category: categorySelection.categoryLabel,
    });
    await sendFinanceNotePrompt(
      env,
      chatId,
      categorySelection.transactionType,
      categorySelection.amount,
      categorySelection.categoryLabel
    );
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
      transactionType: parsed.transactionType,
      callbackId: callbackId,
      telegramChatId: chatId,
      createdAt: new Date().toISOString(),
    })
  );
}

async function processCallbackAction(env, parsed, chatId, messageId, actionData) {
  const result = await sendToAppsScript(env, actionData);

  if ((parsed.draftId || parsed.queueTask || parsed.queueFollowUp || parsed.financeDraft) && messageId) {
    try {
      await callTelegramApi(env, "deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      console.error("Could not delete the completed draft message:", error);
    }
  }

  if (parsed.queueTask && result?.task) {
    await sendTelegramMessageWithKeyboard(
      env,
      chatId,
      [
        `▶️ Started from Queue`,
        "",
        result.task,
        result.start && result.finish ? `🕐 ${result.start}–${result.finish}` : "",
        "Tap Done whenever you finish, or I’ll check in again in one hour.",
      ].filter(Boolean).join("\n"),
      getActiveTaskKeyboard(result.taskRef || parsed.taskRef)
    );
  }

  if (parsed.queueFollowUp && result?.task) {
    const message = parsed.action === "finish_queue_task"
      ? [`✅ Completed`, "", result.task]
      : [`➕ Continued for one more hour`, "", result.task, `Planned until ${result.finish}`];
    await sendTelegramMessage(env, chatId, message.join("\n"));
  }

  if (parsed.financeDraft && result?.message) {
    if (parsed.action === "confirm_finance_draft") {
      await sendTelegramMessage(env, chatId, [
        "✅ Done — ثبت شد",
        "",
        result.type === "income" ? "💵 Income saved" : "💸 Expense saved",
        "",
        `Amount: ${formatMoneyText(result.amount)}`,
        `Category: ${result.category || "Uncategorized"}`,
        result.note ? `Note: ${result.note}` : "",
        `Balance: ${formatMoneyText(result.balance)}`,
      ].filter(Boolean).join("\n"));
    } else {
      await sendTelegramMessage(env, chatId, "❌ Finance draft cancelled.");
    }
  }

  if (parsed.financeReport && result?.message) {
    await sendTelegramMessage(env, chatId, result.message);
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

  if (action === "qstart") {
    const taskRef = normalizeTaskRef(parts[1]);

    if (!isValidTaskRef(taskRef)) {
      return { ok: false, message: "Invalid queue task reference." };
    }

    return {
      ok: true,
      action: "start_queue_task",
      draftId: null,
      taskRef: taskRef,
      energyValue: null,
      queueTask: true,
      confirmation: "Starting queued task...",
    };
  }

  if (["qdone", "qcontinue"].includes(action)) {
    const taskRef = normalizeTaskRef(parts[1]);

    if (!isValidTaskRef(taskRef)) {
      return { ok: false, message: "Invalid active task reference." };
    }

    const isDone = action === "qdone";
    return {
      ok: true,
      action: isDone ? "finish_queue_task" : "continue_queue_task",
      draftId: null,
      taskRef: taskRef,
      energyValue: null,
      queueFollowUp: true,
      confirmation: isDone ? "Completing task..." : "Adding another hour...",
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

  if (action === "financebalance" || action === "financeweek") {
    return {
      ok: true,
      action: action === "financebalance" ? "finance_balance" : "finance_week_report",
      draftId: null,
      taskRef: null,
      energyValue: null,
      financeReport: true,
      confirmation: action === "financebalance" ? "Preparing finance balance..." : "Preparing finance report...",
    };
  }

  if (["finconfirm", "fincancel"].includes(action)) {
    const draftId = String(parts[1] || "").trim();

    if (!draftId) {
      return { ok: false, message: "Invalid finance draft reference." };
    }

    return {
      ok: true,
      action: action === "finconfirm" ? "confirm_finance_draft" : "cancel_finance_draft",
      draftId: draftId,
      taskRef: null,
      energyValue: null,
      financeDraft: true,
      confirmation: action === "finconfirm" ? "Saving transaction..." : "Cancelling finance draft...",
    };
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
        "Use the buttons below to add a task, pick something from your Queue, or log finance.",
        "",
        "/queue — Pick a pending task to start now",
        "/active — Show running Queue tasks",
        "/finance — Open finance tools",
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
      "/queue to pick a pending task and start it now",
      "/active to mark a running Queue task as Done early",
      "/expense to log an expense step by step",
      "/income to log income step by step",
      "",
      "You can also send plain text directly and I will suggest the next available free slot automatically.",
    ].join("\n"));
    return;
  }

  const financeStep = getFinanceReplyStep(message.reply_to_message?.text);
  if (financeStep && rawText) {
    await handleFinanceStepReply(env, chatId, rawText, financeStep);
    return;
  }

  const financeSession = await getFinanceSession(chatId);
  if (
    financeSession &&
    rawText &&
    !text.startsWith("/") &&
    !isMainMenuText(rawText)
  ) {
    await handleFinanceStepReply(env, chatId, rawText, financeSession);
    return;
  }

  if (text.startsWith("/expense") || text.startsWith("/income")) {
    const transactionType = text.startsWith("/income") ? "income" : "expense";
    const input = rawText.replace(/^\/(?:expense|income)\s*/i, "").trim();

    if (!input) {
      await setFinanceSession(chatId, { kind: "amount", transactionType });
      await sendFinanceAmountPrompt(env, chatId, transactionType);
      return;
    }

    if (input.includes("|")) {
      await prepareFinanceDraft(env, chatId, input, transactionType);
      return;
    }

    await sendFinanceCategoryPicker(env, chatId, transactionType, input);
    return;
  }

  if (text.startsWith("/add")) {
    await clearFinanceSession(chatId);
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

  if (rawText === "📥 Queue" || text.startsWith("/queue")) {
    await clearFinanceSession(chatId);
    await sendQueueList(env, chatId);
    return;
  }

  if (rawText === "▶️ Active" || text.startsWith("/active")) {
    await clearFinanceSession(chatId);
    await sendActiveQueueList(env, chatId);
    return;
  }

  if (rawText === "💰 Finance" || text.startsWith("/finance")) {
    await clearFinanceSession(chatId);
    await sendFinanceMenu(env, chatId);
    return;
  }

  if (rawText === "💸 Add Expense") {
    await setFinanceSession(chatId, { kind: "amount", transactionType: "expense" });
    await sendFinanceAmountPrompt(env, chatId, "expense");
    return;
  }

  if (rawText === "💵 Add Income") {
    await setFinanceSession(chatId, { kind: "amount", transactionType: "income" });
    await sendFinanceAmountPrompt(env, chatId, "income");
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
      "Use /add to create a task, /queue to pick pending work, /today for a report, /week for the weekly report, or /help for examples.",
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
    keyboard: [
      [{ text: "➕ Add Task" }, { text: "📥 Queue" }],
      [{ text: "▶️ Active" }, { text: "💰 Finance" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: inputPlaceholder || "Choose an action...",
  };
}

function isMainMenuText(text) {
  return [
    "➕ Add Task",
    "📥 Queue",
    "▶️ Active",
    "💰 Finance",
    "💸 Add Expense",
    "💵 Add Income",
  ].includes(String(text || "").trim());
}

async function sendQueueList(env, chatId) {
  const result = await sendToAppsScript(env, {
    action: "list_queue",
    telegramChatId: chatId,
    createdAt: new Date().toISOString(),
  });
  const items = Array.isArray(result?.items) ? result.items : [];

  if (items.length === 0) {
    await sendTelegramMessage(env, chatId, "📭 Your Queue is empty.");
    return;
  }

  const buttons = items.map((item) => [{
    text: formatQueueButtonLabel(item),
    callback_data: `qstart:${item.taskRef}`,
  }]);
  const remaining = Math.max(0, Number(result.total || items.length) - items.length);
  const footer = remaining > 0
    ? `\n\nShowing ${items.length} tasks. ${remaining} more remain in the sheet.`
    : "";

  await sendTelegramMessageWithKeyboard(
    env,
    chatId,
    `📥 Queue\n\nWhich task do you feel like doing now?${footer}`,
    { inline_keyboard: buttons }
  );
}

async function sendActiveQueueList(env, chatId) {
  const result = await sendToAppsScript(env, {
    action: "list_active_queue_tasks",
    telegramChatId: chatId,
    createdAt: new Date().toISOString(),
  });
  const items = Array.isArray(result?.items) ? result.items : [];

  if (items.length === 0) {
    await sendTelegramMessage(env, chatId, "📭 No Queue task is currently running.");
    return;
  }

  if (items.length === 1) {
    const item = items[0];
    await sendTelegramMessageWithKeyboard(
      env,
      chatId,
      [
        "▶️ Active Queue Task",
        "",
        item.task,
        item.start && item.finish ? `🕐 ${item.start}–${item.finish}` : "",
      ].filter(Boolean).join("\n"),
      getActiveTaskKeyboard(item.taskRef)
    );
    return;
  }

  const lines = ["▶️ Active Queue Tasks", ""];
  const buttons = [];

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.task}`);
    if (item.start && item.finish) lines.push(`   🕐 ${item.start}–${item.finish}`);
    buttons.push([
      { text: `✅ Done ${index + 1}`, callback_data: `qdone:${item.taskRef}` },
      { text: `➕ Continue ${index + 1}`, callback_data: `qcontinue:${item.taskRef}` },
    ]);
  });

  await sendTelegramMessageWithKeyboard(
    env,
    chatId,
    lines.join("\n"),
    { inline_keyboard: buttons }
  );
}

function getActiveTaskKeyboard(taskRef) {
  return {
    inline_keyboard: [[
      { text: "✅ Done", callback_data: `qdone:${taskRef}` },
      { text: "➕ Continue 1h", callback_data: `qcontinue:${taskRef}` },
    ]],
  };
}

async function sendFinanceMenu(env, chatId) {
  await sendTelegramMessageWithKeyboard(
    env,
    chatId,
    [
      "💰 Finance",
      "",
      "Log income and expenses step by step.",
      "",
      "Flow:",
      "1) Enter amount",
      "2) Pick category",
      "3) Add an optional note",
      "4) Save",
    ].join("\n"),
    {
      inline_keyboard: [
        [
          { text: "💸 Add Expense", callback_data: "finance:add_expense" },
          { text: "💵 Add Income", callback_data: "finance:add_income" },
        ],
        [
          { text: "🏦 Balance", callback_data: "financebalance" },
          { text: "📊 Week", callback_data: "financeweek" },
        ],
      ],
    }
  );
}

const FINANCE_EXPENSE_CATEGORIES = [
  ["Food", "Food"],
  ["Transport", "Transport"],
  ["Bills", "Bills"],
  ["Loan", "Loan"],
  ["Rent", "Rent"],
  ["Health", "Health"],
  ["Education", "Education"],
  ["Shopping", "Shopping"],
  ["Other", "other"],
];

const FINANCE_INCOME_CATEGORIES = [
  ["Salary", "Salary"],
  ["Freelance", "Freelance"],
  ["Gift", "Gift"],
  ["Investment", "Investment"],
  ["Refund", "Refund"],
  ["Other", "other"],
];

async function sendFinanceAmountPrompt(env, chatId, transactionType) {
  const isIncome = transactionType === "income";
  await callTelegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: [
      isIncome ? "💵 Income Amount" : "💸 Expense Amount",
      "",
      "Reply with the amount only.",
      "",
      isIncome ? "Example: 5000000" : "Example: 250000",
    ].join("\n"),
    reply_markup: getMainMenuKeyboard(isIncome ? "5000000" : "250000"),
  });
}

async function handleFinanceStepReply(env, chatId, rawText, step) {
  if (step.kind === "amount") {
    await sendFinanceCategoryPicker(env, chatId, step.transactionType, rawText);
    return;
  }

  if (step.kind === "category") {
    const category = rawText.trim();
    if (!category || category.length > 80) {
      await sendTelegramMessage(env, chatId, "Please send a shorter category name.");
      return;
    }

    await setFinanceSession(chatId, {
      kind: "note",
      transactionType: step.transactionType,
      amount: step.amount,
      category,
    });
    await sendFinanceNotePrompt(env, chatId, step.transactionType, step.amount, category);
    return;
  }

  if (step.kind === "note") {
    const note = isEmptyFinanceNote(rawText) ? "" : rawText.trim();
    await prepareFinanceDraft(env, chatId, `${step.amount} | ${step.category} | ${note}`, step.transactionType);
    await clearFinanceSession(chatId);
  }
}

async function sendFinanceCategoryPicker(env, chatId, transactionType, amountInput) {
  const amount = normalizeFinanceAmountInput(amountInput);

  if (!amount) {
    await sendTelegramMessage(env, chatId, "Amount should be a number greater than zero. Please try again.");
    await sendFinanceAmountPrompt(env, chatId, transactionType);
    return;
  }

  const isIncome = transactionType === "income";
  const categories = isIncome ? FINANCE_INCOME_CATEGORIES : FINANCE_EXPENSE_CATEGORIES;
  const buttons = [];

  for (let index = 0; index < categories.length; index += 2) {
    buttons.push(categories.slice(index, index + 2).map(([label, value]) => ({
      text: label,
      callback_data: `fincat:${transactionType}:${encodeURIComponent(amount)}:${encodeURIComponent(value)}`,
    })));
  }

  await sendTelegramMessageWithKeyboard(env, chatId, [
    isIncome ? "💵 Income Category" : "💸 Expense Category",
    "",
    `Amount: ${amount}`,
    "",
    "Pick a category:",
  ].join("\n"), { inline_keyboard: buttons });
}

async function sendFinanceCustomCategoryPrompt(env, chatId, transactionType, amount) {
  await callTelegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: [
      "Custom category",
      "",
      `Amount: ${amount}`,
      "",
      "Reply with the category name.",
    ].join("\n"),
    reply_markup: getMainMenuKeyboard("Food, Loan, Subscription..."),
  });
}

async function sendFinanceNotePrompt(env, chatId, transactionType, amount, category) {
  await callTelegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: [
      "Any note?",
      "",
      `Amount: ${amount}`,
      `Category: ${category}`,
      "",
      "Reply with a short note, or send - if you do not need one.",
    ].join("\n"),
    reply_markup: getMainMenuKeyboard("groceries, July salary, or -"),
  });
}

function parseFinanceCategoryCallback(data) {
  const parts = data.split(":");
  const transactionType = parts[1];
  const amount = decodeURIComponent(parts[2] || "");
  const categoryKey = decodeURIComponent(parts[3] || "");

  if (!["income", "expense"].includes(transactionType) || !amount || !categoryKey) {
    return { ok: false, message: "Invalid finance category." };
  }

  const categories = transactionType === "income"
    ? FINANCE_INCOME_CATEGORIES
    : FINANCE_EXPENSE_CATEGORIES;
  const match = categories.find(([, value]) => value === categoryKey);

  if (!match) {
    return { ok: false, message: "Unknown finance category." };
  }

  return {
    ok: true,
    transactionType,
    amount,
    categoryKey,
    categoryLabel: match[0],
  };
}

function getFinanceReplyStep(text) {
  const value = String(text || "");
  const amountMatch = value.match(/#finance_amount_(income|expense)/);
  if (amountMatch) {
    return { kind: "amount", transactionType: amountMatch[1] };
  }

  const categoryMatch = value.match(/#finance_category_(income|expense)_([^\s]+)/);
  if (categoryMatch) {
    return {
      kind: "category",
      transactionType: categoryMatch[1],
      amount: decodeURIComponent(categoryMatch[2]),
    };
  }

  const noteMatch = value.match(/#finance_note_(income|expense)_([^\s]+)_([^\s]+)/);
  if (noteMatch) {
    return {
      kind: "note",
      transactionType: noteMatch[1],
      amount: decodeURIComponent(noteMatch[2]),
      category: decodeURIComponent(noteMatch[3]),
    };
  }

  return null;
}

function normalizeFinanceAmountInput(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[,\s]/g, "")
    .replace(/[^\d.۰-۹٠-٩]/g, "")
    .replace(/[۰-۹]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit))
    .replace(/[٠-٩]/g, (digit) => "٠١٢٣٤٥٦٧٨٩".indexOf(digit));
  const amount = Number(normalized);

  if (!Number.isFinite(amount) || amount <= 0) return "";
  return String(Math.round(amount * 100) / 100);
}

function isEmptyFinanceNote(value) {
  return ["", "-", "—", "no", "none", "na", "n/a", "نه", "ندارم"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function getFinanceSessionRequest(chatId) {
  return new Request(`https://pulsetask.local/finance-session/${encodeURIComponent(chatId)}`);
}

async function setFinanceSession(chatId, session) {
  try {
    await caches.default.put(
      getFinanceSessionRequest(chatId),
      new Response(JSON.stringify(session), {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=900",
        },
      })
    );
  } catch (error) {
    console.error("Could not save finance session:", error);
  }
}

async function getFinanceSession(chatId) {
  try {
    const response = await caches.default.match(getFinanceSessionRequest(chatId));
    if (!response) return null;
    return await response.json();
  } catch (error) {
    console.error("Could not read finance session:", error);
    return null;
  }
}

async function clearFinanceSession(chatId) {
  try {
    await caches.default.delete(getFinanceSessionRequest(chatId));
  } catch (error) {
    console.error("Could not clear finance session:", error);
  }
}

async function sendFinanceEntryPrompt(env, chatId, transactionType) {
  const isIncome = transactionType === "income";
  await callTelegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: [
      isIncome ? "💵 Income Entry" : "💸 Expense Entry",
      "",
      "Reply with:",
      "AMOUNT | CATEGORY | NOTE",
      "",
      isIncome
        ? "Example: 5000000 | Salary | July payment"
        : "Example: 250000 | Food | groceries",
    ].join("\n"),
    reply_markup: getMainMenuKeyboard(
      isIncome ? "5000000 | Salary | July payment" : "250000 | Food | groceries"
    ),
  });
}

function getFinanceReplyType(text) {
  const value = String(text || "");
  if (value.includes("💵 Income Entry")) return "income";
  if (value.includes("💸 Expense Entry")) return "expense";
  return "";
}

async function prepareFinanceDraft(env, chatId, financeInput, transactionType) {
  const result = await sendToAppsScript(env, {
    action: "prepare_finance_draft",
    transactionType: transactionType,
    financeInput: financeInput,
    telegramChatId: chatId,
    createdAt: new Date().toISOString(),
  });

  if (result?.preview && result?.draftId) {
    await sendTelegramMessageWithKeyboard(env, chatId, result.preview, {
      inline_keyboard: [
        [
          { text: "✅ Save", callback_data: `finconfirm:${result.draftId}` },
          { text: "❌ Cancel", callback_data: `fincancel:${result.draftId}` },
        ],
      ],
    });
  }
}

function formatMoneyText(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatQueueButtonLabel(item) {
  const task = String(item?.task || "Untitled task").replace(/\s+/g, " ").trim();
  const duration = String(item?.duration || "").trim();
  const suffix = duration ? ` · ${duration}` : "";
  const maxTaskLength = Math.max(12, 48 - suffix.length);
  const shortTask = task.length > maxTaskLength
    ? `${task.slice(0, maxTaskLength - 1)}…`
    : task;

  return `▶️ ${shortTask}${suffix}`;
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
