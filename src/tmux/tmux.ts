/**
 * Low-level tmux command runner.
 * All tmux operations go through this module.
 */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface TmuxOptions {
  socketPath: string;
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

function validateName(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid tmux name: ${name}`);
  }
  return name;
}

async function tmuxExec(socketPath: string, args: string[]): Promise<string> {
  const { stdout } = await exec("tmux", ["-S", socketPath, ...args]);
  return stdout;
}

export async function ensureSocketDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function listSessions(opts: TmuxOptions): Promise<TmuxSession[]> {
  try {
    const result = await tmuxExec(opts.socketPath, [
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}",
    ]);
    return result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [name, windows, attached, created] = line.split("\t");
        return {
          name,
          windows: Number(windows),
          attached: attached === "1",
          created: created ?? "",
        };
      });
  } catch {
    return [];
  }
}

export async function newSession(
  opts: TmuxOptions,
  name: string,
  command?: string,
): Promise<void> {
  validateName(name);
  const args = ["new", "-d", "-s", name, "-n", "shell"];
  if (command) args.push(command);
  await tmuxExec(opts.socketPath, args);
}

export async function killSession(opts: TmuxOptions, name: string): Promise<void> {
  validateName(name);
  await tmuxExec(opts.socketPath, ["kill-session", "-t", name]);
}

export async function sendKeys(
  opts: TmuxOptions,
  target: string,
  keys: string,
  literal = true,
): Promise<void> {
  const args = ["send-keys", "-t", target];
  if (literal) args.push("-l");
  args.push("--", keys);
  await tmuxExec(opts.socketPath, args);
}

export async function sendEnter(opts: TmuxOptions, target: string): Promise<void> {
  await tmuxExec(opts.socketPath, ["send-keys", "-t", target, "Enter"]);
}

export async function sendCtrlC(opts: TmuxOptions, target: string): Promise<void> {
  await tmuxExec(opts.socketPath, ["send-keys", "-t", target, "C-c"]);
}

export async function capturePane(
  opts: TmuxOptions,
  target: string,
  lines = 200,
): Promise<string> {
  return await tmuxExec(opts.socketPath, [
    "capture-pane", "-p", "-J", "-t", target, "-S", `-${lines}`,
  ]);
}

export async function listWindows(
  opts: TmuxOptions,
  session: string,
): Promise<Array<{ index: number; name: string; active: boolean }>> {
  validateName(session);
  try {
    const result = await tmuxExec(opts.socketPath, [
      "list-windows", "-t", session, "-F", "#{window_index}\t#{window_name}\t#{window_active}",
    ]);
    return result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [index, name, active] = line.split("\t");
        return { index: Number(index), name, active: active === "1" };
      });
  } catch {
    return [];
  }
}

export async function hasSession(opts: TmuxOptions, name: string): Promise<boolean> {
  try {
    validateName(name);
    await tmuxExec(opts.socketPath, ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function resizeWindow(
  opts: TmuxOptions,
  target: string,
  cols: number,
  rows: number,
): Promise<void> {
  await tmuxExec(opts.socketPath, [
    "resize-window", "-t", target, "-x", String(cols), "-y", String(rows),
  ]);
}

export async function getWindowSize(
  opts: TmuxOptions,
  target: string,
): Promise<{ cols: number; rows: number }> {
  const result = await tmuxExec(opts.socketPath, [
    "display-message", "-t", target, "-p", "#{window_width}\t#{window_height}",
  ]);
  const [cols, rows] = result.trim().split("\t").map(Number);
  return { cols, rows };
}
