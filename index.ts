/**
 * Clawdbot 飞书通道插件入口
 */

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { feishuPlugin } from "./src/channel.js";
import { setFeishuRuntime } from "./src/runtime.js";

export const plugin = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu (Lark) messaging channel for Clawdbot",

  register(api: ClawdbotPluginApi) {
    // 保存运行时引用
    setFeishuRuntime(api.runtime);

    // 注册飞书通道
    api.registerChannel({ plugin: feishuPlugin });
  },
};

export default plugin;

// 同时导出便于直接测试
export { feishuPlugin } from "./src/channel.js";
export * from "./src/types.js";
export * from "./src/client.js";
export * from "./src/gateway.js";
