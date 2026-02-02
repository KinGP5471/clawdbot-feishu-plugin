/**
 * 消息上下文类型定义
 */

export type MsgContext = {
  From: string;
  Body: string;
  AccountId: string;
  Provider: string;
  Surface: string;
  SessionKey: string;
  To: string;
  ChatType: "direct" | "group";
  /** 消息 ID（用于引用回复） */
  MessageSid?: string;
  /** 来源通道 ID */
  OriginatingChannel?: string;
  /** 来源会话 ID */
  OriginatingTo?: string;
  /** 是否授权执行命令（/compact, /status 等） */
  CommandAuthorized?: boolean;
  /** 是否被 @ 提及 */
  WasMentioned?: boolean;
  /** 下载后的本地文件路径 */
  MediaPath?: string;
  /** 文件 MIME 类型 */
  MediaType?: string;
  /** 媒体 URL（本地路径） */
  MediaUrl?: string;
};
