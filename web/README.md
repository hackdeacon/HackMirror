# HackMirror Web 版

纯静态页面，不需要后端、不需要构建、不需要登录。只需要 Python 3 用来起一个本地静态服务器；浏览器直接请求 `api.fxtwitter.com` 的公开只读接口。

## 运行

在项目根目录：

```bash
./start.sh
```

会自动打开：

```text
http://127.0.0.1:8080
```

其他用法：

```bash
./start.sh --no-open       # 只启动，不自动开浏览器
./start.sh --port=8090     # 换端口
```

也可以手动：

```bash
cd web
python3 -m http.server 8080
```

> 建议用本地 HTTP 服务打开，不要直接双击 `index.html`。虽然接口允许跨域，但部分浏览器对 `file://` 的限制更多。

`web/` 是纯静态目录，也可以直接部署到 Cloudflare Pages / Vercel / Netlify 等静态托管。

## 功能

- 输入 `@用户名` 或 `x.com/用户名`
- 抓取关注列表 + 粉丝列表
- 两个 tab：
  - **没回关你**：你关注了 TA，TA 没关注你
  - **你没回关**：TA 关注了你，你没关注 TA
- **只看蓝V**
- 排序：
  - 按关注先后（接口返回顺序的精确 merge）
  - 粉丝多的在前
  - 粉丝少的在前
- 复制名单（`@handle` 一行一个，跟当前筛选/排序一致）
- 导出 JSON（完整差集 + 精简的两份全名单；不受“只看蓝V”影响）
  - `following` / `followers`：`id, handle, name, followers, verified`，按关注先后排序
  - `notBack` / `owe`：完整差集记录（含关注数/排序键）
- 导出 CSV（没回关 + 你没回关，不受“只看蓝V”影响）
- IndexedDB 缓存 30 分钟，刷新页面不用重新抓
- 支持取消、重试、限流自动退避
- 移动端适配

## 规模上限

- 关注 / 粉丝默认各支持 50,000
- 超出上限时可调整 `max-following` / `max-followers`（命令行），或环境变量 `MAX_FOLLOWING` / `MAX_FOLLOWERS`（服务端）
- 万级账号建议用流式接口或命令行版，避免托管平台的函数执行时限

## 实现要点

- `apiGet()`：`https://api.fxtwitter.com/2/profile/{handle}/{following|followers}`
- `cursor` 形如 `<sortKey>|<nonce>`，可以拿第一页的 `nonce` 伪造任意 `sortKey`，实现区间并行抓取
- 每份名单 4 个 worker，全局限速 8 请求/秒
- 每个用户记录排序区间 `(lo, hi)`，重复出现时取交集；`recent` 按区间中点排序
- 按数字 `id` 比对，不按用户名
- 蓝V判断：`verification.verified === true`
- 覆盖率低于 90% 时自动顺序补抓一次；仍然偏低会显示警告

## 文件

- `index.html`：页面结构
- `style.css`：深色主题样式
- `app.js`：抓取、比对、缓存、渲染、导出

## 注意

- 这是非官方接口，可能改版或限流。
- 浏览器控制台偶尔出现 `404` / `429` 是探测空 cursor 区间或接口限流的正常现象；代码会自动重试/跳过，不影响最终结果。
- 被封/注销的号不会出现在名单里，抓到人数通常略少于资料。
- “按关注先后”是按接口 cursor 顺序做的精确 merge，不是接口返回的 `followed_at` 字段（接口没有这个字段）。
- 仅用于分析自己的账号或已获授权的账号，请勿高频抓取。
