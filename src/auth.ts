/**
 * Persistent auth store with owner pairing and allowed users list.
 *
 * On first /start, the sender becomes the owner. The owner can then
 * add/remove allowed users. Config is stored as JSON and hot-reloaded
 * on every check so edits to the file take effect immediately.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, renameSync } from "node:fs";
import { dirname, basename } from "node:path";

export interface AuthData {
  ownerId: number | null;
  ownerUsername: string | null;
  allowedUserIds: number[];
  pairedAt: string | null;
}

const DEFAULT_AUTH: AuthData = {
  ownerId: null,
  ownerUsername: null,
  allowedUserIds: [],
  pairedAt: null,
};

export class AuthStore {
  private filePath: string;
  private data: AuthData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
    this.watchFile();
  }

  private load(): AuthData {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        return { ...DEFAULT_AUTH, ...JSON.parse(raw) };
      }
    } catch (e) {
      console.error(`Failed to load auth file ${this.filePath}:`, e);
    }
    return { ...DEFAULT_AUTH };
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch (e) {
      console.error(`Failed to save auth file ${this.filePath}:`, e);
    }
  }

  private watchFile(): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const fileName = basename(this.filePath);
      watch(dir, { persistent: false }, (_event, changedFile) => {
        if (changedFile === fileName) {
          this.data = this.load();
          console.log("Auth config reloaded");
        }
      });
    } catch (e) {
      console.error(`Failed to watch auth directory:`, e);
    }
  }

  /** Reload from disk (called manually or by file watcher) */
  reload(): void {
    this.data = this.load();
  }

  /** Whether any owner has been paired yet */
  isPaired(): boolean {
    return this.data.ownerId !== null;
  }

  /** Pair the first user as owner. Returns false if already paired. */
  pair(userId: number, username?: string): boolean {
    if (this.data.ownerId !== null) return false;
    this.data.ownerId = userId;
    this.data.ownerUsername = username ?? null;
    this.data.allowedUserIds = [userId];
    this.data.pairedAt = new Date().toISOString();
    this.save();
    console.log(`Owner paired: ${userId} (@${username ?? "unknown"})`);
    return true;
  }

  /** Check if a user is the owner */
  isOwner(userId: number): boolean {
    return this.data.ownerId === userId;
  }

  /** Check if a user is authorized (owner or in allowed list) */
  isAuthorized(userId: number): boolean {
    if (!this.isPaired()) return false;
    if (this.data.ownerId === userId) return true;
    return this.data.allowedUserIds.includes(userId);
  }

  /** Add an allowed user (owner only). Returns false if already allowed. */
  addUser(userId: number): boolean {
    if (this.data.allowedUserIds.includes(userId)) return false;
    this.data.allowedUserIds.push(userId);
    this.save();
    return true;
  }

  /** Remove an allowed user (owner only). Cannot remove the owner. */
  removeUser(userId: number): boolean {
    if (userId === this.data.ownerId) return false;
    const idx = this.data.allowedUserIds.indexOf(userId);
    if (idx === -1) return false;
    this.data.allowedUserIds.splice(idx, 1);
    this.save();
    return true;
  }

  /** Get a copy of the current auth data */
  getData(): Readonly<AuthData> {
    return { ...this.data };
  }

  /** Reset ownership (dangerous — mainly for testing) */
  reset(): void {
    this.data = { ...DEFAULT_AUTH };
    this.save();
  }
}
