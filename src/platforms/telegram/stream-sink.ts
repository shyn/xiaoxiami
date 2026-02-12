import type { StreamSink } from "../../im/stream-sink.js";
import type { ConversationRef } from "../../im/types.js";
import type { Messenger } from "../../im/messenger.js";

const EDIT_THROTTLE_MS = 400;
const MAX_DRAFT_LEN = 4000;

export class TelegramStreamSink implements StreamSink {
  private messenger: Messenger;
  private convo: ConversationRef;

  private _buffer = "";
  private currentMsgRef: string | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private draftId = 0;

  constructor(messenger: Messenger, convo: ConversationRef) {
    this.messenger = messenger;
    this.convo = convo;
  }

  get buffer(): string {
    return this._buffer;
  }

  start(): void {
    this._buffer = "";
    this.currentMsgRef = null;
    this.draftId = Math.floor(Math.random() * 2147483646) + 1;
  }

  onDelta(delta: string): void {
    this._buffer += delta;
    this.scheduleEdit();
  }

  async toolNotice(text: string): Promise<void> {
    try {
      await this.messenger.send(this.convo, { type: "text", text });
    } catch { /* best effort */ }
  }

  async finalize(error?: string): Promise<string | null> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (error && this._buffer.length === 0) {
      this.draftId = 0;
      await this.messenger.send(this.convo, { type: "text", text: `⚠️ <b>Model error:</b> ${error}` });
      return null;
    }

    if (this._buffer) {
      const finalText = this._buffer;
      if (this.draftId) {
        const maxChars = this.messenger.capabilities.maxTextChars;
        if (finalText.length > maxChars) {
          const chunks = chunkText(finalText, maxChars);
          for (const chunk of chunks) {
            this.messenger.send(this.convo, { type: "text", text: chunk }).catch(() => {});
          }
        } else {
          this.messenger.send(this.convo, { type: "text", text: finalText }).catch(() => {});
        }
      } else {
        await this.flushStreamEdit();
      }
    }

    const pending = this._buffer;
    this.draftId = 0;
    this._buffer = "";
    this.currentMsgRef = null;
    return pending || null;
  }

  resetState(): void {
    this._buffer = "";
    this.currentMsgRef = null;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.flushStream();
    }, EDIT_THROTTLE_MS);
  }

  private async flushStream(): Promise<void> {
    if (!this._buffer) return;

    const text = this._buffer;

    if (this.draftId && this.messenger.sendDraft) {
      try {
        const draftText = text.length > MAX_DRAFT_LEN ? "…" + text.slice(-MAX_DRAFT_LEN) : text;
        await this.messenger.sendDraft(this.convo, this.draftId, draftText);
      } catch {
        this.draftId = 0;
        await this.flushStreamEdit();
      }
      return;
    }

    await this.flushStreamEdit();
  }

  private async flushStreamEdit(): Promise<void> {
    const text = this._buffer;
    if (!text) return;

    const maxChars = this.messenger.capabilities.maxTextChars;

    if (text.length > maxChars) {
      const chunks = chunkText(text, maxChars);

      if (this.currentMsgRef && chunks.length > 0 && this.messenger.edit) {
        try {
          await this.messenger.edit(this.convo, this.currentMsgRef, { type: "text", text: chunks[0] });
        } catch { /* rate limit or message too old */ }
        this.currentMsgRef = null;
      }

      for (let i = this.currentMsgRef ? 1 : 0; i < chunks.length; i++) {
        try {
          const result = await this.messenger.send(this.convo, { type: "text", text: chunks[i] });
          if (i === chunks.length - 1) {
            this.currentMsgRef = result.messageRef ?? null;
          }
        } catch { /* rate limit */ }
      }

      this._buffer = chunks[chunks.length - 1] ?? "";
      return;
    }

    try {
      if (this.currentMsgRef && this.messenger.edit) {
        await this.messenger.edit(this.convo, this.currentMsgRef, { type: "text", text });
      } else {
        const result = await this.messenger.send(this.convo, { type: "text", text });
        this.currentMsgRef = result.messageRef ?? null;
      }
    } catch {
      try {
        const result = await this.messenger.send(this.convo, { type: "text", text });
        this.currentMsgRef = result.messageRef ?? null;
      } catch { /* give up for this cycle */ }
    }
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
