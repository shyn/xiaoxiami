/**
 * Minimal Telegram Bot API client using fetch.
 * Supports: sendMessage, editMessageText, sendPhoto, sendDocument,
 * answerCallbackQuery, deleteMessage, getUpdates.
 */

const API_BASE = "https://api.telegram.org";

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<TgMessage>;
  editMessageText(chatId: number, messageId: number, text: string, options?: EditMessageOptions): Promise<TgMessage | boolean>;
  deleteMessage(chatId: number, messageId: number): Promise<boolean>;
  sendPhoto(chatId: number, photo: Uint8Array | string, options?: SendPhotoOptions): Promise<TgMessage>;
  sendDocument(chatId: number, doc: Uint8Array, filename: string, options?: SendDocOptions): Promise<TgMessage>;
  answerCallbackQuery(callbackQueryId: string, options?: AnswerCallbackOptions): Promise<boolean>;
  getUpdates(offset?: number, timeout?: number): Promise<TgUpdate[]>;
  sendChatAction(chatId: number, action: string, options?: { message_thread_id?: number }): Promise<boolean>;
  deleteWebhook(): Promise<boolean>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean>;
  getFile(fileId: string): Promise<TgFile>;
  downloadFile(filePath: string): Promise<Uint8Array>;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface SendMessageOptions {
  message_thread_id?: number;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  link_preview_options?: LinkPreviewOptions;
}

export interface EditMessageOptions {
  message_thread_id?: number;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}

export interface SendPhotoOptions {
  message_thread_id?: number;
  caption?: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}

export interface SendDocOptions {
  message_thread_id?: number;
  caption?: string;
  parse_mode?: "MarkdownV2" | "HTML";
}

export interface AnswerCallbackOptions {
  text?: string;
  show_alert?: boolean;
}

export interface LinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  added_to_attachment_menu?: boolean;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
  can_connect_to_business?: boolean;
  has_main_web_app?: boolean;
  has_topics_enabled?: boolean;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
  is_direct_messages?: boolean;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface ForumTopicCreated {
  name: string;
  icon_color: number;
  icon_custom_emoji_id?: string;
  is_name_implicit?: boolean;
}

export interface ForumTopicEdited {
  name?: string;
  icon_custom_emoji_id?: string;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  date: number;
  photo?: TgPhotoSize[];
  reply_to_message?: TgMessage;
  forum_topic_created?: ForumTopicCreated;
  forum_topic_edited?: ForumTopicEdited;
  is_topic_message?: boolean;
}

export interface TgInaccessibleMessage {
  chat: TgChat;
  message_id: number;
  date: 0;
}

export type TgMaybeInaccessibleMessage = TgMessage | TgInaccessibleMessage;

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMaybeInaccessibleMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
  game_short_name?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export function scopedClient(client: TelegramClient, threadId: number | undefined): TelegramClient {
  if (!threadId) return client;
  return {
    sendMessage: (chatId, text, options?) =>
      client.sendMessage(chatId, text, { ...options, message_thread_id: threadId }),
    editMessageText: (chatId, messageId, text, options?) =>
      client.editMessageText(chatId, messageId, text, { ...options, message_thread_id: threadId }),
    deleteMessage: (chatId, messageId) =>
      client.deleteMessage(chatId, messageId),
    sendPhoto: (chatId, photo, options?) =>
      client.sendPhoto(chatId, photo, { ...options, message_thread_id: threadId }),
    sendDocument: (chatId, doc, filename, options?) =>
      client.sendDocument(chatId, doc, filename, { ...options, message_thread_id: threadId }),
    answerCallbackQuery: (id, options?) =>
      client.answerCallbackQuery(id, options),
    getUpdates: (offset?, timeout?) =>
      client.getUpdates(offset, timeout),
    sendChatAction: (chatId, action, options?) =>
      client.sendChatAction(chatId, action, { ...options, message_thread_id: threadId }),
    deleteWebhook: () => client.deleteWebhook(),
    setMyCommands: (commands) => client.setMyCommands(commands),
    getFile: (fileId) => client.getFile(fileId),
    downloadFile: (filePath) => client.downloadFile(filePath),
  };
}

const DEBUG_TELEGRAM = process.env.DEBUG_TELEGRAM === "1";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

interface TgApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

function isRetryable(errorCode: number | undefined, description: string | undefined): boolean {
  if (!errorCode) return false;
  if (errorCode === 429) return true;
  if (errorCode >= 500) return true;
  return false;
}

export function createTelegramClient(token: string): TelegramClient {
  const base = `${API_BASE}/bot${token}`;

  async function call(method: string, body?: Record<string, unknown>): Promise<unknown> {
    const isLongPoll = method === "getUpdates";
    const timeoutMs = isLongPoll
      ? ((body?.timeout as number) ?? 30) * 1000 + 15_000
      : REQUEST_TIMEOUT_MS;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${base}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const json = (await res.json()) as TgApiResponse;
        if (!json.ok) {
          if (isRetryable(json.error_code, json.description) && attempt < MAX_RETRIES) {
            const retryAfter = json.parameters?.retry_after;
            const delay = retryAfter
              ? retryAfter * 1000
              : BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[tg] ${method} error ${json.error_code}: ${json.description}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`Telegram API error [${method}]: ${json.description ?? "unknown"} (${json.error_code ?? "?"})`);
        }

        if (DEBUG_TELEGRAM && json.result && !(Array.isArray(json.result) && json.result.length === 0)) {
          console.log(`[tg] ${method}:`, JSON.stringify(json.result, null, 2).slice(0, 500));
        }
        return json.result;
      } catch (e: unknown) {
        clearTimeout(timer);
        if (e instanceof DOMException && e.name === "AbortError") {
          if (attempt < MAX_RETRIES && !isLongPoll) {
            console.warn(`[tg] ${method} timed out, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
            continue;
          }
          throw new Error(`Telegram API timeout [${method}] after ${timeoutMs}ms`);
        }
        const msg = e instanceof Error ? e.message : String(e);
        const isNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg);
        if (isNetwork && attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[tg] ${method} network error: ${msg}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Telegram API [${method}] failed after ${MAX_RETRIES} retries`);
  }

  async function callFormData(method: string, form: FormData): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/${method}`, { method: "POST", body: form, signal: controller.signal });
      clearTimeout(timer);
      const json = (await res.json()) as TgApiResponse;
      if (!json.ok) {
        throw new Error(`Telegram API error [${method}]: ${json.description ?? "unknown"} (${json.error_code ?? "?"})`);
      }
      return json.result;
    } catch (e: unknown) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(`Telegram API timeout [${method}] after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw e;
    }
  }

  return {
    async sendMessage(chatId, text, options) {
      return (await call("sendMessage", {
        chat_id: chatId,
        text,
        ...options,
      })) as TgMessage;
    },

    async editMessageText(chatId, messageId, text, options) {
      try {
        return (await call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          ...options,
        })) as TgMessage;
      } catch (e: unknown) {
        if (e instanceof Error && e.message.includes("message is not modified")) {
          return true;
        }
        throw e;
      }
    },

    async deleteMessage(chatId, messageId) {
      return (await call("deleteMessage", { chat_id: chatId, message_id: messageId })) as boolean;
    },

    async sendPhoto(chatId, photo, options) {
      if (typeof photo === "string") {
        return (await call("sendPhoto", { chat_id: chatId, photo, ...options })) as TgMessage;
      }
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (options?.message_thread_id) form.set("message_thread_id", String(options.message_thread_id));
      form.set("photo", new Blob([photo]), "screenshot.png");
      if (options?.caption) form.set("caption", options.caption);
      if (options?.parse_mode) form.set("parse_mode", options.parse_mode);
      if (options?.reply_markup) form.set("reply_markup", JSON.stringify(options.reply_markup));
      return (await callFormData("sendPhoto", form)) as TgMessage;
    },

    async sendDocument(chatId, doc, filename, options) {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (options?.message_thread_id) form.set("message_thread_id", String(options.message_thread_id));
      form.set("document", new Blob([doc]), filename);
      if (options?.caption) form.set("caption", options.caption);
      if (options?.parse_mode) form.set("parse_mode", options.parse_mode);
      return (await callFormData("sendDocument", form)) as TgMessage;
    },

    async answerCallbackQuery(callbackQueryId, options) {
      return (await call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...options,
      })) as boolean;
    },

    async getUpdates(offset, timeout = 30) {
      const result = await call("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      });
      return result as TgUpdate[];
    },

    async sendChatAction(chatId, action, options?) {
      return (await call("sendChatAction", { chat_id: chatId, action, ...options })) as boolean;
    },

    async deleteWebhook() {
      return (await call("deleteWebhook", { drop_pending_updates: false })) as boolean;
    },

    async setMyCommands(commands: Array<{ command: string; description: string }>) {
      return (await call("setMyCommands", { commands })) as boolean;
    },

    async getFile(fileId: string) {
      return (await call("getFile", { file_id: fileId })) as TgFile;
    },

    async downloadFile(filePath: string) {
      const url = `${API_BASE}/file/bot${token}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
