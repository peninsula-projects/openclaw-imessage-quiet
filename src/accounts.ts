import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type {
  ImessageQuietAccountConfig,
  ResolvedImessageQuietAccount,
} from "./types.js";

export type { ResolvedImessageQuietAccount } from "./types.js";

const CHANNEL_ID = "imessage-quiet";

const { listAccountIds, resolveDefaultAccountId } =
  createAccountListHelpers(CHANNEL_ID);

export const listImessageQuietAccountIds = listAccountIds;
export const resolveDefaultImessageQuietAccountId = resolveDefaultAccountId;

function getChannelSection(cfg: OpenClawConfig): ImessageQuietAccountConfig | undefined {
  return (cfg.channels as Record<string, any>)?.[CHANNEL_ID] as
    | ImessageQuietAccountConfig
    | undefined;
}

function mergeAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ImessageQuietAccountConfig {
  const section = getChannelSection(cfg);
  return resolveMergedAccountConfig<ImessageQuietAccountConfig>({
    channelConfig: section,
    accounts: section?.accounts as
      | Record<string, Partial<ImessageQuietAccountConfig>>
      | undefined,
    accountId,
  });
}

export function resolveImessageQuietAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedImessageQuietAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultImessageQuietAccountId(params.cfg),
  );
  const section = getChannelSection(params.cfg);
  const baseEnabled = section?.enabled !== false;
  const merged = mergeAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const configured = Boolean(
    merged.cliPath?.trim() ||
      merged.dbPath?.trim() ||
      (merged.allowFrom && merged.allowFrom.length > 0) ||
      (merged.groupAllowFrom && merged.groupAllowFrom.length > 0) ||
      merged.dmPolicy ||
      merged.groupPolicy ||
      (merged.mentionPatterns && merged.mentionPatterns.length > 0),
  );

  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
  };
}
