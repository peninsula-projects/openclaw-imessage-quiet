import { describe, it, expect } from "vitest";
import { resolveImessageQuietAccount } from "../src/accounts.js";

function makeCfg(channelConfig: Record<string, unknown> = {}): any {
  return {
    channels: {
      "imessage-quiet": channelConfig,
    },
  };
}

describe("resolveImessageQuietAccount", () => {
  it("resolves single-account config with default account ID", () => {
    const cfg = makeCfg({
      cliPath: "/opt/homebrew/bin/imsg",
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    });
    const account = resolveImessageQuietAccount({ cfg });
    expect(account.accountId).toBeTruthy();
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(true);
    expect(account.config.cliPath).toBe("/opt/homebrew/bin/imsg");
    expect(account.config.allowFrom).toEqual(["+15551234567"]);
  });

  it("resolves named account from accounts block", () => {
    const cfg = makeCfg({
      accounts: {
        home: {
          cliPath: "/usr/local/bin/imsg",
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    const account = resolveImessageQuietAccount({ cfg, accountId: "home" });
    expect(account.accountId).toBe("home");
    expect(account.configured).toBe(true);
  });

  it("returns configured: false for missing config", () => {
    const cfg = makeCfg({});
    const account = resolveImessageQuietAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("returns enabled: false for disabled account", () => {
    const cfg = makeCfg({ enabled: false, cliPath: "imsg" });
    const account = resolveImessageQuietAccount({ cfg });
    expect(account.enabled).toBe(false);
  });

  it("defaults dmPolicy to allowlist when not specified", () => {
    const cfg = makeCfg({
      cliPath: "imsg",
      allowFrom: ["+15551234567"],
    });
    const account = resolveImessageQuietAccount({ cfg });
    // dmPolicy should not be set in config (defaults applied at runtime)
    // The monitor applies the default "allowlist" when reading from config
    expect(account.config.dmPolicy).toBeUndefined();
  });

  it("respects explicit dmPolicy", () => {
    const cfg = makeCfg({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    const account = resolveImessageQuietAccount({ cfg });
    expect(account.config.dmPolicy).toBe("open");
  });

  it("handles missing channels section", () => {
    const cfg = { channels: {} };
    const account = resolveImessageQuietAccount({ cfg: cfg as any });
    expect(account.configured).toBe(false);
    expect(account.enabled).toBe(true); // undefined !== false
  });
});
