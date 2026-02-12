/**
 * Persistent permission store for per-conversation tool permissions.
 *
 * Each conversation (chat + thread) has its own permission configuration
 * stored as a JSON file. Config is hot-reloaded on file changes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, renameSync, readdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { PermissionConfig, PermissionMode } from "./bot/permissions.js";

const DEFAULT_PERMISSION_CONFIG: Required<PermissionConfig> = {
  defaultMode: "default",
  allow: [],
  ask: [],
  deny: [],
};

export class PermissionStore {
  private baseDir: string;
  private configs = new Map<string, PermissionConfig>();
  private watchers = new Map<string, ReturnType<typeof watch>>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.ensureDir();
    this.loadAll();
    this.watchDir();
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (e) {
      console.error(`Failed to create permissions directory ${this.baseDir}:`, e);
    }
  }

  private getFilePath(conversationKey: string): string {
    // Sanitize the key to be a valid filename
    const safeKey = conversationKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.baseDir, `${safeKey}.json`);
  }

  private loadAll(): void {
    try {
      if (!existsSync(this.baseDir)) return;
      const files = readdirSync(this.baseDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const key = file.replace(/\.json$/, "");
        this.load(key);
      }
    } catch (e) {
      console.error(`Failed to load permission configs from ${this.baseDir}:`, e);
    }
  }

  private load(conversationKey: string): PermissionConfig {
    const filePath = this.getFilePath(conversationKey);
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const config: PermissionConfig = {
          defaultMode: parsed.defaultMode ?? DEFAULT_PERMISSION_CONFIG.defaultMode,
          allow: parsed.allow ?? [],
          ask: parsed.ask ?? [],
          deny: parsed.deny ?? [],
        };
        this.configs.set(conversationKey, config);
        return config;
      }
    } catch (e) {
      console.error(`Failed to load permission config ${filePath}:`, e);
    }
    // Return default if file doesn't exist or is invalid
    const defaultConfig = { ...DEFAULT_PERMISSION_CONFIG };
    this.configs.set(conversationKey, defaultConfig);
    return defaultConfig;
  }

  private save(conversationKey: string): void {
    const config = this.configs.get(conversationKey);
    if (!config) return;

    const filePath = this.getFilePath(conversationKey);
    try {
      this.ensureDir();
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`Failed to save permission config ${filePath}:`, e);
    }
  }

  private watchDir(): void {
    try {
      this.ensureDir();
      const watcher = watch(this.baseDir, { persistent: false }, (_event, filename) => {
        if (!filename || !filename.endsWith(".json")) return;
        const key = filename.replace(/\.json$/, "");
        // Reload from disk if file changed externally
        setTimeout(() => {
          console.log(`Permission config reloaded: ${key}`);
          this.load(key);
        }, 100);
      });
      this.watcher = watcher;
    } catch (e) {
      console.error(`Failed to watch permissions directory ${this.baseDir}:`, e);
    }
  }

  private watcher?: ReturnType<typeof watch>;

  /**
   * Get permission config for a conversation.
   * Returns a copy that can be modified and passed back to setConfig.
   */
  getConfig(conversationKey: string): PermissionConfig {
    const config = this.configs.get(conversationKey);
    if (config) {
      return { ...config };
    }
    return { ...DEFAULT_PERMISSION_CONFIG };
  }

  /**
   * Set permission config for a conversation.
   * Automatically saves to disk.
   */
  setConfig(conversationKey: string, config: PermissionConfig): void {
    this.configs.set(conversationKey, { ...config });
    this.save(conversationKey);
  }

  /**
   * Reset permissions to defaults for a conversation.
   */
  reset(conversationKey: string): void {
    const defaultConfig = { ...DEFAULT_PERMISSION_CONFIG };
    this.configs.set(conversationKey, defaultConfig);
    this.save(conversationKey);
  }

  /**
   * List all conversations with custom permission configs.
   */
  listConversations(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Clean up watchers.
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}
