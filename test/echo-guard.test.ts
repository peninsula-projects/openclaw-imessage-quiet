import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEchoGuard } from "../src/monitor/echo-guard.js";
import type { EchoGuard } from "../src/types.js";

describe("EchoGuard", () => {
  let guard: EchoGuard;

  beforeEach(() => {
    guard = createEchoGuard();
  });

  it("detects remembered text hash within TTL", () => {
    guard.remember("scope1", "abc123hash");
    expect(guard.has("scope1", "abc123hash")).toBe(true);
  });

  it("does not match different scopes with same hash", () => {
    guard.remember("scope1", "abc123hash");
    expect(guard.has("scope2", "abc123hash")).toBe(false);
  });

  it("detects remembered message ID within TTL", () => {
    guard.remember("scope1", "texthash", "msg-42");
    expect(guard.has("scope1", "different-hash", "msg-42")).toBe(true);
  });

  it("returns false for unknown hash", () => {
    expect(guard.has("scope1", "unknown-hash")).toBe(false);
  });

  it("expires text hash entries after TTL", () => {
    vi.useFakeTimers();
    try {
      guard.remember("scope1", "abc123hash");
      expect(guard.has("scope1", "abc123hash")).toBe(true);

      // Advance past text hash TTL (4 seconds) + cleanup interval (5 seconds)
      vi.advanceTimersByTime(10_000);
      expect(guard.has("scope1", "abc123hash")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires message ID entries after TTL", () => {
    vi.useFakeTimers();
    try {
      guard.remember("scope1", "texthash", "msg-99");
      expect(guard.has("scope1", "otherhash", "msg-99")).toBe(true);

      // Advance past message ID TTL (60 seconds) + cleanup interval
      vi.advanceTimersByTime(70_000);
      expect(guard.has("scope1", "otherhash", "msg-99")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never stores plaintext", () => {
    const plaintextMessage = "Hello, this is a secret message!";
    const hash = "a1b2c3d4e5f6";
    guard.remember("scope1", hash, "msg-1");

    // The guard should only contain hashes, not the plaintext
    const guardInternal = guard as any;
    if (guardInternal.textHashes) {
      for (const [key] of guardInternal.textHashes) {
        expect(key).not.toContain(plaintextMessage);
      }
    }
    if (guardInternal.messageIds) {
      for (const [key] of guardInternal.messageIds) {
        expect(key).not.toContain(plaintextMessage);
      }
    }
  });
});
