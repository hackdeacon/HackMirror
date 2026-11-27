# HackMirror

比对一个 X 账号的**关注列表**和**粉丝列表**，找出：

- **没回关你**：你关注了 TA，TA 没关注你
- **你没回关**：TA 关注了你，你还没关注 TA
- **互关人数 / 回关率**
- **蓝V / 非蓝V 拆分统计**
- **筛选**：只看蓝V、不看蓝V、不看万粉（≥ 1 万）、不看锁推
- **排序**：按关注先后（早 → 晚）、时间优先 + 同时间粉丝多、粉丝多在前、粉丝少在前
- **展开所有 / 复制名单 / 导出 JSON / CSV**
- **标记已点击**：点开过的账号变灰并显示「已看」，可随时开关
- **多选 / 批量打开 / 批量取关**：批量打开主页、生成取关脚本或配合浏览器扩展

只读取公开资料，不需要登录、Cookie 或 token。关注和粉丝默认各支持 5 万（可调），适合万级账号。

## 架构

```text
web/          纯静态前端（无构建），提供 Web 界面和 PWA
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

## Web 版

输入 `@用户名` 或 `x.com/用户名` 即可扫描，结果分两个标签页：

- **没回关你**：你关注了但 TA 没回关
- **你没回关**：TA 关注了你但你没回关

工具栏支持：

| 功能 | 说明 |
| --- | --- |
| 只看蓝V | 只显示 `verification.verified === true` |
| 不看蓝V | 只显示非蓝V |
| 不看万粉 | 隐藏粉丝数 ≥ 10,000 的账号（9,999 保留） |
| 不看锁推 | 隐藏 `protected === true` 的账号，适合过滤无法回关的锁推号 |
| 排序 | 关注先后（早→晚）/ 时间优先 + 同时间粉丝多在前 / 粉丝多在前 / 粉丝少在前 |
| 展开所有 | 一次显示剩余全部，不用反复点「再显示」 |
| 标记已点击 | 点开过的账号变灰并显示「已看」；开关关闭时不显示标记；点「清除已看」可重置 |
| 复制名单 | 跟随当前筛选和排序 |
| 导出 JSON / CSV | 完整差集，**不受**页面筛选影响 |

统计卡片会显示「没回关你 / 你没回关」的总数，以及其中的蓝V / 非蓝V人数。

页面是 PWA：资源网络优先、离线可回退缓存；有 IndexedDB 结果缓存（30 分钟），刷新页面不用重新抓。

## 批量操作与取关

结果列表支持「多选」，勾选后可：

- **打开选中**：一次最多打开 10 个主页，由你手动取关（最安全）
- **取关脚本**：生成一段脚本，复制到已登录的 `x.com` 控制台执行；带 2–3.5 秒间隔，按 `Esc` 可停止
- **复制取关清单**：复制 JSON 清单，配合 [`extension/`](./extension/) 浏览器扩展使用

> 直接在本站批量取关是做不到的：取关需要 x.com 的登录态，跨域页面读不到 Cookie，也不应该把凭据交给第三方站点。
> 取关脚本和扩展都是在你自己的 `x.com` 会话里执行，不保存凭据。
>
> ⚠ 自动化取关可能触发 X 风控或限流，建议每次不超过 50 个。接口改版时脚本/扩展可能失效。

## 命令行

```bash
node mirror.mjs <用户名>
node mirror.mjs <用户名> --blue --sort big
node mirror.mjs <用户名> --sort recent-big
node mirror.mjs <用户名> --no-blue
node mirror.mjs <用户名> --no-big
node mirror.mjs <用户名> --no-lock
node mirror.mjs <用户名> --limit 0 --json out.json
node mirror.mjs <用户名> --api https://api.你的域名.com
```

### 诊断接口

```bash
node scripts/check.mjs <用户名>
```

逐个检查 3 个必需接口是否可用。

## API

Vercel Functions 提供三个端点：

| 端点 | 说明 |
| --- | --- |
| `GET /api/scan?u=用户名` | 同步返回完整 JSON |
| `GET /api/scan-stream?u=用户名` | NDJSON 流式返回，带进度 |
| `GET /api/health` | 健康检查，`?probe=1&u=用户名` 可验证上游连通性 |

`/api/scan` 与 `/api/scan-stream` 支持：

| 参数 | 说明 |
| --- | --- |
| `u` / `handle` | 必填，支持 `@用户名` 或 `x.com/用户名` |
| `sort` | `recent`（默认）/ `big` / `small` / `recent-big` |
| `blue` | `1` 只看蓝V；`0` 不看蓝V；不传为全部 |
| `noBig` | `1` 不看万粉及以上（粉丝 ≥ 1 万） |
| `noLock` | `1` 不看锁推账号 |

示例：

```bash
curl 'https://your-app.vercel.app/api/scan?u=someuser&sort=recent-big&blue=1&noBig=1&noLock=1'
```

## 部署

Vercel：

```bash
vercel login
vercel --prod
```

详见 [`DEPLOY-VERCEL.md`](./DEPLOY-VERCEL.md)；Cloudflare 部署见 [`DEPLOY-CLOUDFLARE.md`](./DEPLOY-CLOUDFLARE.md)。

> Cloudflare Pages 需要把**构建输出目录**设为 `web`，否则站点会直接暴露仓库根目录。

## 输出示例

```text
@someuser  ...
关注 1,234 · 粉丝 1,456 · 抓到 关注 1,2xx / 粉丝 1,4xx
互关 1,0xx · 回关率 xx% · 没回关你 xxx · 你没回关 xxx

【没回关你】xxx 人 · 按关注先后（早→晚）
   1. @xxxx  xxxx ✓ · 12.3万粉
   ...

【你没回关】xxx 人 · 按关注先后（早→晚）
   1. @xxxx  xxxx · 3,456粉
   ...
```

> 蓝V / 非蓝V 的拆分显示在 Web 统计卡片中；CLI 在加 `--blue` 或 `--no-blue` 时会额外输出对应小计。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--blue` | 只看蓝V（`verification.verified`） |
| `--no-blue` | 不看蓝V（只列非蓝V） |
| `--no-big` | 不看万粉及以上（粉丝 ≥ 1 万） |
| `--no-lock` | 不看锁推账号 |
| `--sort recent\|big\|small\|recent-big` | 关注先后（早→晚）/ 粉丝多在前 / 粉丝少在前 / 时间优先且同时间粉丝多在前，默认 `recent` |
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
- **锁推账号**会正常出现在名单里（`protected: true`），可用「不看锁推 / `--no-lock`」过滤；你无法直接回关它们。
- “按关注先后”是按接口返回顺序和 cursor 做的 merge，不是精确的 `followed_at` 时间戳（接口不返回这个字段）。
- 请不要高频、大规模抓取；默认 8 请求/秒已经比较保守。大量请求可能被上游限流。
- 仅用于分析自己的账号或获得授权的账号，遵守 X 的使用条款和当地法律。

## 文件

- `lib/mirror-core.mjs`：共享核心（抓取、cursor 二分、比对、序列化）
- `mirror.mjs`：命令行版
- `api/`：Vercel Functions（`scan` / `scan-stream` / `health`）
- `web/`：Web 前端（说明见 [`web/README.md`](./web/README.md)）
- `extension/`：可选的浏览器扩展，用你自己的 x.com 会话批量取关（见 [`extension/README.md`](./extension/README.md)）
- `scripts/check.mjs`：接口诊断
- `scripts/dev-server.mjs`：本地模拟 Vercel Functions
- `vercel.json`、`tsconfig.json`、`package.json`：部署配置
- `start.sh` / `serve-web.sh`：一键启动脚本
- `self-host-fxembed.sh`：自托管 FxEmbed 分步助手（`./self-host-fxembed.sh doctor` 可先检查环境）
- `SELF-HOST.md`：自托管数据源说明
- `DEPLOY-VERCEL.md` / `DEPLOY-CLOUDFLARE.md`：部署说明
- `DESIGN.md`：界面设计规范
- `.mirror-cache/`：命令行版缓存（可删除）
