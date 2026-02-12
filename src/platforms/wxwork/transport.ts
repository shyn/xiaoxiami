import type { InboundEvent, ConversationRef, UserRef } from "../../im/types.js";
import {
  createWxWorkCrypto,
  extractEncryptFromXml,
  parseMessageXml,
} from "./crypto.js";

export interface WxWorkTransportOptions {
  corpId: string;
  token: string;
  encodingAESKey: string;
  port: number;
  onEvent: (event: InboundEvent) => Promise<void>;
}

function buildConvo(userId: string): ConversationRef {
  return {
    platform: "wxwork",
    conversationId: userId,
  };
}

function buildUser(userId: string): UserRef {
  return {
    platform: "wxwork",
    userId,
  };
}

export async function startWxWorkWebhook(opts: WxWorkTransportOptions): Promise<void> {
  const crypto = createWxWorkCrypto(opts.token, opts.encodingAESKey, opts.corpId);

  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);

      const msgSignature = url.searchParams.get("msg_signature") ?? "";
      const timestamp = url.searchParams.get("timestamp") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";

      // GET: URL verification
      if (req.method === "GET") {
        const echostr = url.searchParams.get("echostr") ?? "";
        if (!crypto.verifySignature(msgSignature, timestamp, nonce, echostr)) {
          console.error("[wxwork] GET verification: signature mismatch");
          return new Response("signature mismatch", { status: 403 });
        }

        try {
          const plaintext = crypto.decrypt(echostr);
          return new Response(plaintext, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        } catch (e) {
          console.error("[wxwork] GET verification: decrypt failed:", e);
          return new Response("decrypt failed", { status: 500 });
        }
      }

      // POST: Message callback
      if (req.method === "POST") {
        try {
          const body = await req.text();
          const encryptedMsg = extractEncryptFromXml(body);

          if (!crypto.verifySignature(msgSignature, timestamp, nonce, encryptedMsg)) {
            console.error("[wxwork] POST: signature mismatch");
            return new Response("signature mismatch", { status: 403 });
          }

          const decryptedXml = crypto.decrypt(encryptedMsg);
          const msg = parseMessageXml(decryptedXml);

          console.log(`[wxwork] Received ${msg.msgType} from ${msg.fromUserName}`);

          const event = convertToEvent(msg);
          if (event) {
            opts.onEvent(event).catch((e) => {
              console.error("[wxwork] Error handling event:", e);
            });
          }

          return new Response("success", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        } catch (e) {
          console.error("[wxwork] POST handling error:", e);
          return new Response("error", { status: 500 });
        }
      }

      return new Response("method not allowed", { status: 405 });
    },
  });

  console.log(`[wxwork] Webhook server listening on port ${opts.port}`);
}

function convertToEvent(msg: ReturnType<typeof parseMessageXml>): InboundEvent | null {
  const convo = buildConvo(msg.fromUserName);
  const from = buildUser(msg.fromUserName);

  switch (msg.msgType) {
    case "text": {
      if (!msg.content) return null;
      const text = msg.content.trim();
      if (!text) return null;

      if (text.startsWith("/")) {
        const spaceIdx = text.indexOf(" ");
        const command = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;
        const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";
        return { type: "command", convo, from, command, args };
      }

      return { type: "text", convo, from, text };
    }

    case "event": {
      if (msg.event === "click" && msg.eventKey) {
        return {
          type: "command",
          convo,
          from,
          command: `/${msg.eventKey}`,
          args: "",
        };
      }
      return null;
    }

    case "image": {
      return null;
    }

    default:
      return null;
  }
}
