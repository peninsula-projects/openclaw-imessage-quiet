// --- IMessage RPC Types ---

/** Raw message payload from imsg RPC watch.subscribe notification */
export type IMessagePayload = {
  id?: number | null;
  guid?: string | null;
  chat_id?: number | null;
  sender?: string | null;
  destination_caller_id?: string | null;
  is_from_me?: boolean | null;
  text?: string | null;
  reply_to_id?: number | string | null;
  reply_to_text?: string | null;
  reply_to_sender?: string | null;
  created_at?: string | null;
  attachments?: null;
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

/** JSON-RPC 2.0 error shape from imsg */
export type ImsgRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

/** JSON-RPC 2.0 response from imsg */
export type ImsgRpcResponse<T = unknown> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: ImsgRpcError;
  method?: string;
  params?: unknown;
};

/** JSON-RPC 2.0 notification from imsg (no id) */
export type ImsgRpcNotification = {
  method: string;
  params?: unknown;
};

// --- Account Types ---

/** Raw config shape from openclaw.json channels.imessage-quiet section */
export type ImessageQuietAccountConfig = {
  enabled?: boolean;
  name?: string;
  cliPath?: string;
  dbPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupAllowFrom?: string[];
  mentionPatterns?: string[];
  maxInboundLength?: number;
  rateLimitPerConversation?: number;
  rateLimitGlobal?: number;
  accounts?: Record<string, Partial<ImessageQuietAccountConfig>>;
  defaultAccount?: string;
};

/** Resolved account after config merge */
export type ResolvedImessageQuietAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: ImessageQuietAccountConfig;
  configured: boolean;
};

// --- Inbound Decision Types ---

export type InboundDropDecision = {
  kind: "drop";
  reason: string;
};

export type InboundDispatchDecision = {
  kind: "dispatch";
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  sender: string;
  senderNormalized: string;
  bodyText: string;
  strippedBody: string;
  createdAt?: number;
  effectiveWasMentioned: true;
  sessionKey: string;
  agentId: string;
  accountId: string;
  historyKey?: string;
};

export type InboundDecision = InboundDropDecision | InboundDispatchDecision;

// --- Echo Guard Types ---

export type EchoGuard = {
  remember(scope: string, textHash: string, messageId?: string): void;
  has(scope: string, textHash: string, messageId?: string): boolean;
};

// --- Rate Limiter Types ---

export type RateLimitResult = {
  allowed: boolean;
  reason?: "per-conversation" | "global";
};

export type DispatchRateLimiter = {
  tryDispatch(conversationKey: string): RateLimitResult;
  reset(): void;
};

// --- Dedup Types ---

export type MessageDedup = {
  isDuplicate(messageId: string, isFromMe: boolean): boolean;
};

// --- Send Result ---

export type SendResult = {
  messageId: string;
  sentTextHash: string;
};

// --- Group History ---

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

// --- Monitor State ---

export type MonitorContext = {
  startupTime: number;
  accountId: string;
  cliPath: string;
  dbPath?: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  groupAllowFrom: string[];
  mentionPatterns: string[];
  maxInboundLength: number;
  rateLimitPerConversation: number;
  rateLimitGlobal: number;
};
