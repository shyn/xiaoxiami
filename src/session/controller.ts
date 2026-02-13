/**
 * Per-chat controller: orchestrates Telegram <-> Agent <-> tmux.
 * Delegates streaming to StreamingManager and tmux to TmuxHandler.
 */

import type { TelegramClient } from "../telegram/client.js";
import type { Config } from "../config.js";
import type { ManagedSession, AgentEventCallbacks } from "../agent/session.js";
import { createManagedSession } from "../agent/session.js";
import { createTmuxTools } from "../tmux/tools.js";
import * as tmux from "../tmux/tmux.js";
import { escapeHtml } from "../telegram/format.js";
import { modelsKeyboard, thinkingKeyboard, agentSessionsKeyboard } from "../telegram/keyboards.js";
import { SessionManager, type ToolDefinition, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import type { ModelConfig, ThinkingLevel } from "../models.js";
import { StreamingManager } from "./controller/streaming.js";
import { TmuxHandler } from "./controller/tmux-handler.js";
import { parseCallbackData } from "../telegram/callback-parser.js";
import { createLogger, type Logger } from "../logger.js";

export class ChatController {
  private tg: TelegramClient;
  private config: Config;
  private chatId: number;
  private threadId: number | undefined;
  private managed: ManagedSession | null = null;
  private logger: Logger;

  private streaming: StreamingManager;
  private tmuxHandler: TmuxHandler;

  private isAgentRunning = false;
  private pendingInput: string | null = null;

  private sessionIndex = new Map<string, SessionInfo>();
  private sessionListOffset = 0;

  private static readonly SESSIONS_PAGE_SIZE = 8;

  constructor(tg: TelegramClient, config: Config, chatId: number, threadId?: number) {
    this.tg = tg;
    this.config = config;
    this.chatId = chatId;
    this.threadId = threadId;
    this.logger = createLogger({
      component: "controller",
      conversationId: String(chatId),
      threadId,
    });

    this.streaming = new StreamingManager(tg, chatId, config.telegramMaxChars, config.editThrottleMs);
    this.tmuxHandler = new TmuxHandler(tg, chatId, config.tmuxDefaultSocket, config.tmuxSocketDir, config.telegramMaxChars);
  }

  private get sessionDir(): string {
    const suffix = this.threadId ? `${this.chatId}_${this.threadId}` : `${this.chatId}`;
    return `${this.config.sessionDir}/${suffix}`;
  }

  private get activeModelKey(): string {
    return this.managed?.activeModelKey ?? this.config.modelRegistry.defaultKey;
  }

  private get activeThinkingLevel(): ThinkingLevel {
    return this.managed?.activeThinkingLevel ?? this.config.defaultThinkingLevel;
  }

  private get activeModel(): ModelConfig {
    return this.config.modelRegistry.get(this.activeModelKey) ?? this.config.modelRegistry.getDefault();
  }

  // ── Initialization ─────────────────────────────────────────────────

  async init(autoResume = true): Promise<void> {
    this.logger.info({ sessionDir: this.sessionDir, autoResume }, "Initializing agent");

    await tmux.ensureSocketDir(this.config.tmuxSocketDir);
    await mkdir(this.sessionDir, { recursive: true });

    const tmuxOpts = { socketPath: this.config.tmuxDefaultSocket };
    const tmuxToolDefs = createTmuxTools(tmuxOpts);

    const defaultModel = this.config.modelRegistry.getDefault();
    const modelKey = defaultModel.key;
    const thinkingLevel = defaultModel.thinkingLevel ?? this.config.defaultThinkingLevel;

    const callbacks: AgentEventCallbacks = {
      onTextDelta: (delta) => this.streaming.handleTextDelta(delta),
      onThinkingDelta: (_delta) => {},
      onToolStart: (name, args) => this.handleToolStart(name, args),
      onToolEnd: (name, result, isError) => this.handleToolEnd(name, result, isError),
      onAgentStart: () => this.handleAgentStart(),
      onAgentEnd: (err) => this.handleAgentEnd(err),
      onError: (err) => this.handleError(err),
      onModelFallback: (from, to, error) => this.handleModelFallback(from, to, error),
    };

    this.managed = await createManagedSession({
      config: this.config,
      tmuxTools: tmuxToolDefs as ToolDefinition[],
      callbacks,
      sessionDir: this.sessionDir,
      modelKey,
      thinkingLevel,
    });

    if (!autoResume) {
      this.logger.info("Agent initialized (fresh session, no auto-resume)");
      return;
    }

    try {
      const existing = await SessionManager.list(this.config.cwd, this.sessionDir);
      if (existing.length > 0) {
        existing.sort((a, b) => b.modified.getTime() - a.modified.getTime());
        const latest = existing[0];
        const label = latest.name || latest.firstMessage?.slice(0, 40) || latest.id.slice(0, 8);
        this.logger.info({ sessionCount: existing.length, latestSession: label, sessionId: latest.id.slice(0, 8) }, "Resuming latest session");

        await this.managed.switchSession(latest.path);
        this.logger.info({ messageCount: latest.messageCount }, "Session resumed successfully");
      } else {
        this.logger.info("No existing sessions, starting fresh");
      }
    } catch (e) {
      this.logger.error({ err: e }, "Failed to auto-resume session");
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.managed) {
      try {
        await this.init();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error({ err: e }, "Failed to initialize agent");
        await this.tg.sendMessage(this.chatId, `❌ Agent initialization failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
        throw e;
      }
    }
  }

  dispose(): void {
    if (this.managed) {
      this.managed.dispose();
      this.managed = null;
    }
    this.streaming.resetStreamState();
    this.isAgentRunning = false;
  }

  // ── User message handling ──────────────────────────────────────────

  async handleMessage(text: string): Promise<void> {
    if (this.tmuxHandler.isTmuxThread) {
      await this.tmuxHandler.tmuxTerminalSend(text);
      return;
    }

    await this.ensureInitialized();

    if (this.isAgentRunning) {
      try {
        await this.managed!.session.steer(text);
        await this.tg.sendMessage(this.chatId, "↩️ <i>Steering agent with new instruction...</i>", {
          parse_mode: "HTML",
        });
      } catch {
        this.pendingInput = text;
        await this.tg.sendMessage(this.chatId, "⏳ <i>Message queued, agent is busy.</i>", {
          parse_mode: "HTML",
        });
      }
      return;
    }

    this.logger.info({ charCount: text.length }, "Prompting agent");
    await this.tg.sendChatAction(this.chatId, "typing");
    await this.managed!.prompt(text);
  }

  async handlePhoto(fileId: string, caption?: string): Promise<void> {
    await this.ensureInitialized();

    if (this.isAgentRunning) {
      await this.tg.sendMessage(this.chatId, "⏳ <i>Agent is busy. Send photo after it finishes.</i>", {
        parse_mode: "HTML",
      });
      return;
    }

    try {
      const file = await this.tg.getFile(fileId);
      if (!file.file_path) {
        await this.tg.sendMessage(this.chatId, "❌ Could not retrieve file path from Telegram.");
        return;
      }

      const data = await this.tg.downloadFile(file.file_path);
      const base64 = Buffer.from(data).toString("base64");
      const mimeType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";

      const prompt = caption || "What do you see in this image?";

      this.logger.info({ imageBytes: data.length, promptPreview: prompt.slice(0, 50) }, "Prompting agent with image");
      await this.tg.sendChatAction(this.chatId, "typing");

      await this.managed!.prompt(prompt, {
        images: [{
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64 },
        }],
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: e }, "Photo handling error");
      await this.tg.sendMessage(this.chatId, `❌ Failed to process image: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  async handleTmuxTopicMessage(text: string): Promise<void> {
    await this.tmuxHandler.handleTmuxTopicMessage(text);
  }

  // ── Command handling ───────────────────────────────────────────────

  async handleCommand(command: string, args: string): Promise<void> {
    switch (command) {
      case "/start":
      case "/help":
        await this.sendHelp();
        break;
      case "/tmux":
        await this.tmuxHandler.enterTmuxMode();
        break;
      case "/sessions":
        await this.showAgentSessions();
        break;
      case "/resume":
        await this.resumeAgentSession(args);
        break;
      case "/newsession":
        await this.startNewAgentSession();
        break;
      case "/new":
        await this.tmuxHandler.createTmuxSession(args || `session-${Date.now()}`);
        break;
      case "/capture":
        await this.tmuxHandler.captureSelectedPane(args);
        break;
      case "/send":
        await this.tmuxHandler.sendKeysToSelected(args);
        break;
      case "/ctrlc":
        await this.tmuxHandler.sendCtrlCToSelected();
        break;
      case "/kill":
        await this.tmuxHandler.killSelectedSession(args);
        break;
      case "/select":
        await this.tmuxHandler.selectSession(args);
        break;
      case "/resize":
        await this.tmuxHandler.resizeTmuxWindow(args);
        break;
      case "/reset":
        await this.resetAgent();
        break;
      case "/abort":
        await this.abortAgent();
        break;
      case "/model":
        await this.switchModel(args);
        break;
      case "/thinking":
        await this.switchThinking(args);
        break;
      case "/status":
        await this.showStatus();
        break;
      default:
        await this.tg.sendMessage(this.chatId, `Unknown command: ${escapeHtml(command)}. Use /help.`, {
          parse_mode: "HTML",
        });
    }
  }

  // ── Callback query handling ────────────────────────────────────────

  async handleCallback(queryId: string, data: string): Promise<void> {
    const parsed = parseCallbackData(data);
    if (!parsed) {
      await this.tg.answerCallbackQuery(queryId, { text: "Invalid action.", show_alert: true });
      return;
    }

    try {
      switch (parsed.prefix) {
        case "tmux":
          await this.tmuxHandler.handleTmuxCallback(queryId, parsed.parts);
          break;
        case "confirm":
          await this.tmuxHandler.handleConfirmCallback(queryId, parsed.parts);
          break;
        case "sess":
          await this.handleSessionCallback(queryId, parsed.parts);
          break;
        case "term":
          await this.tmuxHandler.handleTerminalCallback(queryId, parsed.parts);
          break;
        case "model":
          await this.handleModelCallback(queryId, parsed.parts);
          break;
        case "think":
          await this.handleThinkingCallback(queryId, parsed.parts);
          break;
        case "agent":
          if (parsed.parts[0] === "abort") {
            await this.abortAgent();
            await this.tg.answerCallbackQuery(queryId, { text: "Agent aborted." });
          }
          break;
        default:
          await this.tg.answerCallbackQuery(queryId, { text: "Unknown action." });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.answerCallbackQuery(queryId, { text: `Error: ${msg.slice(0, 100)}`, show_alert: true });
    }
  }

  // ── Agent event handlers ───────────────────────────────────────────

  private handleToolStart(name: string, args: any): void {
    let message = '';

    try {
      switch (name) {
        case 'bash':
          if (args?.command) {
            const cmd = this.truncate(args.command, 120);
            message = `💻 <b>Running:</b> <code>${escapeHtml(cmd)}</code>`;
          } else {
            message = `💻 <b>Executing shell command...</b>`;
          }
          break;
        case 'read':
          if (args?.path) {
            message = `📖 <b>Reading:</b> <code>${escapeHtml(args.path)}</code>`;
          } else {
            message = `📖 <b>Reading file...</b>`;
          }
          break;
        case 'edit':
          if (args?.path) {
            message = `✏️ <b>Editing:</b> <code>${escapeHtml(args.path)}</code>`;
          } else {
            message = `✏️ <b>Editing file...</b>`;
          }
          break;
        case 'write':
          if (args?.path) {
            message = `💾 <b>Writing:</b> <code>${escapeHtml(args.path)}</code>`;
          } else {
            message = `💾 <b>Writing file...</b>`;
          }
          break;
        case 'tmux_send_keys':
          if (args?.session && args?.keys) {
            const keys = this.truncate(args.keys, 60);
            message = `⌨️ <b>Sending to ${escapeHtml(args.session)}:</b> <code>${escapeHtml(keys)}</code>`;
          } else if (args?.session) {
            message = `⌨️ <b>Sending keys to:</b> <code>${escapeHtml(args.session)}</code>`;
          } else {
            message = `⌨️ <b>Sending keys to tmux...</b>`;
          }
          break;
        case 'tmux_capture_pane':
          if (args?.session) {
            message = `📸 <b>Capturing pane:</b> <code>${escapeHtml(args.session)}</code>`;
          } else {
            message = `📸 <b>Capturing tmux pane...</b>`;
          }
          break;
        case 'tmux_new_session':
          if (args?.name) {
            message = `🆕 <b>Creating tmux session:</b> <code>${escapeHtml(args.name)}</code>`;
          } else {
            message = `🆕 <b>Creating tmux session...</b>`;
          }
          break;
        case 'tmux_kill_session':
          if (args?.name) {
            message = `🗑️ <b>Killing tmux session:</b> <code>${escapeHtml(args.name)}</code>`;
          } else {
            message = `🗑️ <b>Killing tmux session...</b>`;
          }
          break;
        case 'tmux_list_sessions':
          message = `📋 <b>Listing tmux sessions...</b>`;
          break;
        case 'tmux_send_ctrl_c':
          if (args?.session) {
            message = `🛑 <b>Sending Ctrl-C to:</b> <code>${escapeHtml(args.session)}</code>`;
          } else {
            message = `🛑 <b>Sending Ctrl-C...</b>`;
          }
          break;
        default: {
          const toolDisplay = name.replace(/_/g, ' ');
          if (args && Object.keys(args).length > 0) {
            const firstKey = Object.keys(args)[0];
            const firstVal = args[firstKey];
            if (typeof firstVal === 'string') {
              message = `🔧 <b>${escapeHtml(toolDisplay)}:</b> <code>${escapeHtml(this.truncate(firstVal, 80))}</code>`;
            } else {
              message = `🔧 <b>Running ${escapeHtml(toolDisplay)}...</b>`;
            }
          } else {
            message = `🔧 <b>Running ${escapeHtml(toolDisplay)}...</b>`;
          }
        }
      }
    } catch {
      message = `🔧 <code>${escapeHtml(name)}</code>`;
    }

    this.streaming.sendToolNotification(message);
  }

  private handleToolEnd(name: string, result: any, isError: boolean): void {
    if (isError) {
      let errorMsg = '';
      try {
        if (result && typeof result === 'object') {
          if (result.error) errorMsg = String(result.error);
          else if (result.message) errorMsg = String(result.message);
        } else if (typeof result === 'string') {
          errorMsg = result;
        }
      } catch { /* ignore */ }

      const toolDisplay = name.replace(/_/g, ' ');
      let message: string;
      if (errorMsg) {
        const truncated = this.truncate(errorMsg, 150);
        message = `❌ <b>${escapeHtml(toolDisplay)} failed:</b>\n<code>${escapeHtml(truncated)}</code>`;
      } else {
        message = `❌ <b>${escapeHtml(toolDisplay)} failed</b>`;
      }
      this.streaming.sendToolNotification(message);
    }
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
  }

  private handleAgentStart(): void {
    this.logger.info("Agent started");
    this.isAgentRunning = true;
    this.streaming.startNewStream();
  }

  private async handleAgentEnd(errorMessage?: string): Promise<void> {
    this.logger.info({ bufferChars: this.streaming.streamBuffer.length, errorMessage }, "Agent ended");
    this.isAgentRunning = false;

    await this.streaming.finalizeStream(errorMessage);

    if (this.pendingInput) {
      const msg = this.pendingInput;
      this.pendingInput = null;
      this.handleMessage(msg);
    }
  }

  private handleError(err: string): void {
    this.logger.error({ error: err }, "Agent error");
    this.isAgentRunning = false;
    this.tg.sendMessage(this.chatId, `⚠️ <b>Agent error:</b> ${escapeHtml(err)}`, {
      parse_mode: "HTML",
    });
  }

  private handleModelFallback(fromLabel: string, toLabel: string, error: string): void {
    this.logger.info({ from: fromLabel, to: toLabel }, "Model fallback");
    const truncatedError = error.length > 150 ? error.slice(0, 150) + "…" : error;
    this.tg.sendMessage(
      this.chatId,
      `⚠️ <b>${escapeHtml(fromLabel)}</b> failed: <code>${escapeHtml(truncatedError)}</code>\n\nSwitched to <b>${escapeHtml(toLabel)}</b>. Please retry your message.`,
      { parse_mode: "HTML" },
    );
  }

  // ── Model switching ─────────────────────────────────────────────────

  private async switchModel(args: string): Promise<void> {
    const registry = this.config.modelRegistry;
    const models = registry.list();

    if (args.trim()) {
      const key = args.trim();
      const model = registry.get(key);
      if (model) {
        await this.applyModel(key);
        return;
      }
      await this.tg.sendMessage(this.chatId, `Unknown model: <code>${escapeHtml(key)}</code>`, { parse_mode: "HTML" });
      return;
    }

    const m = this.activeModel;
    const lines = [
      `<b>🤖 Model Settings</b>`,
      ``,
      `Current: <b>${escapeHtml(m.label)}</b>`,
      `<code>${escapeHtml(m.provider)}/${escapeHtml(m.id)}</code>`,
      `Thinking: <code>${escapeHtml(this.activeThinkingLevel)}</code>`,
    ];

    await this.tg.sendMessage(this.chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: modelsKeyboard(
          models.map((m) => ({ key: m.key, label: m.label })),
          this.activeModelKey,
        ),
      },
    });
  }

  private async applyModel(key: string): Promise<void> {
    if (this.isAgentRunning) {
      await this.tg.sendMessage(this.chatId, "Cannot switch model while agent is running. Use /abort first.");
      return;
    }

    const model = this.config.modelRegistry.get(key);
    if (!model) {
      await this.tg.sendMessage(this.chatId, `Model not found: <code>${escapeHtml(key)}</code>`, { parse_mode: "HTML" });
      return;
    }

    await this.ensureInitialized();

    try {
      await this.managed!.setModelByKey(key);
      const thinkingDisplay = this.managed!.activeThinkingLevel;
      await this.tg.sendMessage(
        this.chatId,
        `✅ Switched to <b>${escapeHtml(model.label)}</b>\n<code>${escapeHtml(model.provider)}/${escapeHtml(model.id)}</code> (thinking: ${escapeHtml(thinkingDisplay)})`,
        { parse_mode: "HTML" },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.sendMessage(this.chatId, `❌ Failed to switch model: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  private async handleModelCallback(queryId: string, parts: string[]): Promise<void> {
    const action = parts[0];
    switch (action) {
      case "pick": {
        const key = parts.slice(1).join(":");
        if (key === this.activeModelKey) {
          await this.tg.answerCallbackQuery(queryId, { text: "Already using this model." });
          return;
        }
        await this.tg.answerCallbackQuery(queryId, { text: "Switching..." });
        await this.applyModel(key);
        break;
      }
      case "cancel":
        await this.tg.answerCallbackQuery(queryId, { text: "Cancelled." });
        break;
      default:
        await this.tg.answerCallbackQuery(queryId, { text: "Unknown action." });
    }
  }

  // ── Thinking level ─────────────────────────────────────────────────

  private async switchThinking(args: string): Promise<void> {
    const valid: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

    if (args.trim() && valid.includes(args.trim().toLowerCase() as ThinkingLevel)) {
      await this.applyThinking(args.trim().toLowerCase() as ThinkingLevel);
      return;
    }

    const m = this.activeModel;
    const lines = [
      `<b>🧠 Thinking Level</b>`,
      ``,
      `Current: <code>${escapeHtml(this.activeThinkingLevel)}</code>`,
      `Model: <b>${escapeHtml(m.label)}</b>`,
    ];

    await this.tg.sendMessage(this.chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: thinkingKeyboard(this.activeThinkingLevel) },
    });
  }

  private async applyThinking(level: ThinkingLevel): Promise<void> {
    if (this.isAgentRunning) {
      await this.tg.sendMessage(this.chatId, "Cannot change thinking level while agent is running. Use /abort first.");
      return;
    }

    await this.ensureInitialized();
    this.managed!.setThinkingLevel(level);

    await this.tg.sendMessage(
      this.chatId,
      `✅ Thinking level set to <code>${escapeHtml(level)}</code>`,
      { parse_mode: "HTML" },
    );
  }

  private async handleThinkingCallback(queryId: string, parts: string[]): Promise<void> {
    const action = parts[0];
    switch (action) {
      case "pick": {
        const level = parts[1] as ThinkingLevel;
        if (level === this.activeThinkingLevel) {
          await this.tg.answerCallbackQuery(queryId, { text: "Already using this level." });
          return;
        }
        await this.tg.answerCallbackQuery(queryId, { text: "Updating..." });
        await this.applyThinking(level);
        break;
      }
      case "cancel":
        await this.tg.answerCallbackQuery(queryId, { text: "Cancelled." });
        break;
      default:
        await this.tg.answerCallbackQuery(queryId, { text: "Unknown action." });
    }
  }

  // ── Agent session management ────────────────────────────────────────

  private async showAgentSessions(offset = 0): Promise<void> {
    await this.ensureInitialized();

    try {
      const allSessions = await SessionManager.list(this.config.cwd, this.sessionDir);
      allSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      if (allSessions.length === 0) {
        await this.tg.sendMessage(this.chatId, "<i>No saved sessions.</i>\n\nSend a message to start one.", { parse_mode: "HTML" });
        return;
      }

      this.sessionIndex.clear();
      for (const s of allSessions) {
        this.sessionIndex.set(s.id, s);
      }
      this.sessionListOffset = offset;

      const page = allSessions.slice(offset, offset + ChatController.SESSIONS_PAGE_SIZE);
      const hasMore = offset + ChatController.SESSIONS_PAGE_SIZE < allSessions.length;

      const currentId = this.managed!.session.sessionId;
      const items = page.map((s) => {
        const date = s.modified.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const preview = s.name || s.firstMessage?.slice(0, 30) || s.id.slice(0, 8);
        const current = s.id === currentId ? " ✦" : "";
        return { id: s.id, label: `${date} · ${preview}${current}` };
      });

      const lines = [`<b>📂 Agent Sessions</b> (${allSessions.length} total)`];
      if (offset > 0) lines.push(`<i>Showing ${offset + 1}–${offset + page.length}</i>`);

      await this.tg.sendMessage(this.chatId, lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: agentSessionsKeyboard(items, hasMore) },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.sendMessage(this.chatId, `Failed to list sessions: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  private async resumeAgentSession(args: string): Promise<void> {
    const id = args.trim();
    if (!id) {
      await this.showAgentSessions();
      return;
    }

    if (this.isAgentRunning) {
      await this.tg.sendMessage(this.chatId, "Cannot switch session while agent is running. Use /abort first.");
      return;
    }

    await this.ensureInitialized();

    let info = this.sessionIndex.get(id);
    if (!info) {
      const allSessions = await SessionManager.list(this.config.cwd, this.sessionDir);
      for (const s of allSessions) {
        this.sessionIndex.set(s.id, s);
      }
      info = this.sessionIndex.get(id);
    }

    if (!info) {
      await this.tg.sendMessage(this.chatId, `Session not found: <code>${escapeHtml(id)}</code>`, { parse_mode: "HTML" });
      return;
    }

    try {
      this.streaming.resetStreamState();
      this.pendingInput = null;
      await this.managed!.switchSession(info.path);
      const label = info.name || info.firstMessage?.slice(0, 40) || info.id.slice(0, 8);
      await this.tg.sendMessage(
        this.chatId,
        `✅ Resumed session: <b>${escapeHtml(label)}</b>\n<code>${escapeHtml(info.id.slice(0, 8))}</code> · ${info.messageCount} messages`,
        { parse_mode: "HTML" },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.sendMessage(this.chatId, `❌ Failed to resume: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  private async startNewAgentSession(): Promise<void> {
    if (this.isAgentRunning) {
      await this.tg.sendMessage(this.chatId, "Cannot start new session while agent is running. Use /abort first.");
      return;
    }

    await this.ensureInitialized();

    try {
      this.streaming.resetStreamState();
      this.pendingInput = null;
      await this.managed!.session.newSession();
      await this.tg.sendMessage(this.chatId, "✅ New session started.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.sendMessage(this.chatId, `❌ Failed to start new session: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  private async handleSessionCallback(queryId: string, parts: string[]): Promise<void> {
    const action = parts[0];

    switch (action) {
      case "switch": {
        const id = parts.slice(1).join(":");
        await this.tg.answerCallbackQuery(queryId, { text: "Switching..." });
        await this.resumeAgentSession(id);
        break;
      }
      case "new":
        await this.tg.answerCallbackQuery(queryId);
        await this.startNewAgentSession();
        break;
      case "more":
        await this.tg.answerCallbackQuery(queryId);
        await this.showAgentSessions(this.sessionListOffset + ChatController.SESSIONS_PAGE_SIZE);
        break;
      case "refresh":
        await this.tg.answerCallbackQuery(queryId, { text: "Refreshed" });
        await this.showAgentSessions();
        break;
      default:
        await this.tg.answerCallbackQuery(queryId, { text: "Unknown action" });
    }
  }

  // ── Agent commands ─────────────────────────────────────────────────

  private async resetAgent(): Promise<void> {
    if (this.managed) {
      this.managed.dispose();
      this.managed = null;
    }
    this.isAgentRunning = false;
    this.streaming.resetStreamState();
    await this.init(false);
    await this.managed!.session.newSession();
    await this.tg.sendMessage(this.chatId, "🔄 Agent session reset.");
  }

  private async abortAgent(): Promise<void> {
    if (this.managed && this.isAgentRunning) {
      await this.managed.abort();
      await this.tg.sendMessage(this.chatId, "⏹ Agent aborted.");
    } else {
      await this.tg.sendMessage(this.chatId, "Agent is not running.");
    }
  }

  private async showStatus(): Promise<void> {
    const tmuxSessions = await tmux.listSessions({ socketPath: this.config.tmuxDefaultSocket });
    const sessionId = this.managed?.session.sessionId;
    const sessionName = this.managed?.session.sessionName;
    const sessionLabel = sessionName || (sessionId ? sessionId.slice(0, 8) : "<i>none</i>");
    const parts: string[] = [
      `<b>Status</b>`,
      `Agent: ${this.isAgentRunning ? "🟢 Running" : "⚪ Idle"}`,
      `Mode: ${this.tmuxHandler.isTmuxThread ? "📟 tmux terminal" : "🤖 Agent"}`,
      `Session: <code>${escapeHtml(sessionLabel)}</code>`,
      this.threadId ? `Topic: <code>${this.threadId}</code>` : "",
      `Model: <b>${escapeHtml(this.activeModel.label)}</b> (<code>${escapeHtml(this.activeModel.provider)}/${escapeHtml(this.activeModel.id)}</code>)`,
      `Thinking: <code>${escapeHtml(this.activeThinkingLevel)}</code>`,
      `tmux sessions: ${tmuxSessions.length}`,
      `Selected: ${this.tmuxHandler.selectedSession ? `<b>${escapeHtml(this.tmuxHandler.selectedSession)}</b>` : "<i>none</i>"}`,
      `CWD: <code>${escapeHtml(this.config.cwd)}</code>`,
    ].filter(Boolean);
    await this.tg.sendMessage(this.chatId, parts.join("\n"), { parse_mode: "HTML" });
  }

  private async sendHelp(): Promise<void> {
    const help = [
      "<b>🤖 Pi Agent Telegram Bot</b>",
      "",
      "Send any message to chat with the AI agent.",
      "The agent has tools: read files, run bash, edit code, and control tmux.",
      "",
      "<b>Agent Commands</b>",
      "/sessions — List agent sessions",
      "/resume — Resume a previous session",
      "/newsession — Start a fresh session",
      "/reset — Full agent reset",
      "/abort — Abort current operation",
      "/model — Select model",
      "/thinking — Set thinking level",
      "/status — Show status",
      "",
      "<b>tmux Terminal</b>",
      "/tmux — Open interactive terminal mode",
      "In tmux mode, all messages are sent as terminal input.",
      "Buttons: Refresh, Ctrl-C, Enter, Up/Down, Tab, Switch",
      "",
      "<b>tmux Management</b>",
      "/new &lt;name&gt; — Create session",
      "/select &lt;name&gt; — Select session",
      "/capture — Capture pane output",
      "/send &lt;text&gt; — Send keys",
      "/ctrlc — Send Ctrl-C",
      "/kill [name] — Kill session",
      "/resize [CxR] — Resize window (e.g. /resize 45x60)",
      "",
      "<b>User Management</b> (owner only)",
      "/adduser &lt;id&gt; — Allow a user",
      "/removeuser &lt;id&gt; — Remove a user",
      "/users — List allowed users",
      "",
      "<b>Tips</b>",
      "• Use /tmux in a topic for a dedicated terminal",
      "• The agent can also use tmux tools automatically",
      '• Ask things like "start a Python REPL in tmux"',
    ];
    await this.tg.sendMessage(this.chatId, help.join("\n"), { parse_mode: "HTML" });
  }
}
