import { createDecipheriv, createHash } from "node:crypto";

export interface WxWorkCrypto {
  decrypt(encryptedMsg: string): string;
  verifySignature(msgSignature: string, timestamp: string, nonce: string, encryptMsg: string): boolean;
}

export function createWxWorkCrypto(token: string, encodingAESKey: string, corpId: string): WxWorkCrypto {
  const aesKey = Buffer.from(encodingAESKey + "=", "base64");
  const iv = aesKey.subarray(0, 16);

  function decrypt(encryptedMsg: string): string {
    const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(encryptedMsg, "base64"),
      decipher.final(),
    ]);

    const pad = decrypted[decrypted.length - 1];
    const content = decrypted.subarray(0, decrypted.length - pad);

    const msgLen = content.readUInt32BE(16);
    const msg = content.subarray(20, 20 + msgLen).toString("utf-8");

    const receiveid = content.subarray(20 + msgLen).toString("utf-8");
    if (receiveid !== corpId) {
      throw new Error(`WxWork decrypt: receiveid mismatch (expected ${corpId}, got ${receiveid})`);
    }

    return msg;
  }

  function computeSignature(token: string, timestamp: string, nonce: string, encryptMsg: string): string {
    const parts = [token, timestamp, nonce, encryptMsg].sort();
    return createHash("sha1").update(parts.join("")).digest("hex");
  }

  function verifySignature(msgSignature: string, timestamp: string, nonce: string, encryptMsg: string): boolean {
    const computed = computeSignature(token, timestamp, nonce, encryptMsg);
    return computed === msgSignature;
  }

  return { decrypt, verifySignature };
}

export function extractEncryptFromXml(xml: string): string {
  const match = xml.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s);
  if (!match) {
    throw new Error("Failed to extract Encrypt from XML");
  }
  return match[1];
}

export interface WxWorkMessage {
  toUserName: string;
  fromUserName: string;
  createTime: number;
  msgType: string;
  content?: string;
  msgId?: string;
  agentId?: string;
  event?: string;
  eventKey?: string;
}

export function parseMessageXml(xml: string): WxWorkMessage {
  function extractField(fieldName: string): string | undefined {
    const cdataMatch = xml.match(new RegExp(`<${fieldName}><!\\\[CDATA\\\[(.*?)\\\]\\\]><\/${fieldName}>`, "s"));
    if (cdataMatch) return cdataMatch[1];
    const plainMatch = xml.match(new RegExp(`<${fieldName}>(.*?)<\/${fieldName}>`, "s"));
    if (plainMatch) return plainMatch[1];
    return undefined;
  }

  return {
    toUserName: extractField("ToUserName") ?? "",
    fromUserName: extractField("FromUserName") ?? "",
    createTime: Number(extractField("CreateTime") ?? "0"),
    msgType: extractField("MsgType") ?? "",
    content: extractField("Content"),
    msgId: extractField("MsgId"),
    agentId: extractField("AgentID"),
    event: extractField("Event"),
    eventKey: extractField("EventKey"),
  };
}
