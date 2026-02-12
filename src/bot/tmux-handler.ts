/**
 * Platform-agnostic tmux session management and terminal mode handler.
 * Depends only on im/ contracts — no Telegram imports.
 */

import type { Messenger, UIButton, UIElement } from "../im/messenger.js";
import type { Formatter } from "../im/formatter.js";
import type { ConversationRef } from "../im/types.js";
import * as tmux from "../tmux/tmux.js";

export class TmuxHandler {
  private messenger: Messenger;
  private fmt: Formatter;
  private convo: ConversationRef;
  private tmuxSocket: string;
  private tmuxSocketDir: string;

  selectedSession: string | null = null;
  isTmuxThread = false;
  lastCaptureMsgRef: string | null = null;

  constructor(
    messenger: Messenger,
    fmt: Formatter,
    convo: ConversationRef,
    tmuxSocket: string,
    tmuxSocketDir: string,
  ) {
    this.messenger = messenger;
    this.fmt = fmt;
    this.convo = convo;
    this.tmuxSocket = tmuxSocket;
    this.tmuxSocketDir = tmuxSocketDir;
  }

  private get maxTextChars(): number {
    return this.messenger.capabilities.maxTextChars;
  }

  // ── UI element builders ────────────────────────────────────────────

  private sessionsUI(sessions: string[]): UIElement {
    const rows: UIButton[][] = [];
    for (let i = 0; i < sessions.length; i += 2) {
      const row: UIButton[] = [
        { label: `📟 ${sessions[i]}`, actionId: "tmux", data: `sess:${sessions[i]}` },
      ];
      if (sessions[i + 1]) {
        row.push({ label: `📟 ${sessions[i + 1]}`, actionId: "tmux", data: `sess:${sessions[i + 1]}` });
      }
      rows.push(row);
    }
    rows.push([
      { label: "➕ New Session", actionId: "tmux", data: "new" },
      { label: "🔄 Refresh", actionId: "tmux", data: "refresh" },
    ]);
    return { kind: "buttons", rows };
  }

  private sessionActionsUI(sessionName: string): UIElement {
    return {
      kind: "buttons",
      rows: [
        [
          { label: "📋 Capture", actionId: "tmux", data: `capture:${sessionName}` },
          { label: "⌨️ Send Keys", actionId: "tmux", data: `sendkeys:${sessionName}` },
        ],
        [
          { label: "🛑 Ctrl-C", actionId: "tmux", data: `ctrlc:${sessionName}` },
          { label: "❌ Kill", actionId: "tmux", data: `kill:${sessionName}` },
        ],
        [
          { label: "◀️ Back to sessions", actionId: "tmux", data: "list" },
        ],
      ],
    };
  }

  private terminalUI(): UIElement {
    return {
      kind: "buttons",
      rows: [
        [
          { label: "🔄 Refresh", actionId: "term", data: "refresh" },
          { label: "🛑 Ctrl-C", actionId: "term", data: "ctrlc" },
          { label: "⏎ Enter", actionId: "term", data: "enter" },
        ],
        [
          { label: "📟 Switch", actionId: "term", data: "switch" },
          { label: "⬆️ Up", actionId: "term", data: "up" },
          { label: "⬇️ Down", actionId: "term", data: "down" },
          { label: "⇥ Tab", actionId: "term", data: "tab" },
        ],
        [
          { label: "📐 Resize", actionId: "term", data: "resize" },
        ],
      ],
    };
  }

  private resizeUI(): UIElement {
    return {
      kind: "buttons",
      rows: [
        [
          { label: "📱 Mobile (45×60)", actionId: "term", data: "rz:45:60" },
          { label: "📱 Narrow (35×80)", actionId: "term", data: "rz:35:80" },
        ],
        [
          { label: "🖥 Standard (80×24)", actionId: "term", data: "rz:80:24" },
          { label: "🖥 Wide (120×40)", actionId: "term", data: "rz:120:40" },
        ],
        [
          { label: "◀️ Back", actionId: "term", data: "refresh" },
        ],
      ],
    };
  }

  private confirmUI(action: string, data: string): UIElement {
    return {
      kind: "buttons",
      rows: [
        [
          { label: "✅ Yes", actionId: "confirm", data: `yes:${action}:${data}` },
          { label: "❌ No", actionId: "confirm", data: `no:${action}:${data}` },
        ],
      ],
    };
  }

  // ── Topic message handling ─────────────────────────────────────────

  async handleTmuxTopicMessage(text: string): Promise<void> {
    if (!this.selectedSession) {
      await this.promptSelectTmuxSession();
      return;
    }

    const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, this.selectedSession);
    if (!exists) {
      this.selectedSession = null;
      await this.messenger.send(this.convo, { type: "text", text: "⚠️ Session no longer exists." });
      await this.promptSelectTmuxSession();
      return;
    }

    const target = `${this.selectedSession}:0.0`;
    await tmux.sendKeys({ socketPath: this.tmuxSocket }, target, text, true);
    await tmux.sendEnter({ socketPath: this.tmuxSocket }, target);

    await new Promise((r) => setTimeout(r, 500));
    await this.tmuxTopicCapture();
  }

  async tmuxTopicCapture(): Promise<void> {
    if (!this.selectedSession) return;

    if (this.lastCaptureMsgRef) {
      try {
        await this.messenger.deleteMessage?.(this.convo, this.lastCaptureMsgRef);
      } catch {
        // message already deleted or too old
      }
      this.lastCaptureMsgRef = null;
    }

    try {
      const output = await tmux.capturePane(
        { socketPath: this.tmuxSocket },
        `${this.selectedSession}:0.0`,
      );
      const trimmed = output.trim();
      const display = trimmed || "(empty)";

      const maxLen = this.maxTextChars - 200;
      const truncated = display.length > maxLen ? `…${display.slice(-maxLen)}` : display;
      const text = `📟 ${this.fmt.bold(this.selectedSession)}\n${this.fmt.pre(truncated)}`;
      const ui = this.terminalUI();

      const result = await this.messenger.send(this.convo, { type: "text", text, ui });
      this.lastCaptureMsgRef = result.messageRef ?? null;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `❌ Capture failed: ${this.fmt.escape(msg)}`,
      });
    }
  }

  async promptSelectTmuxSession(): Promise<void> {
    const sessions = await tmux.listSessions({ socketPath: this.tmuxSocket });

    if (sessions.length === 0) {
      const ui: UIElement = {
        kind: "buttons",
        rows: [[{ label: "➕ New Session", actionId: "tmux", data: "new" }]],
      };
      await this.messenger.send(this.convo, {
        type: "text",
        text: "No tmux sessions running.\n\nUse /new <name> to create one, or /tmux for interactive mode.",
        ui,
      });
      return;
    }

    await this.messenger.send(this.convo, {
      type: "text",
      text: `${this.fmt.bold("Select a tmux session:")}\n\nUse /select <name> or click below:`,
      ui: this.sessionsUI(sessions.map((s) => s.name)),
    });
  }

  async showTmuxSessions(): Promise<void> {
    const sessions = await tmux.listSessions({ socketPath: this.tmuxSocket });
    if (sessions.length === 0) {
      const ui: UIElement = {
        kind: "buttons",
        rows: [[{ label: "➕ New Session", actionId: "tmux", data: "new" }]],
      };
      await this.messenger.send(this.convo, {
        type: "text",
        text: "No tmux sessions running.\n\nUse /new <name> to create one.",
        ui,
      });
      return;
    }

    const lines = sessions.map(
      (s) => `• ${this.fmt.bold(s.name)} — ${s.windows} window${s.windows > 1 ? "s" : ""}${s.attached ? " 🟢" : ""}`,
    );
    const selected = this.selectedSession ? `\n\n${this.fmt.italic(`Selected: ${this.selectedSession}`)}` : "";

    await this.messenger.send(this.convo, {
      type: "text",
      text: `${this.fmt.bold("📟 tmux Sessions")}\n\n${lines.join("\n")}${selected}`,
      ui: this.sessionsUI(sessions.map((s) => s.name)),
    });
  }

  async createTmuxSession(name: string): Promise<void> {
    const clean = name.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
    try {
      await tmux.newSession({ socketPath: this.tmuxSocket }, clean);
      this.selectedSession = clean;
      await this.messenger.send(this.convo, {
        type: "text",
        text: `✅ Session ${this.fmt.bold(clean)} created and selected.\n\n${this.fmt.code(`tmux -S ${this.tmuxSocket} attach -t ${clean}`)}`,
        ui: this.sessionActionsUI(clean),
      });
    } catch (e: unknown) {
      await this.messenger.send(this.convo, {
        type: "text",
        text: `Failed to create session: ${this.fmt.escape(String(e))}`,
      });
    }
  }

  async captureSelectedPane(sessionOverride?: string): Promise<void> {
    const name = sessionOverride?.trim() || this.selectedSession;
    if (!name) {
      await this.messenger.send(this.convo, { type: "text", text: "No session selected. Use /select <name> or /tmux." });
      return;
    }

    try {
      const output = await tmux.capturePane({ socketPath: this.tmuxSocket }, `${name}:0.0`);
      const trimmed = output.trim();
      if (!trimmed) {
        await this.messenger.send(this.convo, { type: "text", text: this.fmt.italic("(empty pane)") });
        return;
      }

      if (trimmed.length > this.maxTextChars - 100) {
        const buf = new TextEncoder().encode(trimmed);
        await this.messenger.send(this.convo, {
          type: "file",
          bytes: buf,
          filename: `capture-${name}.txt`,
          caption: `📋 Capture from ${this.fmt.bold(name)}`,
        });
      } else {
        await this.messenger.send(this.convo, {
          type: "text",
          text: `📋 ${this.fmt.bold(name)}\n${this.fmt.pre(trimmed)}`,
        });
      }
    } catch (e: unknown) {
      await this.messenger.send(this.convo, {
        type: "text",
        text: `Failed to capture: ${this.fmt.escape(String(e))}`,
      });
    }
  }

  async sendKeysToSelected(text: string): Promise<void> {
    if (!this.selectedSession) {
      await this.messenger.send(this.convo, { type: "text", text: "No session selected. Use /select <name> or /tmux." });
      return;
    }
    if (!text.trim()) {
      await this.messenger.send(this.convo, { type: "text", text: "Usage: /send <text to type>" });
      return;
    }

    const target = `${this.selectedSession}:0.0`;
    await tmux.sendKeys({ socketPath: this.tmuxSocket }, target, text, true);
    await tmux.sendEnter({ socketPath: this.tmuxSocket }, target);
    await this.messenger.send(this.convo, {
      type: "text",
      text: `⌨️ Sent to ${this.fmt.bold(this.selectedSession)}`,
    });
  }

  async sendCtrlCToSelected(): Promise<void> {
    if (!this.selectedSession) {
      await this.messenger.send(this.convo, { type: "text", text: "No session selected." });
      return;
    }
    await tmux.sendCtrlC({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`);
    await this.messenger.send(this.convo, {
      type: "text",
      text: `🛑 Ctrl-C sent to ${this.fmt.bold(this.selectedSession)}`,
    });
  }

  async killSelectedSession(nameOverride?: string): Promise<void> {
    const name = nameOverride?.trim() || this.selectedSession;
    if (!name) {
      await this.messenger.send(this.convo, { type: "text", text: "No session selected." });
      return;
    }
    await this.messenger.send(this.convo, {
      type: "text",
      text: `Kill session ${this.fmt.bold(name)}?`,
      ui: this.confirmUI("tmux-kill", name),
    });
  }

  async resizeTmuxWindow(args: string): Promise<void> {
    if (!this.selectedSession) {
      await this.messenger.send(this.convo, { type: "text", text: "No session selected. Use /select <name> or /tmux." });
      return;
    }

    const parts = args.trim().split(/[x×\s]+/);
    if (parts.length === 2) {
      const cols = parseInt(parts[0], 10);
      const rows = parseInt(parts[1], 10);
      if (cols > 0 && rows > 0 && cols <= 300 && rows <= 300) {
        try {
          await tmux.resizeWindow({ socketPath: this.tmuxSocket }, this.selectedSession, cols, rows);
          await this.messenger.send(this.convo, {
            type: "text",
            text: `📐 Resized ${this.fmt.bold(this.selectedSession)} to ${cols}×${rows}`,
          });
          if (this.isTmuxThread) {
            await this.tmuxTerminalCapture();
          }
          return;
        } catch (e: unknown) {
          await this.messenger.send(this.convo, {
            type: "text",
            text: `❌ Resize failed: ${this.fmt.escape(String(e))}`,
          });
          return;
        }
      }
    }

    await this.messenger.send(this.convo, {
      type: "text",
      text: `${this.fmt.bold("📐 Resize tmux window")}\n\nUsage: ${this.fmt.code("/resize 45x60")}\n\nSelect a preset:`,
      ui: this.resizeUI(),
    });
  }

  async selectSession(name: string): Promise<void> {
    const clean = name.trim();
    if (!clean) {
      await this.messenger.send(this.convo, { type: "text", text: "Usage: /select <session-name>" });
      return;
    }
    const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, clean);
    if (!exists) {
      await this.messenger.send(this.convo, {
        type: "text",
        text: `Session '${this.fmt.escape(clean)}' not found. Use /tmux to see available sessions.`,
      });
      return;
    }
    this.selectedSession = clean;
    await this.messenger.send(this.convo, {
      type: "text",
      text: `✅ Selected: ${this.fmt.bold(clean)}`,
      ui: this.sessionActionsUI(clean),
    });
  }

  async enterTmuxMode(): Promise<void> {
    this.isTmuxThread = true;
    await tmux.ensureSocketDir(this.tmuxSocketDir);

    if (this.selectedSession) {
      const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, this.selectedSession);
      if (exists) {
        await this.tmuxTerminalCapture();
        return;
      }
      this.selectedSession = null;
    }

    await this.tmuxTerminalPickSession();
  }

  async tmuxTerminalPickSession(): Promise<void> {
    const sessions = await tmux.listSessions({ socketPath: this.tmuxSocket });
    if (sessions.length === 0) {
      const name = `session-${Date.now()}`;
      const clean = name.replace(/[^a-zA-Z0-9._-]/g, "-");
      await tmux.newSession({ socketPath: this.tmuxSocket }, clean);
      this.selectedSession = clean;
      await this.messenger.send(this.convo, {
        type: "text",
        text: `📟 Created and connected to ${this.fmt.bold(clean)}\nSend text to type into the terminal.`,
      });
      await this.tmuxTerminalCapture();
      return;
    }

    const rows: UIButton[][] = sessions.map((s) => [
      { label: `📟 ${s.name}${s.attached ? " 🟢" : ""}`, actionId: "term", data: `sel:${s.name}` },
    ]);
    rows.push([
      { label: "➕ New Session", actionId: "term", data: "new" },
      { label: "🔄 Refresh", actionId: "term", data: "pick" },
    ]);

    await this.messenger.send(this.convo, {
      type: "text",
      text: `${this.fmt.bold("📟 Select a tmux session")}\n\nAll messages in this thread will be sent as terminal input.`,
      ui: { kind: "buttons", rows },
    });
  }

  async tmuxTerminalSend(text: string): Promise<void> {
    if (!this.selectedSession) {
      await this.tmuxTerminalPickSession();
      return;
    }

    const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, this.selectedSession);
    if (!exists) {
      this.selectedSession = null;
      await this.messenger.send(this.convo, { type: "text", text: "⚠️ Session no longer exists." });
      await this.tmuxTerminalPickSession();
      return;
    }

    const target = `${this.selectedSession}:0.0`;
    await tmux.sendKeys({ socketPath: this.tmuxSocket }, target, text, true);
    await tmux.sendEnter({ socketPath: this.tmuxSocket }, target);

    await new Promise((r) => setTimeout(r, 300));
    await this.tmuxTerminalCapture();
  }

  async tmuxTerminalCapture(): Promise<void> {
    if (!this.selectedSession) return;

    try {
      const output = await tmux.capturePane(
        { socketPath: this.tmuxSocket },
        `${this.selectedSession}:0.0`,
      );
      const trimmed = output.trim();
      const display = trimmed || "(empty)";

      const maxLen = this.maxTextChars - 200;
      const truncated = display.length > maxLen ? `…${display.slice(-maxLen)}` : display;
      const text = `📟 ${this.fmt.bold(this.selectedSession)}\n${this.fmt.pre(truncated)}`;
      const ui = this.terminalUI();

      if (this.lastCaptureMsgRef) {
        try {
          await this.messenger.edit?.(this.convo, this.lastCaptureMsgRef, { type: "text", text, ui });
          return;
        } catch {
          // edit failed (message too old, etc) — send new
        }
      }

      const result = await this.messenger.send(this.convo, { type: "text", text, ui });
      this.lastCaptureMsgRef = result.messageRef ?? null;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.messenger.send(this.convo, {
        type: "text",
        text: `❌ Capture failed: ${this.fmt.escape(msg)}`,
      });
    }
  }

  // ── Callback handlers ──────────────────────────────────────────────

  async handleTmuxCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const action = parts[0];
    const target = parts.slice(1).join(":");

    switch (action) {
      case "sess":
        this.selectedSession = target;
        await this.messenger.ackAction?.(ackHandle, `Selected: ${target}`);
        await this.messenger.send(this.convo, {
          type: "text",
          text: `📟 Selected: ${this.fmt.bold(target)}`,
          ui: this.sessionActionsUI(target),
        });
        break;

      case "list":
        await this.messenger.ackAction?.(ackHandle);
        await this.showTmuxSessions();
        break;

      case "new":
        await this.messenger.ackAction?.(ackHandle);
        await this.createTmuxSession(`session-${Date.now()}`);
        break;

      case "refresh":
        await this.messenger.ackAction?.(ackHandle, "Refreshed");
        await this.showTmuxSessions();
        break;

      case "capture":
        await this.messenger.ackAction?.(ackHandle);
        await this.captureSelectedPane(target);
        break;

      case "sendkeys":
        await this.messenger.ackAction?.(ackHandle, "Use /send <text> to send keys");
        break;

      case "ctrlc":
        this.selectedSession = target;
        await tmux.sendCtrlC({ socketPath: this.tmuxSocket }, `${target}:0.0`);
        await this.messenger.ackAction?.(ackHandle, "Ctrl-C sent");
        break;

      case "kill":
        await this.messenger.ackAction?.(ackHandle);
        await this.killSelectedSession(target);
        break;

      default:
        await this.messenger.ackAction?.(ackHandle, "Unknown action");
    }
  }

  async handleConfirmCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const [answer, action, ...rest] = parts;
    const data = rest.join(":");

    if (answer === "yes") {
      switch (action) {
        case "tmux-kill":
          try {
            await tmux.killSession({ socketPath: this.tmuxSocket }, data);
            if (this.selectedSession === data) this.selectedSession = null;
            await this.messenger.ackAction?.(ackHandle, `Session ${data} killed.`);
            await this.showTmuxSessions();
          } catch (e: unknown) {
            await this.messenger.ackAction?.(ackHandle, `Failed: ${String(e).slice(0, 80)}`, true);
          }
          break;
        default:
          await this.messenger.ackAction?.(ackHandle, "Unknown action");
      }
    } else {
      await this.messenger.ackAction?.(ackHandle, "Cancelled.");
    }
  }

  async handleTerminalCallback(ackHandle: unknown, parts: string[]): Promise<void> {
    const action = parts[0];

    switch (action) {
      case "refresh":
        await this.messenger.ackAction?.(ackHandle);
        await this.tmuxTerminalCapture();
        break;

      case "ctrlc":
        if (this.selectedSession) {
          await tmux.sendCtrlC({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`);
          await this.messenger.ackAction?.(ackHandle, "Ctrl-C sent");
          await new Promise((r) => setTimeout(r, 200));
          await this.tmuxTerminalCapture();
        } else {
          await this.messenger.ackAction?.(ackHandle, "No session selected");
        }
        break;

      case "enter":
        if (this.selectedSession) {
          await tmux.sendEnter({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`);
          await this.messenger.ackAction?.(ackHandle, "Enter sent");
          await new Promise((r) => setTimeout(r, 200));
          await this.tmuxTerminalCapture();
        } else {
          await this.messenger.ackAction?.(ackHandle, "No session selected");
        }
        break;

      case "up":
      case "down":
        if (this.selectedSession) {
          const key = action === "up" ? "Up" : "Down";
          await tmux.sendKeys({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`, key, false);
          await this.messenger.ackAction?.(ackHandle, `${key} sent`);
          await new Promise((r) => setTimeout(r, 150));
          await this.tmuxTerminalCapture();
        } else {
          await this.messenger.ackAction?.(ackHandle, "No session selected");
        }
        break;

      case "tab":
        if (this.selectedSession) {
          await tmux.sendKeys({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`, "Tab", false);
          await this.messenger.ackAction?.(ackHandle, "Tab sent");
          await new Promise((r) => setTimeout(r, 200));
          await this.tmuxTerminalCapture();
        } else {
          await this.messenger.ackAction?.(ackHandle, "No session selected");
        }
        break;

      case "switch":
      case "pick":
        await this.messenger.ackAction?.(ackHandle);
        this.lastCaptureMsgRef = null;
        await this.tmuxTerminalPickSession();
        break;

      case "sel": {
        const name = parts.slice(1).join(":");
        const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, name);
        if (!exists) {
          await this.messenger.ackAction?.(ackHandle, "Session not found", true);
          return;
        }
        this.selectedSession = name;
        this.lastCaptureMsgRef = null;
        await this.messenger.ackAction?.(ackHandle, `Connected: ${name}`);
        await this.tmuxTerminalCapture();
        break;
      }

      case "new": {
        const name = `session-${Date.now()}`.replace(/[^a-zA-Z0-9._-]/g, "-");
        await tmux.ensureSocketDir(this.tmuxSocketDir);
        await tmux.newSession({ socketPath: this.tmuxSocket }, name);
        this.selectedSession = name;
        this.lastCaptureMsgRef = null;
        await this.messenger.ackAction?.(ackHandle, `Created: ${name}`);
        await this.tmuxTerminalCapture();
        break;
      }

      case "resize":
        await this.messenger.ackAction?.(ackHandle);
        if (this.selectedSession) {
          const size = await tmux.getWindowSize({ socketPath: this.tmuxSocket }, this.selectedSession);
          await this.messenger.send(this.convo, {
            type: "text",
            text: `${this.fmt.bold("📐 Resize")} (current: ${size.cols}×${size.rows})\n\nOr use: ${this.fmt.code("/resize 45x60")}`,
            ui: this.resizeUI(),
          });
        } else {
          await this.messenger.send(this.convo, { type: "text", text: "No session selected." });
        }
        break;

      case "rz": {
        if (!this.selectedSession) {
          await this.messenger.ackAction?.(ackHandle, "No session selected");
          break;
        }
        const cols = parseInt(parts[1], 10);
        const rows = parseInt(parts[2], 10);
        if (cols > 0 && rows > 0) {
          try {
            await tmux.resizeWindow({ socketPath: this.tmuxSocket }, this.selectedSession, cols, rows);
            await this.messenger.ackAction?.(ackHandle, `Resized to ${cols}×${rows}`);
            await this.tmuxTerminalCapture();
          } catch {
            await this.messenger.ackAction?.(ackHandle, "Resize failed", true);
          }
        }
        break;
      }

      default:
        await this.messenger.ackAction?.(ackHandle, "Unknown action");
    }
  }
}
