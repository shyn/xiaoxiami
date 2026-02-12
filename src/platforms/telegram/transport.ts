import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationRef, UserRef, InboundEvent } from "../../im/types.js";
import type { TelegramClient, TgUpdate } from "../../telegram/client.js";
import { createTelegramClient } from "../../telegram/client.js";

function buildConvo(chatId: number, threadId?: number): ConversationRef {
  return {
    platform: "telegram",
    conversationId: String(chatId),
    threadId: threadId ? String(threadId) : undefined,
  };
}

function buildUser(from: { id: number; username?: string; first_name?: string }): UserRef {
  return {
    platform: "telegram",
    userId: String(from.id),
    displayName: from.username ?? from.first_name,
  };
}

export async function parseTelegramUpdate(
  update: TgUpdate,
  tg: TelegramClient,
): Promise<InboundEvent | null> {
  if (update.callback_query) {
    const cb = update.callback_query;
    const cbChat = cb.message?.chat;
    if (!cbChat || !cb.data) return null;

    const cbThreadId =
      cb.message && "message_thread_id" in cb.message
        ? (cb.message as { message_thread_id?: number }).message_thread_id
        : undefined;

    const convo = buildConvo(cbChat.id, cbThreadId);
    const from = buildUser(cb.from);

    const colonIdx = cb.data.indexOf(":");
    const actionId = colonIdx > 0 ? cb.data.slice(0, colonIdx) : cb.data;
    const data = colonIdx > 0 ? cb.data.slice(colonIdx + 1) : undefined;

    return {
      type: "action",
      convo,
      from,
      actionId,
      data,
      ackHandle: cb.id,
      raw: update,
    };
  }

  if (update.message) {
    const msg = update.message;
    if (!msg.from) return null;

    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const convo = buildConvo(chatId, threadId);
    const from = buildUser(msg.from);

    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      try {
        const file = await tg.getFile(largestPhoto.file_id);
        if (!file.file_path) return null;
        const bytes = await tg.downloadFile(file.file_path);
        const mimeType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
        return {
          type: "image",
          convo,
          from,
          image: { bytes, mimeType },
          caption: msg.caption?.trim(),
          raw: update,
        };
      } catch (e) {
        console.error("[transport] Failed to download photo:", e);
        return null;
      }
    }

    const text = msg.text?.trim();
    if (!text) return null;

    const topicName =
      msg.reply_to_message?.forum_topic_created?.name ?? msg.forum_topic_created?.name;
    const isTmuxTopic = topicName?.startsWith("/tmux") ?? false;

    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const command = (spaceIdx > 0 ? text.slice(0, spaceIdx) : text).split("@")[0];
      const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";
      return {
        type: "command",
        convo,
        from,
        command,
        args,
        raw: isTmuxTopic ? { ...update, isTmuxTopic: true } : update,
      };
    }

    if (isTmuxTopic) {
      return {
        type: "text",
        convo,
        from,
        text,
        raw: { ...update, isTmuxTopic: true },
      };
    }

    return {
      type: "text",
      convo,
      from,
      text,
      raw: update,
    };
  }

  return null;
}

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
    console.error("Failed to save offset:", e);
  }
}

export interface TelegramTransportOptions {
  token: string;
  dataDir: string;
  onEvent: (event: InboundEvent) => Promise<void>;
  onRawUpdate?: (update: TgUpdate, chatId?: number, threadId?: number) => void;
}

export async function startTelegramPolling(opts: TelegramTransportOptions): Promise<never> {
  const tg = createTelegramClient(opts.token);
  let offset: number | undefined = loadOffset(opts.dataDir);

  try {
    await tg.deleteWebhook();
    console.log("Webhook cleared (safe startup).");
  } catch (e) {
    console.error("Failed to clear webhook:", e);
  }

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
    { command: "permissions", description: "Configure tool permissions" },
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

  console.log("Polling for updates...");

  while (true) {
    try {
      const updates = await tg.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;

        const chatId =
          update.message?.chat.id ?? update.callback_query?.message?.chat.id;
        const threadId =
          update.message?.message_thread_id ??
          (update.callback_query?.message && "message_thread_id" in update.callback_query.message
            ? (update.callback_query.message as { message_thread_id?: number }).message_thread_id
            : undefined);

        if (opts.onRawUpdate) {
          opts.onRawUpdate(update, chatId, threadId);
        }

        try {
          const event = await parseTelegramUpdate(update, tg);
          if (event) {
            await opts.onEvent(event);
          }
        } catch (e) {
          console.error("Error handling update:", e);
        }
      }
      if (updates.length > 0 && offset !== undefined) {
        saveOffset(opts.dataDir, offset);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("webhook") || msg.includes("Conflict")) {
        console.log("Webhook conflict during polling, removing...");
        try {
          await tg.deleteWebhook();
          console.log("Webhook removed, resuming polling.");
        } catch (delErr) {
          console.error("Failed to delete webhook:", delErr);
        }
      } else {
        console.error("Polling error:", e);
      }
      await Bun.sleep(3000);
    }
  }
}
