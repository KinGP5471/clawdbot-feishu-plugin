/**
 * 飞书机器人信息同步模块
 * 启动时自动从飞书 API 获取机器人信息并更新 IDENTITY.md
 */

import type { ResolvedFeishuAccount } from "./types.js";
import { registerBot } from "./bot-registry.js";
import * as fs from "fs/promises";
import * as path from "path";

interface BotInfo {
  app_name: string;
  avatar_url: string;
  open_id: string;
  activate_status: number;
}

interface BotInfoResponse {
  code: number;
  msg: string;
  bot?: BotInfo;
}

interface TenantAccessTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

/**
 * 获取飞书 tenant_access_token
 */
async function getTenantAccessToken(account: ResolvedFeishuAccount): Promise<string | null> {
  try {
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: account.appId,
        app_secret: account.appSecret,
      }),
    });

    const data = await response.json() as TenantAccessTokenResponse;
    
    if (data.code !== 0 || !data.tenant_access_token) {
      console.error(`[feishu:${account.accountId}] 获取 access_token 失败: ${data.msg}`);
      return null;
    }

    return data.tenant_access_token;
  } catch (error) {
    console.error(`[feishu:${account.accountId}] 获取 access_token 异常:`, error);
    return null;
  }
}

/**
 * 获取飞书机器人信息
 */
async function getBotInfo(account: ResolvedFeishuAccount, accessToken: string): Promise<BotInfo | null> {
  try {
    const response = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
    });

    const data = await response.json() as BotInfoResponse;
    
    if (data.code !== 0 || !data.bot) {
      console.error(`[feishu:${account.accountId}] 获取机器人信息失败: ${data.msg}`);
      return null;
    }

    return data.bot;
  } catch (error) {
    console.error(`[feishu:${account.accountId}] 获取机器人信息异常:`, error);
    return null;
  }
}

/**
 * 更新 IDENTITY.md 文件
 */
async function updateIdentityFile(workspace: string, botInfo: BotInfo): Promise<boolean> {
  try {
    const identityPath = path.join(workspace, "IDENTITY.md");
    
    // 读取现有文件（如果存在）
    let content = "";
    try {
      content = await fs.readFile(identityPath, "utf-8");
    } catch (error) {
      // 文件不存在，创建新的
      console.log(`[feishu] IDENTITY.md 不存在，将创建新文件`);
    }

    // 更新或创建内容
    const newContent = `# IDENTITY.md - Who Am I?

- **Name:** ${botInfo.app_name}
- **Creature:** 一只住在服务器里的 AI 龙虾 🦞
- **Vibe:** 轻松随和，干活靠谱，偶尔皮一下
- **Emoji:** 🦞
- **Avatar:** ${botInfo.avatar_url}
`;

    await fs.writeFile(identityPath, newContent, "utf-8");
    console.log(`[feishu] ✅ IDENTITY.md 已更新: ${botInfo.app_name}`);
    return true;
  } catch (error) {
    console.error(`[feishu] 更新 IDENTITY.md 失败:`, error);
    return false;
  }
}

/**
 * 更新 SOUL.md 中的名字
 */
async function updateSoulFile(workspace: string, botName: string): Promise<boolean> {
  try {
    const soulPath = path.join(workspace, "SOUL.md");
    
    // 读取现有文件
    let content = "";
    try {
      content = await fs.readFile(soulPath, "utf-8");
    } catch (error) {
      // 文件不存在，不处理
      console.log(`[feishu] SOUL.md 不存在，跳过更新`);
      return true;
    }

    // 只更新第一行的名字部分
    const lines = content.split("\n");
    if (lines.length > 2 && lines[2].includes("你是")) {
      // 替换 "你是XXX" 中的名字
      lines[2] = `*你是${botName} 🦞，大佬驴殿下的 AI 研发搭档。*`;
      const newContent = lines.join("\n");
      await fs.writeFile(soulPath, newContent, "utf-8");
      console.log(`[feishu] ✅ SOUL.md 已更新: ${botName}`);
    }

    return true;
  } catch (error) {
    console.error(`[feishu] 更新 SOUL.md 失败:`, error);
    return false;
  }
}

/**
 * 同步机器人信息到 workspace
 */
export async function syncBotInfo(account: ResolvedFeishuAccount): Promise<void> {
  console.log(`[feishu:${account.accountId}] 开始同步机器人信息...`);

  // 1. 获取 access_token
  const accessToken = await getTenantAccessToken(account);
  if (!accessToken) {
    return;
  }

  // 2. 获取机器人信息
  const botInfo = await getBotInfo(account, accessToken);
  if (!botInfo) {
    return;
  }

  console.log(`[feishu:${account.accountId}] 机器人信息: ${botInfo.app_name}`);

  // 3. 注册到 bot registry（所有账号都注册，用于群内 @ 转发）
  registerBot({
    accountId: account.accountId,
    name: botInfo.app_name,
    openId: botInfo.open_id,
    account,
  });

  // 4. 更新 workspace 文件（仅对 default 账号更新）
  if (account.accountId === "default") {
    // default 账号对应 main agent，workspace 是 /root/clawd
    const workspace = account.workspace || "/root/clawd";
    await updateIdentityFile(workspace, botInfo);
    await updateSoulFile(workspace, botInfo.app_name);
    
    // 4. 创建 identity.json 供监控页面使用
    await updateIdentityJson(workspace, botInfo);
  } else {
    console.log(`[feishu:${account.accountId}] 跳过文件更新（非 default 账号）`);
  }
}

/**
 * 更新 canvas/identity.json 供监控页面使用
 */
async function updateIdentityJson(workspace: string, botInfo: BotInfo): Promise<boolean> {
  try {
    const canvasDir = path.join(workspace, "canvas");
    const identityJsonPath = path.join(canvasDir, "identity.json");
    
    const data = {
      name: botInfo.app_name,
      avatar: botInfo.avatar_url,
      emoji: "🦞",
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(identityJsonPath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`[feishu] ✅ identity.json 已更新`);
    return true;
  } catch (error) {
    console.error(`[feishu] 更新 identity.json 失败:`, error);
    return false;
  }
}
