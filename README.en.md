# Clawdbot Feishu Plugin (Feishu/Lark Channel Plugin)

> **🤖 This project is entirely maintained by AI.** Issues and Discussions are automatically read, evaluated, and processed by AI (branching, coding, creating PRs). A human reviews and merges the final result.
>
> **⚠️ This project only accepts requests related to the Clawdbot / OpenClaw Feishu plugin.** Bug reports, feature requests, and usage questions are welcome, but please do not submit unrelated issues — they will be closed immediately.

---

Feishu (Lark) messaging channel plugin for Clawdbot, with multi-account support, rich text messages, and audio transcription.

## Features

### Inbound Messages (11 types)
text, post, image, audio, file, media, sticker, share_chat, share_user, merge_forward, location

### Outbound Messages (6 types)
text, post, image, audio, file, interactive card

### Message Actions
- Emoji reactions
- Message recall (delete)
- Message edit

### Core Capabilities
- Multi-account support (Bot Registry)
- WebSocket persistent connection
- Message deduplication
- @mention routing (inter-bot forwarding in group chats)
- DM block buffering (merge streamed blocks into single message)
- Markdown → Feishu Post rich text conversion
- Card action callback (Card Action via WebSocket)
- Per-workspace file download isolation
- Tencent Cloud ASR audio transcription
- Auto-acknowledge receipt (👀 reaction, configurable)

## Installation

### Option 1: Quick Install
```bash
git clone https://github.com/KinGP5471/clawdbot-feishu-plugin.git
cd clawdbot-feishu-plugin
chmod +x install.sh
./install.sh
```

### Option 2: Manual Install
```bash
git clone https://github.com/KinGP5471/clawdbot-feishu-plugin.git
cd clawdbot-feishu-plugin
npm install --production
npm pack
clawdbot plugins install feishu-1.0.1.tgz
```

### Option 3: Development Mode (live reload)
```bash
git clone https://github.com/KinGP5471/clawdbot-feishu-plugin.git
cd clawdbot-feishu-plugin
npm install
clawdbot plugins install -l .
```

## Configuration

Add to your `clawdbot.json`:

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

### Multi-Account Setup

Each agent can bind to its own Feishu bot:

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

## Dependencies

- [Clawdbot / OpenClaw](https://github.com/openclaw/openclaw) >= 2026.1.24
- [@larksuiteoapi/node-sdk](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) ^1.46.0

## Notes

- After modifying plugin code, run `systemctl restart clawdbot` (SIGUSR1 does not reload modules)
- TypeScript source is loaded directly at runtime (via jiti)
- File download paths follow the `account.workspace` config

## License

MIT
