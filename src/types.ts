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
}

export interface ResolvedFeishuAccount {
  accountId: string;
  appId: string;
  appSecret: string;
  workspace?: string;
  enabled?: boolean;
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
