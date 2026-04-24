import { stat } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createChannelReplyPipeline,
} from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  dispatchInboundMessage,
  createReplyDispatcher,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import {
  sanitizeForPlainText,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  stripInlineDirectiveTagsForDelivery,
} from "openclaw/plugin-sdk/text-runtime";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveImessageQuietAccount } from "../accounts.js";
import { createImsgClient, type ImsgRpcClient } from "../client.js";
import { sendMessageQuiet } from "../send.js";
import { parseNotificationPayload } from "./parse-notification.js";
import type { IMessagePayload } from "../types.js";

const CHANNEL_ID = "imessage-quiet";
const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

async function validateCliPath(cliPath: string): Promise<void> {
  if (!cliPath || cliPath === "imsg") return;
  try {
    const info = await stat(cliPath);
    if (!info.isFile()) {
      throw new Error(`imessage-quiet: cliPath "${cliPath}" is not a regular file`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as any).code === "ENOENT") {
      throw new Error(`imessage-quiet: cliPath "${cliPath}" does not exist`);
    }
    throw err;
  }
}

function buildMentionRegex(patterns: string[]): RegExp | null {
  if (patterns.length === 0) return null;
  const escaped = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<=^|\\W)(?:${escaped.join("|")})(?=\\W|$)`, "i");
}

function stripMention(text: string, patterns: string[]): string {
  let result = text;
  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<=^|\\W)${escaped}(?=\\W|$)`, "gi"), "").trim();
  }
  return result;
}

function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return trimmed.replace(/[^\d+]/g, "");
}

function deriveBotLabel(mentionPattern: string): string {
  const name = mentionPattern.replace(/^@/, "");
  return `[${name.charAt(0).toUpperCase()}${name.slice(1)}]`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "- ")
    .replace(/^\d+\.\s+/gm, (m) => m)
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

// --- Monitor Provider ---

export async function monitorImessageQuietProvider(ctx: {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const cfg = ctx.cfg;
  const account = resolveImessageQuietAccount({ cfg, accountId: ctx.accountId });
  const accountCfg = account.config;

  const cliPath = accountCfg.cliPath?.trim() || "imsg";
  const dbPath = accountCfg.dbPath?.trim();
  const mentionPatterns = accountCfg.mentionPatterns ?? ["@millbot"];

  await validateCliPath(cliPath);

  const startupTime = Date.now();
  const mentionRegex = buildMentionRegex(mentionPatterns);
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);

  const botLabel = deriveBotLabel(mentionPatterns[0] ?? "@assistant");

  async function handleMessage(message: IMessagePayload): Promise<void> {
    const text = (message.text ?? "").trim();
    if (!text) return;

    const createdAt = message.created_at ? Date.parse(message.created_at) : undefined;
    if (createdAt !== undefined && createdAt < startupTime) return;

    if (!mentionRegex || !mentionRegex.test(text)) return;

    const strippedBody = stripMention(text, mentionPatterns);
    if (!strippedBody) return;

    const sender = (message.sender ?? "").trim();
    const isGroup = Boolean(message.is_group);
    const chatId = message.chat_id ?? undefined;
    const senderNormalized = normalizeHandle(sender || "self");

    const peerId = isGroup
      ? String(chatId ?? message.chat_guid ?? "unknown")
      : senderNormalized;
    const route = resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      peer: { kind: isGroup ? "group" : "direct", id: peerId },
    });

    const chatTarget = isGroup && chatId != null ? `chat_id:${chatId}` : undefined;
    const fromLabel = formatInboundFromLabel({
      isGroup,
      groupLabel: undefined,
      groupId: chatId !== undefined ? String(chatId) : "unknown",
      groupFallback: "Group",
      directLabel: senderNormalized,
      directId: sender || "self",
    });

    const mentionLabel = mentionPatterns[0] ?? "@assistant";
    const preamble = [
      `[iMessage channel — you were explicitly invoked with ${mentionLabel}.]`,
      `[Rules: Reply ONLY to what was asked. Do not volunteer other topics or send proactive updates into this channel. Do not treat iMessage as your primary communication channel. After completing this request, go quiet until the next ${mentionLabel} invocation. You are the user's assistant in this conversation — other messages in the thread that do not contain ${mentionLabel} are not directed at you.]`,
      `[Format: This is iMessage — plain text only. No markdown syntax (no **, *, \`, #, [], (), etc.). Use natural language, dashes for lists, and line breaks for structure.]`,
      `[Your replies will be automatically prefixed with "${botLabel}" so the other person knows the message is from you, not the user. Do not add your own prefix.]`,
    ].join("\n");

    const envelope = formatInboundEnvelope({
      channel: "iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: strippedBody,
      chatType: isGroup ? "group" : "direct",
      sender: { name: senderNormalized, id: sender || "self" },
      envelope: envelopeOptions,
    });

    const body = `${preamble}\n\n${envelope}`;

    const replyTarget = chatTarget || sender || "self";
    const imessageTo = chatTarget || `imessage-quiet:${sender || "self"}`;

    const ctxPayload = finalizeInboundContext({
      Body: body,
      BodyForAgent: strippedBody,
      RawBody: strippedBody,
      CommandBody: strippedBody,
      From: isGroup
        ? `imessage-quiet:group:${chatId ?? "unknown"}`
        : `imessage-quiet:${sender || "self"}`,
      To: imessageTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderNormalized,
      SenderId: sender || "self",
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      MessageSid: message.id ? String(message.id) : undefined,
      Timestamp: createdAt,
      WasMentioned: true,
      CommandAuthorized: false,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: imessageTo,
    });

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: CHANNEL_ID,
      accountId: route.accountId,
    });

    const dispatcher = createReplyDispatcher({
      ...replyPipeline,
      deliver: async (payload) => {
        if (!replyTarget) return;
        const replyText = sanitizeForPlainText(
          stripInlineDirectiveTagsForDelivery(payload.text ?? "").text,
        );
        if (!replyText.trim()) return;
        const plainText = stripMarkdown(replyText);
        if (!plainText.trim()) return;
        await sendMessageQuiet({
          config: cfg,
          to: replyTarget,
          text: `${botLabel} ${plainText}`,
          accountId: account.accountId,
          client: activeClient ?? undefined,
        });
      },
      onError: (err) => {
        console.error(`[imessage-quiet] reply delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });

    await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: { onModelSelected },
    });
  }

  function onWatchNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method === "message") {
      const payload = parseNotificationPayload(notification.params);
      if (!payload) return;
      void handleMessage(payload).catch(() => {});
    }
  }

  // --- Connect and subscribe ---
  let activeClient: ImsgRpcClient | null = null;
  const abort = ctx.abortSignal;

  for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (abort?.aborted) return;

    let attemptClient: ImsgRpcClient | undefined;
    let keepClient = false;

    try {
      attemptClient = await createImsgClient({
        cliPath,
        dbPath,
        onNotification: onWatchNotification,
        onStderr: () => {},
      });

      await attemptClient.request<{ subscription?: number }>(
        "watch.subscribe",
        { attachments: false },
        { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS },
      );
      activeClient = attemptClient;
      keepClient = true;
      break;
    } catch (err) {
      if (abort?.aborted) return;
      const isRetriable =
        attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS &&
        /imsg rpc timeout|imsg rpc (closed|exited|not running)/i.test(String(err));
      if (!isRetriable) throw err;
      await attemptClient?.stop();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          abort?.removeEventListener("abort", onAbort);
          resolve();
        }, WATCH_SUBSCRIBE_RETRY_DELAY_MS);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        abort?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      if (!keepClient) await attemptClient?.stop();
    }
  }

  if (!activeClient) return;

  if (abort) {
    const onAbort = () => void activeClient?.stop().catch(() => {});
    abort.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await activeClient.waitForClose();
  } catch (err) {
    if (abort?.aborted) return;
    throw err;
  } finally {
    await activeClient.stop();
  }
}
