import { createHash } from "node:crypto";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  IMessagePayload,
  InboundDecision,
  InboundDispatchDecision,
  InboundDropDecision,
  MonitorContext,
  EchoGuard,
  MessageDedup,
} from "../types.js";

const CHANNEL_ID = "imessage-quiet";

function hashForLog(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return trimmed.replace(/[^\d+]/g, "");
}

function isAllowedSender(params: {
  allowFrom: string[];
  sender: string;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
}): boolean {
  if (params.allowFrom.length === 0) return false;
  const senderNorm = normalizeHandle(params.sender);
  for (const entry of params.allowFrom) {
    const trimmed = entry.trim();
    if (trimmed === "*") return true;
    if (trimmed.toLowerCase().startsWith("chat_id:") || trimmed.toLowerCase().startsWith("chat:")) {
      const colonIdx = trimmed.indexOf(":");
      const value = trimmed.slice(colonIdx + 1).trim();
      if (params.chatId != null && String(params.chatId) === value) return true;
      continue;
    }
    if (trimmed.toLowerCase().startsWith("chat_guid:") || trimmed.toLowerCase().startsWith("guid:")) {
      const colonIdx = trimmed.indexOf(":");
      const value = trimmed.slice(colonIdx + 1).trim();
      if (params.chatGuid && params.chatGuid === value) return true;
      continue;
    }
    const entryNorm = normalizeHandle(trimmed);
    if (entryNorm && senderNorm === entryNorm) return true;
  }
  return false;
}

function stripMention(text: string, mentionRegexes: RegExp[]): string {
  let result = text;
  for (const re of mentionRegexes) {
    result = result.replace(re, "").trim();
  }
  return result;
}

export function resolveInboundDecision(params: {
  cfg: OpenClawConfig;
  monitorCtx: MonitorContext;
  message: IMessagePayload;
  echoGuard: EchoGuard;
  dedup: MessageDedup;
}): InboundDecision {
  const { cfg, monitorCtx, message, echoGuard, dedup } = params;
  const messageText = (message.text ?? "").trim();
  const sender = (message.sender ?? "").trim();
  const chatId = message.chat_id ?? undefined;
  const chatGuid = message.chat_guid ?? undefined;
  const chatIdentifier = message.chat_identifier ?? undefined;
  const isGroup = Boolean(message.is_group);
  const createdAt = message.created_at ? Date.parse(message.created_at) : undefined;

  // [1] Startup time check
  if (createdAt !== undefined && createdAt < monitorCtx.startupTime) {
    return { kind: "drop", reason: "pre-startup message" };
  }

  // [2] Dedup check
  if (message.id != null) {
    const isFromMe = Boolean(message.is_from_me);
    if (dedup.isDuplicate(String(message.id), isFromMe)) {
      return { kind: "drop", reason: "duplicate" };
    }
  }

  // [3] is_from_me check -- ALWAYS DROP, no exceptions
  if (message.is_from_me) {
    return { kind: "drop", reason: "is_from_me" };
  }

  // Missing sender check
  if (!sender) {
    return { kind: "drop", reason: "missing sender" };
  }

  // [4] Echo guard (hash-based, no plaintext)
  if (messageText) {
    const scope = isGroup
      ? `${monitorCtx.accountId}:group:${chatId ?? chatGuid ?? "unknown"}`
      : `${monitorCtx.accountId}:dm:${sender}`;
    const textHash = hashText(messageText);
    const messageIdStr = message.id != null ? String(message.id) : undefined;
    if (echoGuard.has(scope, textHash, messageIdStr)) {
      return { kind: "drop", reason: "echo" };
    }
  }

  // [5] Inbound length limit
  let effectiveText = messageText;
  if (effectiveText.length > monitorCtx.maxInboundLength) {
    effectiveText = effectiveText.slice(0, monitorCtx.maxInboundLength);
  }

  // [6] Mention check -- ALWAYS REQUIRED, explicit only
  const mentionRegexes = buildMentionRegexes(cfg, undefined);
  const customPatterns = monitorCtx.mentionPatterns;
  const allMentionRegexes = [...mentionRegexes];
  for (const pattern of customPatterns) {
    try {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      allMentionRegexes.push(new RegExp(`\\b${escaped}\\b`, "i"));
    } catch {
      // Skip invalid patterns
    }
  }

  const mentionMatch = matchesMentionWithExplicit(effectiveText, {
    mentionRegexes: allMentionRegexes,
    mentionPatterns: customPatterns,
  });

  const decision = resolveInboundMentionDecision({
    facts: {
      canDetectMention: allMentionRegexes.length > 0,
      wasMentioned: mentionMatch.matched,
      hasAnyMention: mentionMatch.hasExplicitMention,
      implicitMentionKinds: [],
    },
    policy: {
      isGroup,
      requireMention: true,
      allowTextCommands: false,
      hasControlCommand: false,
      commandAuthorized: false,
    },
  });

  if (decision.shouldSkip) {
    return { kind: "drop", reason: "no mention" };
  }

  // [7] Empty body after mention stripping
  const strippedBody = stripMention(effectiveText, allMentionRegexes);
  if (!strippedBody.trim()) {
    return { kind: "drop", reason: "empty body after mention stripping" };
  }

  // [8] DM/Group access policy
  if (isGroup && !chatId && !chatGuid && !chatIdentifier) {
    return { kind: "drop", reason: "group without chat_id" };
  }

  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy: monitorCtx.dmPolicy,
    groupPolicy: monitorCtx.groupPolicy,
    allowFrom: monitorCtx.allowFrom,
    groupAllowFrom: monitorCtx.groupAllowFrom,
    storeAllowFrom: [],
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFromList: string[]) =>
      isAllowedSender({
        allowFrom: allowFromList,
        sender,
        chatId,
        chatGuid,
        chatIdentifier,
      }),
  });

  if (accessDecision.decision !== "allow") {
    return { kind: "drop", reason: `access denied: ${accessDecision.reason}` };
  }

  // DISPATCH
  const senderNormalized = normalizeHandle(sender);
  const historyKey = isGroup
    ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
    : undefined;

  return {
    kind: "dispatch",
    isGroup,
    chatId,
    chatGuid: chatGuid ?? undefined,
    chatIdentifier: chatIdentifier ?? undefined,
    sender,
    senderNormalized,
    bodyText: effectiveText,
    strippedBody,
    createdAt,
    effectiveWasMentioned: true,
    sessionKey: "",
    agentId: "",
    accountId: monitorCtx.accountId,
    historyKey,
  };
}
