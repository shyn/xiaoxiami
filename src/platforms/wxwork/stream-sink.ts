import type { StreamSink } from "../../im/stream-sink.js";
import type { ConversationRef } from "../../im/types.js";
import type { Messenger } from "../../im/messenger.js";

export class WxWorkStreamSink implements StreamSink {
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
  }

  onDelta(delta: string): void {
    this._buffer += delta;
  }

  async toolNotice(text: string): Promise<void> {
    try {
      await this.messenger.send(this.convo, { type: "text", text });
    } catch { /* best effort */ }
  }

  async finalize(error?: string): Promise<string | null> {
    if (error && this._buffer.length === 0) {
      await this.messenger.send(this.convo, {
        type: "text",
        text: `⚠️ **Model error:** ${error}`,
      });
      return null;
    }

    if (this._buffer) {
      const maxChars = this.messenger.capabilities.maxTextChars;
      const text = this._buffer;

      if (text.length > maxChars) {
        const chunks = chunkText(text, maxChars);
        for (const chunk of chunks) {
          try {
            await this.messenger.send(this.convo, { type: "text", text: chunk });
          } catch { /* best effort */ }
        }
      } else {
        await this.messenger.send(this.convo, { type: "text", text });
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
