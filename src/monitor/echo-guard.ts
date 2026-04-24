import type { EchoGuard } from "../types.js";

const TEXT_HASH_TTL_MS = 4_000;
const MESSAGE_ID_TTL_MS = 60_000;
const MAX_ENTRIES = 1024;
const CLEANUP_INTERVAL_MS = 5_000;

type CacheEntry = {
  timestamp: number;
};

class DefaultEchoGuard implements EchoGuard {
  private textHashes = new Map<string, CacheEntry>();
  private messageIds = new Map<string, CacheEntry>();
  private lastCleanup = 0;

  remember(scope: string, textHash: string, messageId?: string): void {
    const now = Date.now();
    if (textHash) {
      this.textHashes.set(`${scope}:${textHash}`, { timestamp: now });
    }
    if (messageId) {
      this.messageIds.set(`${scope}:${messageId}`, { timestamp: now });
    }
    this.maybeCleanup(now);
  }

  has(scope: string, textHash: string, messageId?: string): boolean {
    const now = Date.now();
    this.maybeCleanup(now);

    if (messageId) {
      const entry = this.messageIds.get(`${scope}:${messageId}`);
      if (entry && now - entry.timestamp <= MESSAGE_ID_TTL_MS) {
        return true;
      }
    }

    if (textHash) {
      const entry = this.textHashes.get(`${scope}:${textHash}`);
      if (entry && now - entry.timestamp <= TEXT_HASH_TTL_MS) {
        return true;
      }
    }

    return false;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;

    for (const [key, entry] of this.textHashes) {
      if (now - entry.timestamp > TEXT_HASH_TTL_MS) {
        this.textHashes.delete(key);
      }
    }
    for (const [key, entry] of this.messageIds) {
      if (now - entry.timestamp > MESSAGE_ID_TTL_MS) {
        this.messageIds.delete(key);
      }
    }

    while (this.textHashes.size > MAX_ENTRIES) {
      const oldest = this.textHashes.keys().next().value;
      if (typeof oldest === "string") this.textHashes.delete(oldest);
      else break;
    }
    while (this.messageIds.size > MAX_ENTRIES) {
      const oldest = this.messageIds.keys().next().value;
      if (typeof oldest === "string") this.messageIds.delete(oldest);
      else break;
    }
  }
}

export function createEchoGuard(): EchoGuard {
  return new DefaultEchoGuard();
}
