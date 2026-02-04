/**
 * 飞书消息客户端
 * 负责发送消息、下载资源、语音识别、发送媒体
 */

import * as lark from "@larksuiteoapi/node-sdk";
import type { ResolvedFeishuAccount } from "./types.js";
import { Readable } from "stream";
import { readFile, writeFile, unlink, stat } from "fs/promises";
import { createReadStream } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join, extname, basename } from "path";

const execFileAsync = promisify(execFile);

// 客户端缓存
const clientCache = new Map<string, lark.Client>();

// 机器人信息缓存
const botInfoCache = new Map<string, { open_id: string; app_name: string }>();

/**
 * 获取或创建飞书客户端
 */
export function getFeishuClient(account: ResolvedFeishuAccount): lark.Client {
  // 只使用 appId 作为缓存 key，避免敏感信息泄露
  const cacheKey = account.appId;
  
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new lark.Client({
      appId: account.appId,
      appSecret: account.appSecret,
    });
    clientCache.set(cacheKey, client);
  }
  
  return client;
}

/**
 * 获取机器人信息（包括 open_id）
 */
export async function getBotInfo(account: ResolvedFeishuAccount): Promise<{ open_id: string; app_name: string } | null> {
  const cacheKey = account.appId;
  
  // 先查缓存
  const cached = botInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  const client = getFeishuClient(account);
  
  try {
    // 使用 request API 调用飞书接口
    const res: any = await (client as any).request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    
    if (res.code === 0 && res.bot) {
      const botInfo = {
        open_id: res.bot.open_id || "",
        app_name: res.bot.app_name || "",
      };
      botInfoCache.set(cacheKey, botInfo);
      return botInfo;
    }
    return null;
  } catch (error) {
    console.error(`Failed to get bot info for ${account.appId}:`, error);
    return null;
  }
}

/**
 * 发送文本消息到会话
 */
export async function sendTextMessage(
  account: ResolvedFeishuAccount,
  chatId: string,
  text: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  console.log(`[feishu:client] sendTextMessage → accountId=${account.accountId}, appId=${account.appId?.slice(0,8)}..., chatId=${chatId}, text=${text?.substring(0,50)}...`);
  const client = getFeishuClient(account);
  
  try {
    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    
    if (result.code === 0) {
      return { ok: true, messageId: (result.data as any)?.message_id };
    } else {
      return { ok: false, error: result.msg };
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 发送富文本消息（post 格式）
 * 支持代码块、文本混排
 */
export async function sendPostMessage(
  account: ResolvedFeishuAccount,
  chatId: string,
  content: any[][],
  title?: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);
  
  try {
    const postContent = {
      zh_cn: {
        title: title || "",
        content,
      },
    };
    
    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "post",
        content: JSON.stringify(postContent),
      },
    });
    
    if (result.code === 0) {
      return { ok: true };
    } else {
      return { ok: false, error: result.msg };
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 将 markdown 转换为飞书富文本格式
 * 主要处理代码块
 */
export function markdownToFeishuPost(markdown: string): any[][] {
  const lines = markdown.split('\n');
  const content: any[][] = [];
  
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines: string[] = [];
  let textLines: string[] = [];
  
  const flushText = () => {
    if (textLines.length > 0) {
      const text = textLines.join('\n').trim();
      if (text) {
        content.push([{ tag: "text", text }]);
      }
      textLines = [];
    }
  };
  
  const flushCode = () => {
    if (codeLines.length > 0) {
      const code = codeLines.join('\n');
      content.push([{
        tag: "code_block",
        language: codeLanguage || "plain_text",
        text: code,
      }]);
      codeLines = [];
      codeLanguage = '';
    }
  };
  
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // 结束代码块
        flushCode();
        inCodeBlock = false;
      } else {
        // 开始代码块
        flushText();
        codeLanguage = line.slice(3).trim() || 'plain_text';
        inCodeBlock = true;
      }
    } else if (inCodeBlock) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }
  
  // 处理未结束的内容
  flushText();
  if (inCodeBlock) {
    flushCode();
  }
  
  return content.length > 0 ? content : [[{ tag: "text", text: markdown }]];
}

/**
 * 下载消息中的音频资源并转写为文字
 * @param account 飞书账号
 * @param messageId 消息 ID
 * @param fileKey 音频文件 key
 * @returns 转写后的文字，失败返回 null
 */
export async function transcribeAudio(
  account: ResolvedFeishuAccount,
  messageId: string,
  fileKey: string,
): Promise<string | null> {
  const client = getFeishuClient(account);

  try {
    // 1. 下载音频文件
    const resourceResp = await client.im.v1.messageResource.get({
      params: { type: "file" },
      path: { message_id: messageId, file_key: fileKey },
    });

    // 读取流转为 Buffer
    const stream = resourceResp.getReadableStream() as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);
    const audioBase64 = audioBuffer.toString("base64");

    console.log(`[feishu] Audio downloaded: ${audioBuffer.length} bytes`);

    // 2. 保存音频到临时文件，调用本地 Python STT 脚本
    const tmpPath = join(tmpdir(), `feishu-audio-${messageId}.ogg`);
    try {
      await writeFile(tmpPath, audioBuffer);
      const { stdout } = await execFileAsync("python3", ["/usr/local/bin/stt.py", tmpPath], {
        timeout: 30000,
      });
      const text = stdout.trim();
      if (text) {
        console.log(`[feishu] STT result: ${text}`);
        return text;
      }
      console.error(`[feishu] STT returned empty result`);
      return null;
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } catch (error: any) {
    const respData = error?.response?.data;
    console.error(`[feishu] transcribeAudio error:`, {
      status: error?.response?.status,
      data: respData ? JSON.stringify(respData).slice(0, 500) : "no data",
      message: error?.message,
    });
    return null;
  }
}

/**
 * 下载消息中的文件资源（图片/文件/视频等）
 * @param account 飞书账号
 * @param messageId 消息 ID
 * @param fileKey 文件 key（image_key 或 file_key）
 * @param fileName 保存的文件名
 * @returns 本地文件路径，失败返回 null
 */
export async function downloadMessageResource(
  account: ResolvedFeishuAccount,
  messageId: string,
  fileKey: string,
  fileName: string,
): Promise<string | null> {
  const client = getFeishuClient(account);

  try {
    const resourceResp = await client.im.v1.messageResource.get({
      params: { type: "file" },
      path: { message_id: messageId, file_key: fileKey },
    });

    const stream = resourceResp.getReadableStream() as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    // 保存到对应 account workspace 下的 downloads 目录
    const baseDir = account.workspace || process.cwd();
    const downloadDir = join(baseDir, "downloads");
    const { mkdir } = await import("fs/promises");
    await mkdir(downloadDir, { recursive: true });

    const safeName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, "_");
    const filePath = join(downloadDir, `${Date.now()}-${safeName}`);
    await writeFile(filePath, buffer);

    console.log(`[feishu] File downloaded: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (error: any) {
    console.error(`[feishu] downloadMessageResource error:`, {
      message: error?.message,
      status: error?.response?.status,
    });
    return null;
  }
}

/**
 * 下载飞书图片资源（使用 image API）
 * @param account 飞书账号
 * @param imageKey 图片 key
 * @returns 本地文件路径，失败返回 null
 */
export async function downloadImage(
  account: ResolvedFeishuAccount,
  imageKey: string,
): Promise<string | null> {
  const client = getFeishuClient(account);

  try {
    const resp = await client.im.v1.image.get({
      path: { image_key: imageKey },
    } as any);

    const stream = resp.getReadableStream() as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const baseDir = account.workspace || process.cwd();
    const downloadDir = join(baseDir, "downloads");
    const { mkdir } = await import("fs/promises");
    await mkdir(downloadDir, { recursive: true });

    const filePath = join(downloadDir, `${Date.now()}-${imageKey}.png`);
    await writeFile(filePath, buffer);

    console.log(`[feishu] Image downloaded: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (error: any) {
    console.error(`[feishu] downloadImage error:`, {
      message: error?.message,
      status: error?.response?.status,
    });
    return null;
  }
}

/**
 * 回复指定消息（支持多种消息类型）
 * @param msgType 消息类型：text, post, image, audio, file, interactive
 * @param content 消息内容（JSON 字符串或对象）
 */
export async function replyMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
  msgType: string,
  content: string | Record<string, any>,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);
  
  try {
    const result = await client.im.v1.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: msgType,
        content: typeof content === "string" ? content : JSON.stringify(content),
      },
    });
    
    if (result.code === 0) {
      return { ok: true };
    } else {
      return { ok: false, error: result.msg };
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 回复指定消息（纯文本，向后兼容）
 */
export async function replyTextMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  return replyMessage(account, messageId, "text", JSON.stringify({ text }));
}

// ──────────────────────────────────────────────
// 媒体发送能力（图片、文件、音频）
// ──────────────────────────────────────────────

/** 判断文件扩展名是否为图片 */
function isImageExt(ext: string): boolean {
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".ico"].includes(ext.toLowerCase());
}

/** 判断文件扩展名是否为音频 */
function isAudioExt(ext: string): boolean {
  return [".mp3", ".ogg", ".opus", ".wav", ".m4a", ".aac", ".flac"].includes(ext.toLowerCase());
}

/** 将音频文件转为 opus 格式（飞书音频消息要求） */
async function convertToOpus(inputPath: string): Promise<{ path: string; duration: number }> {
  const outputPath = join(tmpdir(), `feishu-audio-${Date.now()}.opus`);
  const execFileAsync = promisify(execFile);

  // 先获取时长
  let duration = 0;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      inputPath,
    ], { timeout: 10000 });
    duration = Math.ceil(parseFloat(stdout.trim()) * 1000); // ms
  } catch {
    duration = 0;
  }

  // 转码为 opus（飞书要求 opus in ogg 容器）
  await execFileAsync("ffmpeg", [
    "-y", "-i", inputPath,
    "-c:a", "libopus",
    "-b:a", "32k",
    "-ar", "16000",
    "-ac", "1",
    outputPath,
  ], { timeout: 30000 });

  console.log(`[feishu] convertToOpus: input=${inputPath}, output=${outputPath}, duration=${duration}ms`);
  return { path: outputPath, duration };
}

/**
 * 上传图片到飞书
 * @returns image_key，失败返回 null
 */
export async function uploadImage(
  account: ResolvedFeishuAccount,
  filePath: string,
): Promise<string | null> {
  const client = getFeishuClient(account);

  try {
    const stream = createReadStream(filePath);
    const result = await client.im.v1.image.create({
      data: {
        image_type: "message",
        image: stream,
      },
    });

    const imageKey = result?.image_key;
    if (imageKey) {
      console.log(`[feishu] Image uploaded: ${imageKey}`);
      return imageKey;
    }
    console.error(`[feishu] Image upload failed: no image_key returned`);
    return null;
  } catch (error: any) {
    console.error(`[feishu] uploadImage error:`, error?.message);
    return null;
  }
}

/**
 * 上传文件到飞书
 * @returns file_key，失败返回 null
 */
export async function uploadFile(
  account: ResolvedFeishuAccount,
  filePath: string,
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream",
  fileName: string,
  duration?: number,
): Promise<string | null> {
  const client = getFeishuClient(account);

  try {
    const fileStream = createReadStream(filePath);
    const result = await client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        ...(duration !== undefined ? { duration: Math.round(duration) } : {}),
        file: fileStream,
      },
    });

    const fileKey = result?.file_key;
    if (fileKey) {
      console.log(`[feishu] File uploaded: ${fileKey} (type=${fileType}, duration=${duration}ms → ${duration !== undefined ? Math.round(duration / 1000) : 'N/A'}s)`);
      return fileKey;
    }
    console.error(`[feishu] File upload failed: no file_key returned`);
    return null;
  } catch (error: any) {
    console.error(`[feishu] uploadFile error:`, error?.message);
    return null;
  }
}

/**
 * 发送图片消息
 */
export async function sendImageMessage(
  account: ResolvedFeishuAccount,
  chatId: string,
  imageKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);

  try {
    const result = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });

    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 发送音频消息
 */
export async function sendAudioMessage(
  account: ResolvedFeishuAccount,
  chatId: string,
  fileKey: string,
  duration?: number,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);

  try {
    const content: any = { file_key: fileKey };
    if (duration && duration > 0) {
      content.duration = String(duration); // 毫秒，飞书要求字符串
    }
    console.log(`[feishu] sendAudioMessage: fileKey=${fileKey}, duration=${duration}ms, content=${JSON.stringify(content)}`);
    const result = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "audio",
        content: JSON.stringify(content),
      },
    });

    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 发送消息卡片（interactive）
 * @param card 飞书卡片 JSON 结构（完整的卡片对象）
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
 */
export async function sendInteractiveMessage(
  account: ResolvedFeishuAccount,
  chatId: string,
  card: Record<string, any>,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);

  try {
    const result = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 发送文件消息
 */
export async function sendFileMessage(
  account: ResolvedFeishuAccount,
  chatId: string,
  fileKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);

  try {
    const result = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 发送媒体文件到飞书会话
 * 自动识别文件类型（图片/音频/其他），上传后发送对应消息类型
 * @param caption 可选的文字说明（图片/音频会单独发文字）
 */
export async function sendMedia(
  account: ResolvedFeishuAccount,
  chatId: string,
  mediaPath: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  const ext = extname(mediaPath).toLowerCase();
  const fileName = basename(mediaPath);

  try {
    // 检查文件是否存在
    await stat(mediaPath);
  } catch {
    return { ok: false, error: `File not found: ${mediaPath}` };
  }

  try {
    // 图片
    if (isImageExt(ext)) {
      const imageKey = await uploadImage(account, mediaPath);
      if (!imageKey) return { ok: false, error: "Failed to upload image" };

      // 先发文字说明（如果有）
      if (caption?.trim()) {
        await sendTextMessage(account, chatId, caption);
      }
      return await sendImageMessage(account, chatId, imageKey);
    }

    // 音频 → 转 opus 后发送
    if (isAudioExt(ext)) {
      let opusPath: string | null = null;
      try {
        const { path: convertedPath, duration } = await convertToOpus(mediaPath);
        opusPath = convertedPath;

        const fileKey = await uploadFile(account, opusPath, "opus", `${Date.now()}.opus`, duration);
        if (!fileKey) return { ok: false, error: "Failed to upload audio" };

        // 语音消息不附带文字说明（音频本身就是内容），传入 duration 显示时长
        return await sendAudioMessage(account, chatId, fileKey, duration);
      } finally {
        if (opusPath) await unlink(opusPath).catch(() => {});
      }
    }

    // 其他文件 → 通用文件发送
    const fileType = mapExtToFileType(ext);
    const fileKey = await uploadFile(account, mediaPath, fileType, fileName);
    if (!fileKey) return { ok: false, error: "Failed to upload file" };

    // 先发文字说明（如果有）
    if (caption?.trim()) {
      await sendTextMessage(account, chatId, caption);
    }
    return await sendFileMessage(account, chatId, fileKey);
  } catch (error: any) {
    return { ok: false, error: `sendMedia failed: ${error?.message}` };
  }
}

/** 文件扩展名 → 飞书文件类型映射 */
function mapExtToFileType(ext: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const map: Record<string, "mp4" | "pdf" | "doc" | "xls" | "ppt"> = {
    ".mp4": "mp4",
    ".pdf": "pdf",
    ".doc": "doc", ".docx": "doc",
    ".xls": "xls", ".xlsx": "xls",
    ".ppt": "ppt", ".pptx": "ppt",
  };
  return map[ext.toLowerCase()] ?? "stream";
}

// ──────────────────────────────────────────────
// 表情回复（Reaction）
// ──────────────────────────────────────────────

/**
 * 添加表情回复
 * @param emojiType 表情类型，如 "THUMBSUP", "SMILE", "HEART" 等
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
 */
export async function addReaction(
  account: ResolvedFeishuAccount,
  messageId: string,
  emojiType: string,
): Promise<{ ok: boolean; reactionId?: string; error?: string }> {
  const client = getFeishuClient(account);
  try {
    const result = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    if (result.code === 0) {
      return { ok: true, reactionId: result.data?.reaction_id };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 删除表情回复
 */
export async function removeReaction(
  account: ResolvedFeishuAccount,
  messageId: string,
  reactionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);
  try {
    const result = await client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// ──────────────────────────────────────────────
// 消息撤回 / 编辑
// ──────────────────────────────────────────────

/**
 * 撤回/删除消息
 */
export async function deleteMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);
  try {
    const result = await client.im.v1.message.delete({
      path: { message_id: messageId },
    });
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 编辑/更新消息
 */
export async function updateMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
  content: string,
  msgType: string = "text",
): Promise<{ ok: boolean; error?: string }> {
  const client = getFeishuClient(account);
  try {
    const result = await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content },
    });
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: result.msg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// ──────────────────────────────────────────────
// 引用消息获取
// ──────────────────────────────────────────────

/**
 * 被引用消息的解析结果
 */
export interface QuotedMessageInfo {
  /** 消息类型 */
  msgType: string;
  /** 文本描述（所有类型都有） */
  text: string;
  /** 图片 image_key（仅图片消息） */
  imageKey?: string;
  /** 文件 file_key（仅文件/媒体消息） */
  fileKey?: string;
  /** 原始文件名 */
  fileName?: string;
  /** 发送者 open_id */
  senderId?: string;
}

/**
 * 获取被引用消息的内容
 * 通过 GET /im/v1/messages/{message_id} 拉取消息详情并解析
 * @param account 飞书账号
 * @param messageId 被引用消息的 message_id
 * @returns 解析后的消息信息，失败返回 null
 */
export async function getQuotedMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<QuotedMessageInfo | null> {
  const client = getFeishuClient(account);

  try {
    const result: any = await (client as any).request({
      method: "GET",
      url: `/open-apis/im/v1/messages/${messageId}`,
      params: { user_id_type: "open_id" },
    });

    if (result.code !== 0 || !result.data?.items?.length) {
      console.log(`[feishu] getQuotedMessage: API returned code=${result.code}, items=${result.data?.items?.length}`);
      return null;
    }

    const msg = result.data.items[0];
    return parseQuotedMessage(msg);
  } catch (error: any) {
    console.error(`[feishu] getQuotedMessage error for ${messageId}:`, error?.message);
    return null;
  }
}

/**
 * 解析飞书消息对象为 QuotedMessageInfo
 */
function parseQuotedMessage(msg: any): QuotedMessageInfo {
  const msgType: string = msg.msg_type || "unknown";
  const content: string = msg.body?.content || "";
  const senderId: string = msg.sender?.sender_id?.open_id || "";

  const base: QuotedMessageInfo = { msgType, text: "", senderId };

  if (!content) {
    base.text = `[${msgType}消息]`;
    return base;
  }

  // merge_forward 的 content 是英文纯文本（"Merged and Forwarded Message"），不是 JSON
  if (msgType === "merge_forward") {
    base.text = "[合并转发消息]";
    return base;
  }

  try {
    const parsed = JSON.parse(content);

    switch (msgType) {
      case "text":
        base.text = parsed.text || "";
        break;

      case "post": {
        // 富文本：提取所有文本节点
        const langContent = parsed.zh_cn || parsed.en_us || parsed;
        const blocks: any[][] = langContent?.content || [];
        const parts: string[] = [];
        for (const line of blocks) {
          if (!Array.isArray(line)) continue;
          const lineParts: string[] = [];
          for (const node of line) {
            if (node.tag === "text" && node.text) lineParts.push(node.text);
            else if (node.tag === "a" && node.text) lineParts.push(`${node.text}(${node.href || ""})`);
            else if (node.tag === "img" && node.image_key) {
              // 富文本中嵌入的图片
              if (!base.imageKey) base.imageKey = node.image_key;
              lineParts.push("[图片]");
            }
          }
          if (lineParts.length > 0) parts.push(lineParts.join(""));
        }
        base.text = parts.join("\n") || "[富文本消息]";
        break;
      }

      case "image":
        base.imageKey = parsed.image_key;
        base.text = "[图片]";
        break;

      case "file":
        base.fileKey = parsed.file_key;
        base.fileName = parsed.file_name || "";
        base.text = `[文件: ${parsed.file_name || "unknown"}]`;
        break;

      case "audio":
        base.text = "[语音消息]";
        break;

      case "media":
        base.fileKey = parsed.file_key;
        base.fileName = parsed.file_name || "";
        base.text = `[视频: ${parsed.file_name || ""}]`;
        break;

      case "sticker":
        base.fileKey = parsed.file_key;
        base.text = "[表情]";
        break;

      case "share_chat":
        base.text = `[分享群聊: ${parsed.chat_name || ""}]`;
        break;

      case "share_user":
        base.text = `[名片: ${parsed.user_name || parsed.name || ""}]`;
        break;

      case "interactive":
        base.text = "[卡片消息]";
        break;

      case "merge_forward":
        base.text = "[合并转发消息]";
        break;

      case "location": {
        const name = parsed.name || "未知位置";
        const lat = parsed.latitude;
        const lng = parsed.longitude;
        base.text = lat && lng ? `[位置: ${name} (${lat}, ${lng})]` : `[位置: ${name}]`;
        break;
      }

      default:
        base.text = `[${msgType}消息]`;
    }
  } catch {
    base.text = `[${msgType || "未知"}消息]`;
  }

  return base;
}

// ──────────────────────────────────────────────
// 合并转发消息解析
// ──────────────────────────────────────────────

/**
 * 合并转发中的单条子消息
 */
export interface ForwardedMessageItem {
  /** 发送者 ID */
  senderId: string;
  /** 发送者类型 (user/app) */
  senderType: string;
  /** 消息类型 */
  msgType: string;
  /** 解析后的文本内容 */
  text: string;
  /** 消息发送时间 */
  createTime: string;
}

/**
 * 获取合并转发消息的子消息列表
 * 通过 GET /im/v1/messages/{message_id} 拉取，返回的 items 包含容器消息和所有子消息
 * @param account 飞书账号
 * @param messageId 合并转发消息的 message_id
 * @returns 子消息列表（已排除容器消息本身），失败返回 null
 */
export async function getMergeForwardMessages(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<ForwardedMessageItem[] | null> {
  const client = getFeishuClient(account);

  try {
    const result: any = await (client as any).request({
      method: "GET",
      url: `/open-apis/im/v1/messages/${messageId}`,
      params: { user_id_type: "open_id" },
    });

    if (result.code !== 0 || !result.data?.items?.length) {
      console.log(`[feishu] getMergeForwardMessages: API returned code=${result.code}, items=${result.data?.items?.length}`);
      return null;
    }

    const items: ForwardedMessageItem[] = [];

    for (const msg of result.data.items) {
      // 跳过容器消息本身（msg_type = merge_forward）
      if (msg.msg_type === "merge_forward") continue;

      const senderId = msg.sender?.id || "";
      const senderType = msg.sender?.sender_type || "user";
      const msgType = msg.msg_type || "unknown";
      const content = msg.body?.content || "";
      const createTime = msg.create_time || "";

      let text = "";
      try {
        const parsed = JSON.parse(content);
        switch (msgType) {
          case "text":
            text = parsed.text || "";
            break;
          case "post": {
            const langContent = parsed.zh_cn || parsed.en_us || parsed;
            const blocks: any[][] = langContent?.content || [];
            const parts: string[] = [];
            for (const line of blocks) {
              if (!Array.isArray(line)) continue;
              const lineParts: string[] = [];
              for (const node of line) {
                if (node.tag === "text" && node.text) lineParts.push(node.text);
                else if (node.tag === "a" && node.text) lineParts.push(`${node.text}(${node.href || ""})`);
              }
              if (lineParts.length > 0) parts.push(lineParts.join(""));
            }
            text = parts.join("\n") || "[富文本]";
            break;
          }
          case "image": text = "[图片]"; break;
          case "file": text = `[文件: ${parsed.file_name || ""}]`; break;
          case "audio": text = "[语音]"; break;
          case "media": text = `[视频: ${parsed.file_name || ""}]`; break;
          case "sticker": text = "[表情]"; break;
          case "interactive": text = "[卡片消息]"; break;
          default: text = content || `[${msgType}]`;
        }
      } catch {
        text = content || `[${msgType}消息]`;
      }

      items.push({ senderId, senderType, msgType, text, createTime });
    }

    return items.length > 0 ? items : null;
  } catch (error: any) {
    console.error(`[feishu] getMergeForwardMessages error for ${messageId}:`, error?.message);
    return null;
  }
}
