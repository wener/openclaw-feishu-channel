import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type {
  FeishuConfig,
  FeishuAccountConfig,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";
import type { FeishuPluginConfig } from "./plugin-config.js";

/**
 * List all configured account IDs from the accounts field.
 */
function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

/**
 * List all Feishu account IDs.
 * If no accounts are configured, returns [DEFAULT_ACCOUNT_ID] for backward compatibility.
 */
export function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    // Backward compatibility: no accounts configured, use default
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Get the raw account-specific config.
 */
function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): FeishuAccountConfig | undefined {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

/**
 * Merge top-level config with account-specific config.
 * Account-specific fields override top-level fields.
 */
function mergeFeishuAccountConfig(cfg: ClawdbotConfig, accountId: string): FeishuConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  // Extract base config (exclude accounts field to avoid recursion)
  const { accounts: _ignored, ...base } = feishuCfg ?? {};

  // Get account-specific overrides
  const account = resolveAccountConfig(cfg, accountId) ?? {};

  // Merge: account config overrides base config
  return { ...base, ...account } as FeishuConfig;
}

/**
 * Resolve Feishu credentials from a config.
 */
export function resolveFeishuCredentials(cfg?: FeishuConfig): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const appId = cfg?.appId?.trim();
  const appSecret = cfg?.appSecret?.trim();
  if (!appId || !appSecret) {
    return null;
  }
  return {
    appId,
    appSecret,
    encryptKey: cfg?.encryptKey?.trim() || undefined,
    verificationToken: cfg?.verificationToken?.trim() || undefined,
    domain: cfg?.domain ?? "feishu",
  };
}

/**
 * Resolve plugin-level config for an account.
 * Priority: plugin config > channel config (backward compatibility)
 */
function resolvePluginAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): {
  botOpenId?: string;
  isRouter?: boolean;
  senderMentionKey?: string;
  routeMap?: Record<string, string>;
} {
  // Try to read from plugin install config first
  const pluginConfig = cfg.plugins?.installs?.feishu?.config as FeishuPluginConfig | undefined;
  const pluginAccountConfig = pluginConfig?.accounts?.[accountId];
  
  if (pluginAccountConfig) {
    return {
      botOpenId: pluginAccountConfig.botOpenId,
      isRouter: pluginAccountConfig.isRouter,
      senderMentionKey: pluginAccountConfig.senderMentionKey,
      routeMap: pluginAccountConfig.routeMap,
    };
  }
  
  // Fallback: read from channel config (backward compatibility)
  const channelCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const channelAccountCfg = channelCfg?.accounts?.[accountId] as FeishuAccountConfig | undefined;
  
  return {
    botOpenId: channelAccountCfg?.botOpenId,
    isRouter: channelAccountCfg?.isRouter,
    senderMentionKey: channelAccountCfg?.senderMentionKey,
    routeMap: undefined, // routeMap only in plugin config
  };
}

/**
 * Resolve a complete Feishu account with merged config.
 */
export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const accountId = normalizeAccountId(params.accountId);
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  // Base enabled state (top-level)
  const baseEnabled = feishuCfg?.enabled !== false;

  // Merge configs
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);

  // Account-level enabled state
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  
  // Resolve plugin-level config (botOpenId, isRouter, etc.)
  const pluginCfg = resolvePluginAccountConfig(params.cfg, accountId);
  
  // Check if this is a router account
  const isRouter = pluginCfg.isRouter === true;

  // Resolve credentials from merged config
  const creds = resolveFeishuCredentials(merged);

  // Get bot open_id from plugin config (priority) or channel config (fallback)
  const botOpenId = pluginCfg.botOpenId;

  return {
    accountId,
    enabled,
    configured: Boolean(creds),
    name: (merged as FeishuAccountConfig).name?.trim() || undefined,
    appId: creds?.appId,
    appSecret: creds?.appSecret,
    encryptKey: creds?.encryptKey,
    verificationToken: creds?.verificationToken,
    botOpenId,
    domain: creds?.domain ?? "feishu",
    isRouter,
    config: merged,
    // Store plugin config for router middleware access
    pluginConfig: pluginCfg,
  };
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
