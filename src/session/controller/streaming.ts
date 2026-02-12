/**
 * Streaming output management for agent responses.
 * Handles text delta buffering, throttled edits, chunking, and draft messages.
 */

import type { TelegramClient } from "../../telegram/client.js";
import { chunkText, escapeHtml } from "../../telegram/format.js";

export class StreamingManager {
  private tg: TelegramClient;
  private chatId: number;
  private telegramMaxChars: number;
  private editThrottleMs: number;

  streamBuffer = "";
  currentMsgId: number | null = null;
  editTimer: ReturnType<typeof setTimeout> | null = null;
  draftId: number = 0;

  constructor(tg: TelegramClient, chatId: number, telegramMaxChars: number, editThrottleMs: number) {
    this.tg = tg;
    this.chatId = chatId;
    this.telegramMaxChars = telegramMaxChars;
    this.editThrottleMs = editThrottleMs;
  }

  handleTextDelta(delta: string): void {
    this.streamBuffer += delta;
    this.scheduleEdit();
  }

  resetStreamState(): void {
    this.streamBuffer = "";
    this.currentMsgId = null;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  startNewStream(): void {
    this.streamBuffer = "";
    this.currentMsgId = null;
    this.draftId = Math.floor(Math.random() * 2147483646) + 1;
  }

  async finalizeStream(errorMessage?: string): Promise<string | null> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (errorMessage && this.streamBuffer.length === 0) {
      this.draftId = 0;
      await this.tg.sendMessage(this.chatId, `⚠️ <b>Model error:</b> ${escapeHtml(errorMessage)}`, {
        parse_mode: "HTML",
      });
      return null;
    }

    if (this.streamBuffer) {
      const finalText = this.streamBuffer;
      if (this.draftId) {
        if (finalText.length > this.telegramMaxChars) {
          const chunks = chunkText(finalText, this.telegramMaxChars);
          for (const chunk of chunks) {
            this.tg.sendMessage(this.chatId, chunk).catch(() => {});
          }
        } else {
          this.tg.sendMessage(this.chatId, finalText).catch(() => {});
        }
      } else {
        await this.flushStreamEdit();
      }
    }

    const pending = this.streamBuffer;
    this.draftId = 0;
    this.streamBuffer = "";
    this.currentMsgId = null;
    return pending || null;
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.flushStream();
    }, this.editThrottleMs);
  }

  private async flushStream(): Promise<void> {
    if (!this.streamBuffer) return;

    const text = this.streamBuffer;

    if (this.draftId) {
      try {
        const maxDraftLen = 4000;
        const draftText = text.length > maxDraftLen ? "…" + text.slice(-maxDraftLen) : text;
        await this.tg.sendMessageDraft(this.chatId, this.draftId, draftText);
      } catch {
        this.draftId = 0;
        await this.flushStreamEdit();
      }
      return;
    }

    await this.flushStreamEdit();
  }

  private async flushStreamEdit(): Promise<void> {
    const text = this.streamBuffer;
    if (!text) return;

    if (text.length > this.telegramMaxChars) {
      const chunks = chunkText(text, this.telegramMaxChars);

      if (this.currentMsgId && chunks.length > 0) {
        try {
          await this.tg.editMessageText(this.chatId, this.currentMsgId, chunks[0]);
        } catch { /* rate limit or message too old */ }
        this.currentMsgId = null;
      }

      for (let i = this.currentMsgId ? 1 : 0; i < chunks.length; i++) {
        try {
          const msg = await this.tg.sendMessage(this.chatId, chunks[i]);
          if (i === chunks.length - 1) {
            this.currentMsgId = msg.message_id;
          }
        } catch { /* rate limit */ }
      }

      this.streamBuffer = chunks[chunks.length - 1] ?? "";
      return;
    }

    try {
      if (this.currentMsgId) {
        await this.tg.editMessageText(this.chatId, this.currentMsgId, text);
      } else {
        const msg = await this.tg.sendMessage(this.chatId, text);
        this.currentMsgId = msg.message_id;
      }
    } catch {
      try {
        const msg = await this.tg.sendMessage(this.chatId, text);
        this.currentMsgId = msg.message_id;
      } catch { /* give up for this cycle */ }
    }
  }

  async sendToolNotification(html: string): Promise<void> {
    try {
      await this.tg.sendMessage(this.chatId, html, { parse_mode: "HTML" });
    } catch { /* best effort */ }
  }
}
