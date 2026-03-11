/**
 * 飞书路由配置 Schema
 * 
 * 路由配置定义在 plugins.installs.feishu.config.router 中
 * 独立于账户配置，专注于路由逻辑
 * 
 * 核心设计：
 * - 在 routes 中通过 isRouter 标识哪个账户的消息需要被路由
 * - 不需要单独的 senders 列表，更直观
 */

import { z } from "zod";

/**
 * 路由目标配置
 * 定义一个可以接收路由消息的目标
 */
export const RouterTargetSchema = z.object({
  /**
   * 是否启用该账户的路由功能
   * true = 该账户发送的消息需要检查路由
   * false 或未定义 = 不检查路由
   */
  isRouter: z.boolean().optional().default(false),
  
  /**
   * 目标飞书账户 ID
   * 用于查找对应的飞书应用配置
   */
  accountId: z.string(),
  
  /**
   * 目标 Bot 的 open_id
   * 用于构造@提及消息
   */
  botOpenId: z.string(),
  
  /**
   * 目标 Bot 显示名称
   * 用于日志和调试
   */
  botName: z.string(),
  
  /**
   * 别名列表
   * 用户在消息中@这些别名时，会路由到该目标
   * 例如：@产品技术、@tech 都会路由到 product-tech
   */
  aliases: z.array(z.string()),
});

/**
 * 路由配置
 */
export const RouterConfigSchema = z.object({
  /**
   * 是否启用路由功能
   */
  enabled: z.boolean().optional().default(false),
  
  /**
   * Mention 占位符格式
   * 用于在构造@消息时的占位符，例如 "@_user_1"
   * 配置化以支持不同的格式需求
   */
  senderMentionKey: z.string().optional().default("@_user_1"),
  
  /**
   * 发送者 open_id（固定值）
   * 用于在路由消息时构造发送者身份
   * 默认值：ou_4329a1aa85b00ae1a751b2e186cde884
   */
  senderOpenId: z.string().optional().default("ou_4329a1aa85b00ae1a751b2e186cde884"),
  
  /**
   * 路由目标定义
   * key: 路由关键词（如 "tech"、"health"、"miloRouter"）
   * value: 目标配置（包含 isRouter、accountId、botOpenId、botName、aliases）
   */
  routes: z.record(z.string(), RouterTargetSchema),
});

export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type RouterTarget = z.infer<typeof RouterTargetSchema>;
