/**
 * WxWork (WeCom/企业微信) entry point.
 *
 * Receives messages via webhook callback, sends responses via WxWork API.
 *
 * Environment variables:
 *   WXWORK_CORP_ID        — WeCom Corp ID (required)
 *   WXWORK_CORP_SECRET    — WeCom App Secret (required)
 *   WXWORK_AGENT_ID       — WeCom Agent ID (required)
 *   WXWORK_TOKEN          — Callback Token (required)
 *   WXWORK_ENCODING_KEY   — Callback EncodingAESKey (required)
 *   WXWORK_PORT           — Webhook server port (default: 8080)
 *   AGENT_CWD             — Working directory for the agent (default: cwd)
 *   TMUX_SOCKET_DIR       — tmux socket directory
 *   AUTH_FILE              — Path to auth.json
 *   DATA_DIR              — Data directory
 *   OWNER_ID              — Pre-configured owner ID
 */

import { loadModels, type ThinkingLevel } from "./models.js";
import { AuthStore } from "./auth.js";
import { WxWorkClient } from "./platforms/wxwork/client.js";
import { WxWorkMessenger } from "./platforms/wxwork/messenger.js";
import { WxWorkFormatter } from "./platforms/wxwork/formatter.js";
import { WxWorkStreamSink } from "./platforms/wxwork/stream-sink.js";
import { startWxWorkWebhook } from "./platforms/wxwork/transport.js";
import { Router } from "./bot/router.js";
import type { Config } from "./config.js";
import type { ConversationRef } from "./im/types.js";

async function main(): Promise<void> {
  const corpId = process.env.WXWORK_CORP_ID;
  const corpSecret = process.env.WXWORK_CORP_SECRET;
  const agentIdStr = process.env.WXWORK_AGENT_ID;
  const callbackToken = process.env.WXWORK_TOKEN;
  const encodingAESKey = process.env.WXWORK_ENCODING_KEY;

  if (!corpId || !corpSecret || !agentIdStr || !callbackToken || !encodingAESKey) {
    throw new Error(
      "Required env vars: WXWORK_CORP_ID, WXWORK_CORP_SECRET, WXWORK_AGENT_ID, WXWORK_TOKEN, WXWORK_ENCODING_KEY",
    );
  }

  const agentId = Number(agentIdStr);
  const port = Number(process.env.WXWORK_PORT ?? "8080");

  const tmpdir = process.env.TMPDIR ?? "/tmp";
  const tmuxSocketDir = process.env.TMUX_SOCKET_DIR ?? `${tmpdir}/pi-wxwork-tmux`;
  const cwd = process.env.AGENT_CWD ?? process.cwd();
  const dataDir = process.env.DATA_DIR ?? ".";
  const authFile = process.env.AUTH_FILE ?? `${dataDir}/auth.json`;
  const sessionDir = process.env.SESSION_DIR ?? `${dataDir}/sessions`;
  const defaultThinkingLevel = (process.env.THINKING_LEVEL ?? "medium") as ThinkingLevel;

  const presetOwnerIdRaw = process.env.OWNER_ID;
  const presetOwnerId = presetOwnerIdRaw ? Number(presetOwnerIdRaw) : null;

  const modelRegistry = await loadModels(dataDir);

  const config: Config = {
    telegramToken: "",
    tmuxSocketDir,
    tmuxDefaultSocket: `${tmuxSocketDir}/agent.sock`,
    authFile,
    telegramMaxChars: 1800,
    editThrottleMs: 0,
    cwd,
    sessionDir,
    dataDir,
    modelRegistry,
    defaultThinkingLevel,
    presetOwnerId,
    messageStoreEnabled: false,
    messageStoreMaxAgeDays: 0,
  };

  const auth = new AuthStore(config.authFile);
  const wxClient = new WxWorkClient({ corpId, corpSecret, agentId });
  const messenger = new WxWorkMessenger(wxClient);
  const fmt = new WxWorkFormatter();

  const createStreamSink = (convo: ConversationRef) =>
    new WxWorkStreamSink(messenger, convo);

  const router = new Router({ config, auth, messenger, fmt, createStreamSink });

  if (presetOwnerId && !auth.isPaired()) {
    auth.pair(presetOwnerId);
    console.log(`Owner pre-configured via OWNER_ID: ${presetOwnerId}`);
  }

  const modelCount = modelRegistry.list().length;
  const defaultModel = modelRegistry.getDefault();

  console.log(`🤖 Pi Agent WxWork Bot started`);
  console.log(`   Auth file: ${authFile}`);
  console.log(`   Paired: ${auth.isPaired() ? `yes (owner: ${auth.getData().ownerId})` : "no — waiting for /start"}`);
  console.log(`   Agent CWD: ${cwd}`);
  console.log(`   Models: ${modelCount} configured, default: ${defaultModel.key} (${defaultModel.provider}/${defaultModel.id})`);
  console.log(`   tmux socket: ${config.tmuxDefaultSocket}`);
  console.log(`   Webhook port: ${port}`);

  setInterval(router.cleanupStaleControllers, router.cleanupIntervalMs);

  await startWxWorkWebhook({
    corpId,
    token: callbackToken,
    encodingAESKey,
    port,
    onEvent: router.handleEvent,
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
