import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";
import { checkAndRouteMessage, executeRouting } from "./router-middleware.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const log = console.log;
    const error = console.error;
    
    log(`[Router-Outbound] sendText called: to=${to}, accountId=${accountId}`);
    log(`[Router-Outbound] Text: "${text.substring(0, 200)}"`);
    
    // 先发送消息到飞书，获取真实的 message_id
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    log(`[Router-Outbound] Message sent, messageId: ${result.messageId}`);
    
    // Router middleware: check if message should be routed
    // Condition: must have accountId and be a group chat (oc_xxx format)
    const isGroupChat = to.startsWith('oc_');
    
    if (accountId && isGroupChat) {
      log(`[Router-Outbound] ✅ Condition met (accountId=${accountId}, isGroupChat=${isGroupChat}), checking routing...`);
      
      const routeResult = checkAndRouteMessage({
        cfg,
        text,
        chatId: to,  // 直接使用，不需要替换前缀
        accountId,
      });
      
      log(`[Router-Outbound] Route result: routed=${routeResult.routed}, routes=${routeResult.routes?.length || 0}`);
      
      if (routeResult.routed && routeResult.routes) {
        log(`[Router-Outbound] Routing to ${routeResult.routes.length} agent(s)...`);
        
        // 使用真实的 message_id 进行路由
        executeRouting({
          routes: routeResult.routes,
          chatId: to,  // 直接使用，不需要替换前缀
          runtime: getFeishuRuntime(),
          cfg,
          senderOpenId: 'ou_4329a1aa85b00ae1a751b2e186cde884',  // 使用真实用户的 open_id
          originalMessageId: result.messageId,  // 使用真实的飞书 message_id
        }).then(() => {
          log(`[Router-Outbound] ✅ Routing complete`);
        }).catch(err => {
          error(`[Router-Outbound] ❌ Routing failed: ${err}`);
        });
      } else {
        log(`[Router-Outbound] No routing needed`);
      }
    } else {
      log(`[Router-Outbound] ❌ Condition NOT met: accountId=${!!accountId}, isGroupChat=${isGroupChat}`);
    }
    
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const log = console.log;
    const error = console.error;
    
    log(`[Router-Outbound] sendMedia called: to=${to}, accountId=${accountId}`);
    
    // Send text first if provided (with routing check)
    if (text?.trim()) {
      const isGroupChat = to.startsWith('oc_');
      
      if (accountId && isGroupChat) {
        log(`[Router-Outbound] sendMedia ✅ Condition met, routing...`);
        
        const routeResult = checkAndRouteMessage({
          cfg,
          text,
          chatId: to,
          accountId,
        });
        
        if (routeResult.routed && routeResult.routes) {
          log(`[Router-Outbound] Routing media text to ${routeResult.routes.length} agent(s)...`);
          
          executeRouting({
            routes: routeResult.routes,
            chatId: to,
            runtime: getFeishuRuntime(),
            cfg,
            senderOpenId: 'ou_4329a1aa85b00ae1a751b2e186cde884',  // 使用真实用户的 open_id
          }).catch(err => {
            error(`[Router-Outbound] Routing failed: ${err}`);
          });
        }
      }
      
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
