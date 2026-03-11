/**
 * 飞书插件安装配置 Schema
 * 
 * 这部分配置存储在 openclaw.json 的 plugins.installs.feishu.config 中
 * 用于存放不适合放在 channels.feishu 中的插件特定参数
 */

import { z } from "zod";

/**
 * 每个飞书账户的插件级配置
 * 
 * 这些参数与渠道配置分离，原因：
 * - botOpenId: 是机器人身份标识，不是渠道连接参数
 * - isRouter: 是插件功能开关，不是渠道配置
 * - senderMentionKey: 是消息格式配置，不是渠道参数
 */
export const FeishuPluginAccountConfigSchema = z.object({
  /**
   * 机器人的 open_id
   * 用于：
   * - 检查消息是否@了 bot
   * - 构造@提及消息时排除 bot 自己
   * - 路由功能中识别目标 bot
   */
  botOpenId: z.string().optional(),
  
  /**
   * 是否启用路由功能
   * 当 bot 发送的消息包含 @其他机器人 时，自动转发到对应 agent 会话
   */
  isRouter: z.boolean().optional().default(false),
  
  /**
   * Mention 占位符格式
   * 用于在构造@消息时的占位符，例如 "@_user_1"
   * 可配置化以支持不同的格式需求
   */
  senderMentionKey: z.string().optional().default("@_user_1"),
  
  /**
   * 自定义路由映射表（可选）
   * 覆盖默认的 ROUTE_MAP
   * 格式：{ "关键词": "accountId" }
   */
  routeMap: z.record(z.string(), z.string()).optional(),
});

/**
 * 飞书插件配置
 */
export const FeishuPluginConfigSchema = z.object({
  /**
   * 多账户插件配置
   * key: accountId (与 channels.feishu.accounts 对应)
   * value: 插件级配置
   */
  accounts: z.record(z.string(), FeishuPluginAccountConfigSchema).optional(),
  
  /**
   * 全局默认 senderMentionKey
   * 当账户未配置时使用此默认值
   */
  defaultSenderMentionKey: z.string().optional().default("@_user_1"),
});

export type FeishuPluginConfig = z.infer<typeof FeishuPluginConfigSchema>;
export type FeishuPluginAccountConfig = z.infer<typeof FeishuPluginAccountConfigSchema>;
