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

export type ImsgRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type ImsgRpcResponse<T = unknown> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: ImsgRpcError;
  method?: string;
  params?: unknown;
};

export type ImsgRpcNotification = {
  method: string;
  params?: unknown;
};

export type ImessageQuietAccountConfig = {
  enabled?: boolean;
  name?: string;
  cliPath?: string;
  dbPath?: string;
  mentionPatterns?: string[];
  accounts?: Record<string, Partial<ImessageQuietAccountConfig>>;
  defaultAccount?: string;
};

export type ResolvedImessageQuietAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: ImessageQuietAccountConfig;
  configured: boolean;
};

export type SendResult = {
  messageId: string;
  sentTextHash: string;
};
