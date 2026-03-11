/**
 * 飞书消息路由中间件
 * 
 * 功能：在 bot 发送消息前拦截，检查是否包含 @其他机器人
 * 如果包含，直接通过 session_send 发送到目标 agent 的会话
 * 
 * 配置结构（plugins.installs.feishu.config.router）：
 * {
 *   "enabled": true,
 *   "senderMentionKey": "@_user_1",
 *   "senderOpenId": "ou_4329a1aa85b00ae1a751b2e186cde884",
 *   "routes": {
 *     "miloRouter": {
 *       "isRouter": true,
 *       "accountId": "milo",
 *       "botOpenId": "ou_780aa05d4ac936f7ec4a7dccec1036df",
 *       "botName": "健康-milo",
 *       "aliases": ["milo", "健康-milo"]
 *     },
 *     "techRouter": {
 *       "accountId": "product-tech",
 *       "botOpenId": "ou_31d580f87e1ea0c3b9fcdd91c115c48f",
 *       "botName": "健康 - 产品技术",
 *       "aliases": ["tech"]
 *     }
 *   }
 * }
 * 
 * 路由流程：
 * 1. Agent 生成回复
 * 2. 在 deliver 前检查回复内容
 * 3. 如果包含 @其他机器人 → 发送到目标 agent 会话
 * 4. 跳过原发送逻辑
 */

import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { dispatchRoutedMessage } from "./bot.js";
import type { RouterConfig, RouterTarget } from "./router-config.js";

/**
 * 默认路由配置（向后兼容）
 * 当 plugins.installs.feishu.config.router 未配置时使用
 */
const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enabled: false,
  senderMentionKey: "@_user_1",
  senderOpenId: "ou_4329a1aa85b00ae1a751b2e186cde884",
  routes: {
    'miloRouter': {
      isRouter: true,
      accountId: 'milo',
      botOpenId: 'ou_780aa05d4ac936f7ec4a7dccec1036df',
      botName: '健康-milo',
      aliases: ['milo'],
    },
    'techRouter': {
      accountId: 'product-tech',
      botOpenId: 'ou_31d580f87e1ea0c3b9fcdd91c115c48f',
      botName: '健康 - 产品技术',
      aliases: ['tech'],
    },
    'healthRouter': {
      accountId: 'health-advisor',
      botOpenId: 'ou_e5dc2412f29e7f9c78ecadecca788d18',
      botName: '健康 - 健康顾问',
      aliases: ['health'],
    },
    'marketingRouter': {
      accountId: 'marketing',
      botOpenId: 'ou_1421ad51aad4f5d27fa2859710703759',
      botName: '健康 - 营销增长',
      aliases: ['marketing'],
    },
    'internalAffairsRouter': {
      accountId: 'internal-affairs',
      botOpenId: 'ou_18dbf4619ced6706c9ffa4e25c3767f9',
      botName: '健康 - 内务',
      aliases: ['finance'],
    },
  },
};

/**
 * 从配置中获取 router 配置
 * 优先级：plugins.entries.feishu.config.router > DEFAULT_ROUTER_CONFIG
 */
function getRouterConfig(cfg: ClawdbotConfig): RouterConfig {
  // 从 plugins.entries.feishu.config 读取
  const entryConfig = cfg.plugins?.entries?.feishu?.config?.router as RouterConfig | undefined;
  
  if (entryConfig && entryConfig.enabled) {
    return {
      ...DEFAULT_ROUTER_CONFIG,
      ...entryConfig,
      routes: {
        ...DEFAULT_ROUTER_CONFIG.routes,
        ...entryConfig.routes,
      },
    };
  }
  
  // 使用默认配置
  return DEFAULT_ROUTER_CONFIG;
}

/**
 * 构建别名到路由 key 的映射
 * 例如：{ "tech": "techRouter", "health": "healthRouter" }
 */
function buildAliasToRouteKeyMap(routerConfig: RouterConfig): Record<string, string> {
  const aliasMap: Record<string, string> = {};
  
  for (const [routeKey, target] of Object.entries(routerConfig.routes)) {
    for (const alias of target.aliases) {
      aliasMap[alias] = routeKey;
    }
  }
  
  return aliasMap;
}

/**
 * 构建 accountId 到 route key 的映射
 * 用于快速查找当前账户是否启用了路由
 * 例如：{ "milo": "miloRouter", "product-tech": "techRouter" }
 */
function buildAccountIdToRouteKeyMap(routerConfig: RouterConfig): Record<string, string> {
  const accountMap: Record<string, string> = {};
  
  for (const [routeKey, target] of Object.entries(routerConfig.routes)) {
    if (target.isRouter) {
      accountMap[target.accountId] = routeKey;
    }
  }
  
  return accountMap;
}

/**
 * 检查当前账户是否启用了路由功能
 */
function isAccountRouterEnabled(params: {
  accountId: string;
  routerConfig: RouterConfig;
  accountMap: Record<string, string>;
}): boolean {
  const { accountId, routerConfig, accountMap } = params;
  
  const routeKey = accountMap[accountId];
  if (!routeKey) {
    return false;
  }
  
  const route = routerConfig.routes[routeKey];
  return route?.isRouter === true;
}

/**
 * 解析路由目标（只检查文本中的@关键词）
 * 不影响正常的 mentions 检测
 */
function parseRouteTargets(params: {
  content: string;
  aliasMap: Record<string, string>;
  excludeRouteKey?: string;  // 排除的路由 key（当前账户自己）
}): string[] {
  const { content, aliasMap, excludeRouteKey } = params;
  const targets: string[] = [];
  const seen = new Set<string>();
  
  const textMatches = content.match(/@([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g);
  if (textMatches) {
    for (const match of textMatches) {
      const name = match.substring(1);
      // 只保留在 aliasMap 中定义的别名
      const routeKey = aliasMap[name];
      if (routeKey && routeKey !== excludeRouteKey && !seen.has(name)) {
        targets.push(name);
        seen.add(name);
      }
    }
  }
  
  return targets;
}

/**
 * 按行分析消息内容，识别需要路由的行
 * 支持一行中@多个机器人
 */
function analyzeMessageForRouting(params: {
  text: string;
  routerConfig: RouterConfig;
  aliasMap: Record<string, string>;
  excludeRouteKey?: string;  // 排除的路由 key（当前账户自己）
}): Array<{
  alias: string;       // 用户使用的别名（如 "tech"）
  routeKey: string;    // 路由 key（如 "techRouter"）
  target: RouterTarget;
  message: string;
}> {
  const { text, routerConfig, aliasMap, excludeRouteKey } = params;
  const routes: Array<{
    alias: string;
    routeKey: string;
    target: RouterTarget;
    message: string;
  }> = [];
  
  const lines = text.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    // 使用 parseRouteTargets 检测@关键词
    const aliases = parseRouteTargets({
      content: trimmedLine,
      aliasMap,
      excludeRouteKey,
    });
    
    for (const alias of aliases) {
      const routeKey = aliasMap[alias];
      const target = routerConfig.routes[routeKey];
      
      if (!target) {
        continue;
      }
      
      routes.push({
        alias,
        routeKey,
        target,
        message: trimmedLine,
      });
    }
  }
  
  return routes;
}

/**
 * 路由结果
 */
export type RouteResult = {
  routed: boolean;
  routes?: Array<{
    alias: string;      // 用户使用的别名（如 "tech"）
    routeKey: string;   // 路由 key（如 "techRouter"）
    accountId: string;  // 飞书 accountId
    botOpenId: string;  // 目标 Bot 的 open_id
    botName: string;    // Bot 显示名称
    message: string;    // 消息内容
  }>;
};

/**
 * 检查并路由消息
 * 
 * @returns 如果已路由，返回 { routed: true, routes: [...] }
 *          如果无需路由，返回 { routed: false }
 */
export function checkAndRouteMessage(params: {
  cfg: ClawdbotConfig;
  text: string;
  chatId: string;
  accountId: string;
  senderOpenId: string;
  runtime?: RuntimeEnv;
}): RouteResult {
  const { cfg, text, chatId, accountId, senderOpenId, runtime } = params;
  const log = runtime?.log ?? console.log;
  
  // 获取 router 配置
  const routerConfig = getRouterConfig(cfg);
  
  if (!routerConfig.enabled) {
    log(`[Router] ❌ Skip: router.enabled=false`);
    return { routed: false };
  }
  
  // 构建映射表
  const aliasMap = buildAliasToRouteKeyMap(routerConfig);
  const accountMap = buildAccountIdToRouteKeyMap(routerConfig);
  
  // 检查当前账户是否启用了路由
  const isRouterEnabled = isAccountRouterEnabled({
    accountId,
    routerConfig,
    accountMap,
  });
  
  if (!isRouterEnabled) {
    log(`[Router] ❌ Skip: accountId ${accountId} does not have isRouter=true`);
    return { routed: false };
  }
  
  // 获取当前账户对应的 route key（用于排除自己）
  const currentRouteKey = accountMap[accountId];
  
  // 获取配置参数
  const senderMentionKey = routerConfig.senderMentionKey || '@_user_1';
  const defaultSenderOpenId = routerConfig.senderOpenId || 'ou_4329a1aa85b00ae1a751b2e186cde884';
  
  log(`[Router] 🔍 Check routing for: "${text.substring(0, 100)}"`);
  log(`[Router] 📍 Account: ${accountId}, ChatId: ${chatId}, Sender: ${senderOpenId}`);
  log(`[Router] 🔑 Using senderMentionKey: ${senderMentionKey}`);
  log(`[Router] 👤 Using senderOpenId: ${defaultSenderOpenId}`);
  log(`[Router] 🗺️  Alias map: ${JSON.stringify(aliasMap)}`);
  log(`[Router] 🎯 Current route key: ${currentRouteKey || 'unknown'}`);
  
  // 按行分析，检测@关键词（排除当前账户自己）
  const routes = analyzeMessageForRouting({
    text,
    routerConfig,
    aliasMap,
    excludeRouteKey: currentRouteKey,
  });
  
  if (routes.length === 0) {
    log(`[Router] ❌ No route targets found`);
    return { routed: false };
  }
  
  log(`[Router] ✅ Found ${routes.length} route(s):`);
  routes.forEach((route, i) => {
    log(`[Router]   [${i + 1}] @${route.alias} (${route.routeKey}) → ${route.target.accountId} (${route.target.botName})`);
    log(`[Router]       BotOpenId: ${route.target.botOpenId}`);
    log(`[Router]       Message: "${route.message.substring(0, 100)}"`);
  });
  
  return {
    routed: true,
    routes: routes.map(r => ({
      alias: r.alias,
      routeKey: r.routeKey,
      accountId: r.target.accountId,
      botOpenId: r.target.botOpenId,
      botName: r.target.botName,
      message: r.message,
    })),
  };
}

/**
 * 执行路由 - 发送消息到目标飞书账户
 */
export async function executeRouting(params: {
  routes: Array<{
    alias: string;
    routeKey: string;
    accountId: string;
    botOpenId: string;
    botName: string;
    message: string;
  }>;
  chatId: string;
  senderOpenId?: string;
  originalMessageId?: string;  // 原始消息的真实飞书 message_id
  runtime?: RuntimeEnv;
  cfg: ClawdbotConfig;
}): Promise<boolean> {
  const { routes, chatId, senderOpenId, originalMessageId, runtime, cfg } = params;
  const log = runtime?.log ?? console.log;
  
  // 获取 router 配置中的 senderOpenId
  const routerConfig = getRouterConfig(cfg);
  const defaultSenderOpenId = routerConfig.senderOpenId || 'ou_4329a1aa85b00ae1a751b2e186cde884';
  
  log(`[Router] 🚀 Start executing routing for ${routes.length} target(s)`);
  
  for (const route of routes) {
    try {
      log(`[Router] 📤 Routing to accountId: ${route.accountId}`);
      log(`[Router]    Route Key: ${route.routeKey}`);
      log(`[Router]    Alias Used: @${route.alias}`);
      log(`[Router]    Bot Name: ${route.botName}`);
      log(`[Router]    Bot OpenId: ${route.botOpenId}`);
      log(`[Router]    Message: "${route.message.substring(0, 100)}"`);
      log(`[Router]    Original messageId: ${originalMessageId || 'none'}`);
      
      // 调用 dispatchRoutedMessage，创建独立 context
      await dispatchRoutedMessage({
        cfg,
        targetAccountId: route.accountId,
        message: route.message,
        targetName: route.alias,
        chatId,
        senderOpenId: senderOpenId || defaultSenderOpenId,
        originalMessageId,  // 传递真实的 message_id
        runtime,
      });
      
      log(`[Router] ✅ Dispatched to ${route.accountId} successfully`);
      
    } catch (err) {
      log(`[Router] ❌ Route to ${route.accountId} failed: ${err}`);
    }
  }
  
  log(`[Router] 🏁 Routing execution complete`);
  return true;
}

/**
 * 检查路由是否启用
 */
export function isRouterEnabled(cfg: ClawdbotConfig): boolean {
  const routerConfig = getRouterConfig(cfg);
  return routerConfig.enabled === true;
}
