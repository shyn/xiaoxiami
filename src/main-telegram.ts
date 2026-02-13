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
import { rootLogger } from "./logger.js";

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
    rootLogger.info({ ownerId: config.presetOwnerId }, "Owner pre-configured via OWNER_ID");
  }

  const modelCount = config.modelRegistry.list().length;
  const defaultModel = config.modelRegistry.getDefault();

  rootLogger.info("🤖 Pi Agent Telegram Bot started");
  rootLogger.info({
    authFile: config.authFile,
    paired: auth.isPaired(),
    ownerId: auth.getData().ownerId,
    agentCwd: config.cwd,
    modelCount,
    defaultModel: { key: defaultModel.key, provider: defaultModel.provider, id: defaultModel.id },
    tmuxSocket: config.tmuxDefaultSocket,
  }, "Bot configuration");

  setInterval(router.cleanupStaleControllers, router.cleanupIntervalMs);

  await startTelegramPolling({
    token: config.telegramToken,
    dataDir: config.dataDir,
    onEvent: router.handleEvent,
    onRawUpdate: (update, chatId, threadId) => {
      if (chatId != null) {
        messageStore.append(chatId, threadId, update).catch((e) =>
          rootLogger.error({ err: e }, "Failed to persist update"),
        );
      }
    },
  });
}

main().catch((e) => {
  rootLogger.fatal({ err: e }, "Fatal error");
  process.exit(1);
});
