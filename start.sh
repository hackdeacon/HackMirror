#!/bin/sh
set -eu

cd "$(dirname "$0")"

PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
OPEN_BROWSER=1
WITH_API=1

for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_BROWSER=0 ;;
    --no-api) WITH_API=0 ;;
    --port=*) PORT="${arg#*=}" ;;
    --api-port=*) API_PORT="${arg#*=}" ;;
    -h|--help)
      cat <<'EOF'
本工具启动脚本

用法:
  ./start.sh                  同时启动前端和本地 API，并打开浏览器
  ./start.sh --no-api         只启动静态前端（前端会直连 FxTwitter）
  ./start.sh --no-open        不自动打开浏览器
  ./start.sh --port=8090      指定前端端口
  ./start.sh --api-port=8888  指定本地 API 端口

停止:
  Ctrl+C
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg（用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

URL="http://${HOST}:${PORT}"
API_URL="http://${HOST}:${API_PORT}/api/scan-stream"

open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

is_web() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 2 "$URL/" 2>/dev/null | grep -q '本工具'
}

is_api() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 2 "http://${HOST}:${API_PORT}/api/health" 2>/dev/null | grep -q '"ok"'
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 python3，无法启动静态服务器。" >&2
  exit 1
fi

if [ "$WITH_API" = 1 ] && ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，本地 API 无法启动；将只启动静态前端。" >&2
  WITH_API=0
fi

# 端口占用自动换
pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if ! is_web; then
    OLD="$PORT"
    PORT="$(pick_port)"
    URL="http://${HOST}:${PORT}"
    echo "端口 $OLD 被占用，前端改用 $PORT"
  fi
fi

if [ "$WITH_API" = 1 ] && command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if ! is_api; then
    OLD="$API_PORT"
    API_PORT="$(pick_port)"
    API_URL="http://${HOST}:${API_PORT}/api/scan-stream"
    echo "端口 $OLD 被占用，本地 API 改用 $API_PORT"
  fi
fi

PIDS=""

cleanup() {
  for pid in $PIDS; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup INT TERM EXIT

if [ "$WITH_API" = 1 ] && ! is_api; then
  echo "本地 API 启动中：http://${HOST}:${API_PORT}"
  PORT="$API_PORT" HOST="$HOST" node scripts/dev-server.mjs >/tmp/hackmirror-dev-server.log 2>&1 &
  PIDS="$PIDS $!"
  i=0
  while [ "$i" -lt 50 ]; do
    is_api && break
    i=$((i + 1))
    sleep 0.1
  done
fi

if ! is_web; then
  echo "本工具启动中：${URL}"
  (cd web && python3 -m http.server "$PORT" --bind "$HOST") &
  PIDS="$PIDS $!"
  i=0
  while [ "$i" -lt 50 ]; do
    is_web && break
    i=$((i + 1))
    sleep 0.1
  done
else
  echo "本工具已经在运行：${URL}"
fi

if [ "$WITH_API" = 1 ]; then
  TARGET="${URL}/?scan=${API_URL}"
else
  TARGET="${URL}/"
fi

echo "打开：$TARGET"
echo "按 Ctrl+C 停止"

[ "$OPEN_BROWSER" = 1 ] && open_url "$TARGET"

# 等任意子进程退出
wait
