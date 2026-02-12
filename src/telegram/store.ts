/**
 * Append-only JSONL store for persisting raw Telegram updates.
 * Stores one file per chat/thread per day: {baseDir}/{chatId}_{threadId}/{date}.jsonl
 * Supports disabling via config and automatic daily rotation.
 */

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import type { TgUpdate } from "./client.js";

export interface MessageStoreOptions {
  enabled?: boolean;
  maxAgeDays?: number;
}

export class TelegramMessageStore {
  private baseDir: string;
  private ensuredDirs = new Set<string>();
  private enabled: boolean;
  private maxAgeDays: number;
  private lastCleanup = 0;

  constructor(baseDir: string, options?: MessageStoreOptions) {
    this.baseDir = baseDir;
    this.enabled = options?.enabled !== false;
    this.maxAgeDays = options?.maxAgeDays ?? 30;
  }

  private dirFor(chatId: number, threadId?: number): string {
    const suffix = threadId ? `${chatId}_${threadId}` : `${chatId}`;
    return `${this.baseDir}/${suffix}`;
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }

  private todayFileName(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`;
  }

  async append(chatId: number, threadId: number | undefined, update: TgUpdate): Promise<void> {
    if (!this.enabled) return;

    const dir = this.dirFor(chatId, threadId);
    await this.ensureDir(dir);
    const record = { ts: new Date().toISOString(), update };
    await appendFile(`${dir}/${this.todayFileName()}`, JSON.stringify(record) + "\n", "utf-8");

    this.maybeCleanup(dir);
  }

  private maybeCleanup(dir: string): void {
    const now = Date.now();
    if (now - this.lastCleanup < 3600_000) return;
    this.lastCleanup = now;
    this.cleanupOldFiles(dir).catch((e) => console.error("Store cleanup error:", e));
  }

  private async cleanupOldFiles(dir: string): Promise<void> {
    if (this.maxAgeDays <= 0) return;

    try {
      const files = await readdir(dir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.maxAgeDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const dateStr = file.replace(".jsonl", "");
        if (dateStr < cutoffStr) {
          await unlink(`${dir}/${file}`);
          console.log(`[store] Cleaned up old log: ${dir}/${file}`);
        }
      }
    } catch {
      // directory may not exist yet
    }
  }
}
