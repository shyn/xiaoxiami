/**
 * Inline keyboard builders for Telegram UI.
 */

import type { InlineKeyboardButton } from "./client.js";

export type InlineKeyboard = InlineKeyboardButton[][];

export function tmuxSessionsKeyboard(sessions: string[]): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < sessions.length; i += 2) {
    const row: InlineKeyboardButton[] = [
      { text: `📟 ${sessions[i]}`, callback_data: `tmux:sess:${sessions[i]}` },
    ];
    if (sessions[i + 1]) {
      row.push({ text: `📟 ${sessions[i + 1]}`, callback_data: `tmux:sess:${sessions[i + 1]}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: "➕ New Session", callback_data: "tmux:new" },
    { text: "🔄 Refresh", callback_data: "tmux:refresh" },
  ]);
  return rows;
}

export function tmuxSessionActionsKeyboard(sessionName: string): InlineKeyboard {
  return [
    [
      { text: "📋 Capture", callback_data: `tmux:capture:${sessionName}` },
      { text: "⌨️ Send Keys", callback_data: `tmux:sendkeys:${sessionName}` },
    ],
    [
      { text: "🛑 Ctrl-C", callback_data: `tmux:ctrlc:${sessionName}` },
      { text: "❌ Kill", callback_data: `tmux:kill:${sessionName}` },
    ],
    [
      { text: "◀️ Back to sessions", callback_data: "tmux:list" },
    ],
  ];
}

export function tmuxTerminalKeyboard(sessionName: string): InlineKeyboard {
  return [
    [
      { text: "🔄 Refresh", callback_data: `term:refresh` },
      { text: "🛑 Ctrl-C", callback_data: `term:ctrlc` },
      { text: "⏎ Enter", callback_data: `term:enter` },
    ],
    [
      { text: "📟 Switch", callback_data: `term:switch` },
      { text: "⬆️ Up", callback_data: `term:up` },
      { text: "⬇️ Down", callback_data: `term:down` },
      { text: "⇥ Tab", callback_data: `term:tab` },
    ],
    [
      { text: "📐 Resize", callback_data: `term:resize` },
    ],
  ];
}

export function tmuxResizeKeyboard(): InlineKeyboard {
  return [
    [
      { text: "📱 Mobile (45×60)", callback_data: "term:rz:45:60" },
      { text: "📱 Narrow (35×80)", callback_data: "term:rz:35:80" },
    ],
    [
      { text: "🖥 Standard (80×24)", callback_data: "term:rz:80:24" },
      { text: "🖥 Wide (120×40)", callback_data: "term:rz:120:40" },
    ],
    [
      { text: "◀️ Back", callback_data: "term:refresh" },
    ],
  ];
}

export function confirmKeyboard(action: string, data: string): InlineKeyboard {
  return [
    [
      { text: "✅ Yes", callback_data: `confirm:yes:${action}:${data}` },
      { text: "❌ No", callback_data: `confirm:no:${action}:${data}` },
    ],
  ];
}

export function agentActionsKeyboard(): InlineKeyboard {
  return [
    [
      { text: "⏹ Abort", callback_data: "agent:abort" },
    ],
  ];
}

export function modelsKeyboard(
  models: Array<{ key: string; label: string }>,
  currentKey: string,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < models.length; i += 2) {
    const row: InlineKeyboardButton[] = [];
    for (let j = i; j < Math.min(i + 2, models.length); j++) {
      const m = models[j];
      const isCurrent = m.key === currentKey;
      row.push({
        text: isCurrent ? `✅ ${m.label}` : m.label,
        callback_data: `model:pick:${m.key}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "❌ Cancel", callback_data: "model:cancel" }]);
  return rows;
}

export function thinkingKeyboard(
  currentLevel: string,
): InlineKeyboard {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const rows: InlineKeyboard = [];
  for (let i = 0; i < levels.length; i += 3) {
    const row: InlineKeyboardButton[] = [];
    for (let j = i; j < Math.min(i + 3, levels.length); j++) {
      const level = levels[j];
      const isCurrent = level === currentLevel;
      row.push({
        text: isCurrent ? `✅ ${level}` : level,
        callback_data: `think:pick:${level}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "❌ Cancel", callback_data: "think:cancel" }]);
  return rows;
}

export function agentSessionsKeyboard(sessions: Array<{ id: string; label: string }>, hasMore: boolean): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (const s of sessions) {
    rows.push([{ text: s.label, callback_data: `sess:switch:${s.id}` }]);
  }
  const bottomRow: InlineKeyboardButton[] = [
    { text: "➕ New Session", callback_data: "sess:new" },
  ];
  if (hasMore) {
    bottomRow.push({ text: "📄 More", callback_data: "sess:more" });
  }
  bottomRow.push({ text: "🔄 Refresh", callback_data: "sess:refresh" });
  rows.push(bottomRow);
  return rows;
}
