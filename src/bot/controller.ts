/**
 * Platform-agnostic per-chat controller: orchestrates IM <-> Agent <-> tmux.
 * Depends only on im/ contracts — no platform-specific imports.
 */

import type { Messenger, UIButton, UIElement } from "../im/messenger.js";
import type { Formatter } from "../im/formatter.js";
import type { StreamSink } from "../im/stream-sink.js";
import type { ConversationRef, ImageData } from "../im/types.js";
import type { Config } from "../config.js";
import type { ManagedSession, AgentEventCallbacks } from "../agent/session.js";
import { createManagedSession } from "../agent/session.js";
import { createTmuxTools } from "../tmux/tools.js";
import * as tmux from "../tmux/tmux.js";
import { SessionManager, type ToolDefinition, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import type { ModelConfig, ThinkingLevel } from "../models.js";
import { TmuxHandler } from "./tmux-handler.js";
import { ToolAuthorizer, type PermissionConfig, type PermissionMode } from "./permissions.js";
import type { PermissionStore } from "../permissions-store.js";
import { createLogger, type Logger } from "../logger.js";

export class ChatController {
  private messenger: Messenger;
  private fmt: Formatter;
  private convo: ConversationRef;
  private config: Config;
  private permissions: PermissionStore;
  private managed: ManagedSession | null = null;
  private logger: Logger;

  private streamSink: StreamSink;
  private tmuxHandler: TmuxHandler;
  private toolAuthorizer: ToolAuthorizer;

  private isAgentRunning = false;
  private pendingInput: string | null = null;

  private sessionIndex = new Map<string, SessionInfo>();
  private sessionListOffset = 0;

  private static readonly SESSIONS_PAGE_SIZE = 8;

  constructor(
    messenger: Messenger,
    fmt: Formatter,
    convo: ConversationRef,
    config: Config,
    createStreamSink: (convo: ConversationRef) => StreamSink,
    permissions: PermissionStore,
  ) {
    this.messenger = messenger;
    this.fmt = fmt;
    this.convo = convo;
    this.config = config;
    this.permissions = permissions;
    this.logger = createLogger({
      component: "controller",
      conversationId: convo.conversationId,
      threadId: convo.threadId,
    });

    this.streamSink = createStreamSink(convo);
    this.tmuxHandler = new TmuxHandler(messenger, fmt, convo, config.tmuxDefaultSocket, config.tmuxSocketDir);

    // Load permission config from store
    const permissionConfig = this.permissions.getConfig(this.conversationKey);
    this.logger.debug({ permissionConfig }, "ChatController created");
    this.toolAuthorizer = new ToolAuthorizer(messenger, fmt, convo, {
      cwd: config.cwd,
      timeoutMs: 5 * 60 * 1000, // 5 minutes
      config: permissionConfig,
    });
    this.logger.debug({ mode: permissionConfig.defaultMode || "default" }, "ToolAuthorizer initialized");
  }

  private get conversationKey(): string {
    return `${this.convo.conversationId}:${this.convo.threadId ?? ""}`;
  }

  /**
   * Update permission config and persist to disk.
   */
  private savePermissionConfig(config: PermissionConfig): void {
    this.toolAuthorizer.setConfig(config);
    this.permissions.setConfig(this.conversationKey, config);
  }

  private get sessionDir(): string {
    const suffix = this.convo.threadId
      ? `${this.convo.conversationId}_${this.convo.threadId}`
      : this.convo.conversationId;
    return `${this.config.sessionDir}/${suffix}`;
  }

  private get chatLabel(): string {
    return this.convo.threadId
      ? `chat=${this.convo.conversationId} thread=${this.convo.threadId}`
      : `chat=${this.convo.conversationId}`;
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
      onTextDelta: (delta) => this.streamSink.onDelta(delta),
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
      wrapTools: (tools) => this.toolAuthorizer.wrapTools(tools),
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
        await this.messenger.send(this.convo, {
          type: "text",
          text: `❌ Agent initialization failed: ${this.fmt.escape(msg)}`,
        });
        throw e;
      }
    }
  }

  dispose(): void {
    if (this.managed) {
      this.managed.dispose();
      this.managed = null;
    }
    this.streamSink.resetState();
    this.isAgentRunning = false;
    this.toolAuthorizer.dispose();
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
        await this.messenger.send(this.convo, {
          type: "text",
          text: `↩️ ${this.fmt.italic("Steering agent with new instruction...")}`,
        });
      } catch {
        this.pendingInput = text;
        await this.messenger.send(this.convo, {
          type: "text",
          text: `⏳ ${this.fmt.italic("Message queued, agent is busy.")}`,
        });
      }
      return;
    }

    this.logger.info({ charCount: text.length }, "Prompting agent");
    await this.messenger.sendTyping?.(this.convo);
    await this.managed!.prompt(text);
  }

  async handlePhoto(image: ImageData, caption?: string): Promise<void> {
    await this.ensureInitialized();

    if (this.isAgentRunning) {
      await this.messenger.send(this.convo, {
        type: "text",
        text: `⏳ ${this.fmt.italic("Agent is busy. Send photo after it finishes.")}`,
      });
      return;
    }

    try {
      const base64 = Buffer.from(image.bytes).toString("base64");
      const prompt = caption || "What do you see in this image?";

      this.logger.info({ imageBytes: image.bytes.length, promptPreview: prompt.slice(0, 50) }, "Prompting agent with image");
      await this.messenger.sendTyping?.(this.convo);

      await this.managed!.prompt(prompt, {
        images: [{
          type: "image",
          source: { type: "base64", media_type: image.mimeType, data: base64 },
        }],
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: e }, "Photo handling error");
      await this.messenger.send(this.convo, {
        type: "text",
        text: `❌ Failed to process image: ${this.fmt.escape(msg)}`,
      });
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
      case "/permissions":
        await this.handlePermissionsCommand(args);
        break;
      default:
        await this.messenger.send(this.convo, {
          type: "text",
          text: `Unknown command: ${this.fmt.escape(command)}. Use /help.`,
        });
    }
  }

  // ── Callback handling ──────────────────────────────────────────────

  async handleCallback(ackHandle: unknown, actionId: string, data?: string): Promise<void> {
    const parts = data ? data.split(":") : [];

    try {
      switch (actionId) {
        case "tmux":
          await this.tmuxHandler.handleTmuxCallback(ackHandle, parts);
          break;
        case "confirm":
          await this.tmuxHandler.handleConfirmCallback(ackHandle, parts);
          break;
        case "sess":
          await this.handleSessionCallback(ackHandle, parts);
          break;
        case "term":
          await this.tmuxHandler.handleTerminalCallback(ackHandle, parts);
          break;
        case "model":
          await this.handleModelCallback(ackHandle, parts);
          break;
        case "think":
          await this.handleThinkingCallback(ackHandle, parts);
          break;
        case "agent":
          if (parts[0] === "abort") {
            await this.abortAgent();
            await this.messenger.ackAction?.(ackHandle, "Agent aborted.");
          }
          break;
        case "auth":
          await this.handleAuthCallback(ackHandle, parts);
          break;
        case "perm":
          await this.handlePermissionsCallback(ackHandle, parts);
          break;
        default:
          await this.messenger.ackAction?.(ackHandle, "Unknown action.");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.ackAction?.(ackHandle, `Error: ${msg.slice(0, 100)}`, true);
    }
  }

  // ── Agent event handlers ───────────────────────────────────────────

  private handleToolStart(name: string, args: any): void {
    // Skip notification if the tool will need authorization — the auth prompt
    // is shown instead. SDK fires tool_execution_start BEFORE tool.execute().
    const permission = this.toolAuthorizer.evaluate(name, args);
    if (permission === "ask") return;

    let message = '';

    try {
      switch (name) {
        case 'bash':
          if (args?.command) {
            const cmd = this.truncate(args.command, 120);
            message = `💻 ${this.fmt.bold("Running:")} ${this.fmt.code(cmd)}`;
          } else {
            message = `💻 ${this.fmt.bold("Executing shell command...")}`;
          }
          break;
        case 'read':
          if (args?.path) {
            message = `📖 ${this.fmt.bold("Reading:")} ${this.fmt.code(args.path)}`;
          } else {
            message = `📖 ${this.fmt.bold("Reading file...")}`;
          }
          break;
        case 'edit':
          if (args?.path) {
            message = `✏️ ${this.fmt.bold("Editing:")} ${this.fmt.code(args.path)}`;
          } else {
            message = `✏️ ${this.fmt.bold("Editing file...")}`;
          }
          break;
        case 'write':
          if (args?.path) {
            message = `💾 ${this.fmt.bold("Writing:")} ${this.fmt.code(args.path)}`;
          } else {
            message = `💾 ${this.fmt.bold("Writing file...")}`;
          }
          break;
        case 'tmux_send_keys':
          if (args?.session && args?.keys) {
            const keys = this.truncate(args.keys, 60);
            message = `⌨️ ${this.fmt.bold(`Sending to ${args.session}:`)} ${this.fmt.code(keys)}`;
          } else if (args?.session) {
            message = `⌨️ ${this.fmt.bold("Sending keys to:")} ${this.fmt.code(args.session)}`;
          } else {
            message = `⌨️ ${this.fmt.bold("Sending keys to tmux...")}`;
          }
          break;
        case 'tmux_capture_pane':
          if (args?.session) {
            message = `📸 ${this.fmt.bold("Capturing pane:")} ${this.fmt.code(args.session)}`;
          } else {
            message = `📸 ${this.fmt.bold("Capturing tmux pane...")}`;
          }
          break;
        case 'tmux_new_session':
          if (args?.name) {
            message = `🆕 ${this.fmt.bold("Creating tmux session:")} ${this.fmt.code(args.name)}`;
          } else {
            message = `🆕 ${this.fmt.bold("Creating tmux session...")}`;
          }
          break;
        case 'tmux_kill_session':
          if (args?.name) {
            message = `🗑️ ${this.fmt.bold("Killing tmux session:")} ${this.fmt.code(args.name)}`;
          } else {
            message = `🗑️ ${this.fmt.bold("Killing tmux session...")}`;
          }
          break;
        case 'tmux_list_sessions':
          message = `📋 ${this.fmt.bold("Listing tmux sessions...")}`;
          break;
        case 'tmux_send_ctrl_c':
          if (args?.session) {
            message = `🛑 ${this.fmt.bold("Sending Ctrl-C to:")} ${this.fmt.code(args.session)}`;
          } else {
            message = `🛑 ${this.fmt.bold("Sending Ctrl-C...")}`;
          }
          break;
        default: {
          const toolDisplay = name.replace(/_/g, ' ');
          if (args && Object.keys(args).length > 0) {
            const firstKey = Object.keys(args)[0];
            const firstVal = args[firstKey];
            if (typeof firstVal === 'string') {
              message = `🔧 ${this.fmt.bold(`${toolDisplay}:`)} ${this.fmt.code(this.truncate(firstVal, 80))}`;
            } else {
              message = `🔧 ${this.fmt.bold(`Running ${toolDisplay}...`)}`;
            }
          } else {
            message = `🔧 ${this.fmt.bold(`Running ${toolDisplay}...`)}`;
          }
        }
      }
    } catch {
      message = `🔧 ${this.fmt.code(name)}`;
    }

    this.streamSink.toolNotice(message);
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
        message = `❌ ${this.fmt.bold(`${toolDisplay} failed:`)}\n${this.fmt.code(truncated)}`;
      } else {
        message = `❌ ${this.fmt.bold(`${toolDisplay} failed`)}`;
      }
      this.streamSink.toolNotice(message);
    }
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
  }

  private handleAgentStart(): void {
    this.logger.info("Agent started");
    this.isAgentRunning = true;
    this.streamSink.start();
  }

  private async handleAgentEnd(errorMessage?: string): Promise<void> {
    this.logger.info({ bufferChars: this.streamSink.buffer.length, errorMessage }, "Agent ended");
    this.isAgentRunning = false;

    await this.streamSink.finalize(errorMessage);

    if (this.pendingInput) {
      const msg = this.pendingInput;
      this.pendingInput = null;
      this.handleMessage(msg);
    }
  }

  private handleError(err: string): void {
    this.logger.error({ error: err }, "Agent error");
    this.isAgentRunning = false;
    this.messenger.send(this.convo, {
      type: "text",
      text: `⚠️ ${this.fmt.bold("Agent error:")} ${this.fmt.escape(err)}`,
    });
  }

  private handleModelFallback(fromLabel: string, toLabel: string, error: string): void {
    this.logger.info({ from: fromLabel, to: toLabel }, "Model fallback");
    const truncatedError = error.length > 150 ? error.slice(0, 150) + "…" : error;
    this.messenger.send(this.convo, {
      type: "text",
      text: `⚠️ ${this.fmt.bold(fromLabel)} failed: ${this.fmt.code(truncatedError)}\n\nSwitched to ${this.fmt.bold(toLabel)}. Please retry your message.`,
    });
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
      await this.messenger.send(this.convo, {
        type: "text",
        text: `Unknown model: ${this.fmt.code(key)}`,
      });
      return;
    }

    const m = this.activeModel;
    const lines = [
      this.fmt.bold("🤖 Model Settings"),
      "",
      `Current: ${this.fmt.bold(m.label)}`,
      this.fmt.code(`${m.provider}/${m.id}`),
      `Thinking: ${this.fmt.code(this.activeThinkingLevel)}`,
    ];

    await this.messenger.send(this.convo, {
      type: "text",
      text: lines.join("\n"),
      ui: this.modelsUI(
        models.map((m) => ({ key: m.key, label: m.label })),
        this.activeModelKey,
      ),
    });
  }

  private async applyModel(key: string): Promise<void> {
    if (this.isAgentRunning) {
      await this.messenger.send(this.convo, { type: "text", text: "Cannot switch model while agent is running. Use /abort first." });
      return;
    }

    const model = this.config.modelRegistry.get(key);
    if (!model) {
      await this.messenger.send(this.convo, { type: "text", text: `Model not found: ${this.fmt.code(key)}` });
      return;
    }

    await this.ensureInitialized();

    try {
      await this.managed!.setModelByKey(key);
      const thinkingDisplay = this.managed!.activeThinkingLevel;
      await this.messenger.send(this.convo, {
        type: "text",
        text: `✅ Switched to ${this.fmt.bold(model.label)}\n${this.fmt.code(`${model.provider}/${model.id}`)} (thinking: ${this.fmt.escape(thinkingDisplay)})`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `❌ Failed to switch model: ${this.fmt.escape(msg)}`,
      });
    }
  }

  private async handleModelCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const action = parts[0];
    switch (action) {
      case "pick": {
        const key = parts.slice(1).join(":");
        if (key === this.activeModelKey) {
          await this.messenger.ackAction?.(ackHandle, "Already using this model.");
          return;
        }
        await this.messenger.ackAction?.(ackHandle, "Switching...");
        await this.applyModel(key);
        break;
      }
      case "cancel":
        await this.messenger.ackAction?.(ackHandle, "Cancelled.");
        break;
      default:
        await this.messenger.ackAction?.(ackHandle, "Unknown action.");
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
      this.fmt.bold("🧠 Thinking Level"),
      "",
      `Current: ${this.fmt.code(this.activeThinkingLevel)}`,
      `Model: ${this.fmt.bold(m.label)}`,
    ];

    await this.messenger.send(this.convo, {
      type: "text",
      text: lines.join("\n"),
      ui: this.thinkingUI(this.activeThinkingLevel),
    });
  }

  private async applyThinking(level: ThinkingLevel): Promise<void> {
    if (this.isAgentRunning) {
      await this.messenger.send(this.convo, { type: "text", text: "Cannot change thinking level while agent is running. Use /abort first." });
      return;
    }

    await this.ensureInitialized();
    this.managed!.setThinkingLevel(level);

    await this.messenger.send(this.convo, {
      type: "text",
      text: `✅ Thinking level set to ${this.fmt.code(level)}`,
    });
  }

  private async handleThinkingCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const action = parts[0];
    switch (action) {
      case "pick": {
        const level = parts[1] as ThinkingLevel;
        if (level === this.activeThinkingLevel) {
          await this.messenger.ackAction?.(ackHandle, "Already using this level.");
          return;
        }
        await this.messenger.ackAction?.(ackHandle, "Updating...");
        await this.applyThinking(level);
        break;
      }
      case "cancel":
        await this.messenger.ackAction?.(ackHandle, "Cancelled.");
        break;
      default:
        await this.messenger.ackAction?.(ackHandle, "Unknown action.");
    }
  }

  private async handleAuthCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const [action, authId] = parts;
    this.logger.debug({ action, authId }, "handleAuthCallback");
    if (!authId || (action !== "allow" && action !== "deny")) {
      this.logger.warn({ parts }, "Invalid authorization request");
      await this.messenger.ackAction?.(ackHandle, "Invalid authorization request.");
      return;
    }
    await this.toolAuthorizer.handleCallback(ackHandle, action, authId);
  }

  private async handlePermissionsCommand(args: string): Promise<void> {
    const config = this.toolAuthorizer.getConfig();

    if (args.trim()) {
      // Handle subcommands like "add", "remove", "mode"
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0].toLowerCase();

      switch (subcommand) {
        case "allow":
        case "ask":
        case "deny":
          if (parts.length < 2) {
            await this.messenger.send(this.convo, {
              type: "text",
              text: `Usage: /permissions ${subcommand} <rule>\nExample: /permissions ${subcommand} bash(npm run *)`,
            });
            return;
          }
          const rule = parts.slice(1).join(" ");
          await this.addPermissionRule(subcommand, rule);
          return;

        case "mode":
          if (parts.length < 2) {
            const modes: PermissionMode[] = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
            await this.messenger.send(this.convo, {
              type: "text",
              text: [
                this.fmt.bold("Permission Modes:"),
                "",
                "• default - Prompt for permission on first use of dangerous tools",
                "• acceptEdits - Auto-accept file edits, ask for other dangerous tools",
                "• dontAsk - Auto-deny unless pre-approved via rules",
                "• bypassPermissions - Skip all permission prompts (dangerous!)",
                "",
                `Current: ${this.fmt.code(config.defaultMode || "default")}`,
                "",
                "Use /permissions mode <mode> to change.",
              ].join("\n"),
            });
            return;
          }
          await this.setPermissionMode(parts[1] as PermissionMode);
          return;

        case "clear":
          await this.clearPermissionRules();
          return;

        default:
          await this.messenger.send(this.convo, {
            type: "text",
            text: `Unknown subcommand: ${subcommand}\n\nAvailable: allow, ask, deny, mode, clear`,
          });
          return;
      }
    }

    // Show current permissions (use raw text to avoid HTML parsing issues with rule syntax)
    const lines = [
      "🔐 Permissions",
      "",
      `Mode: ${config.defaultMode || "default"}`,
      "",
    ];

    const rulesText = this.toolAuthorizer.formatRulesRaw();
    lines.push(rulesText);

    lines.push(
      "",
      "Usage:",
      "/permissions allow <rule> - Auto-approve matching tools",
      "/permissions ask <rule> - Prompt for matching tools",
      "/permissions deny <rule> - Block matching tools",
      "/permissions mode <mode> - Set default mode",
      "/permissions clear - Clear all custom rules",
      "",
      "Rule Syntax:",
      "• Tool - matches all uses (e.g., bash, write)",
      "• Tool(specifier) - matches specific uses",
      "• bash(npm run *) - matches npm run commands",
      "• edit(./src/**/*.ts) - matches TypeScript edits",
      "• read(~/.env) - matches reading .env file",
    );

    await this.messenger.send(this.convo, {
      type: "text",
      text: lines.join("\n"),
      ui: this.permissionsUI(),
      parseMode: "none",
    });
  }

  private async addPermissionRule(level: "allow" | "ask" | "deny", rule: string): Promise<void> {
    const config = this.toolAuthorizer.getConfig();

    // Add to appropriate list
    if (level === "allow") {
      config.allow = [...(config.allow || []), rule];
    } else if (level === "ask") {
      config.ask = [...(config.ask || []), rule];
    } else {
      config.deny = [...(config.deny || []), rule];
    }

    this.savePermissionConfig(config);

    await this.messenger.send(this.convo, {
      type: "text",
      text: `✅ Added ${level} rule: ${this.fmt.code(rule)}\n\nChanges take effect immediately for new tool calls.`,
    });
  }

  private async setPermissionMode(mode: PermissionMode): Promise<void> {
    const config = this.toolAuthorizer.getConfig();
    config.defaultMode = mode;
    this.savePermissionConfig(config);

    const descriptions: Record<PermissionMode, string> = {
      default: "Prompt for permission on first use of dangerous tools",
      acceptEdits: "Auto-accept file edits, ask for other dangerous tools",
      dontAsk: "Auto-deny unless pre-approved via rules",
      bypassPermissions: "Skip all permission prompts (use with caution!)",
    };

    await this.messenger.send(this.convo, {
      type: "text",
      text: [
        `✅ Permission mode set to ${this.fmt.bold(mode)}`,
        "",
        descriptions[mode],
      ].join("\n"),
    });
  }

  private async clearPermissionRules(): Promise<void> {
    this.savePermissionConfig({ defaultMode: this.toolAuthorizer.getConfig().defaultMode });

    await this.messenger.send(this.convo, {
      type: "text",
      text: "✅ All custom permission rules cleared.",
    });
  }

  private permissionsUI(): UIElement {
    const config = this.toolAuthorizer.getConfig();
    const modes: PermissionMode[] = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
    const currentMode = config.defaultMode || "default";

    const rows: UIButton[][] = [];

    // Mode selection buttons
    const modeRow: UIButton[] = [];
    for (let i = 0; i < Math.min(2, modes.length); i++) {
      const mode = modes[i];
      const isCurrent = mode === currentMode;
      modeRow.push({
        label: isCurrent ? `✅ ${mode}` : mode,
        actionId: "perm",
        data: `mode:${mode}`,
      });
    }
    rows.push(modeRow);

    const modeRow2: UIButton[] = [];
    for (let i = 2; i < modes.length; i++) {
      const mode = modes[i];
      const isCurrent = mode === currentMode;
      modeRow2.push({
        label: isCurrent ? `✅ ${mode}` : mode,
        actionId: "perm",
        data: `mode:${mode}`,
      });
    }
    if (modeRow2.length > 0) {
      rows.push(modeRow2);
    }

    rows.push([{ label: "❌ Close", actionId: "perm", data: "close" }]);

    return { kind: "buttons", rows };
  }

  private async handlePermissionsCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const action = parts[0];

    switch (action) {
      case "mode": {
        const mode = parts[1] as PermissionMode;
        await this.messenger.ackAction?.(ackHandle, `Setting mode to ${mode}...`);
        await this.setPermissionMode(mode);
        break;
      }
      case "close":
        await this.messenger.ackAction?.(ackHandle, "Closed.");
        break;
      default:
        await this.messenger.ackAction?.(ackHandle, "Unknown action.");
    }
  }

  // ── Agent session management ────────────────────────────────────────

  private async showAgentSessions(offset = 0): Promise<void> {
    await this.ensureInitialized();

    try {
      const allSessions = await SessionManager.list(this.config.cwd, this.sessionDir);
      allSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      if (allSessions.length === 0) {
        await this.messenger.send(this.convo, {
          type: "text",
          text: `${this.fmt.italic("No saved sessions.")}\n\nSend a message to start one.`,
        });
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

      const lines = [`${this.fmt.bold("📂 Agent Sessions")} (${allSessions.length} total)`];
      if (offset > 0) lines.push(this.fmt.italic(`Showing ${offset + 1}–${offset + page.length}`));

      await this.messenger.send(this.convo, {
        type: "text",
        text: lines.join("\n"),
        ui: this.sessionsUI(items, hasMore),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `Failed to list sessions: ${this.fmt.escape(msg)}`,
      });
    }
  }

  private async resumeAgentSession(args: string): Promise<void> {
    const id = args.trim();
    if (!id) {
      await this.showAgentSessions();
      return;
    }

    if (this.isAgentRunning) {
      await this.messenger.send(this.convo, { type: "text", text: "Cannot switch session while agent is running. Use /abort first." });
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
      await this.messenger.send(this.convo, {
        type: "text",
        text: `Session not found: ${this.fmt.code(id)}`,
      });
      return;
    }

    try {
      this.streamSink.resetState();
      this.pendingInput = null;
      await this.managed!.switchSession(info.path);
      const label = info.name || info.firstMessage?.slice(0, 40) || info.id.slice(0, 8);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `✅ Resumed session: ${this.fmt.bold(label)}\n${this.fmt.code(info.id.slice(0, 8))} · ${info.messageCount} messages`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `❌ Failed to resume: ${this.fmt.escape(msg)}`,
      });
    }
  }

  private async startNewAgentSession(): Promise<void> {
    if (this.isAgentRunning) {
      await this.messenger.send(this.convo, { type: "text", text: "Cannot start new session while agent is running. Use /abort first." });
      return;
    }

    await this.ensureInitialized();

    try {
      this.streamSink.resetState();
      this.pendingInput = null;
      await this.managed!.session.newSession();
      await this.messenger.send(this.convo, { type: "text", text: "✅ New session started." });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `❌ Failed to start new session: ${this.fmt.escape(msg)}`,
      });
    }
  }

  private async handleSessionCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const action = parts[0];

    switch (action) {
      case "switch": {
        const id = parts.slice(1).join(":");
        await this.messenger.ackAction?.(ackHandle, "Switching...");
        await this.resumeAgentSession(id);
        break;
      }
      case "new":
        await this.messenger.ackAction?.(ackHandle);
        await this.startNewAgentSession();
        break;
      case "more":
        await this.messenger.ackAction?.(ackHandle);
        await this.showAgentSessions(this.sessionListOffset + ChatController.SESSIONS_PAGE_SIZE);
        break;
      case "refresh":
        await this.messenger.ackAction?.(ackHandle, "Refreshed");
        await this.showAgentSessions();
        break;
      default:
        await this.messenger.ackAction?.(ackHandle, "Unknown action");
    }
  }

  // ── Agent commands ─────────────────────────────────────────────────

  private async resetAgent(): Promise<void> {
    if (this.managed) {
      this.managed.dispose();
      this.managed = null;
    }
    this.isAgentRunning = false;
    this.streamSink.resetState();
    await this.init(false);
    await this.managed!.session.newSession();
    await this.messenger.send(this.convo, { type: "text", text: "🔄 Agent session reset." });
  }

  private async abortAgent(): Promise<void> {
    if (this.managed && this.isAgentRunning) {
      await this.managed.abort();
      await this.messenger.send(this.convo, { type: "text", text: "⏹ Agent aborted." });
    } else {
      await this.messenger.send(this.convo, { type: "text", text: "Agent is not running." });
    }
  }

  private async showStatus(): Promise<void> {
    const tmuxSessions = await tmux.listSessions({ socketPath: this.config.tmuxDefaultSocket });
    const sessionId = this.managed?.session.sessionId;
    const sessionName = this.managed?.session.sessionName;
    const sessionLabel = sessionName || (sessionId ? sessionId.slice(0, 8) : this.fmt.italic("none"));
    const parts: string[] = [
      this.fmt.bold("Status"),
      `Agent: ${this.isAgentRunning ? "🟢 Running" : "⚪ Idle"}`,
      `Mode: ${this.tmuxHandler.isTmuxThread ? "📟 tmux terminal" : "🤖 Agent"}`,
      `Session: ${this.fmt.code(sessionLabel)}`,
      this.convo.threadId ? `Topic: ${this.fmt.code(this.convo.threadId)}` : "",
      `Model: ${this.fmt.bold(this.activeModel.label)} (${this.fmt.code(`${this.activeModel.provider}/${this.activeModel.id}`)})`,
      `Thinking: ${this.fmt.code(this.activeThinkingLevel)}`,
      `Permissions: ${this.fmt.code(this.toolAuthorizer.getConfig().defaultMode || "default")}`,
      `tmux sessions: ${tmuxSessions.length}`,
      `Selected: ${this.tmuxHandler.selectedSession ? this.fmt.bold(this.tmuxHandler.selectedSession) : this.fmt.italic("none")}`,
      `CWD: ${this.fmt.code(this.config.cwd)}`,
    ].filter(Boolean);
    await this.messenger.send(this.convo, { type: "text", text: parts.join("\n") });
  }

  private async sendHelp(): Promise<void> {
    const help = [
      this.fmt.bold("🤖 Pi Agent Bot"),
      "",
      "Send any message to chat with the AI agent.",
      "The agent has tools: read files, run bash, edit code, and control tmux.",
      "",
      this.fmt.bold("Agent Commands"),
      "/sessions — List agent sessions",
      "/resume — Resume a previous session",
      "/newsession — Start a fresh session",
      "/reset — Full agent reset",
      "/abort — Abort current operation",
      "/model — Select model",
      "/thinking — Set thinking level",
      "/permissions — Configure tool permissions",
      "/status — Show status",
      "",
      this.fmt.bold("tmux Terminal"),
      "/tmux — Open interactive terminal mode",
      "In tmux mode, all messages are sent as terminal input.",
      "Buttons: Refresh, Ctrl-C, Enter, Up/Down, Tab, Switch",
      "",
      this.fmt.bold("tmux Management"),
      "/new <name> — Create session",
      "/select <name> — Select session",
      "/capture — Capture pane output",
      "/send <text> — Send keys",
      "/ctrlc — Send Ctrl-C",
      "/kill [name] — Kill session",
      "/resize [CxR] — Resize window (e.g. /resize 45x60)",
      "",
      this.fmt.bold("User Management") + " (owner only)",
      "/adduser <id> — Allow a user",
      "/removeuser <id> — Remove a user",
      "/users — List allowed users",
      "",
      this.fmt.bold("Permissions & Authorization"),
      "• Use /permissions to configure tool permissions",
      "• Rules: allow/ask/deny with pattern matching",
      "• Example: /permissions allow bash(npm run *)",
      "• Example: /permissions deny read(~/.env)",
      "",
      this.fmt.bold("Tips"),
      "• Use /tmux in a topic for a dedicated terminal",
      "• The agent can also use tmux tools automatically",
      '• Ask things like "start a Python REPL in tmux"',
    ];
    await this.messenger.send(this.convo, { type: "text", text: help.join("\n") });
  }

  // ── UI element builders ────────────────────────────────────────────

  private modelsUI(
    models: Array<{ key: string; label: string }>,
    currentKey: string,
  ): UIElement {
    const rows: UIButton[][] = [];
    for (let i = 0; i < models.length; i += 2) {
      const row: UIButton[] = [];
      for (let j = i; j < Math.min(i + 2, models.length); j++) {
        const m = models[j];
        const isCurrent = m.key === currentKey;
        row.push({
          label: isCurrent ? `✅ ${m.label}` : m.label,
          actionId: "model",
          data: `pick:${m.key}`,
        });
      }
      rows.push(row);
    }
    rows.push([{ label: "❌ Cancel", actionId: "model", data: "cancel" }]);
    return { kind: "buttons", rows };
  }

  private thinkingUI(currentLevel: string): UIElement {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const rows: UIButton[][] = [];
    for (let i = 0; i < levels.length; i += 3) {
      const row: UIButton[] = [];
      for (let j = i; j < Math.min(i + 3, levels.length); j++) {
        const level = levels[j];
        const isCurrent = level === currentLevel;
        row.push({
          label: isCurrent ? `✅ ${level}` : level,
          actionId: "think",
          data: `pick:${level}`,
        });
      }
      rows.push(row);
    }
    rows.push([{ label: "❌ Cancel", actionId: "think", data: "cancel" }]);
    return { kind: "buttons", rows };
  }

  private sessionsUI(
    sessions: Array<{ id: string; label: string }>,
    hasMore: boolean,
  ): UIElement {
    const rows: UIButton[][] = [];
    for (const s of sessions) {
      rows.push([{ label: s.label, actionId: "sess", data: `switch:${s.id}` }]);
    }
    const bottomRow: UIButton[] = [
      { label: "➕ New Session", actionId: "sess", data: "new" },
    ];
    if (hasMore) {
      bottomRow.push({ label: "📄 More", actionId: "sess", data: "more" });
    }
    bottomRow.push({ label: "🔄 Refresh", actionId: "sess", data: "refresh" });
    rows.push(bottomRow);
    return { kind: "buttons", rows };
  }
}
