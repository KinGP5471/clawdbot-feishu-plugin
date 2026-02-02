# Clawdbot 飞书插件 (Feishu/Lark Channel Plugin)

Clawdbot 的飞书消息通道插件，支持多账号、富文本消息、语音转写等功能。

## 功能

### 消息接收 (11 种)
text, post, image, audio, file, media, sticker, share_chat, share_user, merge_forward, location

### 消息发送 (6 种)
text, post, image, audio, file, interactive card

### 消息操作
- Reaction 表情回复
- 消息撤回
- 消息编辑

### 核心能力
- 多账号支持 (Bot Registry)
- WebSocket 长连接
- 消息去重
- @mention 路由（群聊中 bot 间 @ 转发）
- 私聊 block 缓冲合并（防拆条）
- Markdown → Post 富文本转换
- 卡片按钮回调 (Card Action)
- 文件下载路径隔离（按 workspace）
- 腾讯云 ASR 语音转文字

## 安装

### 方式一：一键安装
```bash
git clone https://github.com/KinGP5471/clawdbot-feishu-plugin.git
cd clawdbot-feishu-plugin
chmod +x install.sh
./install.sh
```

### 方式二：手动安装
```bash
git clone https://github.com/KinGP5471/clawdbot-feishu-plugin.git
cd clawdbot-feishu-plugin
npm install --production
npm pack
clawdbot plugins install feishu-1.0.1.tgz
```

### 方式三：开发模式（代码修改即时生效）
```bash
git clone https://github.com/KinGP5471/clawdbot-feishu-plugin.git
cd clawdbot-feishu-plugin
npm install
clawdbot plugins install -l .
```

## 配置

在 `clawdbot.json` 中添加：

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "main": {
          "appId": "cli_xxxxxxxxxx",
          "appSecret": "xxxxxxxxxx",
          "enabled": true,
          "workspace": "/path/to/agent/workspace"
        }
      }
    }
  }
}
```

### 多账号配置

每个 agent 可以绑定独立的飞书机器人：

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "main": {
          "appId": "cli_main_bot",
          "appSecret": "secret1",
          "enabled": true,
          "workspace": "/root/clawd"
        },
        "dev": {
          "appId": "cli_dev_bot",
          "appSecret": "secret2",
          "enabled": true,
          "workspace": "/root/clawd-dev"
        }
      }
    }
  }
}
```

## 依赖

- [Clawdbot](https://github.com/openclaw/openclaw) >= 2026.1.24
- [@larksuiteoapi/node-sdk](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) ^1.46.0

## 注意事项

- 修改插件代码后需要 `systemctl restart clawdbot`（SIGUSR1 不重载模块）
- 运行时直接加载 TypeScript 源码（通过 jiti）
- 文件下载路径跟随 account.workspace 配置
