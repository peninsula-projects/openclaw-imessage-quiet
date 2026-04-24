import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { resolveInboundDecision } from "../src/monitor/inbound.js";
import { createEchoGuard } from "../src/monitor/echo-guard.js";
import { createMessageDedup } from "../src/monitor/dedup.js";
import type {
  IMessagePayload,
  MonitorContext,
  EchoGuard,
  MessageDedup,
} from "../src/types.js";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeMonitorCtx(overrides: Partial<MonitorContext> = {}): MonitorContext {
  return {
    startupTime: Date.now() - 60_000,
    accountId: "default",
    cliPath: "imsg",
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["+15551234567"],
    groupAllowFrom: ["chat_id:42"],
    mentionPatterns: ["@millbot"],
    maxInboundLength: 8000,
    rateLimitPerConversation: 5,
    rateLimitGlobal: 20,
    ...overrides,
  };
}

function makeCfg(): any {
  return { channels: {} };
}

function makeMessage(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id: 1001,
    sender: "+15551234567",
    text: "@millbot what time is it?",
    is_from_me: false,
    is_group: false,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveInboundDecision", () => {
  let echoGuard: EchoGuard;
  let dedup: MessageDedup;
  let cfg: any;
  let monitorCtx: MonitorContext;

  beforeEach(() => {
    echoGuard = createEchoGuard();
    dedup = createMessageDedup();
    cfg = makeCfg();
    monitorCtx = makeMonitorCtx();
  });

  it("drops pre-startup messages", () => {
    const pastDate = new Date(monitorCtx.startupTime - 10_000).toISOString();
    const message = makeMessage({ created_at: pastDate });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "pre-startup message" });
  });

  it("drops duplicate messages", () => {
    const message = makeMessage({ id: 999 });
    resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "duplicate" });
  });

  it("drops is_from_me messages", () => {
    const message = makeMessage({ id: 2001, is_from_me: true });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "is_from_me" });
  });

  it("drops echo messages", () => {
    const text = "Hello from bot";
    const scope = `${monitorCtx.accountId}:dm:+15551234567`;
    echoGuard.remember(scope, hashText(text));
    const message = makeMessage({ id: 2002, text, sender: "+15551234567" });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "echo" });
  });

  it("drops messages without mention", () => {
    const message = makeMessage({ id: 2003, text: "hello everyone" });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "no mention" });
  });

  it("drops empty body after mention stripping", () => {
    const message = makeMessage({ id: 2004, text: "@millbot" });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "empty body after mention stripping" });
  });

  it("drops blocked sender (allowlist)", () => {
    const message = makeMessage({ id: 2005, sender: "+19999999999", text: "@millbot hi" });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("drop");
    expect((result as any).reason).toContain("access denied");
  });

  it("drops group without chat_id", () => {
    const message = makeMessage({
      id: 2006,
      text: "@millbot hello",
      is_group: true,
      chat_id: null,
      chat_guid: null,
      chat_identifier: null,
    });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "group without chat_id" });
  });

  it("dispatches valid DM mention", () => {
    const message = makeMessage({
      id: 2007,
      text: "@millbot what time is it?",
      sender: "+15551234567",
    });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("dispatch");
    if (result.kind === "dispatch") {
      expect(result.isGroup).toBe(false);
      expect(result.strippedBody).toBe("what time is it?");
      expect(result.effectiveWasMentioned).toBe(true);
      expect(result.senderNormalized).toBe("+15551234567");
    }
  });

  it("dispatches valid group mention", () => {
    const message = makeMessage({
      id: 2008,
      text: "@millbot hello",
      sender: "+15551234567",
      is_group: true,
      chat_id: 42,
    });
    const monCtx = makeMonitorCtx({ groupPolicy: "open", groupAllowFrom: ["*"] });
    const result = resolveInboundDecision({ cfg, monitorCtx: monCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("dispatch");
    if (result.kind === "dispatch") {
      expect(result.isGroup).toBe(true);
      expect(result.chatId).toBe(42);
    }
  });

  it("truncates long messages", () => {
    const longText = "@millbot " + "x".repeat(10000);
    const message = makeMessage({ id: 2009, text: longText });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("dispatch");
    if (result.kind === "dispatch") {
      expect(result.bodyText.length).toBeLessThanOrEqual(monitorCtx.maxInboundLength);
    }
  });

  it("drops messages with missing sender", () => {
    const message = makeMessage({ id: 2010, sender: null });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result).toEqual({ kind: "drop", reason: "missing sender" });
  });

  it("drops DMs when dmPolicy is disabled", () => {
    const monCtx = makeMonitorCtx({ dmPolicy: "disabled" });
    const message = makeMessage({ id: 2011, text: "@millbot hi" });
    const result = resolveInboundDecision({ cfg, monitorCtx: monCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("drop");
  });

  it("drops groups when groupPolicy is disabled", () => {
    const monCtx = makeMonitorCtx({ groupPolicy: "disabled" });
    const message = makeMessage({
      id: 2012,
      text: "@millbot hi",
      is_group: true,
      chat_id: 42,
    });
    const result = resolveInboundDecision({ cfg, monitorCtx: monCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("drop");
  });

  it("handles is_from_me false without camelCase regression", () => {
    const message = makeMessage({
      id: 2013,
      is_from_me: false,
      text: "@millbot hello",
    });
    const result = resolveInboundDecision({ cfg, monitorCtx, message, echoGuard, dedup });
    expect(result.kind).toBe("dispatch");
  });
});
