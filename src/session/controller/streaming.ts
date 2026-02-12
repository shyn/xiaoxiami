/**
 * Streaming output management for agent responses.
 * Simplified: sends typing indicator at start, then sends final message(s) at the end.
 */

import type { TelegramClient } from "../../telegram/client.js";
import { chunkText, escapeHtml } from "../../telegram/format.js";

export class StreamingManager {
  private tg: TelegramClient;
  private chatId: number;
  private telegramMaxChars: number;

  streamBuffer = "";

  constructor(tg: TelegramClient, chatId: number, telegramMaxChars: number, _editThrottleMs?: number) {
    this.tg = tg;
    this.chatId = chatId;
    this.telegramMaxChars = telegramMaxChars;
  }

  handleTextDelta(delta: string): void {
    this.streamBuffer += delta;
    // Buffer the content but don't send - we'll send the full message at the end
  }

  resetStreamState(): void {
    this.streamBuffer = "";
  }

  startNewStream(): void {
    this.streamBuffer = "";
    // Send typing indicator at the start of streaming
    this.tg.sendChatAction(this.chatId, "typing").catch(() => {});
  }

  async finalizeStream(errorMessage?: string): Promise<string | null> {
    if (errorMessage && this.streamBuffer.length === 0) {
      await this.tg.sendMessage(this.chatId, `⚠️ <b>Model error:</b> ${escapeHtml(errorMessage)}`, {
        parse_mode: "HTML",
      });
      return null;
    }

    if (this.streamBuffer) {
      const finalText = this.streamBuffer;

      if (finalText.length > this.telegramMaxChars) {
        const chunks = chunkText(finalText, this.telegramMaxChars);
        for (const chunk of chunks) {
          await this.tg.sendMessage(this.chatId, chunk).catch(() => {});
        }
      } else {
        await this.tg.sendMessage(this.chatId, finalText).catch(() => {});
      }
    }

    const pending = this.streamBuffer;
    this.streamBuffer = "";
    return pending || null;
  }

  async sendToolNotification(html: string): Promise<void> {
    try {
      await this.tg.sendMessage(this.chatId, html, { parse_mode: "HTML" });
    } catch { /* best effort */ }
  }
}
