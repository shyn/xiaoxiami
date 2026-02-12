import { loadConfig } from "./config.js";
import { AuthStore } from "./auth.js";
import { PermissionStore } from "./permissions-store.js";
import { createTelegramClient } from "./telegram/client.js";
import { TelegramMessenger } from "./platforms/telegram/messenger.js";
import { TelegramFormatter } from "./platforms/telegram/formatter.js";
import { TelegramStreamSink } from "./platforms/telegram/stream-sink.js";
import { TelegramMessageStore } from "./telegram/store.js";
import { startTelegramPolling } from "./platforms/telegram/transport.js";
import { Router } from "./bot/router.js";
import type { ConversationRef } from "./im/types.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const auth = new AuthStore(config.authFile);
  const permissions = new PermissionStore(config.permissionsDir);
  const tg = createTelegramClient(config.telegramToken);
  const messenger = new TelegramMessenger(tg);
  const fmt = new TelegramFormatter();

  const messageStore = new TelegramMessageStore(config.sessionDir, {
    enabled: config.messageStoreEnabled,
    maxAgeDays: config.messageStoreMaxAgeDays,
  });

  const createStreamSink = (convo: ConversationRef) =>
    new TelegramStreamSink(messenger, convo);

  const router = new Router({ config, auth, permissions, messenger, fmt, createStreamSink });

  if (config.presetOwnerId && !auth.isPaired()) {
    auth.pair(config.presetOwnerId);
    console.log(`Owner pre-configured via OWNER_ID: ${config.presetOwnerId}`);
  }

  const modelCount = config.modelRegistry.list().length;
  const defaultModel = config.modelRegistry.getDefault();

  console.log(`🤖 Pi Agent Telegram Bot started`);
  console.log(`   Auth file: ${config.authFile}`);
  console.log(`   Paired: ${auth.isPaired() ? `yes (owner: ${auth.getData().ownerId})` : "no — waiting for /start"}`);
  console.log(`   Agent CWD: ${config.cwd}`);
  console.log(`   Models: ${modelCount} configured, default: ${defaultModel.key} (${defaultModel.provider}/${defaultModel.id})`);
  console.log(`   tmux socket: ${config.tmuxDefaultSocket}`);

  setInterval(router.cleanupStaleControllers, router.cleanupIntervalMs);

  await startTelegramPolling({
    token: config.telegramToken,
    dataDir: config.dataDir,
    onEvent: router.handleEvent,
    onRawUpdate: (update, chatId, threadId) => {
      if (chatId != null) {
        messageStore.append(chatId, threadId, update).catch((e) =>
          console.error("Failed to persist update:", e),
        );
      }
    },
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
