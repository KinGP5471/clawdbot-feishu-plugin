/**
 * 飞书卡片按钮回调处理
 *
 * 飞书的卡片按钮回调不支持 WebSocket 长连接，必须通过 HTTP 回调处理。
 * 本模块注册 /feishu/card/callback 路由来接收回调。
 *
 * 约定：发送卡片时，在按钮的 action.value 中嵌入 `_account_id` 字段，
 * 用于标识是哪个 bot 的卡片，以便路由到正确的 agent。
 *
 * 飞书卡片回调 payload 格式：
 * - URL 验证: { challenge, token, type: "url_verification" }
 * - 卡片动作: { open_id, open_message_id, open_chat_id, tenant_key, token, action: { value, tag } }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFeishuRuntime } from "./runtime.js";
import { sendTextMessage, sendPostMessage, markdownToFeishuPost } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";
import type { MsgContext } from "./msg-context.js";

/**
 * 读取 HTTP 请求体
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * 从配置中解析飞书账号
 */
function resolveAccountFromConfig(
  cfg: any,
  accountId: string
): ResolvedFeishuAccount | undefined {
  const feishuCfg = cfg?.channels?.feishu;
  if (!feishuCfg) return undefined;

  // 多账号模式
  if (feishuCfg.accounts?.[accountId]) {
    const acc = feishuCfg.accounts[accountId];
    return {
      accountId,
      appId: acc.appId,
      appSecret: acc.appSecret,
      workspace: acc.workspace,
    };
  }

  // 单账号兼容
  if (
    accountId === "default" &&
    feishuCfg.appId &&
    feishuCfg.appSecret
  ) {
    return {
      accountId: "default",
      appId: feishuCfg.appId,
      appSecret: feishuCfg.appSecret,
    };
  }

  return undefined;
}

/**
 * 创建卡片回调 HTTP 路由 handler
 *
 * @param savedConfig - 插件注册时保存的配置引用
 */
export function createCardCallbackHandler(savedConfig: any) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // 只接受 POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return;
    }

    let body: any;
    try {
      const rawBody = await readBody(req);
      body = JSON.parse(rawBody);
    } catch (err) {
      console.error("[feishu] card callback: failed to parse body:", err);
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // ── URL 验证 challenge ──────────────────────────
    if (body.type === "url_verification") {
      console.log("[feishu] card callback: URL verification challenge received");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ challenge: body.challenge }));
      return;
    }

    // ── 卡片动作回调 ────────────────────────────────
    const action = body.action;
    if (!action) {
      console.log("[feishu] card callback: no action in body, ignoring");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
      return;
    }

    // 立即返回 200，避免飞书 3 秒超时
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");

    // 异步处理回调
    setImmediate(async () => {
      try {
        const cfg = savedConfig;
        const openId = body.open_id || "";
        const openMessageId = body.open_message_id || "";
        const openChatId = body.open_chat_id || "";
        const tenantKey = body.tenant_key || "";
        const actionValue = { ...(action.value || {}) };
        const actionTag = action.tag || "unknown";
        // action.option 用于 select_static / overflow 等组件
        const actionOption = action.option || "";

        console.log(
          `[feishu] card callback: tag=${actionTag}, chat=${openChatId}, user=${openId}, msgId=${openMessageId}, value=${JSON.stringify(actionValue)}`
        );

        // ── 确定账号 ──────────────────────────────
        // 优先从 action.value._account_id 获取
        let accountId: string = actionValue._account_id || "default";
        // 从 value 中移除内部字段，不传给 agent
        delete actionValue._account_id;

        let account = resolveAccountFromConfig(cfg, accountId);
        if (!account) {
          console.warn(
            `[feishu] card callback: account "${accountId}" not found, falling back to "default"`
          );
          accountId = "default";
          account = resolveAccountFromConfig(cfg, "default");
        }
        if (!account) {
          console.error(
            "[feishu] card callback: no valid account found, dropping callback"
          );
          return;
        }

        const runtime = getFeishuRuntime();

        // ── 路由解析 ──────────────────────────────
        const isGroup = !!openChatId;
        const peerId = isGroup ? openChatId : openId;
        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "feishu",
          accountId,
          peer: {
            kind: isGroup ? ("group" as const) : ("dm" as const),
            id: peerId,
          },
        });

        console.log(
          `[feishu] card callback: route → agent=${route.agentId}, session=${route.sessionKey}`
        );

        // ── 构造消息文本 ──────────────────────────
        const valueParts: string[] = [];
        for (const [k, v] of Object.entries(actionValue)) {
          valueParts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        }
        const valueDisplay =
          valueParts.length > 0 ? valueParts.join(", ") : actionOption || "(无附加数据)";

        const msgText = [
          `[卡片回调] 用户点击了 ${actionTag}`,
          `数据: ${valueDisplay}`,
          `卡片消息ID: ${openMessageId}`,
        ].join("\n");

        // ── 构造 MsgContext ───────────────────────
        const chatId = isGroup ? openChatId : openId;
        const msgCtx: MsgContext = {
          From: openId,
          Body: msgText,
          AccountId: accountId,
          Provider: "feishu",
          Surface: "feishu",
          SessionKey: route.sessionKey,
          To: chatId,
          ChatType: isGroup ? "group" : "direct",
          OriginatingChannel: "feishu",
          OriginatingTo: chatId,
          CommandAuthorized: false,
        };

        // ── deliver 函数（发送 agent 回复） ─────────
        const deliver = async (payload: any) => {
          const text: string = (payload.text ?? "").trim();
          if (!text) return;

          const hasCodeBlock = text.includes("```");
          if (hasCodeBlock) {
            const postContent = markdownToFeishuPost(text);
            const result = await sendPostMessage(account!, chatId, postContent);
            if (!result.ok) {
              // fallback to plain text
              await sendTextMessage(account!, chatId, text);
            }
          } else {
            await sendTextMessage(account!, chatId, text);
          }
        };

        // ── 分发给 agent ──────────────────────────
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg,
          dispatcherOptions: { deliver },
        });
      } catch (err) {
        console.error("[feishu] card callback async processing error:", err);
      }
    });
  };
}
