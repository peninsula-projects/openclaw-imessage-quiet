import type { DispatchRateLimiter, RateLimitResult } from "../types.js";

const DEFAULT_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 10_000;

type WindowCounter = {
  timestamps: number[];
};

class DefaultDispatchRateLimiter implements DispatchRateLimiter {
  private readonly perConversationLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private conversations = new Map<string, WindowCounter>();
  private globalCounter: WindowCounter = { timestamps: [] };
  private lastCleanup = 0;

  constructor(params: {
    perConversationLimit: number;
    globalLimit: number;
    windowMs?: number;
  }) {
    this.perConversationLimit = params.perConversationLimit;
    this.globalLimit = params.globalLimit;
    this.windowMs = params.windowMs ?? DEFAULT_WINDOW_MS;
  }

  tryDispatch(conversationKey: string): RateLimitResult {
    const now = Date.now();
    this.maybeCleanup(now);

    this.pruneWindow(this.globalCounter, now);
    if (this.globalCounter.timestamps.length >= this.globalLimit) {
      return { allowed: false, reason: "global" };
    }

    let counter = this.conversations.get(conversationKey);
    if (!counter) {
      counter = { timestamps: [] };
      this.conversations.set(conversationKey, counter);
    }
    this.pruneWindow(counter, now);
    if (counter.timestamps.length >= this.perConversationLimit) {
      return { allowed: false, reason: "per-conversation" };
    }

    counter.timestamps.push(now);
    this.globalCounter.timestamps.push(now);

    return { allowed: true };
  }

  reset(): void {
    this.conversations.clear();
    this.globalCounter = { timestamps: [] };
  }

  private pruneWindow(counter: WindowCounter, now: number): void {
    const cutoff = now - this.windowMs;
    while (counter.timestamps.length > 0 && counter.timestamps[0]! < cutoff) {
      counter.timestamps.shift();
    }
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;

    for (const [key, counter] of this.conversations) {
      this.pruneWindow(counter, now);
      if (counter.timestamps.length === 0) {
        this.conversations.delete(key);
      }
    }
    this.pruneWindow(this.globalCounter, now);
  }
}

export function createDispatchRateLimiter(params: {
  perConversationLimit: number;
  globalLimit: number;
  windowMs?: number;
}): DispatchRateLimiter {
  return new DefaultDispatchRateLimiter(params);
}
