/**
 * Flexible permission system following Claude Code's design.
 *
 * Supports rule-based permissions with:
 * - allow: Auto-approve matching tool uses
 * - ask: Prompt for confirmation (default behavior)
 * - deny: Block tool use entirely
 *
 * Rules are evaluated: deny -> ask -> allow (first match wins)
 *
 * Rule syntax: Tool or Tool(specifier)
 * Examples:
 *   - "bash" - matches all bash commands
 *   - "bash(npm run \*)" - matches npm run commands
 *   - "edit(./src/**\/*.ts)" - matches TypeScript file edits
 *   - "read(~/.env)" - matches reading .env file
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Messenger, UIButton, UIElement } from "../im/messenger.js";
import type { Formatter } from "../im/formatter.js";
import type { ConversationRef } from "../im/types.js";
import { minimatch } from "minimatch";
import { resolve, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createLogger, type Logger } from "../logger.js";

export type PermissionLevel = "allow" | "ask" | "deny";
export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions";

export interface PermissionRule {
  level: PermissionLevel;
  tool: string;
  specifier?: string;
}

export interface PermissionConfig {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  defaultMode?: PermissionMode;
}

interface PendingAuthorization {
  toolName: string;
  args: any;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  messageRef?: string;
}

interface PermissionEvaluatorOptions {
  config: PermissionConfig;
  cwd: string;
  timeoutMs: number;
}

/**
 * Parse a permission rule string into structured components
 * Format: "Tool" or "Tool(specifier)"
 */
export function parsePermissionRule(rule: string, level: PermissionLevel): PermissionRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;

  const openParen = trimmed.indexOf("(");
  const closeParen = trimmed.indexOf(")");

  // No specifier - matches all uses of the tool
  if (openParen === -1 || closeParen === -1 || closeParen < openParen) {
    return { level, tool: trimmed.toLowerCase() };
  }

  const tool = trimmed.slice(0, openParen).toLowerCase();
  const specifier = trimmed.slice(openParen + 1, closeParen);

  return { level, tool, specifier };
}

/**
 * Normalize a file path for permission matching
 */
function normalizePath(pattern: string, cwd: string): string {
  // Absolute path from filesystem root: //path
  if (pattern.startsWith("//")) {
    return pattern.slice(1); // Remove one slash to get /path
  }

  // Path from home directory: ~/path
  if (pattern.startsWith("~/")) {
    return join(homedir(), pattern.slice(2));
  }

  // Path relative to settings file: /path
  if (pattern.startsWith("/")) {
    return join(cwd, pattern);
  }

  // Path relative to current directory: path or ./path
  if (pattern.startsWith("./")) {
    return join(cwd, pattern.slice(2));
  }

  // Default: relative to current directory
  return join(cwd, pattern);
}

/**
 * Check if a bash command matches a pattern
 * Supports glob patterns with *
 */
function matchesBashPattern(command: string, pattern: string): boolean {
  // Escape special regex characters except *
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  const regex = new RegExp(`^${regexPattern}$`, "i");
  return regex.test(command);
}

/**
 * Check if a file path matches a pattern
 * Uses gitignore-style matching with minimatch
 */
function matchesPathPattern(filePath: string, pattern: string, cwd: string): boolean {
  const normalizedPattern = normalizePath(pattern, cwd);
  const normalizedFile = resolve(filePath);

  // Direct match
  if (normalizedFile === normalizedPattern) {
    return true;
  }

  // Use minimatch for glob patterns
  const matchOptions = { dot: true, matchBase: true };

  // Check if file matches the pattern
  if (minimatch(normalizedFile, normalizedPattern, matchOptions)) {
    return true;
  }

  // Also check relative path from cwd
  const relativePath = normalizedFile.startsWith(cwd)
    ? normalizedFile.slice(cwd.length).replace(/^\//, "")
    : normalizedFile;

  if (minimatch(relativePath, pattern, matchOptions)) {
    return true;
  }

  return false;
}

/**
 * Check if a WebFetch domain matches a pattern
 */
function matchesDomainPattern(url: string, pattern: string): boolean {
  // Extract domain from URL
  const domainMatch = url.match(/^https?:\/\/([^/]+)/i);
  if (!domainMatch) return false;

  const domain = domainMatch[1].toLowerCase();
  const expectedDomain = pattern.toLowerCase().replace(/^domain:/, "");

  // Exact match
  if (domain === expectedDomain) return true;

  // Subdomain match: example.com matches api.example.com
  if (domain.endsWith(`.${expectedDomain}`)) return true;

  // Wildcard match: *.example.com matches api.example.com
  if (expectedDomain.startsWith("*.")) {
    const suffix = expectedDomain.slice(2);
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }

  return false;
}

export class PermissionEvaluator {
  private rules: PermissionRule[] = [];
  private options: PermissionEvaluatorOptions;
  private logger: Logger;

  constructor(options: Partial<PermissionEvaluatorOptions> = {}) {
    this.options = {
      config: options.config ?? {},
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
    };
    this.logger = createLogger({ component: "permissions" });
    this.loadRules();
  }

  /**
   * Load and parse all permission rules from config
   * Rules are stored in order: deny -> ask -> allow
   */
  private loadRules(): void {
    const config = this.options.config;
    this.rules = [];

    // Process in order: deny -> ask -> allow
    for (const rule of config.deny ?? []) {
      const parsed = parsePermissionRule(rule, "deny");
      if (parsed) this.rules.push(parsed);
    }

    for (const rule of config.ask ?? []) {
      const parsed = parsePermissionRule(rule, "ask");
      if (parsed) this.rules.push(parsed);
    }

    for (const rule of config.allow ?? []) {
      const parsed = parsePermissionRule(rule, "allow");
      if (parsed) this.rules.push(parsed);
    }
  }

  /**
   * Update configuration and reload rules
   */
  setConfig(config: PermissionConfig): void {
    this.options.config = config;
    this.loadRules();
  }

  /**
   * Evaluate permission for a tool use
   * Returns: "allow" | "ask" | "deny"
   */
  evaluate(toolName: string, args: any): PermissionLevel {
    const normalizedTool = toolName.toLowerCase();
    const mode = this.options.config.defaultMode ?? "default";

    this.logger.debug({ toolName, mode, args, ruleCount: this.rules.length, rules: this.rules.map(r => `${r.level}:${r.tool}${r.specifier ? `(${r.specifier})` : ""}`) }, "Evaluating permission");

    // Check rules in order (deny -> ask -> allow)
    for (const rule of this.rules) {
      // Tool name must match
      if (rule.tool !== normalizedTool && rule.tool !== "*") {
        this.logger.trace({ rule: `${rule.level}:${rule.tool}`, tool: normalizedTool }, "Rule does not match tool");
        continue;
      }

      this.logger.trace({ tool: normalizedTool, rule: `${rule.level}:${rule.tool}` }, "Tool matches rule");

      // If no specifier, rule matches all uses
      if (!rule.specifier) {
        this.logger.debug({ tool: normalizedTool, level: rule.level }, "Rule has no specifier, returning level");
        return rule.level;
      }

      // Check specifier based on tool type
      const specifierMatches = this.matchesSpecifier(normalizedTool, args, rule.specifier);
      this.logger.trace({ tool: normalizedTool, specifier: rule.specifier, matches: specifierMatches }, "Checking specifier");
      if (specifierMatches) {
        this.logger.debug({ tool: normalizedTool, level: rule.level, specifier: rule.specifier }, "Specifier matches, returning level");
        return rule.level;
      }
    }

    // Default behavior based on mode
    switch (mode) {
      case "bypassPermissions":
        this.logger.trace({ mode }, "Mode is bypassPermissions, returning allow");
        return "allow";
      case "dontAsk":
        this.logger.trace({ mode }, "Mode is dontAsk, returning deny");
        return "deny";
      case "acceptEdits":
        // Auto-allow edit tools, ask for others
        const result = ["write", "edit"].includes(normalizedTool) ? "allow" : "ask";
        this.logger.trace({ mode, tool: normalizedTool, result }, "Mode is acceptEdits");
        return result;
      default:
        // Default: ask for potentially dangerous tools
        const isDangerous = this.isPotentiallyDangerous(normalizedTool, args);
        this.logger.trace({ mode, tool: normalizedTool, isDangerous }, "Mode is default");
        return isDangerous ? "ask" : "allow";
    }
  }

  /**
   * Check if a tool use matches a specifier
   */
  private matchesSpecifier(tool: string, args: any, specifier: string): boolean {
    switch (tool) {
      case "bash":
        return matchesBashPattern(args?.command ?? "", specifier);

      case "read":
      case "edit":
      case "write":
        return matchesPathPattern(args?.path ?? "", specifier, this.options.cwd);

      case "webfetch":
        return matchesDomainPattern(args?.url ?? "", specifier);

      case "tmux_send_keys":
      case "tmux_capture_pane":
      case "tmux_kill_session":
      case "tmux_new_session":
      case "tmux_send_ctrl_c":
        // For tmux tools, match session name
        return matchesBashPattern(args?.session ?? args?.name ?? "", specifier);

      default:
        // Default: match any argument value
        return JSON.stringify(args).includes(specifier);
    }
  }

  /**
   * Determine if a tool is potentially dangerous (should ask by default)
   */
  private isPotentiallyDangerous(tool: string, _args: any): boolean {
    const dangerousTools = [
      "bash",
      "write",
      "edit",
      "tmux_kill_session",
      "tmux_new_session",
      "tmux_send_keys",
    ];
    return dangerousTools.includes(tool);
  }

  /**
   * Get current configuration
   */
  getConfig(): PermissionConfig {
    return { ...this.options.config };
  }

  /**
   * Format rules for display
   */
  formatRules(fmt: Formatter): string {
    const lines: string[] = [];

    const denies = this.rules.filter((r) => r.level === "deny");
    const asks = this.rules.filter((r) => r.level === "ask");
    const allows = this.rules.filter((r) => r.level === "allow");

    if (denies.length > 0) {
      lines.push(fmt.bold("Deny:"));
      for (const r of denies) {
        const ruleText = `${r.tool}${r.specifier ? `(${r.specifier})` : ""}`;
        lines.push(`  ${fmt.escape(ruleText)}`);
      }
    }

    if (asks.length > 0) {
      lines.push(fmt.bold("Ask:"));
      for (const r of asks) {
        const ruleText = `${r.tool}${r.specifier ? `(${r.specifier})` : ""}`;
        lines.push(`  ${fmt.escape(ruleText)}`);
      }
    }

    if (allows.length > 0) {
      lines.push(fmt.bold("Allow:"));
      for (const r of allows) {
        const ruleText = `${r.tool}${r.specifier ? `(${r.specifier})` : ""}`;
        lines.push(`  ${fmt.escape(ruleText)}`);
      }
    }

    if (lines.length === 0) {
      lines.push(fmt.italic("No custom rules configured."));
    }

    return lines.join("\n");
  }

  /**
   * Format rules for display (raw text, no HTML)
   */
  formatRulesRaw(): string {
    const lines: string[] = [];

    const denies = this.rules.filter((r) => r.level === "deny");
    const asks = this.rules.filter((r) => r.level === "ask");
    const allows = this.rules.filter((r) => r.level === "allow");

    if (denies.length > 0) {
      lines.push("Deny:");
      for (const r of denies) {
        lines.push(`  ${r.tool}${r.specifier ? `(${r.specifier})` : ""}`);
      }
    }

    if (asks.length > 0) {
      lines.push("Ask:");
      for (const r of asks) {
        lines.push(`  ${r.tool}${r.specifier ? `(${r.specifier})` : ""}`);
      }
    }

    if (allows.length > 0) {
      lines.push("Allow:");
      for (const r of allows) {
        lines.push(`  ${r.tool}${r.specifier ? `(${r.specifier})` : ""}`);
      }
    }

    if (lines.length === 0) {
      lines.push("No custom rules configured.");
    }

    return lines.join("\n");
  }
}

export class ToolAuthorizer {
  private messenger: Messenger;
  private fmt: Formatter;
  private convo: ConversationRef;
  private evaluator: PermissionEvaluator;
  private pending = new Map<string, PendingAuthorization>();
  private timeoutMs: number;
  private logger: Logger;

  constructor(
    messenger: Messenger,
    fmt: Formatter,
    convo: ConversationRef,
    options: {
      config?: PermissionConfig;
      cwd?: string;
      timeoutMs?: number;
    } = {},
  ) {
    this.messenger = messenger;
    this.fmt = fmt;
    this.convo = convo;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.logger = createLogger({ component: "tool-authorizer" });
    this.evaluator = new PermissionEvaluator({
      config: options.config ?? {},
      cwd: options.cwd,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * Update permission configuration
   */
  setConfig(config: PermissionConfig): void {
    this.evaluator.setConfig(config);
  }

  /**
   * Get current configuration
   */
  getConfig(): PermissionConfig {
    return this.evaluator.getConfig();
  }

  /**
   * Evaluate permission for a tool use without executing
   */
  evaluate(toolName: string, args: any): PermissionLevel {
    return this.evaluator.evaluate(toolName, args);
  }

  /**
   * Wrap tool definitions with authorization layer
   */
  wrapTools(tools: ToolDefinition[]): ToolDefinition[] {
    const mode = this.evaluator.getConfig().defaultMode;
    this.logger.debug({ mode, tools: tools.map(t => t.name) }, "wrapTools called");

    // In bypass mode, don't wrap
    if (mode === "bypassPermissions") {
      this.logger.debug("bypassPermissions mode - tools NOT wrapped");
      return tools;
    }

    this.logger.debug({ toolCount: tools.length }, "Wrapping tools with authorization");

    return tools.map((tool) => {
      return {
        ...tool,
        execute: async (id: string, params: any) => {
          this.logger.trace({ toolName: tool.name, id }, "Tool executing");
          const permission = this.evaluator.evaluate(tool.name, params);
          this.logger.debug({ toolName: tool.name, permission }, "Tool evaluated");

          switch (permission) {
            case "allow":
              this.logger.trace({ toolName: tool.name }, "Tool allowed - executing directly");
              return tool.execute(id, params);
            case "deny":
              this.logger.debug({ toolName: tool.name }, "Tool denied - throwing error");
              throw new Error(
                `Permission denied: ${tool.name} is blocked by permission rules`,
              );
            case "ask":
            default:
              this.logger.debug({ toolName: tool.name }, "Tool requires authorization - sending request");
              return this.authorizeAndExecute(tool.name, params, () =>
                tool.execute(id, params),
              );
          }
        },
      };
    });
  }

  /**
   * Request authorization for a tool execution
   */
  private async authorizeAndExecute(
    toolName: string,
    args: any,
    executeFn: () => Promise<any>,
  ): Promise<any> {
    const authId = `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.logger.debug({ authId, toolName }, "authorizeAndExecute created");

    return new Promise((resolve, reject) => {
      // Set timeout for authorization
      const timeoutId = setTimeout(() => {
        this.logger.warn({ authId, toolName }, "Authorization timeout");
        this.cleanupAuthorization(authId);
        reject(
          new Error(
            `Authorization timeout: ${toolName} was not confirmed within ${this.timeoutMs / 1000}s`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(authId, {
        toolName,
        args,
        resolve,
        reject,
        timeoutId,
      });

      // Send authorization request
      this.sendAuthorizationRequest(authId, toolName, args).catch((err) => {
        this.cleanupAuthorization(authId);
        reject(err);
      });
    }).then(async (result) => {
      if (result === true) {
        // User approved, execute the tool
        return executeFn();
      } else {
        // User denied
        throw new Error(`Tool execution denied by user: ${toolName}`);
      }
    });
  }

  /**
   * Send authorization request message with buttons
   */
  private async sendAuthorizationRequest(
    authId: string,
    toolName: string,
    args: any,
  ): Promise<void> {
    this.logger.debug({ authId, toolName }, "Sending authorization request");

    const toolDisplay = this.formatToolDisplay(toolName, args);

    const text = [
      `🔒 ${this.fmt.bold("Authorization Required")}`,
      "",
      toolDisplay,
      "",
      this.fmt.italic("Do you want to allow this action?"),
    ].join("\n");

    const ui: UIElement = {
      kind: "buttons",
      rows: [
        [
          { label: "✅ Allow", actionId: "auth", data: `allow:${authId}` },
          { label: "❌ Deny", actionId: "auth", data: `deny:${authId}` },
        ],
      ],
    };

    let result;
    try {
      result = await this.messenger.send(this.convo, {
        type: "text",
        text,
        ui,
      });
      this.logger.debug({ result }, "Authorization message sent");
    } catch (err) {
      this.logger.error({ err }, "Failed to send authorization message");
      throw err;
    }

    // Store message ref for cleanup
    const pending = this.pending.get(authId);
    if (pending && result.messageRef) {
      pending.messageRef = result.messageRef;
    }
  }

  /**
   * Format tool display for authorization message
   */
  private formatToolDisplay(toolName: string, args: any): string {
    const parts: string[] = [];

    switch (toolName.toLowerCase()) {
      case "bash":
        parts.push(this.fmt.bold("Shell Command:"));
        parts.push(this.fmt.code(args?.command || "(no command specified)"));
        break;
      case "write":
        parts.push(this.fmt.bold("Write File:"));
        parts.push(this.fmt.code(args?.path || "(no path specified)"));
        if (args?.content) {
          const preview = String(args.content).slice(0, 200);
          parts.push(
            this.fmt.italic(
              `Preview: ${preview}${String(args.content).length > 200 ? "..." : ""}`,
            ),
          );
        }
        break;
      case "edit":
        parts.push(this.fmt.bold("Edit File:"));
        parts.push(this.fmt.code(args?.path || "(no path specified)"));
        if (args?.oldString && args?.newString) {
          parts.push(this.fmt.italic(`Replacing: ${args.oldString.slice(0, 100)}...`));
        }
        break;
      case "read":
        parts.push(this.fmt.bold("Read File:"));
        parts.push(this.fmt.code(args?.path || "(no path specified)"));
        break;
      case "webfetch":
        parts.push(this.fmt.bold("Fetch URL:"));
        parts.push(this.fmt.code(args?.url || "(no URL specified)"));
        break;
      case "tmux_new_session":
        parts.push(this.fmt.bold("Create tmux Session:"));
        parts.push(this.fmt.code(args?.name || "(auto-generated)"));
        if (args?.command) {
          parts.push(`Command: ${this.fmt.code(args.command)}`);
        }
        break;
      case "tmux_kill_session":
        parts.push(this.fmt.bold("Kill tmux Session:"));
        parts.push(this.fmt.code(args?.name || "(no session specified)"));
        break;
      case "tmux_send_keys":
        parts.push(this.fmt.bold("Send Keys to tmux:"));
        parts.push(`Session: ${this.fmt.code(args?.session || "(none)")}`);
        parts.push(`Keys: ${this.fmt.code(args?.keys || "(none)")}`);
        break;
      case "tmux_send_ctrl_c":
        parts.push(this.fmt.bold("Send Ctrl-C to tmux:"));
        parts.push(`Session: ${this.fmt.code(args?.session || "(none)")}`);
        break;
      case "tmux_capture_pane":
        parts.push(this.fmt.bold("Capture tmux Pane:"));
        parts.push(`Session: ${this.fmt.code(args?.session || "(none)")}`);
        break;
      default:
        parts.push(this.fmt.bold(`Tool: ${toolName}`));
        if (args && Object.keys(args).length > 0) {
          parts.push(this.fmt.code(JSON.stringify(args, null, 2).slice(0, 300)));
        }
    }

    return parts.join("\n");
  }

  /**
   * Handle authorization callback from user
   */
  async handleCallback(
    ackHandle: unknown,
    action: "allow" | "deny",
    authId: string,
  ): Promise<void> {
    this.logger.debug({ action, authId, pendingKeys: Array.from(this.pending.keys()) }, "handleCallback called");

    const pending = this.pending.get(authId);

    if (!pending) {
      this.logger.warn({ authId }, "No pending authorization found");
      await this.messenger.ackAction?.(ackHandle, "Request expired or already handled.");
      return;
    }

    this.logger.debug({ authId, toolName: pending.toolName }, "Found pending authorization");

    // Clear timeout
    clearTimeout(pending.timeoutId);

    // Resolve the pending promise
    if (action === "allow") {
      this.logger.debug({ toolName: pending.toolName }, "Resolving with approval");
      pending.resolve(true);
      await this.messenger.ackAction?.(ackHandle, "Action approved.");
    } else {
      this.logger.debug({ toolName: pending.toolName }, "Rejecting with denial");
      pending.reject(new Error(`Tool execution denied: ${pending.toolName}`));
      await this.messenger.ackAction?.(ackHandle, "Action denied.");
    }

    this.cleanupAuthorization(authId);

    // Edit the message to remove buttons and show result
    if (pending.messageRef) {
      try {
        const newText =
          action === "allow"
            ? `✅ ${this.fmt.bold("Authorized")}: ${this.fmt.code(pending.toolName)}`
            : `❌ ${this.fmt.bold("Denied")}: ${this.fmt.code(pending.toolName)}`;
        await this.messenger.edit?.(this.convo, pending.messageRef, {
          type: "text",
          text: newText,
        });
      } catch {
        // Ignore edit failures
      }
    }
  }

  /**
   * Clean up authorization state
   */
  private cleanupAuthorization(authId: string): void {
    this.pending.delete(authId);
  }

  /**
   * Clean up all pending authorizations (e.g., on session end)
   */
  dispose(): void {
    for (const [authId, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Session ended - authorization cancelled"));
    }
    this.pending.clear();
  }

  /**
   * Get formatted rules for display (HTML formatted)
   */
  formatRules(): string {
    return this.evaluator.formatRules(this.fmt);
  }

  /**
   * Get formatted rules for display (raw text, no HTML)
   */
  formatRulesRaw(): string {
    return this.evaluator.formatRulesRaw();
  }
}
