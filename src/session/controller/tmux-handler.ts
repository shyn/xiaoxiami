/**
 * tmux session management and terminal mode handler.
 */

import type { TelegramClient } from "../../telegram/client.js";
import * as tmux from "../../tmux/tmux.js";
import { escapeHtml, pre } from "../../telegram/format.js";
import {
  tmuxSessionsKeyboard,
  tmuxSessionActionsKeyboard,
  tmuxTerminalKeyboard,
  tmuxResizeKeyboard,
  confirmKeyboard,
} from "../../telegram/keyboards.js";

export class TmuxHandler {
  private tg: TelegramClient;
  private chatId: number;
  private tmuxSocket: string;
  private tmuxSocketDir: string;
  private telegramMaxChars: number;

  selectedSession: string | null = null;
  isTmuxThread = false;
  lastCaptureMsgId: number | null = null;

  constructor(
    tg: TelegramClient,
    chatId: number,
    tmuxSocket: string,
    tmuxSocketDir: string,
    telegramMaxChars: number,
  ) {
    this.tg = tg;
    this.chatId = chatId;
    this.tmuxSocket = tmuxSocket;
    this.tmuxSocketDir = tmuxSocketDir;
    this.telegramMaxChars = telegramMaxChars;
  }

  async handleTmuxTopicMessage(text: string): Promise<void> {
    if (!this.selectedSession) {
      await this.promptSelectTmuxSession();
      return;
    }

    const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, this.selectedSession);
    if (!exists) {
      this.selectedSession = null;
      await this.tg.sendMessage(this.chatId, "⚠️ Session no longer exists.", { parse_mode: "HTML" });
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

    if (this.lastCaptureMsgId) {
      try {
        await this.tg.deleteMessage(this.chatId, this.lastCaptureMsgId);
      } catch {
        // message already deleted or too old
      }
      this.lastCaptureMsgId = null;
    }

    try {
      const output = await tmux.capturePane(
        { socketPath: this.tmuxSocket },
        `${this.selectedSession}:0.0`,
      );
      const trimmed = output.trim();
      const display = trimmed || "(empty)";

      const maxLen = this.telegramMaxChars - 200;
      const truncated = display.length > maxLen ? `…${display.slice(-maxLen)}` : display;
      const html = `📟 <b>${escapeHtml(this.selectedSession)}</b>\n${pre(truncated)}`;
      const keyboard = tmuxTerminalKeyboard(this.selectedSession);

      const msg = await this.tg.sendMessage(this.chatId, html, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
      this.lastCaptureMsgId = msg.message_id;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.sendMessage(this.chatId, `❌ Capture failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  async promptSelectTmuxSession(): Promise<void> {
    const sessions = await tmux.listSessions({ socketPath: this.tmuxSocket });

    if (sessions.length === 0) {
      await this.tg.sendMessage(
        this.chatId,
        "No tmux sessions running.\n\nUse /new <name> to create one, or /tmux for interactive mode.",
        { reply_markup: { inline_keyboard: [[{ text: "➕ New Session", callback_data: "tmux:new" }]] } },
      );
      return;
    }

    await this.tg.sendMessage(
      this.chatId,
      "<b>Select a tmux session:</b>\n\nUse /select <name> or click below:",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: tmuxSessionsKeyboard(sessions.map((s) => s.name)) },
      },
    );
  }

  async showTmuxSessions(): Promise<void> {
    const sessions = await tmux.listSessions({ socketPath: this.tmuxSocket });
    if (sessions.length === 0) {
      await this.tg.sendMessage(
        this.chatId,
        "No tmux sessions running.\n\nUse /new <name> to create one.",
        { reply_markup: { inline_keyboard: [[{ text: "➕ New Session", callback_data: "tmux:new" }]] } },
      );
      return;
    }

    const lines = sessions.map(
      (s) => `• <b>${escapeHtml(s.name)}</b> — ${s.windows} window${s.windows > 1 ? "s" : ""}${s.attached ? " 🟢" : ""}`,
    );
    const selected = this.selectedSession ? `\n\n<i>Selected: ${escapeHtml(this.selectedSession)}</i>` : "";

    await this.tg.sendMessage(
      this.chatId,
      `<b>📟 tmux Sessions</b>\n\n${lines.join("\n")}${selected}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: tmuxSessionsKeyboard(sessions.map((s) => s.name)) },
      },
    );
  }

  async createTmuxSession(name: string): Promise<void> {
    const clean = name.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
    try {
      await tmux.newSession({ socketPath: this.tmuxSocket }, clean);
      this.selectedSession = clean;
      await this.tg.sendMessage(
        this.chatId,
        `✅ Session <b>${escapeHtml(clean)}</b> created and selected.\n\n<code>tmux -S ${escapeHtml(this.tmuxSocket)} attach -t ${escapeHtml(clean)}</code>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: tmuxSessionActionsKeyboard(clean) },
        },
      );
    } catch (e: unknown) {
      await this.tg.sendMessage(this.chatId, `Failed to create session: ${escapeHtml(String(e))}`);
    }
  }

  async captureSelectedPane(sessionOverride?: string): Promise<void> {
    const name = sessionOverride?.trim() || this.selectedSession;
    if (!name) {
      await this.tg.sendMessage(this.chatId, "No session selected. Use /select <name> or /tmux.");
      return;
    }

    try {
      const output = await tmux.capturePane({ socketPath: this.tmuxSocket }, `${name}:0.0`);
      const trimmed = output.trim();
      if (!trimmed) {
        await this.tg.sendMessage(this.chatId, "<i>(empty pane)</i>", { parse_mode: "HTML" });
        return;
      }

      if (trimmed.length > this.telegramMaxChars - 100) {
        const buf = new TextEncoder().encode(trimmed);
        await this.tg.sendDocument(this.chatId, buf, `capture-${name}.txt`, {
          caption: `📋 Capture from <b>${escapeHtml(name)}</b>`,
          parse_mode: "HTML",
        });
      } else {
        await this.tg.sendMessage(this.chatId, `📋 <b>${escapeHtml(name)}</b>\n${pre(trimmed)}`, {
          parse_mode: "HTML",
        });
      }
    } catch (e: unknown) {
      await this.tg.sendMessage(this.chatId, `Failed to capture: ${escapeHtml(String(e))}`);
    }
  }

  async sendKeysToSelected(text: string): Promise<void> {
    if (!this.selectedSession) {
      await this.tg.sendMessage(this.chatId, "No session selected. Use /select <name> or /tmux.");
      return;
    }
    if (!text.trim()) {
      await this.tg.sendMessage(this.chatId, "Usage: /send <text to type>");
      return;
    }

    const target = `${this.selectedSession}:0.0`;
    await tmux.sendKeys({ socketPath: this.tmuxSocket }, target, text, true);
    await tmux.sendEnter({ socketPath: this.tmuxSocket }, target);
    await this.tg.sendMessage(this.chatId, `⌨️ Sent to <b>${escapeHtml(this.selectedSession)}</b>`, {
      parse_mode: "HTML",
    });
  }

  async sendCtrlCToSelected(): Promise<void> {
    if (!this.selectedSession) {
      await this.tg.sendMessage(this.chatId, "No session selected.");
      return;
    }
    await tmux.sendCtrlC({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`);
    await this.tg.sendMessage(this.chatId, `🛑 Ctrl-C sent to <b>${escapeHtml(this.selectedSession)}</b>`, {
      parse_mode: "HTML",
    });
  }

  async killSelectedSession(nameOverride?: string): Promise<void> {
    const name = nameOverride?.trim() || this.selectedSession;
    if (!name) {
      await this.tg.sendMessage(this.chatId, "No session selected.");
      return;
    }
    await this.tg.sendMessage(this.chatId, `Kill session <b>${escapeHtml(name)}</b>?`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: confirmKeyboard("tmux-kill", name) },
    });
  }

  async resizeTmuxWindow(args: string): Promise<void> {
    if (!this.selectedSession) {
      await this.tg.sendMessage(this.chatId, "No session selected. Use /select <name> or /tmux.");
      return;
    }

    const parts = args.trim().split(/[x×\s]+/);
    if (parts.length === 2) {
      const cols = parseInt(parts[0], 10);
      const rows = parseInt(parts[1], 10);
      if (cols > 0 && rows > 0 && cols <= 300 && rows <= 300) {
        try {
          await tmux.resizeWindow({ socketPath: this.tmuxSocket }, this.selectedSession, cols, rows);
          await this.tg.sendMessage(
            this.chatId,
            `📐 Resized <b>${escapeHtml(this.selectedSession)}</b> to ${cols}×${rows}`,
            { parse_mode: "HTML" },
          );
          if (this.isTmuxThread) {
            await this.tmuxTerminalCapture();
          }
          return;
        } catch (e: unknown) {
          await this.tg.sendMessage(this.chatId, `❌ Resize failed: ${escapeHtml(String(e))}`, { parse_mode: "HTML" });
          return;
        }
      }
    }

    await this.tg.sendMessage(
      this.chatId,
      `<b>📐 Resize tmux window</b>\n\nUsage: <code>/resize 45x60</code>\n\nSelect a preset:`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: tmuxResizeKeyboard() },
      },
    );
  }

  async selectSession(name: string): Promise<void> {
    const clean = name.trim();
    if (!clean) {
      await this.tg.sendMessage(this.chatId, "Usage: /select <session-name>");
      return;
    }
    const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, clean);
    if (!exists) {
      await this.tg.sendMessage(this.chatId, `Session '${escapeHtml(clean)}' not found. Use /tmux to see available sessions.`);
      return;
    }
    this.selectedSession = clean;
    await this.tg.sendMessage(
      this.chatId,
      `✅ Selected: <b>${escapeHtml(clean)}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: tmuxSessionActionsKeyboard(clean) },
      },
    );
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
      await this.tg.sendMessage(
        this.chatId,
        `📟 Created and connected to <b>${escapeHtml(clean)}</b>\nSend text to type into the terminal.`,
        { parse_mode: "HTML" },
      );
      await this.tmuxTerminalCapture();
      return;
    }

    const keyboard = sessions.map((s) => [
      { text: `📟 ${s.name}${s.attached ? " 🟢" : ""}`, callback_data: `term:sel:${s.name}` },
    ]);
    keyboard.push([
      { text: "➕ New Session", callback_data: "term:new" },
      { text: "🔄 Refresh", callback_data: "term:pick" },
    ]);

    await this.tg.sendMessage(
      this.chatId,
      `<b>📟 Select a tmux session</b>\n\nAll messages in this thread will be sent as terminal input.`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } },
    );
  }

  async tmuxTerminalSend(text: string): Promise<void> {
    if (!this.selectedSession) {
      await this.tmuxTerminalPickSession();
      return;
    }

    const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, this.selectedSession);
    if (!exists) {
      this.selectedSession = null;
      await this.tg.sendMessage(this.chatId, `⚠️ Session no longer exists.`, { parse_mode: "HTML" });
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

      const maxLen = this.telegramMaxChars - 200;
      const truncated = display.length > maxLen ? `…${display.slice(-maxLen)}` : display;
      const html = `📟 <b>${escapeHtml(this.selectedSession)}</b>\n${pre(truncated)}`;
      const keyboard = tmuxTerminalKeyboard(this.selectedSession);

      if (this.lastCaptureMsgId) {
        try {
          await this.tg.editMessageText(this.chatId, this.lastCaptureMsgId, html, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch {
          // edit failed (message too old, etc) — send new
        }
      }

      const msg = await this.tg.sendMessage(this.chatId, html, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
      this.lastCaptureMsgId = msg.message_id;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.tg.sendMessage(this.chatId, `❌ Capture failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    }
  }

  async handleTmuxCallback(queryId: string, parts: string[]): Promise<void> {
    const action = parts[0];
    const target = parts.slice(1).join(":");

    switch (action) {
      case "sess":
        this.selectedSession = target;
        await this.tg.answerCallbackQuery(queryId, { text: `Selected: ${target}` });
        await this.tg.sendMessage(
          this.chatId,
          `📟 Selected: <b>${escapeHtml(target)}</b>`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: tmuxSessionActionsKeyboard(target) },
          },
        );
        break;

      case "list":
        await this.tg.answerCallbackQuery(queryId);
        await this.showTmuxSessions();
        break;

      case "new":
        await this.tg.answerCallbackQuery(queryId);
        await this.createTmuxSession(`session-${Date.now()}`);
        break;

      case "refresh":
        await this.tg.answerCallbackQuery(queryId, { text: "Refreshed" });
        await this.showTmuxSessions();
        break;

      case "capture":
        await this.tg.answerCallbackQuery(queryId);
        await this.captureSelectedPane(target);
        break;

      case "sendkeys":
        await this.tg.answerCallbackQuery(queryId, { text: "Use /send <text> to send keys" });
        break;

      case "ctrlc":
        this.selectedSession = target;
        await tmux.sendCtrlC({ socketPath: this.tmuxSocket }, `${target}:0.0`);
        await this.tg.answerCallbackQuery(queryId, { text: "Ctrl-C sent" });
        break;

      case "kill":
        await this.tg.answerCallbackQuery(queryId);
        await this.killSelectedSession(target);
        break;

      default:
        await this.tg.answerCallbackQuery(queryId, { text: "Unknown action" });
    }
  }

  async handleConfirmCallback(queryId: string, parts: string[]): Promise<void> {
    const [answer, action, ...rest] = parts;
    const data = rest.join(":");

    if (answer === "yes") {
      switch (action) {
        case "tmux-kill":
          try {
            await tmux.killSession({ socketPath: this.tmuxSocket }, data);
            if (this.selectedSession === data) this.selectedSession = null;
            await this.tg.answerCallbackQuery(queryId, { text: `Session ${data} killed.` });
            await this.showTmuxSessions();
          } catch (e: unknown) {
            await this.tg.answerCallbackQuery(queryId, { text: `Failed: ${String(e).slice(0, 80)}`, show_alert: true });
          }
          break;
        default:
          await this.tg.answerCallbackQuery(queryId, { text: "Unknown action" });
      }
    } else {
      await this.tg.answerCallbackQuery(queryId, { text: "Cancelled." });
    }
  }

  async handleTerminalCallback(queryId: string, parts: string[]): Promise<void> {
    const action = parts[0];

    switch (action) {
      case "refresh":
        await this.tg.answerCallbackQuery(queryId);
        await this.tmuxTerminalCapture();
        break;

      case "ctrlc":
        if (this.selectedSession) {
          await tmux.sendCtrlC({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`);
          await this.tg.answerCallbackQuery(queryId, { text: "Ctrl-C sent" });
          await new Promise((r) => setTimeout(r, 200));
          await this.tmuxTerminalCapture();
        } else {
          await this.tg.answerCallbackQuery(queryId, { text: "No session selected" });
        }
        break;

      case "enter":
        if (this.selectedSession) {
          await tmux.sendEnter({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`);
          await this.tg.answerCallbackQuery(queryId, { text: "Enter sent" });
          await new Promise((r) => setTimeout(r, 200));
          await this.tmuxTerminalCapture();
        } else {
          await this.tg.answerCallbackQuery(queryId, { text: "No session selected" });
        }
        break;

      case "up":
      case "down":
        if (this.selectedSession) {
          const key = action === "up" ? "Up" : "Down";
          await tmux.sendKeys({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`, key, false);
          await this.tg.answerCallbackQuery(queryId, { text: `${key} sent` });
          await new Promise((r) => setTimeout(r, 150));
          await this.tmuxTerminalCapture();
        } else {
          await this.tg.answerCallbackQuery(queryId, { text: "No session selected" });
        }
        break;

      case "tab":
        if (this.selectedSession) {
          await tmux.sendKeys({ socketPath: this.tmuxSocket }, `${this.selectedSession}:0.0`, "Tab", false);
          await this.tg.answerCallbackQuery(queryId, { text: "Tab sent" });
          await new Promise((r) => setTimeout(r, 200));
          await this.tmuxTerminalCapture();
        } else {
          await this.tg.answerCallbackQuery(queryId, { text: "No session selected" });
        }
        break;

      case "switch":
      case "pick":
        await this.tg.answerCallbackQuery(queryId);
        this.lastCaptureMsgId = null;
        await this.tmuxTerminalPickSession();
        break;

      case "sel": {
        const name = parts.slice(1).join(":");
        const exists = await tmux.hasSession({ socketPath: this.tmuxSocket }, name);
        if (!exists) {
          await this.tg.answerCallbackQuery(queryId, { text: "Session not found", show_alert: true });
          return;
        }
        this.selectedSession = name;
        this.lastCaptureMsgId = null;
        await this.tg.answerCallbackQuery(queryId, { text: `Connected: ${name}` });
        await this.tmuxTerminalCapture();
        break;
      }

      case "new": {
        const name = `session-${Date.now()}`.replace(/[^a-zA-Z0-9._-]/g, "-");
        await tmux.ensureSocketDir(this.tmuxSocketDir);
        await tmux.newSession({ socketPath: this.tmuxSocket }, name);
        this.selectedSession = name;
        this.lastCaptureMsgId = null;
        await this.tg.answerCallbackQuery(queryId, { text: `Created: ${name}` });
        await this.tmuxTerminalCapture();
        break;
      }

      case "resize":
        await this.tg.answerCallbackQuery(queryId);
        if (this.selectedSession) {
          const size = await tmux.getWindowSize({ socketPath: this.tmuxSocket }, this.selectedSession);
          await this.tg.sendMessage(
            this.chatId,
            `<b>📐 Resize</b> (current: ${size.cols}×${size.rows})\n\nOr use: <code>/resize 45x60</code>`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: tmuxResizeKeyboard() },
            },
          );
        } else {
          await this.tg.sendMessage(this.chatId, "No session selected.");
        }
        break;

      case "rz": {
        if (!this.selectedSession) {
          await this.tg.answerCallbackQuery(queryId, { text: "No session selected" });
          break;
        }
        const cols = parseInt(parts[1], 10);
        const rows = parseInt(parts[2], 10);
        if (cols > 0 && rows > 0) {
          try {
            await tmux.resizeWindow({ socketPath: this.tmuxSocket }, this.selectedSession, cols, rows);
            await this.tg.answerCallbackQuery(queryId, { text: `Resized to ${cols}×${rows}` });
            await this.tmuxTerminalCapture();
          } catch {
            await this.tg.answerCallbackQuery(queryId, { text: "Resize failed", show_alert: true });
          }
        }
        break;
      }

      default:
        await this.tg.answerCallbackQuery(queryId, { text: "Unknown action" });
    }
  }
}
