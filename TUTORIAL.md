# x2bark-push 从零部署教程（零基础版）

目标：把「X（Twitter）推文实时通知 → iPhone Bark 推送」跑起来，**全程使用 Cloudflare 免费额度，不需要服务器、不需要信用卡**。

预计耗时 20–30 分钟。按顺序做，每一步都附了验证方法。卡住了直接看文末 [常见问题](#常见问题排查)。

> 想了解它为什么能做到实时、免费、不爬虫？部署完成后可以读 [原理文档 PRINCIPLES.md](PRINCIPLES.md)。

---

## 你需要准备什么

| 东西              | 说明                       |
| --------------- | ------------------------ |
| 一台 iPhone       | 用来装 Bark 接收推送            |
| 一个 X（Twitter）账号 | 用来「订阅」通知流                |
| 一台电脑            | Windows / macOS 都行，跑几条命令 |
| 一个邮箱            | 注册 Cloudflare 用          |

---

## 第 0 步：收集三个字符串（手机 + 电脑各 2 分钟）

整个部署只需要填 3 个密钥，先把它们准备好。

### 0.1 BARK_KEY —— iPhone 装 Bark

1. App Store 搜索 **Bark** 安装（免费），或直接打开 <https://apps.apple.com/app/id1403753865> 下载。打开后允许通知权限（首页会显示「通知权限已开启」）
2. 在首页「**使用示例**」下面有个「**复制**」按钮，点它右侧的 `⌄` 箭头，弹出菜单选「**复制 Key**」——剪贴板里得到的就是你的 **BARK_KEY**（一串类似 `AbCdEf123XyZ` 的字符）
3. 把 BARK_KEY 记下来，后面要用

### 0.2 AUTH_TOKEN 和 CT0 —— 从浏览器抓 X 的 cookie

1. 电脑浏览器登录 <https://x.com>
2. 按 `F12` 打开开发者工具 → 顶部选 **Application**（应用）标签
3. 左侧找到 **Cookies** → 点 `https://x.com`
4. 在列表里找到两个名字，分别双击 Value 列复制下来，后面要用：
   - `auth_token` → 这就是 **AUTH_TOKEN**
   - `ct0` → 这就是 **CT0**

> ⚠️ **安全提醒**：这两个值等于你 X 账号的登录凭证。不要发给任何人、不要提交到 git、不要截图时带上。它们只会加密保存在你自己的 Cloudflare 账号里。

### 0.3 给要监控的账号开通知

在 X 网页版进入你想监控的账号主页 → 点铃铛图标 🔔 → 选「**所有推文**」。

> **重要**：本项目的原理是接收「你自己的账号」收到的通知流（详见原理文档），所以**只覆盖你关注并开了铃铛的账号**。没开铃铛的账号不会触发。

---

## 第 1 步：注册 Cloudflare 账号（5 分钟）

1. 打开 <https://dash.cloudflare.com/sign-up>
2. 邮箱 + 设密码即可，**免费计划不需要绑卡**
3. 去邮箱点验证邮件，登录进控制台（蓝色云朵 logo 的页面）

> 国内网络提示：dash.cloudflare.com 一般可直连。如果打不开或极慢，开代理再继续（后面的命令行操作同理）。

---

## 第 2 步：安装 Node.js 和 wrangler（5 分钟）

### 2.1 安装 Node.js

1. 打开 <https://nodejs.org> 下载 **LTS 版本**（20 或 22 都行）
2. Windows 双击安装包一路下一步；macOS 用安装包即可
3. 验证：打开终端（Windows 按 `Win+R` 输入 `powershell` 回车），输入：

```bash
node -v
```

显示 `v20.x.x` 或 `v22.x.x` 之类就说明装好了。

### 2.2 安装 wrangler（Cloudflare 官方命令行工具）

```bash
npm install -g wrangler
```

> 如果下载很慢或报错，先换国内镜像源再重试：
>
> ```bash
> npm config set registry https://registry.npmmirror.com
> npm install -g wrangler
> ```

验证：

```bash
wrangler --version
```

### 2.3 登录 Cloudflare

```bash
wrangler login
```

会自动打开浏览器，点 **Allow**（允许）授权。

> **如果浏览器回调失败/一直转圈**（国内常见），改用 API Token 方式：
>
> 1. 浏览器打开 <https://dash.cloudflare.com/profile/api-tokens>
> 2. 点 **Create Token** → 选模板 **Edit Cloudflare Workers** → Create
> 3. 复制生成的 Token，然后在终端执行（Token 当作环境变量，仅当前窗口有效）：
>    - PowerShell：`$env:CLOUDFLARE_API_TOKEN = "粘贴你的Token"`
>    - macOS/Linux：`export CLOUDFLARE_API_TOKEN="粘贴你的Token"`
>
> 设置了这个环境变量后就不需要 `wrangler login` 了。

---

## 第 3 步：下载本项目并部署（5 分钟）

### 3.1 下载代码

点 GitHub 仓库右上角绿色 **Code** 按钮 → **Download ZIP**，解压到任意位置。  
（或者 `git clone` 本仓库。）

在终端里进入项目目录（ZIP 解压后文件夹名通常是 `x2bark-push-main`）：

```bash
cd x2bark-push-main    # 按你的实际解压路径调整
```

### 3.2 填入三个密钥

依次执行下面三条命令。每条执行后会提示 `Enter a secret value:`，**输入时屏幕上不会显示任何字符（这是正常的安全行为）**，粘贴后直接回车即可：

```bash
wrangler secret put BARK_KEY     # 粘贴 0.1 里记下的 Bark key
wrangler secret put AUTH_TOKEN   # 粘贴 auth_token 的值
wrangler secret put CT0          # 粘贴 ct0 的值
```

> **可能会弹出询问**：`There doesn't seem to be a Worker... would you like to create a new one? (y/n)`  
> —— 这是因为 Worker 还没创建过。**直接按 Y 回车**，wrangler 会先建好占位 Worker 再存密钥，后面部署时自动覆盖。

### 3.3 部署

```bash
wrangler deploy
```

成功的标志：最后输出类似

```
Uploaded x2bark-push (x.xx KiB)
Deployed x2bark-push triggers (0.xx sec)
https://x2bark-push.<你的子域>.workers.dev
```

**记下这个地址**，这就是你的控制面板地址。

> ❗ **如果报错 `workers.dev subdomain` 相关（错误码 10063）**：你的账号还没分配子域名。  
> 解决：浏览器打开 <https://dash.cloudflare.com> → 左侧 **Workers & Pages** → 首次进入会让你选一个子域名（比如 `my-x2bark`，被占了就换一个）→ 确认。  
> 或者直接命令行：`wrangler subdomain 你想要的子域名`，然后重新 `wrangler deploy`。

---

## 第 4 步：验证（3 分钟）

### 4.1 查看监听状态

浏览器打开：

```
https://x2bark-push.你的子域.workers.dev/status
```

期望看到：

```json
{
  "connected": true,
  "uaid": "一串十六进制",
  "endpoint": "https://push.services.mozilla.com/...",
  "lastNotificationAt": null,
  "lastError": null
}
```

- `connected: true` —— 连上 Mozilla 推送服务器了 ✅
- 如果是 `false`，等 1–2 分钟刷新（cron 会自动拉活），还不行访问一次 `/wake` 再刷

### 4.2 注册订阅 + 测试推送

浏览器依次打开：

```
https://x2bark-push.你的子域.workers.dev/register   # 把你的设备注册到 X
https://x2bark-push.你的子域.workers.dev/test       # 发一条测试 Bark 推送
```

`/test` 之后 **iPhone 应该立刻收到标题为 `x2bark` 的测试推送**。收到说明 Bark 链路全通 ✅

---

## 第 5 步（可选）：过滤通知

默认推送所有收到的通知（推文、回复、点赞、关注等）。可以在 `wrangler.toml` 的 `[vars]` 里开启过滤，然后重新 `wrangler deploy`：

```toml
[vars]
BARK_SERVER = "https://api.day.app"
# 只推送这些类型（逗号分隔）。常见类型: tweet, retweet, reply, like, follow, message
NOTIFY_TYPES = "tweet"
# 标题/正文包含关键词才推送（逗号分隔）
# KEYWORDS = "公告,上线"
```

改完记得重新部署：

```bash
wrangler deploy
```

---

## 日常维护（只需记一件事）

**改了 X 密码、或主动登出 X 后，cookie 会失效**，表现为收不到推送、`/status` 的 `lastError` 出现 `login.json` 相关报错。修复流程：

```bash
# 1. 重新抓 cookie（本教程 0.2 的方法）
wrangler secret put AUTH_TOKEN    # 粘贴新的 auth_token
wrangler secret put CT0           # 粘贴新的 ct0
```

**2. 浏览器访问下面这个地址**（换成你自己的子域）：

```
https://x2bark-push.你的子域.workers.dev/register
```

看到返回 JSON 里 `lastError: null` 即修复完成。

**其他情况都不用管**：改代码重新部署、Cloudflare 例行回收连接等都会自动恢复（1 分钟内）。

---

## 常见问题排查

### 部署报错 `10063` / 提示 subdomain

账号没分配 workers.dev 子域名。见 [3.3 的 ❗提示](#33-部署)。

### `wrangler secret put` 弹出 `(y/n)` 问要不要创建 Worker

按 **Y** 回车，正常流程。

### `/status` 一直 `connected: false`

1. 访问一次 `/wake`，等 10 秒再刷
2. 还不行看日志：终端执行 `wrangler tail --format pretty`，然后再访问一次 `/wake`，把日志发到项目 issue 或对照 [原理文档](PRINCIPLES.md) 的日志说明排查

### 推送延迟超过 1 分钟

正常情况下秒级。偶尔的分钟级延迟来自 Cloudflare 回收连接后的重连窗口（详见原理文档），属正常现象，消息不会丢（服务端会补投）。

---

## 费用

- Cloudflare Workers 免费计划：本项目日常消耗不到配额的 2%（详见 [原理文档的额度分析](PRINCIPLES.md#免费额度分析)）
- Bark：免费
- X：免费

**总计：¥0**
