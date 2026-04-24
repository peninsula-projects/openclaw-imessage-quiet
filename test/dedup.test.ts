import { describe, it, expect, vi } from "vitest";
import { createMessageDedup } from "../src/monitor/dedup.js";

describe("MessageDedup", () => {
  it("returns false for first call", () => {
    const dedup = createMessageDedup();
    expect(dedup.isDuplicate("msg-1", false)).toBe(false);
  });

  it("returns true for second call with same ID and isFromMe", () => {
    const dedup = createMessageDedup();
    dedup.isDuplicate("msg-1", false);
    expect(dedup.isDuplicate("msg-1", false)).toBe(true);
  });

  it("treats same ID with different isFromMe as distinct", () => {
    const dedup = createMessageDedup();
    dedup.isDuplicate("msg-1", false);
    expect(dedup.isDuplicate("msg-1", true)).toBe(false);
  });

  it("handles multiple distinct message IDs", () => {
    const dedup = createMessageDedup();
    expect(dedup.isDuplicate("msg-1", false)).toBe(false);
    expect(dedup.isDuplicate("msg-2", false)).toBe(false);
    expect(dedup.isDuplicate("msg-3", false)).toBe(false);
    expect(dedup.isDuplicate("msg-1", false)).toBe(true);
    expect(dedup.isDuplicate("msg-2", false)).toBe(true);
  });

  it("cleans up entries on overflow", () => {
    vi.useFakeTimers();
    try {
      const dedup = createMessageDedup();
      // Add entries up to the max
      for (let i = 0; i < 520; i++) {
        dedup.isDuplicate(`msg-${i}`, false);
      }
      // Advance time past TTL
      vi.advanceTimersByTime(35_000);
      // Trigger cleanup by adding another entry
      dedup.isDuplicate("msg-new", false);
      // Old entries should have been cleaned up
      expect(dedup.isDuplicate("msg-0", false)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
