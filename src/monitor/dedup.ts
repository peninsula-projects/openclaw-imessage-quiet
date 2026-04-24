import type { MessageDedup } from "../types.js";

const SEEN_TTL_MS = 30_000;
const MAX_SEEN_ENTRIES = 512;

class DefaultMessageDedup implements MessageDedup {
  private seen = new Map<string, number>();

  isDuplicate(messageId: string, isFromMe: boolean): boolean {
    const key = `${messageId}:${isFromMe ? 1 : 0}`;
    const now = Date.now();

    if (this.seen.has(key)) {
      return true;
    }

    this.seen.set(key, now);

    if (this.seen.size > MAX_SEEN_ENTRIES) {
      for (const [k, ts] of this.seen) {
        if (now - ts > SEEN_TTL_MS) {
          this.seen.delete(k);
        }
      }
      // Hard cap: if cleanup didn't reduce size enough, evict oldest entries
      while (this.seen.size > MAX_SEEN_ENTRIES) {
        const oldest = this.seen.keys().next().value;
        if (typeof oldest === "string") this.seen.delete(oldest);
        else break;
      }
    }

    return false;
  }
}

export function createMessageDedup(): MessageDedup {
  return new DefaultMessageDedup();
}
