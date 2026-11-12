# 部署到 Cloudflare（手把手）

两种东西可以部署，别搞混：

| 要部署的东西 | 用什么 | 章节 |
|---|---|---|
| **本工具网页**（`web/` 目录，纯静态） | Cloudflare Pages | 第 1 部分 |
| **自己的 FxTwitter API**（本工具的数据源） | Cloudflare Workers | 第 2 部分 |

只做第 1 部分，本工具就能用，数据仍然走公共的 `api.fxtwitter.com`。
做第 2 部分，才能摆脱公共实例的 1000 请求/分钟限速。

---

# 第 1 部分：部署本工具网页到 Cloudflare Pages

## 方式 A：Dashboard 直接上传（最简单，不用命令行）

1. 打开 https://dash.cloudflare.com/ 注册/登录（免费，不用绑卡）
2. 左侧 **Workers & Pages** → **Create** → **Pages** → **Upload assets**
3. Project name 填 `mirror`（这会是你的网址前缀）
4. 把 **`web/` 目录里的 3 个文件**拖进去：
   - `index.html`
   - `style.css`
   - `app.js`
   - （`web/README.md` 不用传）
5. 点 **Deploy site**
6. 完成后访问：`https://mirror.pages.dev`

> 注意：拖的是 `web/` 里的**文件本身**，不是 `web` 这个文件夹；
> 否则会变成 `https://mirror.pages.dev/web/`。

## 方式 B：命令行（Wrangler）

```bash
cd /path/to/hackmirror
npx wrangler@latest pages deploy web --project-name mirror
```

第一次会让你 `npx wrangler login` 打开浏览器授权。

成功输出：

```text
✨ Deployment complete! Take a peek over at https://mirror.pages.dev
```

## 方式 C：GitHub 自动部署

1. 把项目 push 到 GitHub
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. 选仓库，构建配置填：
   - Framework preset: `None`
   - Build command: 留空
   - Build output directory: `web`
4. Save and Deploy

之后每次 push 自动重新部署。

## 绑定自己的域名

Pages 项目 → Custom domains → Set up a custom domain，例如 `mirror.你的域名.com`。

## 部署完记得检查

打开 `https://mirror.pages.dev/?u=someuser`，能看到结果就说明接口跨域正常。

如果页面能打开但一直报网络错误，检查浏览器是否装了拦第三方请求的插件/代理。

---

# 第 2 部分：部署自己的 FxTwitter API 到 Cloudflare Workers

## 0. 准备

- Node.js 20+（Apple Silicon 装 `brew install node`）
- Cloudflare 账号（免费版每天 10 万请求）
- 拿到 **Account ID**：https://dash.cloudflare.com → 首页右侧栏 → Account ID（32 位十六进制）

## 1. 克隆并安装

```bash
git clone https://github.com/FxEmbed/FxEmbed.git
cd FxEmbed
npm install
```

## 2. 配置 wrangler.toml

```bash
cp wrangler.example.toml wrangler.toml
```

编辑 `wrangler.toml`：

```toml
name = "fxembed"
account_id = "你的32位AccountID"
main = "./dist/worker.js"
compatibility_date = "2026-04-11"
send_metrics = false

[build]
command = "npm run build"
```

不用 Analytics Engine 的话，删掉 `analytics_engine_datasets` 那几行。

## 3. 配置 .env（只留 Twitter，可选）

```bash
cp .env.example .env
```

只做 X 的话，可以把其他平台清空：

```ini
STANDARD_DOMAIN_LIST = "你的域名.com"
STANDARD_BSKY_DOMAIN_LIST = ""
STANDARD_TIKTOK_DOMAIN_LIST = ""
STANDARD_INSTAGRAM_DOMAIN_LIST = ""
BLUESKY_API_HOST_LIST = ""
ATMOSPHERE_API_HOST_LIST = ""
API_HOST_LIST = "api.你的域名.com"
```

不想配域名也行，直接用 `*.workers.dev`：

```ini
STANDARD_DOMAIN_LIST = "fxembed.你的账号.workers.dev"
API_HOST_LIST = "api.fxtwitter.你的账号.workers.dev"
```

## 4. 登录并部署

```bash
npx wrangler login
npm run deploy
```

成功后终端会打印你的 Worker 地址，例如：

```text
https://fxembed.<你的账号>.workers.dev
```

## 5. 验证

```bash
curl 'https://fxembed.<你的账号>.workers.dev/2/profile/someuser'
curl 'https://fxembed.<你的账号>.workers.dev/2/profile/someuser/followers'
```

返回 `{"code":200,...}` 就成功。

## 6. 可选：加 X 凭据（更稳）

不加也能用，只是限速更低、抓不到 NSFW。

1. 浏览器登录 x.com，开发者工具 → Application → Cookies → `https://x.com`
2. 复制 `auth_token` 和 `ct0`
3. 在 `FxEmbed` 目录建 `credentials.json`：

```json
{
  "twitter": {
    "accounts": [
      { "authToken": "auth_token 的值", "csrfToken": "ct0 的值", "username": "小号用户名" }
    ]
  }
}
```

4. 推送：

```bash
npx wrangler secret put CREDENTIAL_KEY
npm run credentials:encrypt-push
```

> ⚠️ 这等于托管你的 X 登录态，泄露就是盗号。务必用小号。

## 7. 可选：绑定自定义域名

Dashboard → Workers & Pages → `fxembed` → Settings → Domains & Routes → Add custom domain，绑定：

- `api.你的域名.com` → 给本工具用
- `你的域名.com` → 嵌入页

## 8. 把本工具指向自己的 API

方式一：直接改常量

```js
// web/app.js 第 8 行
const API = 'https://api.你的域名.com';

// mirror.mjs 第 22 行
const API = 'https://api.你的域名.com';
```

方式二：不改代码，网址加参数

```text
https://mirror.pages.dev/?api=https://api.你的域名.com
```

然后重新部署 Pages（方式 A 重新拖文件，或方式 B 重跑 wrangler）。

> 自托管 Worker 一定要在响应里带 `access-control-allow-origin`，原来的 FxEmbed 代码默认就是 `*`。
> 如果你自己包了一层代理，记得别把这个头吞掉。

---

# 常见问题

**Q：部署 Pages 需要 Node 吗？**
不需要，方式 A 纯网页操作。方式 B/C 才需要。

**Q：Pages 和 Workers 哪个免费额度大？**
Pages：每月 500 次构建、无限静态请求。
Workers：每天 10 万请求。本工具网页只消耗 Pages 的静态流量。

**Q：Worker 部署后一直 500？**
先看 `npm run log`，常见是 `account_id` 填错，或 `.env` 的 `API_HOST_LIST` 没对上实际域名。

**Q：本工具网页报 CORS？**
自托管 Worker 默认带 `access-control-allow-origin: *`。如果出错，检查是不是绑了 Cloudflare Access 之类的访问策略。

**Q：能只部署网页、不部署 API 吗？**
能，而且推荐先这么做。公共 API 对个人足够用。

**Q：一晚上用太多会被限流吗？**
公共实例约 1000 请求/分钟/IP。本工具单次扫描 500–800 请求，连续扫十几个号会触发，等几分钟即可。
