# 部署到 Vercel

本工具现在是一个 **Vercel 原生项目**：

- `web/` —— 纯静态前端（无需构建）
- `api/` —— Serverless Functions（Node.js runtime）
- `lib/mirror-core.mjs` —— 前后端共用的抓取/比对核心逻辑
- `mirror.mjs` —— 本地命令行，走同一套核心

后端代理的价值：

1. 浏览器不再直连 `api.fxtwitter.com`，不受 CORS 干扰
2. 可以在服务端做限速、重试、并发
3. 便于以后换成自己的 FxTwitter 实例
4. 前端有进度流（NDJSON），不会白屏等 30 秒

---

## 目录结构

```text
hackmirror/
├── api/
│   ├── scan.js           同步扫描：GET /api/scan?u=xxx
│   ├── scan-stream.js    流式扫描：GET /api/scan-stream?u=xxx（NDJSON）
│   └── health.js         健康检查：GET /api/health[?probe=1&u=xxx]
├── lib/
│   └── mirror-core.mjs   共享核心（抓取、cursor 二分、比对、序列化）
├── web/
│   ├── index.html
│   ├── style.css
│   └── app.js            前端：优先调 /api/scan-stream，失败时回退直连
├── mirror.mjs            命令行版
├── scripts/check.mjs     接口诊断脚本
├── vercel.json
└── package.json
```

---

## 方式一：CLI 部署（推荐）

### 1. 登录

```bash
cd /path/to/hackmirror
vercel login
```

浏览器会自动打开授权。

### 2. 首次部署

```bash
vercel
```

交互提示按下面填：

| 问题 | 选择 |
| --- | --- |
| Set up and deploy? | `Y` |
| Which scope? | 你的账号 |
| Link to existing project? | `N` |
| What's your project's name? | `hackmirror`（或自定义） |
| In which directory is your code located? | `./` |
| Want to modify these settings? | `N` |

### 3. 生产部署

```bash
vercel --prod
```

成功后会打印：

```text
✅ Production: https://hackmirror-xxx.vercel.app
```

### 4. 验证

```bash
curl 'https://your-app.vercel.app/api/health?probe=1&u=someuser'
curl 'https://your-app.vercel.app/api/scan?u=someuser' | head -c 300
```

打开网页：

```text
https://your-app.vercel.app
```

---

## 方式二：GitHub 自动部署

1. 把项目推到 GitHub
2. https://vercel.com/new → Import Git Repository
3. 配置：

| 项 | 值 |
| --- | --- |
| Framework Preset | `Other` |
| Root Directory | `./` |
| Build Command | 留空 |
| Output Directory | `web` |
| Install Command | 留空 |

4. Deploy

之后每次 push 自动部署。

---

## 接口说明

### `GET /api/scan?u=用户名`

同步返回完整结果，适合脚本调用。

```bash
curl 'https://your-app.vercel.app/api/scan?u=someuser&sort=big'
curl 'https://your-app.vercel.app/api/scan?u=someuser&blue=1'   # 只看蓝V
curl 'https://your-app.vercel.app/api/scan?u=someuser&blue=0'   # 不看蓝V
```

响应：

```json
{
  "handle": "someuser",
  "profile": { ... },
  "stats": {
    "following": 1234,
    "followers": 1456,
    "mutual": 1000,
    "rate": 0.81,
    "notBack": 234,
    "owe": 456,
    "notBackBlue": 12,
    "oweBlue": 3,
    "missingFollowing": 10,
    "missingFollowers": 8,
    "followingCoverage": 0.99,
    "followersCoverage": 0.99,
    "partial": false,
    "requests": 42
  },
  "warnings": [],
  "following": [ ... ],
  "followers": [ ... ],
  "notBack": [ ... ],
  "owe": [ ... ]
}
```

参数：

| 参数 | 说明 |
| --- | --- |
| `u` / `handle` | 必填，支持 `@xxx` 或 `x.com/xxx` |
| `sort` | `recent`（默认）/ `big` / `small` |
| `blue` | 不传=全部；`1`=只看蓝V；`0`=不看蓝V（只列非蓝V） |

### `GET /api/scan-stream?u=用户名`

NDJSON 流，边抓边推。同样支持 `blue=1` / `blue=0`：

```jsonl
{"type":"profile","profile":{...}}
{"type":"progress","kind":"following","count":500,"expected":10392}
{"type":"progress","kind":"followers","count":480,"expected":10584}
{"type":"warn","message":"..."}
{"type":"result","data":{...}}
```

出错时：

```jsonl
{"type":"error","title":"锁推账号","message":"..."}
```

前端就是用它显示实时进度条。

### `GET /api/health`

```bash
curl 'https://your-app.vercel.app/api/health'
```

```json
{
  "ok": true,
  "runtime": "vercel-serverless",
  "node": "v20.x",
  "api": "https://api.fxtwitter.com",
  "env": { ... }
}
```

加 `?probe=1&u=用户名` 会实际请求一次上游接口，用来验证连通性。

---

## 环境变量（可选）

Vercel → Project → Settings → Environment Variables：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCAN_WORKERS` | `4` | 每份名单的并发数（1–16） |
| `SCAN_RPS` | `8` | 全局限速（请求/秒） |
| `SCAN_TIMEOUT_MS` | `55000`（scan）/ `280000`（stream） | 单次函数执行时限 |
| `MAX_FOLLOWING` | `50000` | 关注数上限 |
| `MAX_FOLLOWERS` | `50000` | 粉丝数上限 |

不设置也能跑，默认值已经比较保守。

---

## 运行时限制

| 套餐 | 函数最长执行 | 适合 |
| --- | --- | --- |
| Hobby（免费） | 60 秒 | 几千粉/关注的账号 |
| Pro | 300 秒 | 万级账号 |

`/api/scan` 默认在 55 秒超时，`/api/scan-stream` 默认 280 秒。

**超大账号建议用命令行版**，没有执行时限：

```bash
node mirror.mjs someuser --limit 0 --json out.json
```

---

## 本地开发

不装 Vercel CLI 也能测：

```bash
# 1. 起一个本地 Node 服务器（仅用于测试）
node scripts/dev-server.mjs

# 2. 另开终端起静态服务器
cd web && python3 -m http.server 8080

# 3. 打开
open 'http://127.0.0.1:8080/?scan=http://127.0.0.1:8787/api/scan-stream'
```

或者用 Vercel 官方：

```bash
vercel dev
```

它会同时提供静态文件和 `/api/*`，直接访问 `http://localhost:3000`。

---

## 前端回退机制

`web/app.js` 的行为：

1. 先请求 `/api/scan-stream`
2. 如果返回的不是 NDJSON（比如纯静态托管、404、HTML），**自动回退到浏览器直连** `api.fxtwitter.com`
3. 也可以用 `?scan=` 指定其他后端地址：

```text
https://your-app.vercel.app/?scan=https://your-api.example.com
```

这意味着 `web/` 目录放到任何静态托管（Cloudflare Pages、Netlify、GitHub Pages）也能用，只是没有服务端代理。

---

## 切换到自托管 FxTwitter

如果你有自己的 FxEmbed 实例（见 `SELF-HOST.md`），改一处即可：

```js
// lib/mirror-core.mjs
export const API = 'https://api.你的域名.com';
```

或者部署时用环境变量（需要小幅改动，见 `createClient({ base })`）。

命令行也能临时切：

```bash
node mirror.mjs someuser --api https://api.你的域名.com
```

---

## 常见问题

**Q：部署后网页能打开但扫描失败？**
先访问 `/api/health?probe=1&u=someuser`，看 `probe.ok` 是否为 `true`。

**Q：一直卡在"正在照…"？**
Hobby 套餐 60 秒上限，万级账号会超时。用 `scan-stream` 看进度，或改用命令行。

**Q：`next` 还是旧版本？**
```bash
vercel --prod
```

**Q：能不用 Vercel 吗？**
能。`web/` 是纯静态的，`api/` 是标准 Node handler，可以搬到 Netlify Functions、Cloudflare Pages Functions 等。命令行版则完全不依赖托管。

**Q：会不会消耗公共 FxTwitter 额度？**
会，因为默认走 `api.fxtwitter.com`。想要独立额度就自托管并改 `API` 常量。
