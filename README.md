# HackMirror

比对一个 X 账号的**关注列表**和**粉丝列表**，找出：

- **没回关你**：你关注了 TA，TA 没关注你
- **你没回关**：TA 关注了你，你还没关注 TA
- **互关人数 / 回关率**
- **只看蓝V / 不看蓝V**
- **按关注先后 / 粉丝数排序**
- **导出 JSON / CSV**

只读取公开资料，不需要登录、Cookie 或 token。关注和粉丝各默认支持 5 万（可调），适合万级账号。

## 架构

```text
web/          纯静态前端（无构建），同时提供 Web 界面和 PWA
api/          Vercel Serverless Functions
lib/          共享核心：抓取、cursor 二分、比对
mirror.mjs    命令行，复用同一核心
```

前端默认调用同源 `/api/scan-stream`（NDJSON 流式进度）；
后端不可用时自动回退到浏览器直连 FxTwitter。

## 快速开始

需要 Node.js 18+（本地 API 与命令行），Python 3（静态服务器）。

```bash
./start.sh
```

会同时启动：

- 前端 `http://127.0.0.1:8080`
- 本地 API `http://127.0.0.1:8787`

并自动打开 `http://127.0.0.1:8080/?scan=http://127.0.0.1:8787/api/scan-stream`。

其他用法：

```bash
./start.sh --no-api        # 只起前端（浏览器直连 FxTwitter）
./start.sh --no-open       # 不自动开浏览器
./start.sh --port=8090     # 换前端端口
./start.sh --api-port=8888 # 换 API 端口
```

### 命令行

```bash
node mirror.mjs <用户名>
node mirror.mjs <用户名> --blue --sort big
node mirror.mjs <用户名> --sort recent-big
node mirror.mjs <用户名> --no-blue
node mirror.mjs <用户名> --limit 0 --json out.json
node mirror.mjs <用户名> --api https://api.你的域名.com
```

### 诊断接口

```bash
node scripts/check.mjs <用户名>
```

逐个检查 3 个必需接口是否可用。

### 部署到 Vercel

```bash
vercel login
vercel --prod
```

详见 [`DEPLOY-VERCEL.md`](./DEPLOY-VERCEL.md)；Cloudflare 部署见 [`DEPLOY-CLOUDFLARE.md`](./DEPLOY-CLOUDFLARE.md)。

## 输出示例

```text
@someuser  ...
关注 1,234 · 粉丝 1,456 · 抓到 关注 1,2xx / 粉丝 1,4xx
互关 1,0xx · 回关率 xx% · 没回关你 xxx · 你没回关 xxx

【没回关你】xxx 人 · 按关注先后
   1. @xxxx  xxxx ✓ · 12.3万粉
   ...

【你没回关】xxx 人 · 按关注先后
   1. @xxxx  xxxx · 3,456粉
   ...
```

## 参数

| 参数 | 说明 |
| --- | --- |
| `--blue` | 只看蓝V（`verification.verified`） |
| `--no-blue` | 不看蓝V（只列非蓝V） |
| `--sort recent\|big\|small\|recent-big` | 关注先后 / 粉丝多在前 / 粉丝少在前 / 时间优先且同时间粉丝多在前，默认 `recent` |
| `--limit n` | 每栏显示前 n 条，`0` 为全部，默认 40 |
| `--workers n` | 每份名单的并发数，默认 4 |
| `--rps n` | 全局限速（请求/秒），默认 8 |
| `--api url` | 覆盖 API 地址，默认 `https://api.fxtwitter.com` |
| `--json path` | 导出完整 JSON（含 following/followers/notBack/owe） |
| `--csv path` | 导出 CSV（没回关 + 你没回关） |
| `--refresh` | 忽略缓存重新抓 |
| `--no-cache` | 不读也不写缓存 |
| `--cache-dir path` | 缓存目录，默认 `.mirror-cache` |
| `--cache-ttl 分钟` | 缓存有效期，默认 30 |
| `--max-following n` | 关注数上限，默认 50000，`0` 不限制 |
| `--max-followers n` | 粉丝数上限，默认 50000，`0` 不限制 |
| `--max-pages n` | 单份名单最多请求页数，默认 5000 |
| `--timeout ms` | 单请求超时，默认 20000 |
| `--quiet` | 不显示进度 |

## 重要说明

- 数据来自 `api.fxtwitter.com` 的**公开只读接口**，不需要登录、不需要 Cookie、不需要 token。
- 这是非官方接口，随时可能改版或限流；工具里已做重试和限速。
- 想用自己的额度，可以按 [`SELF-HOST.md`](./SELF-HOST.md) 部署一份 FxEmbed，再用 `--api` 指过去。
- 名单里**不会出现被封/注销的号**，所以“抓到的人数”通常会比资料上的关注/粉丝数少一点点。
- “按关注先后”是按接口返回顺序和 cursor 做的 merge，不是精确的 `followed_at` 时间戳（接口不返回这个字段）。
- 请不要高频、大规模抓取；默认 8 请求/秒已经比较保守。大量请求可能被上游限流。
- 仅用于分析自己的账号或获得授权的账号，遵守 X 的使用条款和当地法律。

## 文件

- `lib/mirror-core.mjs`：共享核心（抓取、cursor 二分、比对、序列化）
- `mirror.mjs`：命令行版
- `api/`：Vercel Functions（`scan` / `scan-stream` / `health`）
- `web/`：Web 前端（说明见 [`web/README.md`](./web/README.md)）
- `scripts/check.mjs`：接口诊断
- `scripts/dev-server.mjs`：本地模拟 Vercel Functions
- `vercel.json`、`tsconfig.json`、`package.json`：部署配置
- `start.sh` / `serve-web.sh`：一键启动脚本
- `self-host-fxembed.sh`：自托管 FxEmbed 分步助手（`./self-host-fxembed.sh doctor` 可先检查环境）
- `SELF-HOST.md`：自托管数据源说明
- `DEPLOY-VERCEL.md` / `DEPLOY-CLOUDFLARE.md`：部署说明
- `DESIGN.md`：界面设计规范
- `.mirror-cache/`：命令行版缓存（可删除）
