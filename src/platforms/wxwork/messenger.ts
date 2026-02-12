import type { ConversationRef } from "../../im/types.js";
import type {
  Messenger,
  MessengerCapabilities,
  OutMessage,
  SendResult,
} from "../../im/messenger.js";
import type { WxWorkClient } from "./client.js";

export class WxWorkMessenger implements Messenger {
  readonly capabilities: MessengerCapabilities = {
    supportsEdit: false,
    supportsDraft: false,
    supportsButtons: false,
    supportsThreads: false,
    supportsDelete: false,
    maxTextChars: 1800,
  };

  private client: WxWorkClient;

  constructor(client: WxWorkClient) {
    this.client = client;
  }

  async send(convo: ConversationRef, msg: OutMessage): Promise<SendResult> {
    const toUser = convo.conversationId;

    switch (msg.type) {
      case "text": {
        await this.client.sendMarkdown(toUser, msg.text);
        return {};
      }
      case "image": {
        const mediaId = await this.client.uploadMedia("image", msg.bytes, msg.filename ?? "image.png");
        await this.client.sendImage(toUser, mediaId);
        if (msg.caption) {
          await this.client.sendMarkdown(toUser, msg.caption);
        }
        return {};
      }
      case "file": {
        const mediaId = await this.client.uploadMedia("file", msg.bytes, msg.filename);
        await this.client.sendFile(toUser, mediaId);
        if (msg.caption) {
          await this.client.sendMarkdown(toUser, msg.caption);
        }
        return {};
      }
    }
  }

  async sendTyping(_convo: ConversationRef): Promise<void> {
    // WxWork doesn't support typing indicators
  }
}
