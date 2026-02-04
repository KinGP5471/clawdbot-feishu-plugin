/**
 * 飞书长连接网关
 * 负责接收消息
 */
console.log("[feishu-gateway] MODULE LOADED - v3 with mention routing");

import * as lark from "@larksuiteoapi/node-sdk";
import * as fs from "fs";
import * as path from "path";
import type { ResolvedFeishuAccount, FeishuMessage } from "./types.js";
import { sendTextMessage, transcribeAudio, downloadMessageResource, downloadImage, getBotInfo, getQuotedMessage, getMergeForwardMessages, addReaction, removeReaction } from "./client.js";

// WebSocket 客户端缓存
const wsClientCache = new Map<string, lark.WSClient>();

// 消息去重缓存 (accountId -> Map<messageId, timestamp>)
const processedMessages = new Map<string, Map<string, number>>();
const MESSAGE_DEDUPE_TTL_MS = 60 * 1000; // 60秒过期

// 消息过期时间（30分钟）
// 如果消息发送时间距离当前时间超过此值，则不处理
// 用于避免服务重启后处理一堆过时消息（飞书对未确认消息会重试4次）
const MESSAGE_EXPIRE_TTL_MS = 30 * 60 * 1000; // 30分钟

// 会话类型缓存：chatId -> "p2p" | "group"
// 从 im.message.receive_v1 事件中学习，供卡片回调使用
const chatTypeCache = new Map<string, "p2p" | "group">();

// 自动确认回执缓存：messageId -> reactionId
// 收到消息时加 👀 reaction，回复后移除
const pendingAcknowledgements = new Map<string, { accountId: string; reactionId: string }>();

/**
 * 获取待确认的回执信息（供 channel.ts 回复后移除 reaction 使用）
 */
export function getPendingAcknowledgement(messageId: string): { accountId: string; reactionId: string } | undefined {
  return pendingAcknowledgements.get(messageId);
}

/**
 * 移除待确认的回执（回复后调用）
 */
export function removePendingAcknowledgement(messageId: string): void {
  pendingAcknowledgements.delete(messageId);
}

/**
 * 清理过期的去重缓存
 */
function cleanupDedupeCache(accountId: string): void {
  const cache = processedMessages.get(accountId);
  if (!cache) return;
  
  const now = Date.now();
  for (const [messageId, timestamp] of cache) {
    if (now - timestamp > MESSAGE_DEDUPE_TTL_MS) {
      cache.delete(messageId);
    }
  }
}

/**
 * 检查消息是否已处理过（前置去重，按 accountId 分开）
 */
function isDuplicateMessage(accountId: string, messageId: string): boolean {
  let cache = processedMessages.get(accountId);
  if (!cache) {
    cache = new Map();
    processedMessages.set(accountId, cache);
  }
  
  if (cache.has(messageId)) {
    return true;
  }
  cache.set(messageId, Date.now());
  // 定期清理
  if (cache.size > 100) {
    cleanupDedupeCache(accountId);
  }
  return false;
}

/**
 * 检查消息是否已过期
 * @param createTimeMs 消息创建时间（毫秒时间戳字符串）
 * @returns true 表示消息已过期，应该丢弃
 */
function isMessageExpired(createTimeMs: string | undefined): boolean {
  if (!createTimeMs) {
    // 如果没有创建时间，默认不过期
    return false;
  }
  const createTime = parseInt(createTimeMs, 10);
  if (isNaN(createTime)) {
    return false;
  }
  const now = Date.now();
  return now - createTime > MESSAGE_EXPIRE_TTL_MS;
}

export interface GatewayOptions {
  account: ResolvedFeishuAccount;
  onMessage: (message: FeishuMessage) => Promise<void>;
  abortSignal?: AbortSignal;
  logger?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// 机器人 open_id 缓存（accountId → open_id）
const botOpenIdCache = new Map<string, string>();

/**
 * 启动飞书长连接网关
 */

/**
 * 创建飞书事件分发器（WS 和 Webhook 模式共用）
 */
function createFeishuEventDispatcher(
  options: GatewayOptions,
  dispatcherParams?: { encryptKey?: string; verificationToken?: string },
): lark.EventDispatcher {
  const { account, onMessage, logger } = options;
  const cacheKey = account.accountId;

  return new lark.EventDispatcher({
    encryptKey: dispatcherParams?.encryptKey || "",
    verificationToken: dispatcherParams?.verificationToken || "",
  }).register({
      "im.message.receive_v1": async (data) => {
        const message = data.message;
        if (!message) return {};

        const messageId = message.message_id || "";
        const createTime = message.create_time;

        // 前置去重检查（按 accountId 分开）
        if (isDuplicateMessage(cacheKey, messageId)) {
          return {};
        }

        // 检查消息是否过期（超过30分钟的消息不处理）
        // 用于避免服务重启后处理一堆过时消息
        if (isMessageExpired(createTime)) {
          logger?.info(`Skipping expired message ${message.content}, create_time: ${createTime}`)
          return {};
        }

        // 缓存会话类型（供卡片回调使用）
        const chatId = message.chat_id || "";
        const chatType = message.chat_type === "p2p" ? "p2p" as const : "group" as const;
        if (chatId) {
          chatTypeCache.set(chatId, chatType);
        }

        // 调试：打印所有收到的消息类型和 app_id
        const messageAppId = (data as any).app_id;
        logger?.info(`[${cacheKey}] Received raw message: type=${message.message_type}, id=${messageId}, data.app_id=${messageAppId}, account.appId=${account.appId}`);
        
        // 保存原始消息到文件（按 message_id 分文件夹，文件名为 accountId）
        try {
          const msgDir = path.join("/tmp/feishu-messages", messageId);
          if (!fs.existsSync(msgDir)) {
            fs.mkdirSync(msgDir, { recursive: true });
          }
          const msgFile = path.join(msgDir, `${cacheKey}.json`);
          fs.writeFileSync(msgFile, JSON.stringify(data, null, 2));
          logger?.info(`[${cacheKey}] Saved raw message to: ${msgFile}`);
        } catch (e) {
          logger?.error(`[${cacheKey}] Failed to save message: ${e}`);
        }

        // 解析 mentions：检测机器人是否被 @ 提及
        const mentions = (message as any).mentions as Array<{
          key: string;    // "@_user_1"
          id: { union_id?: string; user_id?: string; open_id?: string };
          name: string;   // 机器人名字
          tenant_key?: string;
        }> | undefined;

        const isGroupChat = message.chat_type !== "p2p";
        
        // 检测 @_all
        const contentText = (() => {
          try {
            if (message.message_type === "text") {
              const parsed = JSON.parse(message.content || "{}");
              return parsed.text || "";
            }
          } catch {
            return "";
          }
          return "";
        })();
        const hasAtAll = contentText.includes("@_all");
        
        // 检查是否被 @ 提及
        let wasMentioned = false;
        let isMentionedThisBot = false;
        let mentionedOpenId: string | undefined;
        
        // 从缓存获取当前机器人的 open_id
        const botOpenId = botOpenIdCache.get(cacheKey);
        
        if (isGroupChat && mentions && mentions.length > 0) {
          wasMentioned = true;
          mentionedOpenId = mentions[0].id?.open_id;
          logger?.info(`[${cacheKey}] Mention detected: mentioned=${mentionedOpenId}, me=${botOpenId}, name=${mentions[0].name}`);
          
          // 检查 mentions 里的 open_id 是否是当前机器人
          if (botOpenId && mentionedOpenId === botOpenId) {
            isMentionedThisBot = true;
            logger?.info(`[${cacheKey}] This mention is for ME!`);
          }
        } else if (isGroupChat && hasAtAll) {
          wasMentioned = true;
          isMentionedThisBot = true; // @_all 视为@所有人
          logger?.info(`[${cacheKey}] @_all detected, processing`);
        }
        
        // 群消息：如果被 @ 了但不是 @ 当前机器人，跳过
        if (isGroupChat && wasMentioned && !isMentionedThisBot) {
          logger?.info(`[${cacheKey}] Skipping: mentioned=${mentionedOpenId}, not me`);
          return {};
        }
        
        // 群消息：设置 wasMentioned 标志
        // 如果有权限"获取群组中所有消息"，即使没被@也继续处理
        if (isGroupChat && !wasMentioned) {
          wasMentioned = false; // 标记为未被提及，但仍然处理
          logger?.info(`[${cacheKey}] Processing group message (not mentioned)`);
        }

        // 从 mentions 里提取被 @ 的机器人名字（如果有）
        const mentionedBotName = mentions && mentions.length > 0 ? mentions[0].name : undefined;
        
        const feishuMessage: FeishuMessage = {
          messageId,
          chatId: message.chat_id || "",
          chatType: message.chat_type === "p2p" ? "p2p" : "group",
          senderId: data.sender?.sender_id?.open_id || "",
          messageType: message.message_type || "",
          content: message.content || "",
          wasMentioned,
          appId: account.appId,  // 用当前长连接的 appId
          accountId: account.accountId,
          mentionedBotName,  // 保存被 @ 的机器人名字
        };

        // 解析文本内容
        if (feishuMessage.messageType === "text") {
          try {
            const parsed = JSON.parse(feishuMessage.content);
            let text = parsed.text || "";
            // 替换 @_user_N 占位符为实际名字
            if (mentions?.length) {
              for (const m of mentions) {
                if (m.key && m.name) {
                  text = text.replace(m.key, `@${m.name}`);
                }
              }
            }
            // 移除飞书移动端引用回复时加的 HTML 标签（如 <p>...</p>）
            text = text.replace(/<[^>]+>/g, "").trim();
            feishuMessage.text = text;
          } catch {
            // ignore
          }
        }

        // 解析富文本消息（post 类型）：提取文字 + 下载图片
        if (feishuMessage.messageType === "post") {
          try {
            const parsed = JSON.parse(feishuMessage.content);
            const blocks: any[][] = parsed.content || [];
            const textParts: string[] = [];
            let firstImageKey: string | null = null;

            for (const line of blocks) {
              for (const node of line) {
                if (node.tag === "text" && node.text) {
                  textParts.push(node.text);
                } else if (node.tag === "a" && node.text) {
                  textParts.push(`${node.text} (${node.href || ""})`);
                } else if (node.tag === "img" && node.image_key && !firstImageKey) {
                  firstImageKey = node.image_key;
                }
              }
            }

            feishuMessage.text = textParts.join("") || "";

            // 下载第一张图片
            if (firstImageKey) {
              logger?.info(`Post message has image (image_key: ${firstImageKey})`);
              const localPath = await downloadMessageResource(
                options.account,
                feishuMessage.messageId,
                firstImageKey,
                `${firstImageKey}.png`,
              );
              if (localPath) {
                feishuMessage.mediaPath = localPath;
                feishuMessage.mediaType = "image/png";
                if (!feishuMessage.text) {
                  feishuMessage.text = "[图片]";
                }
                logger?.info(`Post image saved to: ${localPath}`);
              } else {
                logger?.error(`Failed to download post image`);
              }
            }
          } catch (error) {
            logger?.error(`Error parsing post message: ${error}`);
          }
        }

        // 异步处理，不阻塞返回
        setImmediate(async () => {
          try {
            // 处理音频消息：下载并转写为文字
            if (feishuMessage.messageType === "audio") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const fileKey = parsed.file_key;
                if (fileKey) {
                  logger?.info(`Received audio message, transcribing... (file_key: ${fileKey})`);
                  const text = await transcribeAudio(options.account, feishuMessage.messageId, fileKey);
                  if (text) {
                    logger?.info(`Audio transcribed: ${text}`);
                    feishuMessage.text = text;
                    (feishuMessage as any).originalMessageType = "audio";
                    feishuMessage.messageType = "text";
                  } else {
                    logger?.error(`Audio transcription returned empty result`);
                    return;
                  }
                }
              } catch (error) {
                logger?.error(`Error transcribing audio: ${error}`);
                return;
              }
            }

            // 处理文件消息：下载文件到本地
            if (feishuMessage.messageType === "file") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const fileKey = parsed.file_key;
                const fileName = parsed.file_name || "unknown_file";
                if (fileKey) {
                  logger?.info(`Received file message: ${fileName} (file_key: ${fileKey})`);
                  const localPath = await downloadMessageResource(
                    options.account, feishuMessage.messageId, fileKey, fileName
                  );
                  if (localPath) {
                    feishuMessage.mediaPath = localPath;
                    feishuMessage.fileName = fileName;
                    // 根据文件扩展名猜测 MIME 类型
                    feishuMessage.mediaType = guessMimeType(fileName);
                    feishuMessage.text = `[文件: ${fileName}]`;
                    logger?.info(`File saved to: ${localPath}`);
                  } else {
                    logger?.error(`Failed to download file: ${fileName}`);
                    feishuMessage.text = `[文件下载失败: ${fileName}]`;
                  }
                }
              } catch (error) {
                logger?.error(`Error handling file message: ${error}`);
                feishuMessage.text = `[文件处理失败]`;
              }
            }

            // 处理图片消息：通过 messageResource API 下载用户发送的图片
            if (feishuMessage.messageType === "image") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const imageKey = parsed.image_key;
                if (imageKey) {
                  logger?.info(`Received image message (image_key: ${imageKey})`);
                  const localPath = await downloadMessageResource(
                    options.account,
                    feishuMessage.messageId,
                    imageKey,
                    `${imageKey}.png`,
                  );
                  if (localPath) {
                    feishuMessage.mediaPath = localPath;
                    feishuMessage.mediaType = "image/png";
                    feishuMessage.text = `[图片]`;
                    logger?.info(`Image saved to: ${localPath}`);
                  } else {
                    logger?.error(`Failed to download image`);
                    feishuMessage.text = `[图片下载失败]`;
                  }
                }
              } catch (error) {
                logger?.error(`Error handling image message: ${error}`);
                feishuMessage.text = `[图片处理失败]`;
              }
            }

            // 处理媒体消息（视频等）：下载到本地
            if (feishuMessage.messageType === "media") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const fileKey = parsed.file_key;
                const fileName = parsed.file_name || "media_file";
                if (fileKey) {
                  logger?.info(`Received media message: ${fileName} (file_key: ${fileKey})`);
                  const localPath = await downloadMessageResource(
                    options.account, feishuMessage.messageId, fileKey, fileName
                  );
                  if (localPath) {
                    feishuMessage.mediaPath = localPath;
                    feishuMessage.fileName = fileName;
                    feishuMessage.mediaType = guessMimeType(fileName);
                    feishuMessage.text = `[媒体: ${fileName}]`;
                    logger?.info(`Media saved to: ${localPath}`);
                  } else {
                    feishuMessage.text = `[媒体下载失败: ${fileName}]`;
                  }
                }
              } catch (error) {
                logger?.error(`Error handling media message: ${error}`);
                feishuMessage.text = `[媒体处理失败]`;
              }
            }

            // 处理表情包消息：下载表情包图片
            if (feishuMessage.messageType === "sticker") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const fileKey = parsed.file_key;
                if (fileKey) {
                  logger?.info(`Received sticker message (file_key: ${fileKey})`);
                  const localPath = await downloadMessageResource(
                    options.account, feishuMessage.messageId, fileKey, `${fileKey}.png`
                  );
                  if (localPath) {
                    feishuMessage.mediaPath = localPath;
                    feishuMessage.mediaType = "image/png";
                    feishuMessage.text = `[表情]`;
                    logger?.info(`Sticker saved to: ${localPath}`);
                  } else {
                    logger?.error(`Failed to download sticker`);
                    feishuMessage.text = `[表情]`;
                  }
                }
              } catch (error) {
                logger?.error(`Error handling sticker message: ${error}`);
                feishuMessage.text = `[表情]`;
              }
            }

            // 处理群分享消息
            if (feishuMessage.messageType === "share_chat") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const chatId = parsed.chat_id || "";
                const chatName = parsed.chat_name || chatId || "未知群聊";
                feishuMessage.text = `[分享群聊: ${chatName}]`;
                logger?.info(`Received share_chat: ${chatName} (${chatId})`);
              } catch (error) {
                logger?.error(`Error handling share_chat message: ${error}`);
                feishuMessage.text = `[分享群聊]`;
              }
            }

            // 处理名片分享消息
            if (feishuMessage.messageType === "share_user") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const userId = parsed.user_id || "";
                const userName = parsed.user_name || parsed.name || userId || "未知用户";
                feishuMessage.text = `[名片: ${userName}]`;
                logger?.info(`Received share_user: ${userName} (${userId})`);
              } catch (error) {
                logger?.error(`Error handling share_user message: ${error}`);
                feishuMessage.text = `[名片]`;
              }
            }

            // 处理合并转发消息：拉取子消息内容
            if (feishuMessage.messageType === "merge_forward") {
              logger?.info(`Received merge_forward message, fetching sub-messages...`);
              try {
                const forwardedItems = await getMergeForwardMessages(options.account, feishuMessage.messageId);
                if (forwardedItems && forwardedItems.length > 0) {
                  const lines: string[] = [`[合并转发消息，共${forwardedItems.length}条]`];
                  for (const item of forwardedItems) {
                    const sender = item.senderType === "app" ? "🤖" : "👤";
                    lines.push(`${sender} ${item.text}`);
                  }
                  feishuMessage.text = lines.join("\n");
                  logger?.info(`Merge forward parsed: ${forwardedItems.length} messages`);
                } else {
                  feishuMessage.text = `[合并转发消息（无法解析内容）]`;
                }
              } catch (err) {
                logger?.error(`Failed to parse merge_forward: ${err}`);
                feishuMessage.text = `[合并转发消息（解析失败）]`;
              }
            }

            // 处理位置消息
            if (feishuMessage.messageType === "location") {
              try {
                const parsed = JSON.parse(feishuMessage.content);
                const name = parsed.name || "未知位置";
                const latitude = parsed.latitude;
                const longitude = parsed.longitude;
                if (latitude && longitude) {
                  feishuMessage.text = `[位置: ${name} (${latitude}, ${longitude})]`;
                } else {
                  feishuMessage.text = `[位置: ${name}]`;
                }
                logger?.info(`Received location: ${name} (${latitude}, ${longitude})`);
              } catch (error) {
                logger?.error(`Error handling location message: ${error}`);
                feishuMessage.text = `[位置]`;
              }
            }

            // ── 引用回复处理 ──────────────────────────
            // 如果当前消息是对某条消息的回复（有 parent_id），
            // 则拉取被引用消息的内容，附加到当前消息中
            const parentId = (message as any).parent_id;
            if (parentId) {
              try {
                logger?.info(`Fetching quoted message: ${parentId}`);
                const quoted = await getQuotedMessage(options.account, parentId);
                if (quoted) {
                  logger?.info(`Quoted message: type=${quoted.msgType}, text=${quoted.text?.substring(0, 80)}`);

                  // 1) 如果引用的是图片且当前消息没有附件，下载引用的图片
                  if (quoted.imageKey && !feishuMessage.mediaPath) {
                    logger?.info(`Downloading quoted image: ${quoted.imageKey}`);
                    const localPath = await downloadMessageResource(
                      options.account, parentId, quoted.imageKey, `${quoted.imageKey}.png`
                    );
                    if (localPath) {
                      feishuMessage.mediaPath = localPath;
                      feishuMessage.mediaType = "image/png";
                      logger?.info(`Quoted image saved to: ${localPath}`);
                    }
                  }

                  // 2) 如果引用的是文件且当前消息没有附件，下载引用的文件
                  if (quoted.fileKey && !quoted.imageKey && !feishuMessage.mediaPath && quoted.fileName) {
                    logger?.info(`Downloading quoted file: ${quoted.fileName}`);
                    const localPath = await downloadMessageResource(
                      options.account, parentId, quoted.fileKey, quoted.fileName
                    );
                    if (localPath) {
                      feishuMessage.mediaPath = localPath;
                      feishuMessage.fileName = quoted.fileName;
                      feishuMessage.mediaType = guessMimeType(quoted.fileName);
                      logger?.info(`Quoted file saved to: ${localPath}`);
                    }
                  }

                  // 3) 如果引用的是合并转发，展开子消息
                  if (quoted.msgType === "merge_forward") {
                    try {
                      const forwardedItems = await getMergeForwardMessages(options.account, parentId);
                      if (forwardedItems && forwardedItems.length > 0) {
                        const lines: string[] = [`[引用合并转发，共${forwardedItems.length}条]`];
                        for (const item of forwardedItems) {
                          const sender = item.senderType === "app" ? "🤖" : "👤";
                          lines.push(`${sender} ${item.text}`);
                        }
                        quoted.text = lines.join("\n");
                      }
                    } catch (err) {
                      logger?.error(`Failed to expand quoted merge_forward: ${err}`);
                    }
                  }

                  // 4) 在消息文本前面加上引用内容
                  if (quoted.text && feishuMessage.text) {
                    feishuMessage.text = `[引用: "${quoted.text}"]\n${feishuMessage.text}`;
                  } else if (quoted.text && !feishuMessage.text) {
                    // 用户只引用了消息但没输入文字（比如引用后只发了个表情）
                    feishuMessage.text = `[引用: "${quoted.text}"]`;
                  }
                }
              } catch (err) {
                logger?.error(`Failed to fetch quoted message ${parentId}: ${err}`);
              }
            }

            // 自动确认回执：收到消息后立即加 👀 reaction
            // 表示 bot 已收到并开始处理，回复后自动移除
            if (account.autoAcknowledge !== false) {
              try {
                const ackResult = await addReaction(account, messageId, "Salute");
                if (ackResult.ok && ackResult.reactionId) {
                  pendingAcknowledgements.set(messageId, {
                    accountId: cacheKey,
                    reactionId: ackResult.reactionId,
                  });
                  // 5分钟后自动清理，防止内存泄漏
                  setTimeout(() => pendingAcknowledgements.delete(messageId), 5 * 60 * 1000);
                }
              } catch (ackErr) {
                // 不影响主流程
                logger?.error(`Auto-acknowledge failed for ${messageId}: ${ackErr}`);
              }
            }

            await onMessage(feishuMessage);
          } catch (error) {
            logger?.error(`Error handling message: ${error}`);
          }
        });

        // 立即返回，避免飞书超时重推
        return {};
      },

      // ── 卡片按钮回调处理 ──────────────────────────
      "card.action.trigger": async (data: any) => {
        const operator = data.operator;
        const action = data.action;
        const context = data.context;
        const openId = operator?.open_id || "";
        const actionValue = action?.value || {};
        const actionTag = action?.tag || "unknown";
        const actionOption = action?.option || "";
        const openChatId = context?.open_chat_id || "";
        const openMessageId = context?.open_message_id || "";

        logger?.info(
          `[${cacheKey}] Card callback: tag=${actionTag}, chat=${openChatId}, user=${openId}, msgId=${openMessageId}, value=${JSON.stringify(actionValue)}`
        );

        // 保存原始回调数据到文件（调试用）
        try {
          const callbackDir = "/tmp/feishu-card-callbacks";
          if (!fs.existsSync(callbackDir)) {
            fs.mkdirSync(callbackDir, { recursive: true });
          }
          const ts = Date.now();
          const callbackFile = path.join(callbackDir, `${cacheKey}_${ts}.json`);
          fs.writeFileSync(callbackFile, JSON.stringify(data, null, 2));
          logger?.info(`[${cacheKey}] Card callback saved to: ${callbackFile}`);
        } catch (e) {
          logger?.error(`[${cacheKey}] Failed to save card callback: ${e}`);
        }

        // 构造消息文本
        const valueParts: string[] = [];
        for (const [k, v] of Object.entries(actionValue)) {
          if (k.startsWith("_")) continue; // 跳过内部字段
          valueParts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        }
        const valueDisplay = valueParts.length > 0 
          ? valueParts.join(", ") 
          : actionOption || "(无附加数据)";

        const msgText = `[卡片回调] ${actionTag}: ${valueDisplay}`;

        // 确定会话类型：从缓存查找，默认 p2p
        const cachedChatType = openChatId ? chatTypeCache.get(openChatId) : undefined;
        const cardChatType = cachedChatType || "p2p";
        logger?.info(`[${cacheKey}] Card chat type: cached=${cachedChatType}, using=${cardChatType}`);

        // 构造 FeishuMessage
        // chatId 始终用 open_chat_id（oc_xxx），因为回复消息时需要它
        // senderId 用 openId（ou_xxx），用于路由解析
        const feishuMessage: FeishuMessage = {
          messageId: `card_${openMessageId}_${Date.now()}`,
          chatId: openChatId || openId,
          chatType: cardChatType,
          senderId: openId,
          messageType: "text",
          content: JSON.stringify({ text: msgText }),
          text: msgText,
          wasMentioned: true, // 点按钮视为主动交互
          appId: account.appId,
          accountId: account.accountId,
        };

        // 异步处理，不阻塞返回
        setImmediate(async () => {
          try {
            await onMessage(feishuMessage);
          } catch (error) {
            logger?.error(`[${cacheKey}] Error handling card callback: ${error}`);
          }
        });

        // 返回空对象 = 不更新卡片
        // 如果需要更新卡片，可以返回新的卡片 JSON
        return {};
      },
  });
}

export async function startGateway(options: GatewayOptions): Promise<lark.WSClient> {
  const { account, onMessage, abortSignal, logger } = options;
  const cacheKey = account.accountId;

  // 如果已存在，先停止
  const existing = wsClientCache.get(cacheKey);
  if (existing) {
    stopGateway(cacheKey);
  }

  // 先获取机器人信息（用于后续判断 mentions）
  try {
    const info = await getBotInfo(account);
    if (info && info.open_id) {
      botOpenIdCache.set(cacheKey, info.open_id);
      logger?.info(`Bot info: open_id=${info.open_id}, name=${info.app_name}`);
    } else {
      logger?.error(`Failed to get bot info: API returned null`);
    }
  } catch (err) {
    logger?.error(`Failed to get bot info: ${err}`);
  }

  const wsClient = new lark.WSClient({
    appId: account.appId,
    appSecret: account.appSecret,
    loggerLevel: lark.LoggerLevel.error,
  });

  // 监听 abortSignal，支持框架优雅停止
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      logger?.info("received abort signal, stopping gateway");
      stopGateway(cacheKey);
    }, { once: true });
  }

  // 创建事件分发器
  const dispatcher = createFeishuEventDispatcher(options);
  wsClient.start({ eventDispatcher: dispatcher });

  // 登录成功日志
  logger?.info(`logged in to feishu as ${account.appId}`);

  wsClientCache.set(cacheKey, wsClient);
  return wsClient;
}

/**
 * 根据文件名推断 MIME 类型
 */
function guessMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    // 文档
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    md: "text/markdown",
    // 图片
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    // 压缩包
    zip: "application/zip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
    tar: "application/x-tar",
    gz: "application/gzip",
    // 视频
    mp4: "video/mp4",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    // 音频
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    // 代码/密钥
    pem: "application/x-pem-file",
    key: "application/x-pem-file",
    crt: "application/x-x509-ca-cert",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/**
 * 停止网关
 */
export function stopGateway(accountId: string): void {
  const wsClient = wsClientCache.get(accountId);
  if (wsClient) {
    try {
      // 调用 SDK 提供的关闭方法（如果有的话）
      const client = wsClient as unknown as Record<string, unknown>;
      if (typeof client.close === "function") {
        (client.close as () => void)();
      } else if (typeof client.stop === "function") {
        (client.stop as () => void)();
      }
    } catch {
      // 忽略关闭错误
    }
    wsClientCache.delete(accountId);
  }
}

// ── Webhook 模式 ──────────────────────────────────────

// Webhook 清理函数缓存
const webhookCleanupCache = new Map<string, () => void>();

/**
 * 读取 HTTP 请求体
 */
function readHttpBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * 启动飞书 HTTP 回调网关（Webhook 模式）
 * 用于 Lark 国际版（不支持 WebSocket）或国内飞书的 HTTP 回调模式
 */
export async function startWebhookGateway(options: GatewayOptions): Promise<() => void> {
  const { account, onMessage, abortSignal, logger } = options;
  const cacheKey = account.accountId;

  // 清理旧的 webhook
  const existingCleanup = webhookCleanupCache.get(cacheKey);
  if (existingCleanup) {
    existingCleanup();
    webhookCleanupCache.delete(cacheKey);
  }

  // 获取机器人信息（用于 mentions 判断）
  try {
    const info = await getBotInfo(account);
    if (info && info.open_id) {
      botOpenIdCache.set(cacheKey, info.open_id);
      logger?.info(`[webhook] Bot info: open_id=${info.open_id}, name=${info.app_name}`);
    } else {
      logger?.error(`[webhook] Failed to get bot info: API returned null`);
    }
  } catch (err) {
    logger?.error(`[webhook] Failed to get bot info: ${err}`);
  }

  // 创建事件分发器（传入 encryptKey 和 verificationToken 用于 HTTP 请求验证）
  const dispatcher = createFeishuEventDispatcher(options, {
    encryptKey: account.encryptKey || "",
    verificationToken: account.verificationToken || "",
  });

  const webhookPath = account.webhookPath || "/feishu/webhook";
  logger?.info(`[webhook] Registering HTTP route: ${webhookPath}`);

  // 动态导入 plugin SDK 的 HTTP 路由注册
  const { registerPluginHttpRoute } = await import("clawdbot/plugin-sdk");

  const unregister = registerPluginHttpRoute({
    path: webhookPath,
    pluginId: "feishu",
    accountId: account.accountId,
    log: (msg: string) => logger?.info(msg),
    handler: async (req: any, res: any) => {
      // 只接受 POST
      if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("Feishu Webhook OK");
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.end("Method Not Allowed");
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readHttpBody(req);
      } catch (err) {
        logger?.error(`[webhook] Failed to read request body: ${err}`);
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }

      let data: any;
      try {
        data = JSON.parse(rawBody);
      } catch {
        logger?.error(`[webhook] Invalid JSON body`);
        res.statusCode = 400;
        res.end("Invalid JSON");
        return;
      }

      logger?.info(`[webhook] Received event: type=${data.type || data.header?.event_type || "unknown"}`);

      // ── URL Verification Challenge ──
      // 飞书/Lark 配置回调地址时发送的验证请求
      if (data.type === "url_verification") {
        logger?.info(`[webhook] URL verification challenge received`);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ challenge: data.challenge }));
        return;
      }

      // ── 加密消息的 Challenge 处理 ──
      // 如果启用了 Encrypt Key，飞书会用 AES 加密事件数据
      // EventDispatcher.invoke() 会自动解密，但 challenge 需要特殊处理
      if (data.encrypt && account.encryptKey) {
        try {
          // 尝试让 SDK 解密并处理
          // SDK 的 RequestHandle.parse() 会自动解密
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");

          // SDK invoke 会处理解密、验证、分发
          const result = await dispatcher.invoke(data);

          // 如果是 challenge，result 可能包含 challenge 响应
          if (result && typeof result === "object" && (result as any).challenge) {
            res.end(JSON.stringify(result));
          } else {
            res.end("{}");
          }
          return;
        } catch (err) {
          logger?.error(`[webhook] Failed to process encrypted event: ${err}`);
          res.statusCode = 200;
          res.end("{}");
          return;
        }
      }

      // ── 普通事件处理 ──
      // 立即返回 200，避免飞书超时重推（3秒超时）
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");

      // 异步处理事件
      try {
        // 构造带 headers 的数据（SDK 需要 headers 做验证）
        const eventData = Object.assign(
          Object.create({ headers: req.headers }),
          data,
        );
        await dispatcher.invoke(eventData);
      } catch (err) {
        logger?.error(`[webhook] Event dispatch error: ${err}`);
      }
    },
  });

  // 记录清理函数
  webhookCleanupCache.set(cacheKey, unregister);

  // 监听 abortSignal
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      logger?.info("[webhook] Received abort signal, unregistering HTTP route");
      unregister();
      webhookCleanupCache.delete(cacheKey);
    }, { once: true });
  }

  logger?.info(`[webhook] HTTP webhook gateway started on ${webhookPath}`);
  return unregister;
}
