/**
 * Pi Agent SDK session management.
 * Creates and manages the agent session, bridging events to callbacks.
 * Handles model fallback and session-safe model switching.
 */

import type { Model, Api } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry as SdkModelRegistry,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Config } from "../config.js";
import { ModelStore, type ThinkingLevel } from "../models.js";
import { rootLogger, type Logger } from "../logger.js";

export interface AgentEventCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onToolStart: (toolName: string, args: any) => void;
  onToolEnd: (toolName: string, result: any, isError: boolean) => void;
  onAgentStart: () => void;
  onAgentEnd: (errorMessage?: string) => void;
  onError: (error: string) => void;
  onModelFallback?: (fromLabel: string, toLabel: string, error: string) => void;
}

export interface ManagedSession {
  session: AgentSession;
  modelStore: ModelStore;
  activeModelKey: string;
  activeThinkingLevel: ThinkingLevel;

  prompt: (text: string, options?: { images?: Array<{ type: string; source: { type: string; media_type: string; data: string } }> }) => Promise<void>;
  abort: () => Promise<void>;
  isStreaming: () => boolean;
  dispose: () => void;

  setModelByKey: (key: string) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevel) => void;
  switchSession: (sessionPath: string) => Promise<void>;
}

export interface CreateSessionOptions {
  config: Config;
  tmuxTools: ToolDefinition[];
  callbacks: AgentEventCallbacks;
  sessionDir: string;
  modelKey: string;
  thinkingLevel: ThinkingLevel;
  /**
   * Optional function to wrap/override tools (both built-in and custom).
   * Used for authorization/security layers.
   */
  wrapTools?: (tools: ToolDefinition[]) => ToolDefinition[];
  /**
   * Optional logger instance for structured logging.
   */
  logger?: Logger;
}

export async function createManagedSession(opts: CreateSessionOptions): Promise<ManagedSession> {
  const { config, tmuxTools, callbacks, sessionDir, modelKey, thinkingLevel, wrapTools, logger: customLogger } = opts;

  const logger = customLogger ?? rootLogger.child({ component: "session" });

  const authStorage = new AuthStorage();
  const modelStore = new ModelStore(config.modelRegistry, authStorage);
  modelStore.registerApiKeys();

  const sdkModelRegistry = new SdkModelRegistry(authStorage);
  const sdkModel = modelStore.getSdkModel(modelKey);

  let activeModelKey = modelKey;
  let activeThinkingLevel = thinkingLevel;

  logger.info({ model: `${sdkModel.provider}/${sdkModel.id}`, baseUrl: sdkModel.baseUrl }, "Using model");
  logger.info({ thinkingLevel }, "Thinking level set");

  const skillPaths = [
    resolve(config.cwd, ".agents", "skills"),
    resolve(homedir(), ".agents", "skills"),
  ];
  logger.debug({ skillPaths }, "Skill paths configured");

  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    noSkills: true,
    additionalSkillPaths: skillPaths,
  });
  await (resourceLoader as any).reload();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    model: sdkModel,
    thinkingLevel: thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    sessionManager: SessionManager.create(config.cwd, sessionDir),
    authStorage,
    modelRegistry: sdkModelRegistry,
    customTools: tmuxTools,
    resourceLoader,
  });

  // Wrap tools with authorization/security layer if provided
  function applyToolWrapping(): void {
    if (!wrapTools) return;
    try {
      const agent = (session as any).agent;
      if (agent?.state?.tools) {
        const originalTools = agent.state.tools;
        const wrappedTools = wrapTools(originalTools);
        agent.setTools(wrappedTools);
        logger.info({ toolCount: originalTools.length }, "Tools wrapped with authorization layer");
      }
    } catch (e) {
      logger.error({ err: e }, "Failed to wrap tools");
    }
  }
  applyToolWrapping();

  session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const subType = event.assistantMessageEvent.type;
        if (subType === "text_delta") {
          callbacks.onTextDelta(event.assistantMessageEvent.delta);
        } else if (subType === "thinking_delta") {
          callbacks.onThinkingDelta((event.assistantMessageEvent as { delta: string }).delta);
        }
        break;
      }

      case "tool_execution_start":
        callbacks.onToolStart(event.toolName, event.args);
        break;

      case "tool_execution_end":
        callbacks.onToolEnd(event.toolName, event.result, event.isError);
        break;

      case "agent_start":
        callbacks.onAgentStart();
        break;

      case "agent_end": {
        const msgs = (event as any).messages;
        let errorMessage: string | undefined;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if (m.role === "assistant" && m.errorMessage) {
              errorMessage = m.errorMessage;
            }
          }
        }
        if (errorMessage) {
          logger.error({ errorMessage }, "Agent ended with error");
        } else {
          logger.info({ messageCount: msgs?.length }, "Agent ended");
        }
        callbacks.onAgentEnd(errorMessage);
        break;
      }

      case "message_start": {
        const m = (event as any).message;
        const role = m?.role ?? "?";
        const contentTypes = Array.isArray(m?.content)
          ? m.content.map((c: any) => c.type ?? "unknown").join(",")
          : typeof m?.content;
        logger.debug({ role, contentTypes, stopReason: m?.stopReason, errorMessage: m?.errorMessage }, "Message start");
        break;
      }

      case "message_end": {
        const m = (event as any).message;
        const role = m?.role ?? "?";
        logger.debug({ role, stopReason: m?.stopReason, errorMessage: m?.errorMessage }, "Message end");
        break;
      }

      default:
        logger.debug({ eventType: event.type }, "Agent event");
        break;
    }
  });

  function reapplyModel(): void {
    const model = modelStore.getSdkModel(activeModelKey);
    try {
      (session as any).agent.setModel(model);
    } catch (e) {
      logger.error({ err: e }, "Failed to reapply model");
    }
  }

  function tryFallbackToDefault(error: string): boolean {
    const defaultKey = config.modelRegistry.defaultKey;
    if (activeModelKey === defaultKey) return false;

    const fromConfig = config.modelRegistry.get(activeModelKey);
    const toConfig = config.modelRegistry.get(defaultKey);
    if (!fromConfig || !toConfig) return false;

    logger.info({ from: fromConfig.label, to: toConfig.label }, "Falling back to default model");
    activeModelKey = defaultKey;
    activeThinkingLevel = toConfig.thinkingLevel ?? config.defaultThinkingLevel;

    const defaultModel = modelStore.getSdkModel(defaultKey);
    try {
      (session as any).agent.setModel(defaultModel);
      (session as any).agent.setThinkingLevel(activeThinkingLevel);
    } catch (e) {
      logger.error({ err: e }, "Failed to set fallback model");
      return false;
    }

    callbacks.onModelFallback?.(fromConfig.label, toConfig.label, error);
    return true;
  }

  const managed: ManagedSession = {
    session,
    modelStore,
    get activeModelKey() { return activeModelKey; },
    set activeModelKey(_: string) { /* read via setModelByKey */ },
    get activeThinkingLevel() { return activeThinkingLevel; },
    set activeThinkingLevel(_: ThinkingLevel) { /* read via setThinkingLevel */ },

    async prompt(text: string, options?: { images?: Array<{ type: string; source: { type: string; media_type: string; data: string } }> }) {
      const model = session.model;
      const msgCount = session.messages?.length ?? 0;
      logger.info({
        sessionId: session.sessionId?.slice(0, 8),
        model: `${model?.provider}/${model?.id}`,
        messageCount: msgCount,
        thinkingLevel: session.thinkingLevel,
        imageCount: options?.images?.length ?? 0,
      }, "Prompting agent");
      try {
        await session.prompt(text, options?.images ? { images: options.images } : undefined);
        logger.info("Prompt completed");
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const isRecoverable = /403|401|429|5\d\d|timeout|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(errMsg);
        if (isRecoverable && tryFallbackToDefault(errMsg)) {
          return;
        }
        logger.error({ err: e }, "Prompt error");
        callbacks.onError(errMsg);
      }
    },

    async abort() {
      await session.abort();
    },

    isStreaming() {
      return session.isStreaming;
    },

    dispose() {
      session.dispose();
    },

    async setModelByKey(key: string) {
      const model = modelStore.getSdkModel(key);
      const modelConfig = config.modelRegistry.get(key);
      if (!modelConfig) throw new Error(`Model key "${key}" not found`);

      await session.setModel(model);
      activeModelKey = key;
      if (modelConfig.thinkingLevel) {
        activeThinkingLevel = modelConfig.thinkingLevel;
        session.setThinkingLevel(activeThinkingLevel);
      }
      logger.info({ model: `${model.provider}/${model.id}`, baseUrl: model.baseUrl }, "Model switched");
    },

    setThinkingLevel(level: ThinkingLevel) {
      activeThinkingLevel = level;
      session.setThinkingLevel(level);
      logger.info({ thinkingLevel: level }, "Thinking level set");
    },

    async switchSession(sessionPath: string) {
      await session.switchSession(sessionPath);
      reapplyModel();
    },
  };

  return managed;
}
