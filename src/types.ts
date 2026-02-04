/**
 * 飞书通道配置类型（支持多账号）
 */

export interface FeishuAccountConfig {
  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret */
  appSecret: string;
  /** 可选的 workspace 路径 */
  workspace?: string;
  /** 自动确认回执：收到消息时加 👀 reaction，回复后移除（默认 true） */
  autoAcknowledge?: boolean;
  /** API 域名: feishu(国内,默认) | lark(国际) */
  domain?: "feishu" | "lark";
  /** 连接模式: ws(长连接,默认) | webhook(HTTP回调) — Lark国际版必须用webhook */
  mode?: "ws" | "webhook";
  /** Webhook 路径（默认 /feishu/webhook），多账号时每个账号需不同路径 */
  webhookPath?: string;
  /** 事件加密密钥 (Encrypt Key)，从飞书开放平台获取 */
  encryptKey?: string;
  /** 验证令牌 (Verification Token)，从飞书开放平台获取 */
  verificationToken?: string;
}

export interface FeishuChannelConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 单账号模式（向后兼容） */
  appId?: string;
  appSecret?: string;
  /** 多账号模式 */
  accounts?: {
    [accountId: string]: FeishuAccountConfig;
  };
  /** 全局 API 域名（单账号模式用）: feishu | lark */
  domain?: "feishu" | "lark";
  /** 全局连接模式（单账号模式用）: ws | webhook */
  mode?: "ws" | "webhook";
  /** 全局 Webhook 路径（单账号模式用） */
  webhookPath?: string;
  /** 全局 Encrypt Key（单账号模式用） */
  encryptKey?: string;
  /** 全局 Verification Token（单账号模式用） */
  verificationToken?: string;
}

export interface ResolvedFeishuAccount {
  accountId: string;
  appId: string;
  appSecret: string;
  workspace?: string;
  enabled?: boolean;
  /** 自动确认回执（默认 true） */
  autoAcknowledge?: boolean;
  /** API 域名 */
  domain?: "feishu" | "lark";
  /** 连接模式 */
  mode?: "ws" | "webhook";
  /** Webhook 路径 */
  webhookPath?: string;
  /** Encrypt Key */
  encryptKey?: string;
  /** Verification Token */
  verificationToken?: string;
}

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  messageType: string;
  content: string;
  text?: string;
  /** 是否被 @ 提及 */
  wasMentioned?: boolean;
  /** 下载后的本地文件路径（图片/文件） */
  mediaPath?: string;
  /** 文件 MIME 类型 */
  mediaType?: string;
  /** 原始文件名 */
  fileName?: string;
  /** 收到消息的应用 ID（data.app_id，对应当前长连接） */
  appId?: string;
  /** 收到消息的账号 ID */
  accountId?: string;
  /** 被 @ 的机器人名字（从 mentions 提取） */
  mentionedBotName?: string;
}
