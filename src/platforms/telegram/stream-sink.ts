import type { StreamSink } from "../../im/stream-sink.js";
import type { ConversationRef } from "../../im/types.js";
import type { Messenger } from "../../im/messenger.js";
import { escapeHtml } from "../../telegram/format.js";

export class TelegramStreamSink implements StreamSink {
  private messenger: Messenger;
  private convo: ConversationRef;

  private _buffer = "";

  constructor(messenger: Messenger, convo: ConversationRef) {
    this.messenger = messenger;
    this.convo = convo;
  }

  get buffer(): string {
    return this._buffer;
  }

  start(): void {
    this._buffer = "";
    // Send typing indicator at the start of streaming
    this.messenger.sendTyping?.(this.convo).catch(() => {});
  }

  onDelta(delta: string): void {
    this._buffer += delta;
    // Buffer the content but don't send - we'll send the full message at the end
  }

  async toolNotice(text: string): Promise<void> {
    try {
      await this.messenger.send(this.convo, { type: "text", text });
    } catch { /* best effort */ }
  }

  async finalize(error?: string): Promise<string | null> {
    if (error && this._buffer.length === 0) {
      await this.messenger.send(this.convo, { type: "text", text: `⚠️ <b>Model error:</b> ${escapeHtml(error)}` });
      return null;
    }

    if (this._buffer) {
      const finalText = escapeHtml(this._buffer);
      const maxChars = this.messenger.capabilities.maxTextChars;

      if (finalText.length > maxChars) {
        const chunks = chunkText(finalText, maxChars);
        for (const chunk of chunks) {
          await this.messenger.send(this.convo, { type: "text", text: chunk }).catch(() => {});
        }
      } else {
        await this.messenger.send(this.convo, { type: "text", text: finalText }).catch(() => {});
      }
    }

    const pending = this._buffer;
    this._buffer = "";
    return pending || null;
  }

  resetState(): void {
    this._buffer = "";
  }
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}
