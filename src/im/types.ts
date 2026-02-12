export type Platform = "telegram" | "wxwork";

export interface ConversationRef {
  platform: Platform;
  conversationId: string;
  threadId?: string;
}

export interface UserRef {
  platform: Platform;
  userId: string;
  displayName?: string;
}

export interface ImageData {
  bytes: Uint8Array;
  mimeType: string;
}

export type InboundEvent =
  | { type: "text"; convo: ConversationRef; from: UserRef; text: string; raw?: unknown }
  | { type: "command"; convo: ConversationRef; from: UserRef; command: string; args: string; raw?: unknown }
  | { type: "image"; convo: ConversationRef; from: UserRef; image: ImageData; caption?: string; raw?: unknown }
  | { type: "action"; convo: ConversationRef; from: UserRef; actionId: string; data?: string; ackHandle?: unknown; raw?: unknown };
