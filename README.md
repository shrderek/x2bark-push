# x2bark-push

把 X（Twitter）的推文通知**秒级**推送到 iPhone（Bark），不用官方付费 API、不爬虫、不轮询，全程跑在 Cloudflare Workers **免费计划**上。

> 机制来自 [xnotif](https://github.com/yutakobayashidev/xnotif)：模拟浏览器 Web Push 客户端，通过 Mozilla AutoPush（Firefox 的推送基础设施）实时接收 X 的通知流，解密后转发到 Bark。

## 特性

- ⚡ 秒级实时 —— WebSocket 长连接收推送，不轮询 X、不爬虫
- 🆓 零成本 —— Cloudflare 免费额度占用 <2%，无需服务器、无需绑卡
- 🔒 Cookie 用得最少 —— `auth_token`/`ct0` 仅在注册订阅时用一次；通知链路端到端加密
- 🔁 全托管自愈 —— 断线指数退避重连、cron 保活、alarm 兜底，消息靠 AutoPush 排队补投不丢失
- 🎛️ 可过滤 —— 按通知类型过滤推送
- 🔔 Cookie 失效告警 —— X 拒绝 cookie（`login.json` 401/403）时自动发 Bark 通知（分组 `x2bark-alert`，指向本教程日常维护段）并附原因与解决方法；重注册成功后发「✅ x2bark 已恢复」。其余错误与 Bark 自身故障不告警，避免噪音与循环

## 快速开始

```bash
npm install -g wrangler
wrangler login

wrangler secret put BARK_KEY     # Bark App 里 api.day.app/XXXXX 的 XXXXX
wrangler secret put AUTH_TOKEN   # x.com cookie 的 auth_token
wrangler secret put CT0          # x.com cookie 的 ct0

wrangler deploy
```

然后访问 `https://x2bark-push.<你的子域>.workers.dev/status` 确认 `"connected": true`，再访问 `/register` 和 `/test` 即可。

**没注册过 Cloudflare、完全没用过命令行？** 看保姆级教程 👉 [TUTORIAL.md](TUTORIAL.md)（含每步验证方法和踩坑排查）

**想知道它为什么能做到实时、免费、不爬虫？** 看原理详解 👉 [PRINCIPLES.md](PRINCIPLES.md)（AutoPush 协议、RFC 8291 解密、X 注册链路、额度分析、踩坑记录）

## 端点

| 路径 | 作用 |
|---|---|
| `/status` | 查看连接状态（connected / uaid / endpoint / 最近通知 / 最近重注册 / 最近自动重注册 / 最近错误） |
| `/wake` | 手动确保监听运行（一般不用，cron 每分钟自动拉活） |
| `/register` | 强制重新向 X 注册订阅（cookie 换新后用） |
| `/test` | 发送测试 Bark 推送 |

## 可选配置（wrangler.toml `[vars]`）

| 变量 | 说明 |
|---|---|
| `BARK_SERVER` | 自建 bark-server 地址，默认 `https://api.day.app` |
| `NOTIFY_TYPES` | 只推送这些类型（逗号分隔），留空全部。可用的值：`tweet, reply, mention, follower, favorite, xchat_message_received` |
| `RE_REGISTER_HOURS` | **推送链路自愈·第一重**：每隔 N 小时自动向 X 重注册订阅（应对 X 静默失效订阅），`0` = 关闭，**默认 12**。计时只看自动重注册，手动 `/register` 不计入 |
| `SILENCE_HOURS` | **推送链路自愈·第二重**：连续 N 小时没收到 X 推送（不含 `/test`）则自动重注册，`0` = 关闭（**默认关闭**），想开启填 `2`。同样不计入手动 `/register` |

## 通知类型与文案

Bark 标题/正文/链接的生成规则（对照表）、去重逻辑与结论 👉 [PRINCIPLES.md](PRINCIPLES.md#通知类型与文案对照)。

## 前置条件与覆盖范围

- iPhone 装 [Bark](https://apps.apple.com/app/id1403753865)，拿到 key
- 在 X 上**关注**想监控的账号并点 🔔「所有推文」
- ⚠️ 这条链路接收的是「你的账号」收到的通知流，所以只覆盖你关注并开铃铛的账号——做不到监控任意公开账号

## 日常维护

只记一件事：**改 X 密码或登出后 cookie 失效** → 重新抓 cookie（F12 → Application → Cookies → `auth_token` 和 `ct0`）→ `wrangler secret put` 更新两个 secret → 访问 `/register`。其余情况（重新部署、连接被平台回收等）都会在 1 分钟内自动恢复。

> 🔔 **自动告警**：Worker 每次重注册若收到 X 的 `401`/`403`，会直接发 Bark 通知（标题 `⚠️ x2bark 错误：401/403`，含原因与解决方法，点开跳本段）；重新注册成功后发「✅ x2bark 已恢复」。所以多数时候你不用再手动查 `/status`。Bark 自身故障（如 522）发不出也不告警，避免循环。

## 免责声明

本项目通过模拟浏览器 Web Push 客户端接收 X 的通知，仅供个人学习研究使用。请遵守 X 的服务条款，勿用于批量监控、爬取或商业用途。若上游机制（xnotif / fa0311 的依赖）失效，请关注原仓库更新。

## 开源协议

[MIT](LICENSE) © 2026 shrderek

本项目是 [xnotif](https://github.com/yutakobayashidev/xnotif)（MIT）的 Cloudflare Workers 移植版，遵循 MIT 协议并保留上游版权声明。可自由使用、修改、分发，请保留 LICENSE 中的版权与许可声明。第三方组件的完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

- [xnotif](https://github.com/yutakobayashidev/xnotif) —— 核心机制来源
- [fa0311](https://github.com/fa0311) —— 浏览器指纹与 x-client-transaction-id 算法依赖
- [Bark](https://github.com/Finb/Bark) —— iOS 推送通道
