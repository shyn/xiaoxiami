import type { ConversationRef } from "./types.js";

export interface MessengerCapabilities {
  supportsEdit: boolean;
  supportsDraft: boolean;
  supportsButtons: boolean;
  supportsThreads: boolean;
  supportsDelete: boolean;
  maxTextChars: number;
}

export interface UIButton {
  label: string;
  actionId: string;
  data?: string;
}

export type UIElement =
  | { kind: "buttons"; rows: UIButton[][] }
  | { kind: "none" };

export type OutMessage =
  | { type: "text"; text: string; ui?: UIElement }
  | { type: "image"; bytes: Uint8Array; filename?: string; caption?: string }
  | { type: "file"; bytes: Uint8Array; filename: string; caption?: string };

export interface SendResult {
  messageRef?: string;
}

export interface Messenger {
  readonly capabilities: MessengerCapabilities;
  send(convo: ConversationRef, msg: OutMessage): Promise<SendResult>;
  edit?(convo: ConversationRef, messageRef: string, msg: OutMessage): Promise<void>;
  deleteMessage?(convo: ConversationRef, messageRef: string): Promise<void>;
  ackAction?(ackHandle: unknown, text?: string, alert?: boolean): Promise<void>;
  sendTyping?(convo: ConversationRef): Promise<void>;
  sendDraft?(convo: ConversationRef, draftId: number, text: string): Promise<boolean>;
}
