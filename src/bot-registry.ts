/**
 * 飞书机器人注册表
 * 所有 bot 启动时注册，用于群内 @ 互相发现和消息转发
 */

import type { ResolvedFeishuAccount } from "./types.js";

export interface BotRegistryEntry {
  accountId: string;
  name: string;
  openId: string;
  account: ResolvedFeishuAccount;
}

// 共享注册表（所有 bot 在同一进程内）
const registry = new Map<string, BotRegistryEntry>();

/**
 * 注册一个 bot
 */
export function registerBot(entry: BotRegistryEntry): void {
  registry.set(entry.accountId, entry);
  console.log(`[feishu-registry] ✅ ${entry.name} (${entry.accountId}) openId=${entry.openId}`);
}

/**
 * 按名字查找 bot
 */
export function getBotByName(name: string): BotRegistryEntry | undefined {
  for (const entry of registry.values()) {
    if (entry.name === name) return entry;
  }
  return undefined;
}

/**
 * 按 accountId 查找 bot
 */
export function getBotByAccountId(accountId: string): BotRegistryEntry | undefined {
  return registry.get(accountId);
}

/**
 * 获取所有已注册的 bot
 */
export function getAllBots(): BotRegistryEntry[] {
  return Array.from(registry.values());
}

/**
 * 检测文本中的 @BotName 并返回匹配的 bot 列表
 * 跳过自己（不 @ 自己）
 */
export function detectMentionedBots(text: string, selfAccountId: string): BotRegistryEntry[] {
  const mentioned: BotRegistryEntry[] = [];
  for (const entry of registry.values()) {
    if (entry.accountId === selfAccountId) continue;
    if (text.includes(`@${entry.name}`)) {
      mentioned.push(entry);
    }
  }
  return mentioned;
}

/**
 * 将文本中的 @BotName 替换为飞书 <at> 语法
 */
export function replaceWithFeishuMentions(text: string, bots: BotRegistryEntry[]): string {
  let result = text;
  for (const bot of bots) {
    result = result.replaceAll(`@${bot.name}`, `<at user_id="${bot.openId}">${bot.name}</at>`);
  }
  return result;
}
