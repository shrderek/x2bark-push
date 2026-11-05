// x2bark-push: 把 xnotif 的 AutoPush 推送监听机制移植到 Cloudflare Workers
// Worker 入口：HTTP 控制面 + Cron 保活
//
// Secrets (wrangler secret put):
//   BARK_KEY   - Bark 的 key（api.day.app/XXXXX 里的 XXXXX）
//   AUTH_TOKEN - x.com 的 auth_token cookie
//   CT0        - x.com 的 ct0 cookie
// Vars (wrangler.toml):
//   BARK_SERVER  - 可选，默认 https://api.day.app
//   NOTIFY_TYPES - 可选，逗号分隔只推送这些类型（留空推送全部）
//   KEYWORDS     - 可选，逗号分隔关键词过滤（留空不过滤）

import { Listener } from "./listener.js";

export { Listener };

function stub(env) {
  return env.LISTENER.get(env.LISTENER.idFromName("singleton"));
}

async function proxy(env, path) {
  const r = await stub(env).fetch(`https://listener/${path}`);
  return new Response(await r.text(), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/status":
        return proxy(env, "status");
      case "/wake": // 手动唤醒/重连
        return proxy(env, "ensure");
      case "/register": // 强制重新向 X 注册订阅（cookie 换新后用）
        return proxy(env, "register");
      case "/test": // 发一条测试 Bark 推送
        return proxy(env, "test");
      default:
        return new Response(
          "x2bark-push\n\nGET /status    查看连接状态\nGET /wake     确保监听运行\nGET /register 强制重新注册订阅\nGET /test     测试 Bark 推送\n",
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        );
    }
  },

  // 每分钟拉活一次：DO 掉了（重新部署/驱逐）就拉起来
  async scheduled(event, env, ctx) {
    ctx.waitUntil(proxy(env, "ensure"));
  },
};
