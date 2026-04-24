import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  buildOutboundBaseSessionKey,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveImessageQuietAccount,
  type ResolvedImessageQuietAccount,
} from "./accounts.js";
import { sendMessageQuiet } from "./send.js";
import { monitorImessageQuietProvider } from "./monitor/provider.js";

// --- Constants ---

const CHANNEL_ID = "imessage-quiet" as const;
const DEFAULT_ACCOUNT_ID = "default";

// --- Target Parsing ---

type ImessageQuietTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; to: string };

function parseTarget(raw: string): ImessageQuietTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("imessage-quiet: target is required");
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("chat_id:") || lowered.startsWith("chatid:") || lowered.startsWith("chat:")) {
    const colonIdx = trimmed.indexOf(":");
    const value = trimmed.slice(colonIdx + 1).trim();
    const chatId = parseInt(value, 10);
    if (Number.isFinite(chatId)) {
      return { kind: "chat_id", chatId };
    }
  }
  if (lowered.startsWith("chat_guid:") || lowered.startsWith("chatguid:") || lowered.startsWith("guid:")) {
    const colonIdx = trimmed.indexOf(":");
    const value = trimmed.slice(colonIdx + 1).trim();
    if (value) {
      return { kind: "chat_guid", chatGuid: value };
    }
  }
  if (lowered.startsWith("chat_identifier:") || lowered.startsWith("chatidentifier:") || lowered.startsWith("chatident:")) {
    const colonIdx = trimmed.indexOf(":");
    const value = trimmed.slice(colonIdx + 1).trim();
    if (value) {
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }
  return { kind: "handle", to: trimmed };
}

function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return trimmed.replace(/[^\d+]/g, "");
}

function inferTargetChatType(to: string): "direct" | "group" | null {
  const lowered = to.toLowerCase();
  if (
    lowered.startsWith("chat_id:") || lowered.startsWith("chatid:") || lowered.startsWith("chat:") ||
    lowered.startsWith("chat_guid:") || lowered.startsWith("chatguid:") || lowered.startsWith("guid:") ||
    lowered.startsWith("chat_identifier:") || lowered.startsWith("chatidentifier:") || lowered.startsWith("chatident:")
  ) {
    return "group";
  }
  return "direct";
}

function looksLikeExplicitTargetId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  return (
    lowered.startsWith("chat_id:") || lowered.startsWith("chatid:") || lowered.startsWith("chat:") ||
    lowered.startsWith("chat_guid:") || lowered.startsWith("chatguid:") || lowered.startsWith("guid:") ||
    lowered.startsWith("chat_identifier:") || lowered.startsWith("chatidentifier:") || lowered.startsWith("chatident:") ||
    trimmed.includes("@") ||
    /^\+?\d{7,}$/.test(trimmed.replace(/[\s\-().]/g, ""))
  );
}

function normalizeMessagingTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const lowered = trimmed.toLowerCase();
  for (const prefix of ["imessage:", "sms:", "auto:", "imessage-quiet:"]) {
    if (lowered.startsWith(prefix)) {
      return normalizeMessagingTarget(trimmed.slice(prefix.length));
    }
  }
  return trimmed;
}

// --- Session Key ---

function buildSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({
    ...params,
    channel: CHANNEL_ID,
  });
}

function resolveOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const parsed = parseTarget(params.target);
  if (parsed.kind === "handle") {
    const handle = normalizeHandle(parsed.to);
    if (!handle) return null;
    const peer: RoutePeer = { kind: "direct", id: handle };
    const key = buildSessionKey({ cfg: params.cfg, agentId: params.agentId, accountId: params.accountId, peer });
    return {
      sessionKey: key,
      baseSessionKey: key,
      peer,
      chatType: "direct" as const,
      from: `imessage-quiet:${handle}`,
      to: `imessage-quiet:${handle}`,
    };
  }
  const peerId =
    parsed.kind === "chat_id" ? String(parsed.chatId) :
    parsed.kind === "chat_guid" ? parsed.chatGuid :
    parsed.chatIdentifier;
  if (!peerId) return null;
  const peer: RoutePeer = { kind: "group", id: peerId };
  const key = buildSessionKey({ cfg: params.cfg, agentId: params.agentId, accountId: params.accountId, peer });
  const toPrefix =
    parsed.kind === "chat_id" ? "chat_id" :
    parsed.kind === "chat_guid" ? "chat_guid" :
    "chat_identifier";
  return {
    sessionKey: key,
    baseSessionKey: key,
    peer,
    chatType: "group" as const,
    from: `imessage-quiet:group:${peerId}`,
    to: `${toPrefix}:${peerId}`,
  };
}

// --- Security Adapter ---

const securityAdapter = createRestrictSendersChannelSecurity<ResolvedImessageQuietAccount>({
  channelKey: CHANNEL_ID,
  resolveDmPolicy: (account) => account.config.dmPolicy ?? "allowlist",
  resolveDmAllowFrom: (account) => account.config.allowFrom ?? [],
  resolveGroupPolicy: (account) => account.config.groupPolicy ?? "allowlist",
  surface: "iMessage (Quiet) groups",
  openScope: "any member",
  groupPolicyPath: `channels.${CHANNEL_ID}.groupPolicy`,
  groupAllowFromPath: `channels.${CHANNEL_ID}.groupAllowFrom`,
  mentionGated: true,
  policyPathSuffix: "dmPolicy",
});

// --- Status Adapter ---

const statusAdapter = {
  inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
    const account = resolveImessageQuietAccount({ cfg, accountId });
    return {
      enabled: account.enabled,
      configured: account.configured,
      accountId: account.accountId,
    };
  },
};

// --- Coexistence Check ---

function checkCoexistence(cfg: OpenClawConfig): void {
  const imessageSection = (cfg.channels as Record<string, any>)?.["imessage"];
  if (imessageSection && imessageSection.enabled !== false) {
    console.warn(
      "[imessage-quiet] WARNING: Built-in 'imessage' channel is also enabled. " +
      "Running both channels simultaneously will cause duplicate responses. " +
      "Disable channels.imessage.enabled in openclaw.json."
    );
  }
}

// --- Plugin Assembly ---

export const imessageQuietPlugin = createChatChannelPlugin<ResolvedImessageQuietAccount>({
  base: createChannelPluginBase({
    id: CHANNEL_ID,
    meta: {
      label: "iMessage (Quiet)",
      aliases: ["imsg-quiet"],
      showConfigured: false,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: false,
    },
    setup: {
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveImessageQuietAccount({ cfg, accountId }),
      inspectAccount: statusAdapter.inspectAccount,
    },
    security: securityAdapter,
    messaging: {
      normalizeTarget: (params: { to: string }) => normalizeMessagingTarget(params.to),
      inferTargetChatType: (params: { to: string }) => inferTargetChatType(params.to),
      resolveOutboundSessionRoute: (params: {
        cfg: OpenClawConfig;
        agentId: string;
        accountId?: string | null;
        target: string;
      }) => resolveOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: (value: string) => looksLikeExplicitTargetId(value),
        hint: "<handle|chat_id:ID>",
        resolveTarget: async (params: { normalized?: string }) => {
          const to = params.normalized?.trim();
          if (!to) return null;
          const chatType = inferTargetChatType(to);
          if (!chatType) return null;
          return {
            to,
            kind: chatType === "direct" ? "user" as const : "group" as const,
            source: "normalized" as const,
          };
        },
      },
    },
    gateway: {
      startAccount: async (ctx) => {
        checkCoexistence(ctx.cfg);
        await monitorImessageQuietProvider(ctx);
      },
    },
  }),

  security: securityAdapter,

  outbound: {
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: 4000,
      sanitizeText: (params: { text: string }) => sanitizeForPlainText(params.text),
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (params: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
      }) => {
        const result = await sendMessageQuiet({
          config: params.cfg,
          to: params.to,
          text: params.text,
          accountId: params.accountId ?? undefined,
        });
        return { messageId: result.messageId };
      },
    },
  },
});
