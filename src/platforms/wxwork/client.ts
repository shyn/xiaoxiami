export interface WxWorkClientConfig {
  corpId: string;
  corpSecret: string;
  agentId: number;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class WxWorkClient {
  private config: WxWorkClientConfig;
  private tokenCache: TokenCache | null = null;
  private static readonly BASE_URL = "https://qyapi.weixin.qq.com/cgi-bin";

  constructor(config: WxWorkClientConfig) {
    this.config = config;
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }

    const url = `${WxWorkClient.BASE_URL}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.corpSecret)}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      errcode: number;
      errmsg: string;
      access_token: string;
      expires_in: number;
    };

    if (data.errcode !== 0) {
      throw new Error(`WxWork gettoken failed: ${data.errcode} ${data.errmsg}`);
    }

    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.tokenCache.token;
  }

  async sendText(toUser: string, content: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${WxWorkClient.BASE_URL}/message/send?access_token=${token}`;
    const body = {
      touser: toUser,
      msgtype: "text",
      agentid: this.config.agentId,
      text: { content },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { errcode: number; errmsg: string };
    if (data.errcode !== 0) {
      throw new Error(`WxWork sendText failed: ${data.errcode} ${data.errmsg}`);
    }
  }

  async sendMarkdown(toUser: string, content: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${WxWorkClient.BASE_URL}/message/send?access_token=${token}`;
    const body = {
      touser: toUser,
      msgtype: "markdown",
      agentid: this.config.agentId,
      markdown: { content },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { errcode: number; errmsg: string };
    if (data.errcode !== 0) {
      throw new Error(
        `WxWork sendMarkdown failed: ${data.errcode} ${data.errmsg}`
      );
    }
  }

  async uploadMedia(
    type: "image" | "file",
    bytes: Uint8Array,
    filename: string
  ): Promise<string> {
    const token = await this.getAccessToken();
    const url = `${WxWorkClient.BASE_URL}/media/upload?access_token=${token}&type=${type}`;

    const form = new FormData();
    const blob = new Blob([bytes]);
    form.append("media", blob, filename);

    const res = await fetch(url, { method: "POST", body: form });
    const data = (await res.json()) as {
      errcode: number;
      errmsg: string;
      media_id: string;
    };
    if (data.errcode !== 0) {
      throw new Error(
        `WxWork uploadMedia failed: ${data.errcode} ${data.errmsg}`
      );
    }
    return data.media_id;
  }

  async sendImage(toUser: string, mediaId: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${WxWorkClient.BASE_URL}/message/send?access_token=${token}`;
    const body = {
      touser: toUser,
      msgtype: "image",
      agentid: this.config.agentId,
      image: { media_id: mediaId },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { errcode: number; errmsg: string };
    if (data.errcode !== 0) {
      throw new Error(
        `WxWork sendImage failed: ${data.errcode} ${data.errmsg}`
      );
    }
  }

  async sendFile(toUser: string, mediaId: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${WxWorkClient.BASE_URL}/message/send?access_token=${token}`;
    const body = {
      touser: toUser,
      msgtype: "file",
      agentid: this.config.agentId,
      file: { media_id: mediaId },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { errcode: number; errmsg: string };
    if (data.errcode !== 0) {
      throw new Error(
        `WxWork sendFile failed: ${data.errcode} ${data.errmsg}`
      );
    }
  }
}
