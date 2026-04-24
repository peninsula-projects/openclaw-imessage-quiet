import { describe, it, expect, vi } from "vitest";
import { createDispatchRateLimiter } from "../src/monitor/rate-limiter.js";

describe("DispatchRateLimiter", () => {
  it("allows first N dispatches per conversation", () => {
    const limiter = createDispatchRateLimiter({
      perConversationLimit: 5,
      globalLimit: 20,
    });
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryDispatch("conv-1")).toEqual({ allowed: true });
    }
  });

  it("blocks after per-conversation limit reached", () => {
    const limiter = createDispatchRateLimiter({
      perConversationLimit: 5,
      globalLimit: 20,
    });
    for (let i = 0; i < 5; i++) {
      limiter.tryDispatch("conv-1");
    }
    expect(limiter.tryDispatch("conv-1")).toEqual({
      allowed: false,
      reason: "per-conversation",
    });
  });

  it("allows different conversations independently", () => {
    const limiter = createDispatchRateLimiter({
      perConversationLimit: 5,
      globalLimit: 20,
    });
    for (let i = 0; i < 5; i++) {
      limiter.tryDispatch("conv-1");
    }
    expect(limiter.tryDispatch("conv-2")).toEqual({ allowed: true });
  });

  it("blocks after global limit reached", () => {
    const limiter = createDispatchRateLimiter({
      perConversationLimit: 100,
      globalLimit: 20,
    });
    for (let i = 0; i < 20; i++) {
      limiter.tryDispatch(`conv-${i}`);
    }
    expect(limiter.tryDispatch("conv-new")).toEqual({
      allowed: false,
      reason: "global",
    });
  });

  it("resets counters after window expires", () => {
    vi.useFakeTimers();
    try {
      const limiter = createDispatchRateLimiter({
        perConversationLimit: 5,
        globalLimit: 20,
        windowMs: 60_000,
      });
      for (let i = 0; i < 5; i++) {
        limiter.tryDispatch("conv-1");
      }
      expect(limiter.tryDispatch("conv-1").allowed).toBe(false);

      vi.advanceTimersByTime(61_000);
      expect(limiter.tryDispatch("conv-1")).toEqual({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears all state on reset()", () => {
    const limiter = createDispatchRateLimiter({
      perConversationLimit: 5,
      globalLimit: 20,
    });
    for (let i = 0; i < 5; i++) {
      limiter.tryDispatch("conv-1");
    }
    expect(limiter.tryDispatch("conv-1").allowed).toBe(false);

    limiter.reset();
    expect(limiter.tryDispatch("conv-1")).toEqual({ allowed: true });
  });
});
