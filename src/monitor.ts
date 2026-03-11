import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type ClawdbotConfig,
  type RuntimeEnv,
  type HistoryEntry,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount, listEnabledFeishuAccounts } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent, type FeishuBotAddedEvent } from "./bot.js";
import { createFeishuWSClient, createEventDispatcher } from "./client.js";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

// Per-account WebSocket clients, HTTP servers, and bot info
const wsClients = new Map<string, Lark.WSClient>();
const httpServers = new Map<string, http.Server>();
const botOpenIds = new Map<string, string>();
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const FEISHU_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const FEISHU_WEBHOOK_RATE_LIMIT_MAX_REQUESTS = 120;
const FEISHU_WEBHOOK_COUNTER_LOG_EVERY = 25;
const feishuWebhookRateLimits = new Map<string, { count: number; windowStartMs: number }>();
const feishuWebhookStatusCounters = new Map<string, number>();

// Router bot configuration
const ROUTER_ACCOUNT_ID = 'router';
const ROUTER_BOT_OPEN_ID = 'ou_e930dcbee55995ce0b4b1c09398f96a8';

// Bot open_ids that should be routed
const BOT_OPEN_IDS = new Set([
  'ou_e930dcbee55995ce0b4b1c09398f96a8', // router bot itself (skip)
  'ou_780aa05d4ac936f7ec4a7dccec1036df', // milo
  'ou_31d580f87e1ea0c3b9fcdd91c115c48f', // product-tech
  'ou_e5dc2412f29e7f9c78ecadecca788d18', // health-advisor
  'ou_1421ad51aad4f5d27fa2859710703759', // marketing
  'ou_18dbf4619ced6706c9ffa4e25c3767f9', // internal-affairs
]);

// Route mapping: keyword → target port
const ROUTE_MAP: Record<string, number> = {
  '产品技术': 3001,
  '健康 - 产品技术': 3001,
  'tech': 3001,
  '健康顾问': 3002,
  '健康 - 健康顾问': 3002,
  'health': 3002,
  '营销增长': 3003,
  '健康 - 营销增长': 3003,
  'marketing': 3003,
  'milo': 3000,
  '健康-milo': 3000,
  '内务': 3004,
  '健康 - 内务': 3004,
  'finance': 3004,
};

function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return false;
  }
  const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function isWebhookRateLimited(key: string, nowMs: number): boolean {
  const state = feishuWebhookRateLimits.get(key);
  if (!state || nowMs - state.windowStartMs >= FEISHU_WEBHOOK_RATE_LIMIT_WINDOW_MS) {
    feishuWebhookRateLimits.set(key, { count: 1, windowStartMs: nowMs });
    return false;
  }

  state.count += 1;
  if (state.count > FEISHU_WEBHOOK_RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }
  return false;
}

/**
 * Parse mentions from message content
 */
function parseMentions(content: string, mentions?: any[]): string[] {
  const targets: string[] = [];
  
  if (mentions && mentions.length > 0) {
    for (const mention of mentions) {
      if (mention.name) {
        targets.push(mention.name);
      }
    }
  } else {
    const matches = content.match(/@([^\s@]+)/g);
    if (matches) {
      matches.forEach(m => targets.push(m.substring(1)));
    }
  }
  
  return targets;
}

/**
 * Identify route target from message
 */
function identifyRouteTarget(content: string, mentions?: any[]): { target: string, port: number, cleanContent: string } | null {
  const targets = parseMentions(content, mentions);
  
  for (const target of targets) {
    // Skip router bot itself
    if (target === '健康 - 路由' || target === '路由') {
      continue;
    }
    
    const port = ROUTE_MAP[target];
    if (port) {
      const cleanContent = content.replace(new RegExp(`@${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '').trim();
      return { target, port, cleanContent };
    }
  }
  
  // Try keyword matching
  for (const [keyword, port] of Object.entries(ROUTE_MAP)) {
    if (content.includes(keyword)) {
      const cleanContent = content.replace(keyword, '').trim();
      return { target: keyword, port, cleanContent };
    }
  }
  
  return null;
}

/**
 * Forward message to target bot's webhook
 */
async function forwardToTargetWebhook(
  event: any,
  targetPort: number,
  targetName: string,
  log: (...args: any[]) => void,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(event);
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: targetPort,
      path: '/feishu/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        log(`[Router] Forwarded to ${targetName} (port ${targetPort}), status: ${res.statusCode}`);
        resolve(res.statusCode === 200);
      });
    });
    
    req.on('error', (e) => {
      log(`[Router] Forward to ${targetName} failed: ${e.message}`);
      reject(e);
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Handle router bot message - forward to target bot
 */
async function handleRouterMessage(
  event: any,
  log: (...args: any[]) => void,
): Promise<boolean> {
  try {
    // Parse message content based on type
    let content = '';
    const messageType = event.message?.message_type;
    
    if (messageType === 'text') {
      content = event.message.content || '';
    } else if (messageType === 'post') {
      try {
        const postContent = JSON.parse(event.message.content || '{}');
        const postBody = postContent.post?.content;
        if (Array.isArray(postBody)) {
          content = postBody.map((line: any) => {
            return line.map((item: any) => item.text || '').join('');
          }).join('\n');
        }
      } catch (e) {
        log(`[Router] Parse post error: ${e}`);
      }
    }
    
    const mentions = event.message?.mentions;
    log(`[Router] Content: "${content}" | Mentions: ${JSON.stringify(mentions)}`);
    
    const routeInfo = identifyRouteTarget(content, mentions);
    
    if (!routeInfo) {
      log('[Router] No route target identified');
      return false;
    }
    
    const { target, port, cleanContent } = routeInfo;
    log(`[Router] >>> Route: ${target} -> port ${port}`);
    log(`[Router] >>> Clean content: "${cleanContent}"`);
    
    // Modify event content
    if (event.message && event.message.content) {
      if (messageType === 'post') {
        const postContent = JSON.parse(event.message.content || '{}');
        if (postContent.post?.content) {
          postContent.post.content = [[{ text: cleanContent }]];
          event.message.content = JSON.stringify(postContent);
        }
      } else {
        event.message.content = cleanContent;
      }
    }
    
    // Forward
    log(`[Router] >>> Forwarding...`);
    await forwardToTargetWebhook(event, port, target, log);
    log(`[Router] >>> Forward complete`);
    return true;
    
  } catch (error) {
    log(`[Router] Error: ${error}`);
    return false;
  }
}

function recordWebhookStatus(
  runtime: RuntimeEnv | undefined,
  accountId: string,
  path: string,
  statusCode: number,
): void {
  if (![400, 401, 408, 413, 415, 429].includes(statusCode)) {
    return;
  }
  const key = `${accountId}:${path}:${statusCode}`;
  const next = (feishuWebhookStatusCounters.get(key) ?? 0) + 1;
  feishuWebhookStatusCounters.set(key, next);
  if (next === 1 || next % FEISHU_WEBHOOK_COUNTER_LOG_EVERY === 0) {
    const log = runtime?.log ?? console.log;
    log(`feishu[${accountId}]: webhook anomaly path=${path} status=${statusCode} count=${next}`);
  }
}

async function fetchBotOpenId(account: ResolvedFeishuAccount): Promise<string | undefined> {
  try {
    const result = await probeFeishu(account);
    return result.ok ? result.botOpenId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register common event handlers on an EventDispatcher.
 * When fireAndForget is true (webhook mode), message handling is not awaited
 * to avoid blocking the HTTP response (Lark requires <3s response).
 */
function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: {
    cfg: ClawdbotConfig;
    accountId: string;
    account: ResolvedFeishuAccount;
    runtime?: RuntimeEnv;
    chatHistories: Map<string, HistoryEntry[]>;
    fireAndForget?: boolean;
  },
) {
  const { cfg, accountId, account, runtime, chatHistories, fireAndForget } = context;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      const event = data as any;
      
      // Router bot: try to route messages from other bots
      if (account.isRouter) {
        const senderOpenId = event.sender?.sender_id?.open_id;
        const content = event.message?.content || '';
        const chatType = event.message?.chat_type;
        const msgType = event.message?.message_type;
        
        log(`[Router] Msg from ${senderOpenId} (${chatType}): ${content?.substring(0, 80)}`);
        
        // Only process group messages from other bots (not router bot itself)
        // Check if sender is a known bot
        const isBotSender = BOT_OPEN_IDS.has(senderOpenId);
        
        if (chatType === 'group' && senderOpenId && senderOpenId !== ROUTER_BOT_OPEN_ID && isBotSender) {
          log(`[Router] Bot sender detected: ${senderOpenId}`);
          
          // Try routing in background (don't block)
          setImmediate(async () => {
            try {
              // Parse content to lines for per-line routing
              let lines: string[] = [];
              let postContentObj: any = null;
              
              if (msgType === 'text') {
                lines = content.split('\n');
              } else if (msgType === 'post') {
                try {
                  postContentObj = JSON.parse(content || '{}');
                  const postBody = postContentObj.post?.content;
                  if (Array.isArray(postBody)) {
                    lines = postBody.map((line: any) => {
                      return line.map((item: any) => item.text || '').join('');
                    });
                  }
                } catch (e) {
                  log(`[Router] Parse post error: ${e}`);
                  lines = [content];
                }
              } else {
                lines = [content];
              }
              
              log(`[Router] Processing ${lines.length} lines`);
              
              // Process each line separately for routing
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;
                
                const routeInfo = identifyRouteTarget(trimmedLine, event.message?.mentions);
                if (routeInfo) {
                  log(`[Router] >>> Line route: "${trimmedLine.substring(0, 50)}" -> ${routeInfo.target} (port ${routeInfo.port})`);
                  
                  // Create a new event for this line
                  const lineEvent = JSON.parse(JSON.stringify(event));
                  
                  // Modify content for this line
                  if (msgType === 'text') {
                    lineEvent.message.content = routeInfo.cleanContent;
                  } else if (msgType === 'post') {
                    try {
                      const newPostContent = JSON.parse(lineEvent.message.content);
                      if (newPostContent.post?.content) {
                        newPostContent.post.content = [[{ text: routeInfo.cleanContent }]];
                        lineEvent.message.content = JSON.stringify(newPostContent);
                      }
                    } catch (e) { /* ignore */ }
                  }
                  
                  // Forward
                  await forwardToTargetWebhook(lineEvent, routeInfo.port, routeInfo.target, log);
                  log(`[Router] >>> Forwarded to ${routeInfo.target}`);
                }
              }
            } catch (err) {
              error(`[Router] Route error: ${err}`);
            }
          });
        }
      }
      
      // Normal message processing (always happens, regardless of routing)
      try {
        const feishuEvent = data as unknown as FeishuMessageEvent;
        const promise = handleFeishuMessage({
          cfg,
          event: feishuEvent,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          chatHistories,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling message: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = data as unknown as FeishuBotAddedEvent;
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const event = data as unknown as { chat_id: string };
        log(`feishu[${accountId}]: bot removed from chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
  });
}

type MonitorAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

/**
 * Monitor a single Feishu account.
 */
async function monitorSingleAccount(params: MonitorAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  // Fetch bot open_id
  const botOpenId = await fetchBotOpenId(account);
  botOpenIds.set(accountId, botOpenId ?? "");
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  const connectionMode = account.config.connectionMode ?? "websocket";
  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }
  const eventDispatcher = createEventDispatcher(account);
  const chatHistories = new Map<string, HistoryEntry[]>();



  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    account,
    runtime,
    chatHistories,
    fireAndForget: connectionMode === "webhook",
  });

  if (connectionMode === "webhook") {
    return monitorWebhook({ params, accountId, eventDispatcher });
  }

  return monitorWebSocket({ params, accountId, eventDispatcher });
}

type ConnectionParams = {
  params: MonitorAccountParams;
  accountId: string;
  eventDispatcher: Lark.EventDispatcher;
};

async function monitorWebSocket({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

async function monitorWebhook({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";
  const host = account.config.webhookHost ?? "127.0.0.1";

  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);
  
  if (account.isRouter) {
    log(`[Router] $$$ Router webhook server starting on port ${port} $$$`);
    log(`[Router] Router bot open_id: ${ROUTER_BOT_OPEN_ID}`);
  }

  const server = http.createServer();
  const webhookHandler = Lark.adaptDefault(path, eventDispatcher, { autoChallenge: true });
  server.on("request", (req, res) => {
    // Router bot: log all incoming requests
    if (account.isRouter) {
      log(`[Router] $$$ HTTP ${req.method} ${req.url} from ${req.socket.remoteAddress} $$$`);
    }
    
    res.on("finish", () => {
      recordWebhookStatus(runtime, accountId, path, res.statusCode);
    });

    const rateLimitKey = `${accountId}:${path}:${req.socket.remoteAddress ?? "unknown"}`;
    if (isWebhookRateLimited(rateLimitKey, Date.now())) {
      res.statusCode = 429;
      res.end("Too Many Requests");
      return;
    }

    if (req.method === "POST" && !isJsonContentType(req.headers["content-type"])) {
      res.statusCode = 415;
      res.end("Unsupported Media Type");
      return;
    }

    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }
    
    void Promise.resolve(webhookHandler(req, res))
      .catch((err) => {
        if (!guard.isTripped()) {
          error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
        }
      })
      .finally(() => {
        guard.dispose();
      });
  });
  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.close();
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}

/**
 * Main entry: start monitoring for all enabled accounts.
 */
export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  // If accountId is specified, only monitor that account
  if (opts.accountId) {
    const account = resolveFeishuAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  // Otherwise, start all enabled accounts
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  // Start all accounts in parallel
  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    ),
  );
}

/**
 * Stop monitoring for a specific account or all accounts.
 */
export function stopFeishuMonitor(accountId?: string): void {
  if (accountId) {
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
  } else {
    wsClients.clear();
    for (const server of httpServers.values()) {
      server.close();
    }
    httpServers.clear();
    botOpenIds.clear();
  }
}
