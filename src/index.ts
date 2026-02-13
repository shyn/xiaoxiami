/**
 * Pi Agent Telegram Bot — main entry point.
 *
 * Uses long polling to receive Telegram updates and routes them through
 * auth checks to the ChatController.
 *
 * First user to /start becomes the owner and can manage allowed users.
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token (required)
 *   AGENT_CWD           — Working directory for the agent (default: cwd)
 *   TMUX_SOCKET_DIR     — tmux socket directory (default: $TMPDIR/pi-telegram-tmux)
 *   AUTH_FILE            — Path to auth.json (default: ./auth.json)
 *   DATA_DIR             — Data directory for auth.json (default: .)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { AuthStore } from "./auth.js";
import { createTelegramClient, scopedClient, type TgUpdate } from "./telegram/client.js";
import { escapeHtml } from "./telegram/format.js";
import { ChatController } from "./session/controller.js";
import { TelegramMessageStore } from "./telegram/store.js";
import { rootLogger } from "./logger.js";

let config: Awaited<ReturnType<typeof loadConfig>>;
let auth: AuthStore;
let tg: ReturnType<typeof createTelegramClient>;
let messageStore: TelegramMessageStore;

const controllers = new Map<string, ChatController>();
const controllerQueues = new Map<string, Promise<void>>();
const controllerLastUsed = new Map<string, number>();

const CONTROLLER_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONTROLLER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

function controllerKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}

function getController(chatId: number, threadId?: number): ChatController {
  const key = controllerKey(chatId, threadId);
  controllerLastUsed.set(key, Date.now());
  let ctrl = controllers.get(key);
  if (!ctrl) {
    ctrl = new ChatController(scopedClient(tg, threadId), config, chatId, threadId);
    controllers.set(key, ctrl);
  }
  return ctrl;
}

function cleanupStaleControllers(): void {
  const now = Date.now();
  for (const [key, lastUsed] of controllerLastUsed) {
    if (now - lastUsed > CONTROLLER_TTL_MS) {
      const ctrl = controllers.get(key);
      if (ctrl) {
        rootLogger.info({ controllerKey: key }, "Disposing stale controller");
        ctrl.dispose();
        controllers.delete(key);
      }
      controllerQueues.delete(key);
      controllerLastUsed.delete(key);
    }
  }
}

// ── Offset persistence ─────────────────────────────────────────────

function loadOffset(dataDir: string): number | undefined {
  try {
    const raw = readFileSync(`${dataDir}/telegram_offset.json`, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.offset === "number" ? data.offset : undefined;
  } catch {
    return undefined;
  }
}

function saveOffset(dataDir: string, offset: number): void {
  try {
    const filePath = `${dataDir}/telegram_offset.json`;
    const tmpPath = `${filePath}.tmp`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({ offset }) + "\n", "utf-8");
    renameSync(tmpPath, filePath);
  } catch (e) {
    rootLogger.error({ err: e }, "Failed to save offset");
  }
}

function enqueueForController(chatId: number, threadId: number | undefined, fn: () => Promise<void>): void {
  const key = controllerKey(chatId, threadId);
  const prev = controllerQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => {
    rootLogger.error({ queueKey: key, err: e }, "Unhandled error in queued task");
  });
  controllerQueues.set(key, next);
}

// ── Pairing & auth commands (handled before controller routing) ────

async function handleAuthCommand(
  chatId: number,
  userId: number,
  username: string | undefined,
  command: string,
  args: string,
  threadId?: number,
  chatType?: string,
): Promise<boolean> {
  const send = scopedClient(tg, threadId);
  // /start with no owner → pair (only in private chat for security)
  if (command === "/start" && !auth.isPaired()) {
    if (chatType && chatType !== "private") {
      await send.sendMessage(chatId, "🔒 Owner pairing must be done in a private chat with the bot.");
      return true;
    }
    auth.pair(userId, username);
    await send.sendMessage(
      chatId,
      [
        `🔐 <b>Paired!</b>`,
        ``,
        `You are now the owner of this bot.`,
        `Your user ID: <code>${userId}</code>`,
        ``,
        `<b>Owner commands:</b>`,
        `/adduser &lt;user_id&gt; — Allow another user`,
        `/removeuser &lt;user_id&gt; — Remove a user`,
        `/users — List allowed users`,
        ``,
        `Send /help to see all commands.`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return true;
  }

  // Not paired yet and not the pairing /start → reject
  if (!auth.isPaired()) {
    await send.sendMessage(chatId, "🔒 Bot is not configured yet. Send /start in a private chat to pair as owner.");
    return true;
  }

  // Owner-only user management commands
  if (auth.isOwner(userId)) {
    switch (command) {
      case "/adduser": {
        const targetId = Number(args.trim());
        if (!targetId || !Number.isInteger(targetId)) {
          await send.sendMessage(chatId, "Usage: /adduser &lt;user_id&gt;\n\nAsk the user to message @userinfobot to find their ID.", { parse_mode: "HTML" });
          return true;
        }
        if (auth.addUser(targetId)) {
          await send.sendMessage(chatId, `✅ User <code>${targetId}</code> added.`, { parse_mode: "HTML" });
        } else {
          await send.sendMessage(chatId, `User <code>${targetId}</code> is already allowed.`, { parse_mode: "HTML" });
        }
        return true;
      }

      case "/removeuser": {
        const targetId = Number(args.trim());
        if (!targetId || !Number.isInteger(targetId)) {
          await send.sendMessage(chatId, "Usage: /removeuser &lt;user_id&gt;", { parse_mode: "HTML" });
          return true;
        }
        if (auth.removeUser(targetId)) {
          await send.sendMessage(chatId, `✅ User <code>${targetId}</code> removed.`, { parse_mode: "HTML" });
        } else if (auth.isOwner(targetId)) {
          await send.sendMessage(chatId, "Cannot remove the owner.");
        } else {
          await send.sendMessage(chatId, `User <code>${targetId}</code> is not in the allowed list.`, { parse_mode: "HTML" });
        }
        return true;
      }

      case "/users": {
        const data = auth.getData();
        const lines = [
          `<b>Allowed Users</b>`,
          ``,
          `Owner: <code>${data.ownerId}</code>${data.ownerUsername ? ` (@${escapeHtml(data.ownerUsername)})` : ""}`,
          `Paired: ${data.pairedAt ?? "unknown"}`,
          ``,
        ];
        if (data.allowedUserIds.length > 1) {
          const others = data.allowedUserIds.filter((id) => id !== data.ownerId);
          lines.push(`<b>Other users:</b>`);
          for (const id of others) {
            lines.push(`• <code>${id}</code>`);
          }
        } else {
          lines.push("<i>No other users added.</i>");
        }
        lines.push("", "/adduser &lt;id&gt; — add user", "/removeuser &lt;id&gt; — remove user");
        await send.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
        return true;
      }
    }
  }

  // Non-owner trying owner commands
  if (["/adduser", "/removeuser", "/users"].includes(command)) {
    await send.sendMessage(chatId, "🔒 Owner-only command.");
    return true;
  }

  return false;
}

// ── Update handler ─────────────────────────────────────────────────

async function handleUpdate(update: TgUpdate): Promise<void> {
  // Persist raw update
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  const threadId = update.message?.message_thread_id
    ?? (update.callback_query?.message && "message_thread_id" in update.callback_query.message
      ? update.callback_query.message.message_thread_id
      : undefined);
  if (chatId) {
    messageStore.append(chatId, threadId, update).catch((e) =>
      rootLogger.error({ err: e }, "Failed to persist update"),
    );
  }

  // Handle callback queries
  if (update.callback_query) {
    const cb = update.callback_query;
    if (!auth.isAuthorized(cb.from.id)) {
      await tg.answerCallbackQuery(cb.id, { text: "Unauthorized.", show_alert: true });
      return;
    }
    const cbChatId = cb.message?.chat.id;
    if (!cbChatId || !cb.data) return;
    const cbThreadId = cb.message && "message_thread_id" in cb.message ? cb.message.message_thread_id : undefined;

    enqueueForController(cbChatId, cbThreadId, async () => {
      const ctrl = getController(cbChatId, cbThreadId);
      await ctrl.handleCallback(cb.id, cb.data!);
    });
    return;
  }

  // Handle messages
  if (update.message) {
    const msg = update.message;
    const userId = msg.from?.id;
    if (!userId) return;

    const msgChatId = msg.chat.id;
    const msgThreadId = msg.message_thread_id;
    const text = msg.text?.trim();

    // Handle photo messages
    if (msg.photo && msg.photo.length > 0) {
      if (!auth.isAuthorized(userId)) return;
      const largestPhoto = msg.photo[msg.photo.length - 1];
      enqueueForController(msgChatId, msgThreadId, async () => {
        const ctrl = getController(msgChatId, msgThreadId);
        await ctrl.handlePhoto(largestPhoto.file_id, msg.caption?.trim());
      });
      return;
    }

    if (!text) return;

    // Detect /tmux topic via reply_to_message.forum_topic_created.name
    const topicName = msg.reply_to_message?.forum_topic_created?.name
                      ?? msg.forum_topic_created?.name;
    const isTmuxTopic = topicName?.startsWith("/tmux") ?? false;

    // Parse command
    let command = "";
    let args = "";
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      command = (spaceIdx > 0 ? text.slice(0, spaceIdx) : text).split("@")[0];
      args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";
    }

    // /tmux topic: non-command messages go directly to tmux
    if (isTmuxTopic && !command) {
      if (!auth.isAuthorized(userId)) return;
      enqueueForController(msgChatId, msgThreadId, async () => {
        const ctrl = getController(msgChatId, msgThreadId);
        await ctrl.handleTmuxTopicMessage(text);
      });
      return;
    }

    // Handle auth/pairing commands first (lightweight, run inline)
    if (command) {
      const handled = await handleAuthCommand(msgChatId, userId, msg.from?.username, command, args, msgThreadId, msg.chat.type);
      if (handled) return;
    }

    // Auth check for all other interactions
    if (!auth.isAuthorized(userId)) {
      if (command === "/start") {
        const sc = scopedClient(tg, msgThreadId);
        await sc.sendMessage(msgChatId, "🔒 This bot is already paired to another user. Contact the owner for access.");
      }
      return;
    }

    // Route to controller (enqueued to avoid blocking polling)
    enqueueForController(msgChatId, msgThreadId, async () => {
      const ctrl = getController(msgChatId, msgThreadId);
      if (command) {
        await ctrl.handleCommand(command, args);
      } else {
        await ctrl.handleMessage(text);
      }
    });
  }
}

// ── Long polling loop ──────────────────────────────────────────────

async function ensureNoWebhook(): Promise<void> {
  try {
    await tg.deleteWebhook();
    rootLogger.info("Webhook cleared (safe startup)");
  } catch (e: unknown) {
    rootLogger.error({ err: e }, "Failed to clear webhook");
  }
}

async function poll(): Promise<void> {
  config = await loadConfig();
  auth = new AuthStore(config.authFile);
  tg = createTelegramClient(config.telegramToken);
  messageStore = new TelegramMessageStore(config.sessionDir, {
    enabled: config.messageStoreEnabled,
    maxAgeDays: config.messageStoreMaxAgeDays,
  });

  let offset: number | undefined = loadOffset(config.dataDir);

  const modelCount = config.modelRegistry.list().length;
  const defaultModel = config.modelRegistry.getDefault();
  if (config.presetOwnerId && !auth.isPaired()) {
    auth.pair(config.presetOwnerId);
    rootLogger.info({ ownerId: config.presetOwnerId }, "Owner pre-configured via OWNER_ID");
  }

  rootLogger.info("🤖 Pi Agent Telegram Bot started");
  rootLogger.info({
    authFile: config.authFile,
    paired: auth.isPaired(),
    ownerId: auth.getData().ownerId,
    agentCwd: config.cwd,
    modelCount,
    defaultModel: { key: defaultModel.key, provider: defaultModel.provider, id: defaultModel.id },
    tmuxSocket: config.tmuxDefaultSocket,
  }, "Bot configuration");

  await ensureNoWebhook();

  await tg.setMyCommands([
    { command: "help", description: "Show all commands" },
    { command: "status", description: "Show bot and agent status" },
    { command: "sessions", description: "List agent sessions" },
    { command: "resume", description: "Resume a previous session" },
    { command: "newsession", description: "Start a fresh session" },
    { command: "reset", description: "Full agent reset" },
    { command: "abort", description: "Abort current agent operation" },
    { command: "model", description: "Select model" },
    { command: "thinking", description: "Set thinking level" },
    { command: "tmux", description: "List tmux sessions" },
    { command: "new", description: "Create a new tmux session" },
    { command: "select", description: "Select a tmux session" },
    { command: "capture", description: "Capture tmux pane output" },
    { command: "send", description: "Send keys to selected tmux pane" },
    { command: "ctrlc", description: "Send Ctrl-C to selected pane" },
    { command: "kill", description: "Kill a tmux session" },
    { command: "users", description: "List allowed users (owner)" },
    { command: "adduser", description: "Allow a user (owner)" },
    { command: "removeuser", description: "Remove a user (owner)" },
  ]);

  rootLogger.info("Polling for updates...");

  setInterval(cleanupStaleControllers, CONTROLLER_CLEANUP_INTERVAL_MS);

  while (true) {
    try {
      const updates = await tg.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (e) {
          rootLogger.error({ err: e }, "Error handling update");
        }
      }
      if (updates.length > 0 && offset !== undefined) {
        saveOffset(config.dataDir, offset);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("webhook") || msg.includes("Conflict")) {
        rootLogger.warn("Webhook conflict during polling, removing...");
        try {
          await tg.deleteWebhook();
          rootLogger.info("Webhook removed, resuming polling");
        } catch (delErr) {
          rootLogger.error({ err: delErr }, "Failed to delete webhook");
        }
      } else {
        rootLogger.error({ err: e }, "Polling error");
      }
      await Bun.sleep(3000);
    }
  }
}

poll().catch((e) => {
  rootLogger.fatal({ err: e }, "Fatal error");
  process.exit(1);
});
