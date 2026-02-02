#!/bin/bash
# 飞书插件一键安装脚本
# Usage: ./install.sh [--link]
#
# Options:
#   --link    Link mode (for development, changes reflect immediately)
#   (default) Copy mode (files copied to ~/.clawdbot/extensions/feishu/)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"
MODE="copy"

if [ "$1" = "--link" ]; then
    MODE="link"
fi

echo "🦞 飞书插件安装器"
echo "================================"
echo "模式: $MODE"
echo "源码: $PLUGIN_DIR"
echo ""

# 1. 检查 clawdbot 是否已安装
if ! command -v clawdbot &>/dev/null; then
    echo "❌ 未找到 clawdbot，请先安装: npm install -g clawdbot"
    exit 1
fi

CLAWDBOT_VERSION=$(clawdbot --version 2>/dev/null || echo "unknown")
echo "✅ Clawdbot 版本: $CLAWDBOT_VERSION"

# 2. 安装 npm 依赖
echo ""
echo "📦 安装依赖..."
cd "$PLUGIN_DIR"
if [ -f package.json ]; then
    npm install --production 2>&1 | tail -3
    echo "✅ 依赖安装完成"
else
    echo "❌ 未找到 package.json"
    exit 1
fi

# 3. 安装插件
echo ""
echo "🔌 安装飞书插件..."
if [ "$MODE" = "link" ]; then
    clawdbot plugins install -l "$PLUGIN_DIR" 2>&1
else
    # 打包成 tgz 再安装
    TGZ=$(npm pack 2>/dev/null | tail -1)
    clawdbot plugins install "$PLUGIN_DIR/$TGZ" 2>&1
    rm -f "$PLUGIN_DIR/$TGZ"
fi

echo ""
echo "✅ 插件安装完成！"
echo ""

# 4. 检查配置
echo "📋 下一步：配置飞书账号"
echo ""
echo "在 clawdbot.json 中添加 channels.feishu 配置："
echo ""
cat << 'CONFIG'
{
  "channels": {
    "feishu": {
      "accounts": {
        "main": {
          "appId": "cli_xxxxxxxxxx",
          "appSecret": "xxxxxxxxxx",
          "enabled": true,
          "workspace": "/path/to/workspace"
        }
      }
    }
  }
}
CONFIG
echo ""
echo "配置完成后重启: systemctl restart clawdbot"
echo ""
echo "🦞 Done!"
