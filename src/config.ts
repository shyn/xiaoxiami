import { loadModels, type ModelRegistry, type ThinkingLevel } from "./models.js";

export interface Config {
  telegramToken: string;
  tmuxSocketDir: string;
  tmuxDefaultSocket: string;
  authFile: string;
  telegramMaxChars: number;
  editThrottleMs: number;
  cwd: string;
  sessionDir: string;
  dataDir: string;
  permissionsDir: string;
  modelRegistry: ModelRegistry;
  defaultThinkingLevel: ThinkingLevel;
  presetOwnerId: number | null;
  messageStoreEnabled: boolean;
  messageStoreMaxAgeDays: number;
  logLevel: string;
}

export async function loadConfig(): Promise<Config> {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const tmpdir = process.env.TMPDIR ?? "/tmp";
  const tmuxSocketDir = process.env.TMUX_SOCKET_DIR ?? `${tmpdir}/pi-telegram-tmux`;
  const cwd = process.env.AGENT_CWD ?? process.cwd();
  const dataDir = process.env.DATA_DIR ?? ".";
  const authFile = process.env.AUTH_FILE ?? `${dataDir}/auth.json`;
  const permissionsDir = process.env.PERMISSIONS_DIR ?? `${dataDir}/permissions`;
  const sessionDir = process.env.SESSION_DIR ?? `${dataDir}/sessions`;
  const defaultThinkingLevel = (process.env.THINKING_LEVEL ?? "medium") as ThinkingLevel;

  const presetOwnerIdRaw = process.env.OWNER_ID;
  const presetOwnerId = presetOwnerIdRaw ? Number(presetOwnerIdRaw) : null;
  const messageStoreEnabled = process.env.MESSAGE_STORE_ENABLED !== "false";
  const messageStoreMaxAgeDays = Number(process.env.MESSAGE_STORE_MAX_AGE_DAYS ?? "30");
  const logLevel = process.env.LOG_LEVEL ?? "info";

  const modelRegistry = await loadModels(dataDir);

  return {
    telegramToken,
    tmuxSocketDir,
    tmuxDefaultSocket: `${tmuxSocketDir}/agent.sock`,
    authFile,
    telegramMaxChars: 3800,
    editThrottleMs: 400,
    cwd,
    sessionDir,
    dataDir,
    permissionsDir,
    modelRegistry,
    defaultThinkingLevel,
    presetOwnerId,
    messageStoreEnabled,
    messageStoreMaxAgeDays,
    logLevel,
  };
}
