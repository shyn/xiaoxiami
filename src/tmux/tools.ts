/**
 * Pi agent SDK tools for tmux operations.
 * These tools are registered with the agent session so the AI can control tmux.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import * as tmux from "./tmux.js";
import type { TmuxOptions } from "./tmux.js";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

interface NewSessionParams { name: string; command?: string }
interface KillSessionParams { name: string }
interface SendKeysParams { session: string; keys: string; enter?: boolean; literal?: boolean; pane?: string }
interface CapturePaneParams { session: string; lines?: number; pane?: string }
interface ListWindowsParams { session: string }
interface CtrlCParams { session: string; pane?: string }

export function createTmuxTools(opts: TmuxOptions): ToolDefinition[] {
  return [
    {
      name: "tmux_list_sessions",
      label: "tmux: List Sessions",
      description: "List all tmux sessions on the agent socket.",
      parameters: Type.Object({}),
      execute: async () => {
        const sessions = await tmux.listSessions(opts);
        if (sessions.length === 0) return text("No tmux sessions running.");
        const lines = sessions.map(
          (s) => `${s.name} (${s.windows} window${s.windows > 1 ? "s" : ""}${s.attached ? ", attached" : ""})`,
        );
        return text(lines.join("\n"));
      },
    },
    {
      name: "tmux_new_session",
      label: "tmux: New Session",
      description: "Create a new tmux session. Optionally start a command in it.",
      parameters: Type.Object({
        name: Type.String({ description: "Session name (alphanumeric, dots, hyphens, underscores)" }),
        command: Type.Optional(Type.String({ description: "Command to run in the new session" })),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as NewSessionParams;
        await tmux.newSession(opts, params.name, params.command);
        return text(`Session '${params.name}' created.`);
      },
    },
    {
      name: "tmux_kill_session",
      label: "tmux: Kill Session",
      description: "Kill a tmux session by name.",
      parameters: Type.Object({
        name: Type.String({ description: "Session name to kill" }),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as KillSessionParams;
        await tmux.killSession(opts, params.name);
        return text(`Session '${params.name}' killed.`);
      },
    },
    {
      name: "tmux_send_keys",
      label: "tmux: Send Keys",
      description:
        "Send keystrokes to a tmux pane. Use for typing commands, sending text, or control sequences. Set 'enter' to true to press Enter after. For control keys like Ctrl-C, set literal to false and send 'C-c'.",
      parameters: Type.Object({
        session: Type.String({ description: "Session name" }),
        keys: Type.String({ description: "Keys to send" }),
        enter: Type.Optional(Type.Boolean({ description: "Press Enter after sending keys (default: true)" })),
        literal: Type.Optional(Type.Boolean({ description: "Send as literal text (default: true). Set false for control keys like C-c, C-d, Escape." })),
        pane: Type.Optional(Type.String({ description: "Pane target, e.g. '0.0' (default: 0.0)" })),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as SendKeysParams;
        const target = `${params.session}:${params.pane ?? "0.0"}`;
        const literal = params.literal !== false;
        await tmux.sendKeys(opts, target, params.keys, literal);
        if (params.enter !== false) {
          await tmux.sendEnter(opts, target);
        }
        return text(`Keys sent to ${target}.`);
      },
    },
    {
      name: "tmux_capture_pane",
      label: "tmux: Capture Pane",
      description:
        "Capture the current text content of a tmux pane. Returns the last N lines of output.",
      parameters: Type.Object({
        session: Type.String({ description: "Session name" }),
        lines: Type.Optional(Type.Number({ description: "Number of history lines to capture (default: 200)" })),
        pane: Type.Optional(Type.String({ description: "Pane target, e.g. '0.0' (default: 0.0)" })),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as CapturePaneParams;
        const target = `${params.session}:${params.pane ?? "0.0"}`;
        const output = await tmux.capturePane(opts, target, params.lines ?? 200);
        return text(output || "(empty pane)");
      },
    },
    {
      name: "tmux_list_windows",
      label: "tmux: List Windows",
      description: "List windows in a tmux session.",
      parameters: Type.Object({
        session: Type.String({ description: "Session name" }),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as ListWindowsParams;
        const windows = await tmux.listWindows(opts, params.session);
        if (windows.length === 0) return text("No windows found.");
        const lines = windows.map(
          (w) => `${w.index}: ${w.name}${w.active ? " (active)" : ""}`,
        );
        return text(lines.join("\n"));
      },
    },
    {
      name: "tmux_send_ctrl_c",
      label: "tmux: Send Ctrl-C",
      description: "Send Ctrl-C (interrupt) to a tmux pane.",
      parameters: Type.Object({
        session: Type.String({ description: "Session name" }),
        pane: Type.Optional(Type.String({ description: "Pane target (default: 0.0)" })),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as CtrlCParams;
        const target = `${params.session}:${params.pane ?? "0.0"}`;
        await tmux.sendCtrlC(opts, target);
        return text(`Ctrl-C sent to ${target}.`);
      },
    },
  ];
}
