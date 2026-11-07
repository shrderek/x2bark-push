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
//   API_TOKEN    - 可选，设了之后 /status /register /test /wake 需带 ?token=<值>
//                  或头 X-Api-Token:<值>，否则返回 401。不设则所有人可访问（默认）。

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

    // 可选接口鉴权：仅当设置了 API_TOKEN 才生效（不设则保持原行为，所有人可访问）。
    // 设了之后，外部请求需带 ?token=<API_TOKEN> 或头 X-Api-Token:<API_TOKEN>，否则返回 401。
    // Cron 保活走 scheduled -> proxy 内部调用，不经过此处，不受影响。
    if (env.API_TOKEN) {
      const provided =
        url.searchParams.get("token") || request.headers.get("X-Api-Token");
      if (provided !== env.API_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

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
          "x2bark-push\n\nGET /status       查看连接状态\nGET /wake         确保监听运行\nGET /register     强制重新注册订阅\nGET /test         测试 Bark 推送\n",
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        );
    }
  },

  // 每分钟拉活一次：DO 掉了（重新部署/驱逐）就拉起来
  async scheduled(event, env, ctx) {
    ctx.waitUntil(proxy(env, "ensure"));
  },
};
