import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-runtime";
import { resolveImessageQuietAccount } from "./accounts.js";
import { createImsgClient, type ImsgRpcClient } from "./client.js";
import type { SendResult } from "./types.js";

export type QuietSendOpts = {
  config: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string;
  client?: ImsgRpcClient;
  timeoutMs?: number;
};

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function resolveMessageId(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  const raw =
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.message_id === "string" && result.message_id.trim()) ||
    (typeof result.id === "string" && result.id.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.message_id === "number" ? String(result.message_id) : null) ||
    (typeof result.id === "number" ? String(result.id) : null);
  return raw ? raw.trim() : null;
}

export async function sendMessageQuiet(opts: QuietSendOpts): Promise<SendResult> {
  const account = resolveImessageQuietAccount({
    cfg: opts.config,
    accountId: opts.accountId,
  });
  const cliPath = account.config.cliPath?.trim() || "imsg";
  const dbPath = account.config.dbPath?.trim();

  let message = opts.text ?? "";
  message = stripInlineDirectiveTagsForDelivery(message).text;

  if (!message.trim()) {
    throw new Error("imessage-quiet: send requires non-empty text");
  }

  const params: Record<string, unknown> = {
    text: message,
    service: "auto",
  };

  const to = opts.to.trim();
  const lowered = to.toLowerCase();
  if (lowered.startsWith("chat_id:") || lowered.startsWith("chatid:") || lowered.startsWith("chat:")) {
    const colonIdx = to.indexOf(":");
    const chatId = parseInt(to.slice(colonIdx + 1).trim(), 10);
    if (Number.isFinite(chatId)) {
      params.chat_id = chatId;
    } else {
      params.to = to;
    }
  } else if (lowered.startsWith("chat_guid:") || lowered.startsWith("chatguid:") || lowered.startsWith("guid:")) {
    const colonIdx = to.indexOf(":");
    params.chat_guid = to.slice(colonIdx + 1).trim();
  } else if (lowered.startsWith("chat_identifier:") || lowered.startsWith("chatidentifier:") || lowered.startsWith("chatident:")) {
    const colonIdx = to.indexOf(":");
    params.chat_identifier = to.slice(colonIdx + 1).trim();
  } else {
    params.to = to;
  }

  const client = opts.client ?? await createImsgClient({ cliPath, dbPath });
  const shouldClose = !opts.client;

  try {
    const result = await client.request<Record<string, unknown>>("send", params, {
      timeoutMs: opts.timeoutMs,
    });
    const resolvedId = resolveMessageId(result);
    return {
      messageId: resolvedId ?? "unknown",
      sentTextHash: hashText(message),
    };
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}
