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

  constructor(options: Partial<PermissionEvaluatorOptions> = {}) {
    this.options = {
      config: options.config ?? {},
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
    };
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

    // Check rules in order (deny -> ask -> allow)
    for (const rule of this.rules) {
      // Tool name must match
      if (rule.tool !== normalizedTool && rule.tool !== "*") {
        continue;
      }

      // If no specifier, rule matches all uses
      if (!rule.specifier) {
        return rule.level;
      }

      // Check specifier based on tool type
      if (this.matchesSpecifier(normalizedTool, args, rule.specifier)) {
        return rule.level;
      }
    }

    // Default behavior based on mode
    const mode = this.options.config.defaultMode ?? "default";

    switch (mode) {
      case "bypassPermissions":
        return "allow";
      case "dontAsk":
        return "deny";
      case "acceptEdits":
        // Auto-allow edit tools, ask for others
        return ["write", "edit"].includes(normalizedTool) ? "allow" : "ask";
      default:
        // Default: ask for potentially dangerous tools
        return this.isPotentiallyDangerous(normalizedTool, args) ? "ask" : "allow";
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
        lines.push(`  ${r.tool}${r.specifier ? `(${r.specifier})` : ""}`);
      }
    }

    if (asks.length > 0) {
      lines.push(fmt.bold("Ask:"));
      for (const r of asks) {
        lines.push(`  ${r.tool}${r.specifier ? `(${r.specifier})` : ""}`);
      }
    }

    if (allows.length > 0) {
      lines.push(fmt.bold("Allow:"));
      for (const r of allows) {
        lines.push(`  ${r.tool}${r.specifier ? `(${r.specifier})` : ""}`);
      }
    }

    if (lines.length === 0) {
      lines.push(fmt.italic("No custom rules configured."));
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
   * Wrap tool definitions with authorization layer
   */
  wrapTools(tools: ToolDefinition[]): ToolDefinition[] {
    const mode = this.evaluator.getConfig().defaultMode;

    // In bypass mode, don't wrap
    if (mode === "bypassPermissions") {
      return tools;
    }

    return tools.map((tool) => {
      return {
        ...tool,
        execute: async (id: string, params: any) => {
          const permission = this.evaluator.evaluate(tool.name, params);

          switch (permission) {
            case "allow":
              return tool.execute(id, params);
            case "deny":
              throw new Error(
                `Permission denied: ${tool.name} is blocked by permission rules`,
              );
            case "ask":
            default:
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

    return new Promise((resolve, reject) => {
      // Set timeout for authorization
      const timeoutId = setTimeout(() => {
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

    const result = await this.messenger.send(this.convo, {
      type: "text",
      text,
      ui,
    });

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
    const pending = this.pending.get(authId);

    if (!pending) {
      await this.messenger.ackAction?.(ackHandle, "Request expired or already handled.");
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeoutId);

    // Resolve the pending promise
    if (action === "allow") {
      pending.resolve(true);
      await this.messenger.ackAction?.(ackHandle, "Action approved.");
    } else {
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
   * Get formatted rules for display
   */
  formatRules(): string {
    return this.evaluator.formatRules(this.fmt);
  }
}
