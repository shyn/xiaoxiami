import type { ConversationRef } from "../../im/types.js";
import type {
  Messenger,
  MessengerCapabilities,
  OutMessage,
  SendResult,
  UIElement,
} from "../../im/messenger.js";
import type { TelegramClient, InlineKeyboardButton } from "../../telegram/client.js";

function buildReplyMarkup(ui?: UIElement): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (!ui || ui.kind === "none") return undefined;
  if (ui.kind === "buttons") {
    const keyboard: InlineKeyboardButton[][] = ui.rows.map((row) =>
      row.map((btn) => ({
        text: btn.label,
        callback_data: `${btn.actionId}${btn.data ? ":" + btn.data : ""}`,
      })),
    );
    return { inline_keyboard: keyboard };
  }
  return undefined;
}

function parseChatId(convo: ConversationRef): number {
  return Number(convo.conversationId);
}

function parseThreadId(convo: ConversationRef): number | undefined {
  return convo.threadId ? Number(convo.threadId) : undefined;
}

export class TelegramMessenger implements Messenger {
  readonly capabilities: MessengerCapabilities = {
    supportsEdit: true,
    supportsDraft: false,
    supportsButtons: true,
    supportsThreads: true,
    supportsDelete: true,
    maxTextChars: 3800,
  };

  private tg: TelegramClient;

  constructor(tg: TelegramClient) {
    this.tg = tg;
  }

  async send(convo: ConversationRef, msg: OutMessage): Promise<SendResult> {
    const chatId = parseChatId(convo);
    const threadId = parseThreadId(convo);

    switch (msg.type) {
      case "text": {
        const result = await this.tg.sendMessage(chatId, msg.text, {
          parse_mode: "HTML",
          message_thread_id: threadId,
          reply_markup: buildReplyMarkup(msg.ui),
        });
        return { messageRef: String(result.message_id) };
      }
      case "image": {
        const result = await this.tg.sendPhoto(chatId, msg.bytes, {
          message_thread_id: threadId,
          caption: msg.caption,
          parse_mode: msg.caption ? "HTML" : undefined,
        });
        return { messageRef: String(result.message_id) };
      }
      case "file": {
        const result = await this.tg.sendDocument(chatId, msg.bytes, msg.filename, {
          message_thread_id: threadId,
          caption: msg.caption,
          parse_mode: msg.caption ? "HTML" : undefined,
        });
        return { messageRef: String(result.message_id) };
      }
    }
  }

  async edit(convo: ConversationRef, messageRef: string, msg: OutMessage): Promise<void> {
    if (msg.type !== "text") return;
    const chatId = parseChatId(convo);
    const messageId = Number(messageRef);
    await this.tg.editMessageText(chatId, messageId, msg.text, {
      parse_mode: "HTML",
      reply_markup: buildReplyMarkup(msg.ui),
    });
  }

  async deleteMessage(convo: ConversationRef, messageRef: string): Promise<void> {
    const chatId = parseChatId(convo);
    const messageId = Number(messageRef);
    await this.tg.deleteMessage(chatId, messageId);
  }

  async ackAction(ackHandle: unknown, text?: string, alert?: boolean): Promise<void> {
    const callbackQueryId = ackHandle as string;
    await this.tg.answerCallbackQuery(callbackQueryId, {
      text,
      show_alert: alert,
    });
  }

  async sendTyping(convo: ConversationRef): Promise<void> {
    const chatId = parseChatId(convo);
    const threadId = parseThreadId(convo);
    await this.tg.sendChatAction(chatId, "typing", {
      message_thread_id: threadId,
    });
  }

}
