# 自托管 FxEmbed（自己部署一份 api.fxtwitter.com）

本工具用的 `https://api.fxtwitter.com` 是 **FxEmbed** 的公开实例，MIT 开源，可以自己部署一份。

自己部署的好处：

- 不受公共实例 1000 请求/分钟/IP 的限速
- 不会被对方的 IP 封禁影响
- 可以加自己的 X 账号凭据，更稳定
- 完全掌控

代价：

- 需要 Cloudflare 账号
- 如果想超过免费额度，需要付费（免费额度是 **每天 10 万请求/账号**，本工具一次完整扫描约 500–1000 请求，够用很多次）
- 加凭据需要把自己的 X cookie 加密存到 Cloudflare

---

## 最简单的做法：用我写的脚本

```bash
cd /path/to/hackmirror
./self-host-fxembed.sh
```

脚本会带你走完：

1. 克隆 `https://github.com/FxEmbed/FxEmbed.git` 到 `~/FxEmbed`
2. `npm install`
3. 生成 `wrangler.toml` / `.env` / `branding.json`
4. 检查并提示你填 Cloudflare Account ID
5. `npx wrangler login`
6. 提示可选的 X 凭据配置

想先看环境：

```bash
./self-host-fxembed.sh doctor
```

---

## 手动步骤（官方流程）

### 0. 准备

- Node.js LTS（官方推荐 24，20+ 都能跑）
- Cloudflare 账号：https://dash.cloudflare.com/sign-up
- Cloudflare Account ID：登录后右侧栏 Account ID，是 32 位十六进制

### 1. 克隆并安装

```bash
git clone https://github.com/FxEmbed/FxEmbed.git
cd FxEmbed
npm install
```

### 2. 配置 wrangler.toml

```bash
cp wrangler.example.toml wrangler.toml
```

编辑 `wrangler.toml`：

```toml
name = "fxembed"
account_id = "你的 32 位 Account ID"
main = "./dist/worker.js"
compatibility_date = "2026-04-11"
```

不用 Cloudflare Analytics Engine 的，可以删掉 `analytics_engine_datasets` 那段。

### 3. 配置环境变量

```bash
cp .env.example .env
```

只想给本工具用的话，把 `STANDARD_DOMAIN_LIST` 和 `API_HOST_LIST` 配成你的域名即可，
其余平台相关的条目留空（见下文的最小配置），然后把 `YOURDOMAIN` 换成你的域名。

和本工具相关的主要是 API 域名：

| 变量 | 作用 | 示例 |
| --- | --- | --- |
| `API_HOST_LIST` | 你自托管的 API 域名 | `api.你的域名.com` |
| `STANDARD_DOMAIN_LIST` | 默认 zone（至少一个） | `你的域名.com` |

不配自定义域名也能跑，会使用 `*.workers.dev` 地址（模板里有方案 B）。

### 4. 品牌配置（可选）

```bash
cp branding.example.json branding.json
```

可以改名称、颜色、图标、跳转地址。

### 5. 登录并部署

```bash
npx wrangler login
npm run deploy
```

成功后会打印类似：

```text
https://fxembed.你的账号.workers.dev
```

### 6. 自定义域名（可选）

在 Cloudflare Dashboard → Workers & Pages → 你的 worker → Settings → Domains & Routes 里绑定，例如 `api.你的域名.com`。

---

## 可选：加 X 账号凭据

不加也能用，但**限速更低，且抓不到 NSFW 内容**。本工具这种只读公开资料的使用，不加基本够用。

想加的话：

1. 浏览器登录 x.com
2. 开发者工具 → Application → Cookies → `https://x.com`
3. 取下这两个值：
   - `auth_token` → `authToken`
   - `ct0` → `csrfToken`

创建 `credentials.json`：

```json
{
  "twitter": {
    "accounts": [
      { "authToken": "...", "csrfToken": "...", "username": "你的小号" }
    ]
  }
}
```

然后：

```bash
npx wrangler secret put CREDENTIAL_KEY     # 输入一个长随机串，记好
npm run credentials:encrypt-push           # 加密并推到 R2
```

> ⚠️ `auth_token` 等于你的 X 登录态，泄露就等于账号被盗。
> 官方也建议**用小号**，不要用主号。脚本和文档都不会把它写进 git。

---

## 把本工具切到你自己的接口

部署完成后，把 API 地址改掉即可。

### Web 版

改常量（第 8 行）：

```js
const API = 'https://api.fxtwitter.com';   // 改成
const API = 'https://api.你的域名.com';
```

也可以不改代码，直接在网址上加 `?api=` 临时切换（会写在地址栏里，刷新后仍生效）：

```text
https://你的站点/?u=someuser&api=https://api.你的域名.com
```

### 命令行版

编辑 `mirror.mjs`：

```js
const API = 'https://api.fxtwitter.com';
```

改成你的地址后照常用：

```bash
node mirror.mjs someuser --limit 5
```

---

## 它是不是“最佳第三方 X API”？

只用它做本工具：**是，目前是最合适的一个**；但如果只说“最佳第三方 X API”，答案要分场景。

### 为什么本工具场景它最合适

| 维度 | FxEmbed / api.fxtwitter.com |
|---|---|
| 费用 | 0 元，不用 key、不用账号、不用绑卡 |
| 开源 | MIT，可自托管 |
| 浏览器直连 | CORS `*`，纯静态页面就能跑 |
| 关注/粉丝列表 | 原生支持（`/2/profile/{handle}/following` / `followers`），带游标 |
| 字段 | 姓名、头像、简介、粉丝数、关注数、注册时间、蓝V、机构号，正好够比对 |
| 限速 | 1000 请求/分钟/IP，对个人用很宽松 |
| 稳定性 | Cloudflare Workers，社区维护活跃（5.9k star） |

你不需要写入、不需要私信、不需要历史归档，这些正好是 FxEmbed 的短板，所以不构成问题。

### 但如果你要做产品，它不一定是“最佳”

| 场景 | 更合适的方案 |
|---|---|
| 个人小工具、一次性分析 | **FxEmbed / FxTwitter**（免费、开源、可自托管） |
| 要写入：发推、点赞、关注、取关 | TwitterAPI.io、GetXAPI 这类（FxEmbed 只读） |
| 需要稳定 SLA、工业级吞吐 | 商业 API：TwitterAPI.io、Sorsa、GetXAPI、TwitterAPIs 等 |
| 需要历史全量搜索 | 商业 API 或官方 X API（按量付费） |
| 完全不能依赖第三方 | 官方 X API（2026 年起按量计费，读帖约 $0.005/条、读用户约 $0.010/个，月度上限 300 万条） |

几个商业替代的大致价格（2026 年公开信息，会变）：

- **TwitterAPI.io**：约 $0.15 / 1,000 条；粉丝/关注列表约 $0.01 起 / 1,000 人；最低每请求 $0.00015
- **GetXAPI**：约 $0.001 / 请求，73 个端点
- **TwitterAPIs**：约 $0.0008 / 请求
- **Sorsa**：约 $49/月 10,000 请求

### 它的短板要说清楚

- **只读**：不能发推、关注、取关、私信
- **无 SLA**：志愿者项目，可能限流、改版、封 IP
- **凭据意味着更大风险**：自托管加 X cookie 等于托管登录态，泄露就是盗号
- **不是 X 官方**：数据来自 X 的公开接口，随时可能随 X 改版失效
- **列表有截断**：被封/注销的号不返回，所以抓到人数会比资料少
- **没有精确关注时间**：只有游标顺序，没有 `followed_at`

### 结论

- 本工具这种“读公开的关注/粉丝、比对差集”的需求：**FxEmbed 是当前最佳选择**，免费开源可自托管，没有理由换
- 一旦需要写入、SLA、大规模或历史数据：换商业 API 或官方 X API
- 长期怕它挂：按本文档自己部署一份，成本只有 Cloudflare 免费额度

---
**Q：免费额度够用吗？**
免费版每天 10 万请求/账号。本工具扫一次 1 万粉 + 1 万关注的号大约 500–800 请求，一天能扫一百多次，个人用完全够。

**Q：不加凭据会怎样？**
接口仍可用，但走的是未登录路径，限速更低，NSFW 内容拿不到。本工具只取姓名/粉丝数/蓝V，不受影响。

**Q：需要 R2 吗？**
只有加凭据才需要（加密后的凭据存在 R2 里）。不加凭据不用开 R2。

**Q：Analytics Engine 要不要开？**
可以删。它只用来统计“帖子请求成功/失败率、访问国家、UA、语言”，而且是匿名聚合，不记录具体帖子或用户。本工具走的是 `/2/profile/...` 个人资料接口，不经过这段统计逻辑，开不开对功能没影响。

- 想白嫖一点观测数据：保留 `analytics_engine_datasets` 那几行
- 想最省事、最干净：删掉，Worker 照常工作，`host.analyticsEngine` 为 `undefined` 时项目自己会跳过写入
- 额度：免费版每天 10 万数据点；目前 Cloudflare 也还没实际计费

**Q：能部署到 Vercel / 阿里云 / 自己的服务器吗？**
官方项目是一个 Cloudflare Worker（基于 Hono），理论上可移植到其他 Web 标准运行时，但官方只推荐 Cloudflare，并提供了 Docker 方式本地跑。

**Q：更新怎么办？**

```bash
cd ~/FxEmbed
git pull
npm install
npm run deploy
```

**Q：日志怎么看？**

```bash
npm run log      # wrangler tail
```

---

## 官方链接

- 仓库：https://github.com/FxEmbed/FxEmbed
- 自托管文档：https://docs.fxembed.com/deployment/
- 配置项：https://docs.fxembed.com/deployment/configuration/
- 凭据配置：https://docs.fxembed.com/deployment/credentials/
- API 文档：https://docs.fxembed.com/api/introduction
