#!/bin/sh
# 自托管 FxEmbed（api.fxtwitter.com 的开源代码）分步助手
# 前提：已安装 Node.js 20+、git、Cloudflare 账号
#
# 用法:
#   ./self-host-fxembed.sh            # 按步骤引导
#   ./self-host-fxembed.sh doctor     # 只检查环境

set -eu

REPO="${FXEMBED_DIR:-$HOME/FxEmbed}"
CFG_DIR="$(cd "$(dirname "$0")" && pwd)"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令：$1" >&2
    exit 1
  }
}

doctor() {
  echo "== 环境检查 =="
  for c in git node npm npx; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '  %-5s %s\n' "$c" "$($c --version 2>/dev/null | head -1)"
    else
      printf '  %-5s 未安装\n' "$c"
    fi
  done
  if command -v node >/dev/null 2>&1; then
    node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>=20?0:1)' \
      || echo "  ⚠ Node.js 建议 >= 20（官方推荐 24 LTS）"
  fi
  echo
  echo "Cloudflare 需要的东西："
  echo "  1. 账号：https://dash.cloudflare.com/sign-up"
  echo "  2. Account ID：https://developers.cloudflare.com/fundamentals/get-started/basic-tasks/find-account-and-zone-ids/"
  echo "  3. 登录：在 $REPO 目录下执行 npx wrangler login"
}

case "${1:-}" in
  doctor)
    doctor
    exit 0
    ;;
esac

need git
need node
need npm

cat <<'EOF'
==================== 自托管 FxEmbed ====================

它就是我们本工具用的 api.fxtwitter.com 的开源实现（MIT）。
自托管后你会有自己的接口地址，例如：
  https://fxembed.你的子域.workers.dev
  https://api.你的域名.com

注意：没有 X 账号凭据时仍能工作，但限速更低、抓不到 NSFW；
      加上凭据后更稳。凭据是 X 的 cookie，请当作密码保管。

=========================================================
EOF

if [ ! -d "$REPO/.git" ]; then
  echo "[1/6] 克隆仓库到 $REPO"
  git clone https://github.com/FxEmbed/FxEmbed.git "$REPO"
else
  echo "[1/6] 仓库已存在，跳过克隆：$REPO"
fi

cd "$REPO"

echo "[2/6] 安装依赖（可能需要几分钟）"
npm install

echo "[3/6] 生成 wrangler.toml / .env / branding.json（已存在则不覆盖）"
[ -f wrangler.toml ] || cp wrangler.example.toml wrangler.toml
[ -f .env ] || cp .env.example .env
[ -f branding.json ] || cp branding.example.json branding.json

echo "[4/6] 检查 wrangler.toml"
if ! grep -Eq 'account_id *= *"[A-Za-z0-9]{20,}"' wrangler.toml; then
  cat <<'EOF'

  需要填 Cloudflare Account ID：
    打开 https://dash.cloudflare.com → 右侧栏 Account ID，复制那串 32 位十六进制。
  然后编辑：
EOF
  echo "    $REPO/wrangler.toml"
  cat <<'EOF'
  把 account_id 改成你的，例如：
    account_id = "0123456789abcdef0123456789abcdef"
  改好后重新运行本脚本。

EOF
  exit 0
fi

echo "    account_id 已设置 ✓"

echo "[5/6] 登录 Cloudflare（首次会打开浏览器）"
if ! npx wrangler whoami >/dev/null 2>&1; then
  npx wrangler login
else
  echo "    已登录 ✓"
fi

cat <<EOF

[6/6] 可选：加 X 账号凭据（强烈建议）

  在浏览器登录 x.com，开发者工具 → Application → Cookies → https://x.com
    auth_token  →  credentials.json 的 authToken
    ct0         →  credentials.json 的 csrfToken
  文件格式：
    $REPO/credentials.json
    {
      "twitter": {
        "accounts": [
          { "authToken": "...", "csrfToken": "...", "username": "你的小号" }
        ]
      }
    }

  然后：
    cd $REPO
    npx wrangler secret put CREDENTIAL_KEY   # 随便生成一个长随机串
    npm run credentials:encrypt-push         # 加密并推到 R2

  不加也能用，只是限速更低。

最后部署：
  cd $REPO
  npm run deploy

部署成功后会打印一个 https://<name>.<account>.workers.dev 地址。
把它填到本项目的 web/app.js 和 mirror.mjs 的 API 常量里即可。

查看日志：
  npm run log

更新：
  cd $REPO && git pull && npm install && npm run deploy

EOF
