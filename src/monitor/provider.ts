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
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntry,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveImessageQuietAccount } from "../accounts.js";
import { createImsgClient, type ImsgRpcClient } from "../client.js";
import { sendMessageQuiet } from "../send.js";
import { resolveInboundDecision } from "./inbound.js";
import { createEchoGuard } from "./echo-guard.js";
import { createMessageDedup } from "./dedup.js";
import { createDispatchRateLimiter } from "./rate-limiter.js";
import type {
  IMessagePayload,
  MonitorContext,
} from "../types.js";

const CHANNEL_ID = "imessage-quiet";
const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;
const DEFAULT_GROUP_HISTORY_LIMIT = 10;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

// --- cliPath Validation ---

async function validateCliPath(cliPath: string): Promise<void> {
  if (!cliPath || cliPath === "imsg") {
    return;
  }
  try {
    const info = await stat(cliPath);
    if (!info.isFile()) {
      throw new Error(
        `imessage-quiet: cliPath "${cliPath}" is not a regular file`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as any).code === "ENOENT") {
      throw new Error(
        `imessage-quiet: cliPath "${cliPath}" does not exist`,
      );
    }
    throw err;
  }
}

// --- Parse watch.subscribe notifications ---

function parseNotificationPayload(raw: unknown): IMessagePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.sender !== "string" && typeof msg.text !== "string") {
    return null;
  }
  return msg as unknown as IMessagePayload;
}

// --- Abort Handler ---

function attachAbortHandler(params: {
  abortSignal?: AbortSignal;
  client: ImsgRpcClient;
  getSubscriptionId: () => number | null;
}): () => void {
  const abort = params.abortSignal;
  if (!abort) return () => {};

  const onAbort = () => {
    const subId = params.getSubscriptionId();
    if (subId) {
      void params.client
        .request("watch.unsubscribe", { subscription: subId })
        .catch(() => {});
    }
    void params.client.stop().catch(() => {});
  };

  abort.addEventListener("abort", onAbort, { once: true });
  return () => abort.removeEventListener("abort", onAbort);
}

// --- Monitor Provider ---

export async function monitorImessageQuietProvider(ctx: {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const cfg = ctx.cfg;
  const account = resolveImessageQuietAccount({
    cfg,
    accountId: ctx.accountId,
  });
  const accountCfg = account.config;

  const cliPath = accountCfg.cliPath?.trim() || "imsg";
  const dbPath = accountCfg.dbPath?.trim();
  const dmPolicy = accountCfg.dmPolicy ?? "allowlist";
  const groupPolicy = accountCfg.groupPolicy ?? "allowlist";
  const allowFrom = accountCfg.allowFrom ?? [];
  const groupAllowFrom = accountCfg.groupAllowFrom ?? [];
  const mentionPatterns = accountCfg.mentionPatterns ?? [];
  const maxInboundLength = accountCfg.maxInboundLength ?? 8000;
  const rateLimitPerConversation = accountCfg.rateLimitPerConversation ?? 5;
  const rateLimitGlobal = accountCfg.rateLimitGlobal ?? 20;

  await validateCliPath(cliPath);

  const startupTime = Date.now();

  const echoGuard = createEchoGuard();
  const dedup = createMessageDedup();
  const rateLimiter = createDispatchRateLimiter({
    perConversationLimit: rateLimitPerConversation,
    globalLimit: rateLimitGlobal,
    windowMs: 60_000,
  });
  const groupHistories = new Map<string, HistoryEntry[]>();
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);

  const monitorCtx: MonitorContext = {
    startupTime,
    accountId: account.accountId,
    cliPath,
    dbPath,
    dmPolicy,
    groupPolicy,
    allowFrom,
    groupAllowFrom,
    mentionPatterns,
    maxInboundLength,
    rateLimitPerConversation,
    rateLimitGlobal,
  };

  // --- Message handler ---
  async function handleMessage(message: IMessagePayload): Promise<void> {
    const decision = resolveInboundDecision({
      cfg,
      monitorCtx,
      message,
      echoGuard,
      dedup,
    });

    if (decision.kind === "drop") {
      // Record non-mentioned group messages in history for future context
      // (Chief Architect Review S3: ephemeral group history).
      // When an @mention eventually arrives, these entries provide
      // surrounding conversation context to the agent.
      if (
        decision.reason === "no mention" &&
        message.is_group &&
        message.sender &&
        message.text?.trim()
      ) {
        const chatId = message.chat_id ?? undefined;
        const chatGuid = message.chat_guid ?? undefined;
        const chatIdentifier = message.chat_identifier ?? undefined;
        const histKey = String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown");
        if (histKey !== "unknown") {
          recordPendingHistoryEntry({
            historyMap: groupHistories,
            historyKey: histKey,
            entry: {
              sender: message.sender.trim(),
              body: message.text.trim(),
              timestamp: message.created_at ? Date.parse(message.created_at) : undefined,
            },
            limit: DEFAULT_GROUP_HISTORY_LIMIT,
          });
        }
      }
      return;
    }

    // Rate limiting
    const conversationKey = decision.isGroup
      ? `group:${decision.chatId ?? decision.chatGuid ?? "unknown"}`
      : `dm:${decision.senderNormalized}`;
    const rateResult = rateLimiter.tryDispatch(conversationKey);
    if (!rateResult.allowed) {
      return;
    }

    // Resolve agent route
    const peerId = decision.isGroup
      ? String(decision.chatId ?? decision.chatGuid ?? "unknown")
      : decision.senderNormalized;
    const route = resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      peer: {
        kind: decision.isGroup ? "group" : "direct",
        id: peerId,
      },
    });

    // Build inbound context
    const chatId = decision.chatId;
    const chatTarget = decision.isGroup && chatId != null
      ? `chat_id:${chatId}`
      : undefined;

    const fromLabel = formatInboundFromLabel({
      isGroup: decision.isGroup,
      groupLabel: undefined,
      groupId: chatId !== undefined ? String(chatId) : "unknown",
      groupFallback: "Group",
      directLabel: decision.senderNormalized,
      directId: decision.sender,
    });

    const body = formatInboundEnvelope({
      channel: "iMessage",
      from: fromLabel,
      timestamp: decision.createdAt,
      body: decision.strippedBody,
      chatType: decision.isGroup ? "group" : "direct",
      sender: { name: decision.senderNormalized, id: decision.sender },
      envelope: envelopeOptions,
    });

    // Group history context
    let combinedBody = body;
    const historyKey = decision.historyKey;
    if (decision.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: groupHistories,
        historyKey,
        limit: DEFAULT_GROUP_HISTORY_LIMIT,
        currentMessage: combinedBody,
        formatEntry: (entry: HistoryEntry) =>
          formatInboundEnvelope({
            channel: "iMessage",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }),
      });
    }

    const imessageTo = chatTarget || `imessage-quiet:${decision.sender}`;

    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: decision.strippedBody,
      RawBody: decision.strippedBody,
      CommandBody: decision.strippedBody,
      From: decision.isGroup
        ? `imessage-quiet:group:${chatId ?? "unknown"}`
        : `imessage-quiet:${decision.sender}`,
      To: imessageTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: decision.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: decision.senderNormalized,
      SenderId: decision.sender,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      MessageSid: message.id ? String(message.id) : undefined,
      Timestamp: decision.createdAt,
      WasMentioned: true,
      CommandAuthorized: false,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: imessageTo,
    });

    // CRITICAL: Do NOT call recordInboundSession

    // Create reply pipeline and dispatch
    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: CHANNEL_ID,
      accountId: route.accountId,
    });

    const dispatcher = createReplyDispatcher({
      ...replyPipeline,
      deliver: async (payload) => {
        const target = ctxPayload.To;
        if (!target) return;

        const text = sanitizeForPlainText(
          stripInlineDirectiveTagsForDelivery(payload.text ?? "").text,
        );
        if (!text.trim()) return;

        const result = await sendMessageQuiet({
          config: cfg,
          to: target,
          text,
          accountId: account.accountId,
          client: activeClient ?? undefined,
        });

        // Build scope matching the inbound echo guard format:
        // Groups: "accountId:group:chatId", DMs: "accountId:dm:sender"
        const echoScope = decision.isGroup
          ? `${account.accountId}:group:${decision.chatId ?? decision.chatGuid ?? "unknown"}`
          : `${account.accountId}:dm:${decision.sender}`;
        echoGuard.remember(echoScope, result.sentTextHash, result.messageId);
      },
      onError: (err) => {
        // Security: log only error type, never content that might include message text
        const errType = err instanceof Error ? err.constructor.name : "unknown";
        console.error(`[imessage-quiet] reply delivery failed (${errType})`);
      },
    });

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        onModelSelected,
      },
    });

    // Group history management
    if (decision.isGroup && historyKey) {
      groupHistories.delete(historyKey);
    }
  }

  // --- watch.subscribe notification handler ---
  function onWatchNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method === "message") {
      const payload = parseNotificationPayload(notification.params);
      if (!payload) return;

      void handleMessage(payload).catch((err) => {
        // Security: log only error type, never content that might leak message text
        const errType = err instanceof Error ? err.constructor.name : "unknown";
        console.error(`[imessage-quiet] handler error (${errType})`);
      });
    }
    if (notification.method === "error") {
      console.error("[imessage-quiet] watch stream error");
    }
  }

  // --- Connect and subscribe ---
  let activeClient: ImsgRpcClient | null = null;
  let detachAbort = () => {};
  const abort = ctx.abortSignal;

  for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (abort?.aborted) return;

    let attemptClient: ImsgRpcClient | undefined;
    let attemptDetach = () => {};
    let keepClient = false;

    try {
      attemptClient = await createImsgClient({
        cliPath,
        dbPath,
        onNotification: onWatchNotification,
        onStderr: (line) => {
          console.error("[imessage-quiet] imsg stderr output");
        },
      });

      let subscriptionId: number | null = null;
      attemptDetach = attachAbortHandler({
        abortSignal: abort,
        client: attemptClient,
        getSubscriptionId: () => subscriptionId,
      });

      const result = await attemptClient.request<{ subscription?: number }>(
        "watch.subscribe",
        { attachments: false },
        { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS },
      );
      subscriptionId = result?.subscription ?? null;
      activeClient = attemptClient;
      detachAbort = attemptDetach;
      keepClient = true;
      break;
    } catch (err) {
      if (abort?.aborted) return;
      const isRetriable =
        attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS &&
        /imsg rpc timeout|imsg rpc (closed|exited|not running)/i.test(String(err));
      if (!isRetriable) {
        throw err;
      }
      attemptDetach();
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
      if (!keepClient) {
        attemptDetach();
        await attemptClient?.stop();
      }
    }
  }

  if (!activeClient) return;

  // Wait for close or abort
  try {
    await activeClient.waitForClose();
  } catch (err) {
    if (abort?.aborted) return;
    throw err;
  } finally {
    detachAbort();
    await activeClient.stop();
  }
}
