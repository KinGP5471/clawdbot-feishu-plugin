/**
 * 飞书通道插件定义
 */

import type {
  ChannelPlugin,
  ClawdbotConfig,
  ChannelOnboardingAdapter,
} from "clawdbot/plugin-sdk";
import type { ResolvedFeishuAccount, FeishuChannelConfig } from "./types.js";
import { sendTextMessage, sendMedia, sendPostMessage, sendInteractiveMessage, markdownToFeishuPost, addReaction, removeReaction, deleteMessage, updateMessage, replyMessage, getApiDomain } from "./client.js";
import { startGateway, startWebhookGateway } from "./gateway.js";
import { getFeishuRuntime } from "./runtime.js";
import type { MsgContext } from "./msg-context.js";
import { syncBotInfo } from "./bot-info-sync.js";
import { detectMentionedBots, replaceWithFeishuMentions, getBotByAccountId, type BotRegistryEntry } from "./bot-registry.js";

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_ID = "feishu" as const;

/**
 * 获取飞书通道配置
 */
function getFeishuConfig(cfg: ClawdbotConfig): FeishuChannelConfig | undefined {
  return (cfg as any).channels?.feishu as FeishuChannelConfig | undefined;
}

/**
 * 从配置中获取飞书账号列表（支持多账号）
 */
function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
  const feishuCfg = getFeishuConfig(cfg);
  if (!feishuCfg || feishuCfg.enabled === false) return [];

  // 多账号模式
  if (feishuCfg.accounts) {
    return Object.keys(feishuCfg.accounts).filter(
      (id) =>
        feishuCfg.accounts![id].appId && feishuCfg.accounts![id].appSecret
    );
  }

  // 单账号模式（向后兼容）
  if (feishuCfg.appId && feishuCfg.appSecret) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * 解析飞书账号配置（支持多账号）
 */
function resolveFeishuAccount(
  cfg: ClawdbotConfig,
  accountId: string
): ResolvedFeishuAccount | undefined {
  const feishuCfg = getFeishuConfig(cfg);
  if (!feishuCfg) return undefined;

  // 多账号模式
  if (feishuCfg.accounts && feishuCfg.accounts[accountId]) {
    const acc = feishuCfg.accounts[accountId];
    return {
      accountId,
      appId: acc.appId,
      appSecret: acc.appSecret,
      workspace: acc.workspace,
      autoAcknowledge: acc.autoAcknowledge,
      domain: acc.domain || feishuCfg.domain,
      mode: acc.mode || feishuCfg.mode,
      webhookPath: acc.webhookPath || feishuCfg.webhookPath,
      encryptKey: acc.encryptKey || feishuCfg.encryptKey,
      verificationToken: acc.verificationToken || feishuCfg.verificationToken,
    };
  }

  // 单账号模式（向后兼容）
  if (accountId === DEFAULT_ACCOUNT_ID && feishuCfg.appId && feishuCfg.appSecret) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      appId: feishuCfg.appId,
      appSecret: feishuCfg.appSecret,
      domain: feishuCfg.domain,
      mode: feishuCfg.mode,
      webhookPath: feishuCfg.webhookPath,
      encryptKey: feishuCfg.encryptKey,
      verificationToken: feishuCfg.verificationToken,
    };
  }

  return undefined;
}

/**
 * 飞书 Onboarding Adapter
 * 用于 clawdbot onboard 交互式配置向导
 */
const feishuOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: CHANNEL_ID,

  getStatus: async ({ cfg }) => {
    const feishuCfg = getFeishuConfig(cfg);
    const configured = !!(feishuCfg?.appId && feishuCfg?.appSecret);
    return {
      channel: CHANNEL_ID,
      configured,
      statusLines: [`Feishu: ${configured ? "configured" : "needs App ID & Secret"}`],
      selectionHint: configured ? "configured" : "needs credentials",
    };
  },

  configure: async (ctx) => {
    const { cfg, prompter } = ctx;
    let next = cfg;
    const currentCfg = getFeishuConfig(cfg);
    const hasAppId = !!currentCfg?.appId;
    const hasAppSecret = !!currentCfg?.appSecret;

    // 显示帮助信息
    await prompter.note(
      [
        "1) 登录飞书开放平台 → 创建企业自建应用",
        "2) 获取 App ID 和 App Secret",
        "3) 启用机器人能力，配置消息接收方式为「使用长连接接收消息」",
        "4) 发布应用并授权",
        "Docs: https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes",
      ].join("\n"),
      "飞书机器人配置"
    );

    let appId: string | null = null;
    let appSecret: string | null = null;

    // App ID
    if (hasAppId) {
      const keep = await prompter.confirm({
        message: `App ID 已配置 (${currentCfg!.appId.slice(0, 8)}...)，是否保留？`,
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: "请输入飞书 App ID",
            validate: (value) => (value?.trim() ? undefined : "必填"),
          })
        ).trim();
      }
    } else {
      appId = String(
        await prompter.text({
          message: "请输入飞书 App ID",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        })
      ).trim();
    }

    // App Secret
    if (hasAppSecret) {
      const keep = await prompter.confirm({
        message: "App Secret 已配置，是否保留？",
        initialValue: true,
      });
      if (!keep) {
        appSecret = String(
          await prompter.text({
            message: "请输入飞书 App Secret",
            validate: (value) => (value?.trim() ? undefined : "必填"),
          })
        ).trim();
      }
    } else {
      appSecret = String(
        await prompter.text({
          message: "请输入飞书 App Secret",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        })
      ).trim();
    }

    // 更新配置
    next = {
      ...next,
      channels: {
        ...(next as any).channels,
        feishu: {
          ...(next as any).channels?.feishu,
          enabled: true,
          ...(appId ? { appId } : {}),
          ...(appSecret ? { appSecret } : {}),
        },
      },
    } as ClawdbotConfig;

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...(cfg as any).channels,
      feishu: { ...(cfg as any).channels?.feishu, enabled: false },
    },
  } as ClawdbotConfig),
};

// ──────────────────────────────────────────────
// 引用回复辅助函数
// ──────────────────────────────────────────────

/**
 * 发送文本消息，支持引用回复
 * 如果 replyToId 有值，用飞书 reply API（引用原消息）；否则用普通 create API
 */
async function sendTextWithReply(
  account: ResolvedFeishuAccount,
  chatId: string,
  text: string,
  replyToId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (replyToId) {
    const result = await replyMessage(account, replyToId, "text", JSON.stringify({ text }));
    if (result.ok) return result;
    // reply 失败（消息已删除/过期等），fallback 到普通发送
    console.log(`[feishu] reply failed (${result.error}), fallback to send`);
  }
  return sendTextMessage(account, chatId, text);
}

/**
 * 发送富文本消息，支持引用回复
 */
async function sendPostWithReply(
  account: ResolvedFeishuAccount,
  chatId: string,
  content: any[][],
  replyToId?: string,
  title?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (replyToId) {
    const postContent = { zh_cn: { title: title || "", content } };
    const result = await replyMessage(account, replyToId, "post", JSON.stringify(postContent));
    if (result.ok) return result;
    console.log(`[feishu] reply post failed (${result.error}), fallback to send`);
  }
  return sendPostMessage(account, chatId, content, title);
}

// ──────────────────────────────────────────────
// Bot 间 @ 转发机制
// ──────────────────────────────────────────────

/**
 * 转发上下文：用"已访问边"防循环，用深度做兜底安全网
 * - visitedEdges: 已经转发过的 "发送方→接收方" 对，防止同一对重复转发导致死循环
 * - depth: 纯安全兜底，防止极端情况下无限递归
 */
interface ForwardContext {
  depth: number;
  visitedEdges: Set<string>;
}

const MAX_FORWARD_DEPTH = 30; // 安全兜底上限（正常流程靠 visitedEdges 控制）

/**
 * 转发 @ 消息给目标 bot
 * 在群里发消息后，如果 @ 了其他 bot，通过内部 dispatch 触发目标 bot 处理
 */
async function forwardMentionToBot(
  targetBot: BotRegistryEntry,
  chatId: string,
  originalText: string,
  senderAccount: ResolvedFeishuAccount,
  cfg: any,
  ctx: ForwardContext,
): Promise<void> {
  // 安全兜底
  if (ctx.depth >= MAX_FORWARD_DEPTH) {
    console.warn(`[feishu] ⚠️ 转发深度达到 ${MAX_FORWARD_DEPTH}，强制停止`);
    return;
  }

  // 防循环：同一 A→B 边只转发一次
  const edge = `${senderAccount.accountId}→${targetBot.accountId}`;
  if (ctx.visitedEdges.has(edge)) {
    console.log(`[feishu] ⏭️ 跳过重复转发: ${edge} (已在本轮转发过)`);
    return;
  }

  const runtime = getFeishuRuntime();

  // 解析目标 bot 的路由
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId: targetBot.accountId,
    peer: { kind: "group" as const, id: chatId },
  });

  const senderBot = getBotByAccountId(senderAccount.accountId);
  const senderName = senderBot?.name || senderAccount.accountId;
  console.log(`[feishu] 📨 转发: ${senderName} → ${targetBot.name}, session=${route.sessionKey}, depth=${ctx.depth}, edges=${ctx.visitedEdges.size}`);

  // 记录这条边
  const newCtx: ForwardContext = {
    depth: ctx.depth + 1,
    visitedEdges: new Set([...ctx.visitedEdges, edge]),
  };

  // 构建入站消息上下文（模拟群消息）
  const msgCtx: MsgContext = {
    From: senderBot?.openId || senderAccount.appId,
    Body: originalText,
    AccountId: targetBot.accountId,
    Provider: "feishu",
    Surface: "feishu",
    SessionKey: route.sessionKey,
    To: chatId,
    ChatType: "group",
    CommandAuthorized: false,
    WasMentioned: true,
  };

  // dispatch 到目标 bot 的 agent，目标 bot 的回复通过 deliver 发到群里
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver: createGroupDeliver(targetBot.account, chatId, cfg, newCtx),
    },
  });
}

/**
 * 创建群消息 deliver 函数（支持 @ 检测和递归转发）
 */
function createGroupDeliver(
  senderAccount: ResolvedFeishuAccount,
  chatId: string,
  cfg: any,
  forwardCtx: ForwardContext,
): (payload: any) => Promise<void> {
  let replied = false; // 只对第一条消息做引用回复

  return async (payload: any) => {
    const text = payload.text ?? "";
    const replyToId = !replied ? payload.replyToId : undefined;
    const mediaUrls: string[] = [
      ...(payload.mediaUrls ?? []),
      ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ];

    // 检测 @其他Bot
    const mentionedBots = detectMentionedBots(text, senderAccount.accountId);
    const sendText = mentionedBots.length > 0
      ? replaceWithFeishuMentions(text, mentionedBots)
      : text;

    // 发送到群（支持引用回复）
    if (mediaUrls.length > 0) {
      // 媒体消息：先发文字（带引用），再发媒体
      if (sendText?.trim()) {
        await sendTextWithReply(senderAccount, chatId, sendText, replyToId);
        replied = true;
      }
      for (const url of mediaUrls) {
        const result = await sendMedia(senderAccount, chatId, url);
        if (!result.ok) {
          console.error(`[feishu:${senderAccount.accountId}] sendMedia failed: ${result.error}`);
        }
      }
    } else if (sendText) {
      const hasCodeBlock = sendText.includes('```');
      if (hasCodeBlock) {
        const postContent = markdownToFeishuPost(sendText);
        const result = await sendPostWithReply(senderAccount, chatId, postContent, replyToId);
        if (!result.ok) {
          await sendTextWithReply(senderAccount, chatId, sendText, replyToId);
        }
        replied = true;
      } else {
        await sendTextWithReply(senderAccount, chatId, sendText, replyToId);
        replied = true;
      }
    }

    // 转发给被 @ 的 bot（用 visitedEdges 防循环，depth 做兜底）
    if (forwardCtx.depth < MAX_FORWARD_DEPTH && mentionedBots.length > 0) {
      for (const targetBot of mentionedBots) {
        await forwardMentionToBot(targetBot, chatId, text, senderAccount, cfg, forwardCtx);
      }
    }
  };
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",

  meta: {
    id: "feishu",
    label: "Feishu",
    selectionLabel: "飞书 (Feishu/Lark)",
    docsPath: "https://open.feishu.cn/document",
    blurb: "飞书机器人通道，支持私聊和群聊",
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    reply: true,
    media: true,
  },

  // 消息目标解析（message tool 发消息时使用）
  messaging: {
    targetResolver: {
      looksLikeId: (raw: string) => raw.startsWith("oc_") || raw.startsWith("ou_"),
      hint: "Use a chat_id (oc_xxx) or open_id (ou_xxx)",
    },
  },

  // Message actions (reactions, deleteMessage, editMessage)
  actions: {
    listActions: ({ cfg }: { cfg: any }) => {
      const feishuCfg = getFeishuConfig(cfg);
      if (!feishuCfg || feishuCfg.enabled === false) return [];
      const actions: string[] = ["send", "react", "deleteMessage", "editMessage"];
      return actions;
    },
    supportsAction: ({ action }: { action: string }) => {
      return ["react", "deleteMessage", "editMessage"].includes(action);
    },
    handleAction: async ({ action, params, cfg, accountId }: {
      action: string;
      params: Record<string, any>;
      cfg: any;
      accountId?: string;
    }) => {
      const resolvedAccountId = accountId || "default";
      const account = resolveFeishuAccount(cfg, resolvedAccountId);
      if (!account) {
        return { text: JSON.stringify({ ok: false, error: `Feishu account "${resolvedAccountId}" not found` }) };
      }

      if (action === "react") {
        const messageId = params.messageId;
        if (!messageId) throw new Error("messageId is required for react action");
        const emoji = params.emoji;
        if (!emoji) throw new Error("emoji is required for react action (e.g. THUMBSUP, SMILE, HEART)");
        const remove = params.remove === true;
        if (remove) {
          const reactionId = params.reactionId;
          if (!reactionId) throw new Error("reactionId is required to remove a reaction");
          const result = await removeReaction(account, messageId, reactionId);
          return { text: JSON.stringify(result) };
        }
        const result = await addReaction(account, messageId, emoji);
        return { text: JSON.stringify(result) };
      }

      if (action === "deleteMessage") {
        const messageId = params.messageId;
        if (!messageId) throw new Error("messageId is required for deleteMessage action");
        const result = await deleteMessage(account, messageId);
        return { text: JSON.stringify(result) };
      }

      if (action === "editMessage") {
        const messageId = params.messageId;
        if (!messageId) throw new Error("messageId is required for editMessage action");
        const content = params.content;
        if (!content) throw new Error("content is required for editMessage action");
        const msgType = params.msgType || "text";
        const result = await updateMessage(account, messageId, content, msgType);
        return { text: JSON.stringify(result) };
      }

      throw new Error(`Action "${action}" is not supported for feishu.`);
    },
  },

  // Channel config schema for Control UI
  configSchema: {
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true, description: "启用飞书通道" },
        accounts: {
          type: "object",
          description: "多账号配置（推荐：每个 Agent 一个飞书应用）",
          additionalProperties: {
            type: "object",
            properties: {
              appId: { type: "string", description: "飞书应用 App ID" },
              appSecret: { type: "string", description: "飞书应用 App Secret" },
              workspace: { type: "string", description: "Agent workspace 路径（可选，用于绑定 Agent）" },
              autoAcknowledge: { type: "boolean", description: "收到消息时自动加 👀 回执，回复后移除（默认 true）" },
            },
            required: ["appId", "appSecret"],
          },
        },
        appId: { type: "string", description: "飞书应用 App ID（仅单账号模式使用）" },
        appSecret: { type: "string", description: "飞书应用 App Secret（仅单账号模式使用）" },
      },
    },
    uiHints: {
      "enabled": { label: "启用", help: "启用或禁用飞书通道" },
      "accounts": { label: "账号列表", help: "多账号配置，每个 key 对应一个飞书应用" },
      "appId": { label: "App ID（单账号）", help: "仅在不使用多账号模式时填写", advanced: true },
      "appSecret": { label: "App Secret（单账号）", sensitive: true, help: "仅在不使用多账号模式时填写", advanced: true },
      "accounts.*.appId": { label: "App ID" },
      "accounts.*.appSecret": { label: "App Secret", sensitive: true },
      "accounts.*.workspace": { label: "Workspace 路径", advanced: true },
      "accounts.*.autoAcknowledge": { label: "自动确认回执", help: "收到消息时加 👀，回复后自动移除（默认开启）" },
    },
  },

  // Onboarding 配置向导
  onboarding: feishuOnboardingAdapter,

  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount(cfg, accountId),
    isConfigured: async (account) => !!(account.appId && account.appSecret),
  },

  // Channel status hooks for Control UI
  status: {
    // 探测账号连通性（验证 App 凭证）
    probeAccount: async ({ account, timeoutMs }: { account: ResolvedFeishuAccount; timeoutMs: number }) => {
      if (!account.appId || !account.appSecret) {
        return { ok: false, error: "未配置 App 凭证" };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
        const apiDomain = getApiDomain(account.domain);
        const resp = await fetch(
          `${apiDomain}/open-apis/auth/v3/tenant_access_token/internal`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              app_id: account.appId,
              app_secret: account.appSecret,
            }),
            signal: controller.signal,
          }
        );
        clearTimeout(timer);
        const data = await resp.json() as { code?: number; msg?: string; tenant_access_token?: string };
        if (data.code === 0 && data.tenant_access_token) {
          return { ok: true, appId: account.appId };
        }
        return { ok: false, error: data.msg || "凭证无效" };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },

    // 构建账号快照（Control UI 账号卡片展示）
    buildAccountSnapshot: ({ account, runtime, probe }: {
      account: ResolvedFeishuAccount;
      cfg: any;
      runtime?: any;
      probe?: any;
      audit?: any;
    }) => {
      const configured = !!(account.appId && account.appSecret);
      return {
        accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        name: account.accountId ?? DEFAULT_ACCOUNT_ID,
        enabled: account.enabled !== false,
        configured,
        running: runtime?.running ?? false,
        connected: probe?.ok ?? undefined,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe: probe ? { ok: probe.ok, error: probe.error, appId: probe.appId } : undefined,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },

    // 构建频道级别摘要
    buildChannelSummary: ({ snapshot }: { account: any; cfg: any; defaultAccountId: string; snapshot: any }) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      connected: snapshot?.connected ?? undefined,
      lastError: snapshot?.lastError ?? null,
    }),
  },

  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 4000,
    sendText: async (ctx: any) => {
      // 从 cfg + accountId 解析 account（outbound 标准流程不传 account 对象）
      const accountId = ctx.accountId || "default";
      console.log(`[feishu:outbound] sendText called → ctx.accountId=${ctx.accountId}, resolved=${accountId}, to=${ctx.to}, text=${ctx.text?.substring(0,50)}...`);
      if (!ctx.accountId) {
        console.warn(`[feishu:outbound] sendText accountId missing, falling back to "${accountId}" (to=${ctx.to})`);
      }
      const account = resolveFeishuAccount(ctx.cfg, accountId);
      console.log(`[feishu:outbound] resolvedAccount → accountId=${account?.accountId}, appId=${account?.appId?.slice(0,8)}...`);
      if (!account) {
        return { ok: false, error: new Error(`Feishu account "${accountId}" not found`) };
      }
      // 支持引用回复（框架通过 replyToId 传递目标消息 ID）
      const result = await sendTextWithReply(account, ctx.to, ctx.text, ctx.replyToId);
      return {
        ok: result.ok,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async (ctx: any) => {
      const accountId = ctx.accountId || "default";
      console.log(`[feishu:outbound] sendMedia called → ctx.accountId=${ctx.accountId}, resolved=${accountId}, to=${ctx.to}`);
      if (!ctx.accountId) {
        console.warn(`[feishu:outbound] sendMedia accountId missing, falling back to "${accountId}" (to=${ctx.to})`);
      }
      const account = resolveFeishuAccount(ctx.cfg, accountId);
      if (!account) {
        return { ok: false, error: new Error(`Feishu account "${accountId}" not found`) };
      }
      const mediaUrl = ctx.mediaUrl as string | undefined;
      if (!mediaUrl) {
        return { ok: false, error: new Error("No mediaUrl provided") };
      }
      const caption = ctx.text || "";
      const result = await sendMedia(account, ctx.to, mediaUrl, caption);
      return {
        ok: result.ok,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendInteractive: async (ctx: any) => {
      const accountId = ctx.accountId || "default";
      if (!ctx.accountId) {
        console.warn(`[feishu:outbound] sendInteractive accountId missing, falling back to "${accountId}" (to=${ctx.to})`);
      }
      const account = resolveFeishuAccount(ctx.cfg, accountId);
      if (!account) {
        return { ok: false, error: new Error(`Feishu account "${accountId}" not found`) };
      }
      const card = ctx.card as Record<string, any> | undefined;
      if (!card) {
        return { ok: false, error: new Error("No card payload provided") };
      }
      const result = await sendInteractiveMessage(account, ctx.to, card);
      return {
        ok: result.ok,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const runtime = getFeishuRuntime();
      const account = ctx.account;
      const cfg = ctx.cfg;

      // 同步机器人信息到 workspace
      await syncBotInfo(account);

      // 根据配置选择 WebSocket 或 HTTP Webhook 模式
      // Lark 国际版必须用 webhook（不支持 WebSocket 长连接）
      const useWebhook = account.mode === "webhook" || (account.domain === "lark" && account.mode !== "ws");
      const gatewayStarter = useWebhook ? startWebhookGateway : startGateway;

      if (useWebhook) {
        console.log(`[feishu:${account.accountId}] Starting in WEBHOOK mode (path: ${account.webhookPath || "/feishu/webhook"})`);
      } else {
        console.log(`[feishu:${account.accountId}] Starting in WebSocket mode`);
      }

      await gatewayStarter({
        account,
        abortSignal: ctx.abortSignal,
        onMessage: async (message) => {
          // 需要有文本内容（文本消息、已转写的音频、已下载的文件/图片）
          if (!message.text) {
            return;
          }

          // 群消息：如果没被 @，收到但不回复（静默接收）
          if (message.chatType === "group" && !message.wasMentioned) {
            console.log(`[feishu:${account.accountId}] 收到群消息但未被@，不回复: ${message.text?.substring(0, 30)}...`);
            return;
          }

          // 打印收到的消息内容
          console.log(`[feishu:${account.accountId}] 处理消息: ${message.text?.substring(0, 50)}... (${message.chatType})`);

          // 通过路由系统解析正确的 agent 和 sessionKey
          // message.appId 已经是当前长连接的 appId，对应 account.accountId
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: {
              kind: message.chatType === "p2p" ? "dm" : "group",
              id: message.chatType === "p2p" ? message.senderId : message.chatId,
            },
          });
          console.log(`[feishu:${account.accountId}] Route resolved: agentId=${route.agentId}, sessionKey=${route.sessionKey}, matchedBy=${route.matchedBy}`);

          // 构建消息上下文
          const msgCtx: MsgContext = {
            From: message.senderId,
            Body: message.text,
            AccountId: account.accountId,
            Provider: "feishu",
            Surface: "feishu",
            SessionKey: route.sessionKey,
            To: message.chatId,
            ChatType: message.chatType === "p2p" ? "direct" : "group",
            // 消息 ID（用于引用回复 + 框架的 [[reply_to_current]] 标签系统）
            MessageSid: message.messageId,
            // 标记来源通道（用于 session deliveryContext 和 heartbeat 投递）
            OriginatingChannel: CHANNEL_ID,
            OriginatingTo: message.chatId,
            // 授权命令执行（/compact, /new, /status 等）
            CommandAuthorized: true,
            // 群消息中是否被 @ 提及
            ...(message.wasMentioned ? { WasMentioned: true } : {}),
            // 文件/图片附件信息
            ...(message.mediaPath ? {
              MediaPath: message.mediaPath,
              MediaType: message.mediaType,
              MediaUrl: message.mediaPath,
            } : {}),
            // 语音消息转写后保留 MediaType，用于 TTS inbound 自动语音回复
            ...((message as any).originalMessageType === "audio" ? {
              MediaType: "audio/ogg",
            } : {}),
          };

          // 使用 dispatchReplyWithBufferedBlockDispatcher
          // 群消息使用支持 @ 转发的 deliver，私聊使用普通 deliver
          const isGroup = message.chatType === "group";

          // 私聊引用回复：只对第一条消息做引用
          let dmReplied = false;

          // 底层发送函数（单条消息发送，支持引用回复）
          const rawDeliver = async (text: string, mediaUrls: string[], replyToId?: string) => {
            const effectiveReplyTo = !dmReplied ? replyToId : undefined;

            if (mediaUrls.length > 0) {
              // 媒体消息：先发文字（带引用），再发媒体
              if (text?.trim()) {
                await sendTextWithReply(account, message.chatId, text, effectiveReplyTo);
                dmReplied = true;
              }
              for (const url of mediaUrls) {
                const result = await sendMedia(account, message.chatId, url);
                if (!result.ok) {
                  console.error(`[feishu:${account.accountId}] sendMedia failed: ${result.error}`);
                }
              }
            } else if (text) {
              const hasCodeBlock = text.includes('```');
              if (hasCodeBlock) {
                const postContent = markdownToFeishuPost(text);
                const result = await sendPostWithReply(account, message.chatId, postContent, effectiveReplyTo);
                if (!result.ok) {
                  await sendTextWithReply(account, message.chatId, text, effectiveReplyTo);
                }
                dmReplied = true;
              } else {
                await sendTextWithReply(account, message.chatId, text, effectiveReplyTo);
                dmReplied = true;
              }
            }
          };

          // 私聊 block 缓冲：攒 block 合成一条消息，避免拆成多条
          // 但每隔 MAX_BUFFER_MS 强制 flush，避免长回复让用户等太久
          let blockTextBuffer: string[] = [];
          let blockMediaBuffer: string[] = [];
          let blockReplyToId: string | undefined;
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          let bufferStartTime: number | null = null;
          const FLUSH_DELAY_MS = 2000; // 2秒无新 block 则自动刷新
          const MAX_BUFFER_MS = 8000; // 最长缓冲8秒，超过强制发送

          const flushBlockBuffer = async () => {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            bufferStartTime = null;
            const text = blockTextBuffer.join("\n").trim();
            const media = [...blockMediaBuffer];
            const replyId = blockReplyToId;
            blockTextBuffer = [];
            blockMediaBuffer = [];
            blockReplyToId = undefined;
            if (text || media.length > 0) {
              await rawDeliver(text, media, replyId);
            }
          };

          const bufferedDeliver = async (payload: any, meta?: { kind?: string }) => {
            const text = (payload.text ?? "").trim();
            const mediaUrls: string[] = [
              ...(payload.mediaUrls ?? []),
              ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ];

            if (meta?.kind === "block") {
              // 记录缓冲开始时间
              if (!bufferStartTime) bufferStartTime = Date.now();
              // 累积 block 内容
              if (text) blockTextBuffer.push(text);
              blockMediaBuffer.push(...mediaUrls);
              // 保存第一个 block 的 replyToId
              if (!blockReplyToId && payload.replyToId) {
                blockReplyToId = payload.replyToId;
              }
              // 如果缓冲超过 MAX_BUFFER_MS，立即 flush
              if (Date.now() - bufferStartTime >= MAX_BUFFER_MS) {
                await flushBlockBuffer();
                return;
              }
              // 重置刷新计时器
              if (flushTimer) clearTimeout(flushTimer);
              flushTimer = setTimeout(() => { flushBlockBuffer().catch(() => {}); }, FLUSH_DELAY_MS);
              return;
            }

            // final/tool：先刷缓冲，再发当前内容
            await flushBlockBuffer();
            if (text || mediaUrls.length > 0) {
              await rawDeliver(text, mediaUrls, payload.replyToId);
            }
          };

          const deliver = isGroup
            ? createGroupDeliver(account, message.chatId, cfg, { depth: 0, visitedEdges: new Set() })
            : bufferedDeliver;

          // 语音消息回复时禁用 block streaming，让整个回复走 final 模式
          // 这样 TTS suppressText 能正常生效（只发音频不发文字）
          const isVoiceMessage = (message as any).originalMessageType === "audio";

          await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: msgCtx,
            cfg,
            dispatcherOptions: { deliver },
            replyOptions: {
              disableBlockStreaming: isVoiceMessage || undefined,
            },
          });

          // 确保退出前刷新所有缓冲内容
          await flushBlockBuffer();

          // 回复完成后，移除 🫡 Salute reaction（自动确认回执）
          try {
            const { getPendingAcknowledgement, removePendingAcknowledgement } = await import("./gateway.js");
            const ack = getPendingAcknowledgement(message.messageId);
            if (ack) {
              await removeReaction(account, message.messageId, ack.reactionId);
              removePendingAcknowledgement(message.messageId);
            }
          } catch (ackErr) {
            // 不影响主流程
            console.error(`[feishu:${account.accountId}] Remove reaction failed: ${ackErr}`);
          }
        },
        logger: {
          info: (msg) => console.log(`[feishu:${account.accountId}] ${msg}`),
          error: (msg) => console.error(`[feishu:${account.accountId}] ${msg}`),
        },
      });
    },
  },
};
