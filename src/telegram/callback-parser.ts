/**
 * Strict callback_data parser for Telegram inline keyboard callbacks.
 * Validates prefixes and rejects unknown or malformed data.
 */

const VALID_PREFIXES = new Set([
  "tmux", "confirm", "sess", "term", "model", "think", "agent",
]);

export interface ParsedCallback {
  prefix: string;
  parts: string[];
}

export function parseCallbackData(data: string): ParsedCallback | null {
  if (!data || typeof data !== "string" || data.length > 256) {
    return null;
  }

  const parts = data.split(":");
  const prefix = parts[0];

  if (!prefix || !VALID_PREFIXES.has(prefix)) {
    return null;
  }

  return { prefix, parts: parts.slice(1) };
}
