// Durable Object：持有到 Mozilla AutoPush 的 WebSocket 长连接
// 移植自 xnotif (github.com/yutakobayashidev/xnotif) 的 autopush.ts / decrypt.ts / twitter.ts / utils.ts
// 改动点：Buffer -> atob/btoa，EventEmitter -> 直接回调，状态持久化到 DO storage

const AUTOPUSH_URL = "wss://push.services.mozilla.com/";
const VAPID_KEY =
  "BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs";
const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const HEADER_URL =
  "https://raw.githubusercontent.com/fa0311/latest-user-agent/refs/heads/main/header.json";
const PAIR_URL =
  "https://raw.githubusercontent.com/fa0311/x-client-transaction-id-pair-dict/refs/heads/main/pair.json";

const ALARM_INTERVAL_MS = 5 * 60 * 1000; // alarm 兜底自检间隔
const MAX_RECONNECT_DELAY = 5 * 60 * 1000;
const RE_REGISTER_COOLDOWN_MS = 60 * 60 * 1000; // 退避：两次自动重注册最小间隔 1h，避免疯狂重注册

export class Listener {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.decryptor = null;
    this.channelId = null;
    this.savedEndpoint = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.closed = false;
    this.lastNotificationAt = null;
    this.lastRegisterAt = 0;
    this.lastError = null;
    this.connecting = null; // 进行中的 connect promise，防止并发重连
  }

  async fetch(request) {
    const cmd = new URL(request.url).pathname.replace(/^\//, "");
    try {
      switch (cmd) {
        case "ensure":
          await this.ensure(false);
          break;
        case "register":
          await this.ensure(true);
          break;
        case "test":
          await this.barkPush("x2bark", "测试推送：监听端工作正常");
          break;
        case "stop":
          this.closed = true;
          this.ws?.close();
          break;
      }
    } catch (e) {
      this.lastError = String(e?.message || e);
    }
    return Response.json(await this.statusObj());
  }

  async alarm() {
    // 兜底：socket 挂了就重连
    if (!this.closed && !(this.ws && this.ws.readyState === 1)) {
      try {
        await this.ensure(false);
      } catch (e) {
        this.lastError = String(e?.message || e);
      }
    }
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  async statusObj() {
    return {
      connected: !!(this.ws && this.ws.readyState === 1),
      uaid: this.uaid || null,
      endpoint: this.savedEndpoint || null,
      lastNotificationAt: this.lastNotificationAt ? new Date(this.lastNotificationAt).toISOString() : null,
      lastRegisterAt: this.lastRegisterAt ? new Date(this.lastRegisterAt).toISOString() : null,
      lastError: this.lastError,
    };
  }

  // ---- 去重：按 tag（或 type+uri）记录最近 50 条，命中即丢弃 ----
  async isDuplicate(key) {
    const seen = (await this.state.storage.get("seenTags")) || [];
    if (seen.includes(key)) return true;
    seen.unshift(key);
    await this.state.storage.put("seenTags", seen.slice(0, 50));
    return false;
  }

  async loadPersist() {
    return (await this.state.storage.get("persist")) || null;
  }

  // 自愈相关的时间戳（跨 DO 重启不丢）：上次收到 X 推送、上次重注册
  async loadMeta() {
    return (await this.state.storage.get("meta")) || {};
  }

  async saveMeta(patch) {
    const m = (await this.state.storage.get("meta")) || {};
    Object.assign(m, patch);
    await this.state.storage.put("meta", m);
  }

  // ---- 两重自愈：自动向 X 重注册，避免「X 静默失效 → 收不到但无报错」 ----
  // 第一重（定时）：距上次重注册 > RE_REGISTER_HOURS 则重注册（默认每 12h）。
  // 第二重（静默）：连续 SILENCE_HOURS 没收到 X 推送（不含 /test）则重注册（默认关闭）。
  // 两者都受 1h 退避约束：两次重注册至少间隔 1h，避免疯狂重注册。
  async maybeAutoRegister() {
    if (!this.currentEndpoint) return;
    const now = Date.now();
    const sinceReg = now - (this.lastRegisterAt || 0);
    if (sinceReg < RE_REGISTER_COOLDOWN_MS) return; // 退避期内，不重注册
    const reRegMs = hoursToMs(this.env.RE_REGISTER_HOURS);
    const silenceMs = hoursToMs(this.env.SILENCE_HOURS);
    const layer1 = reRegMs > 0 && sinceReg > reRegMs;
    const sinceNotif = this.lastNotificationAt ? now - this.lastNotificationAt : 0;
    const layer2 = silenceMs > 0 && this.lastNotificationAt && sinceNotif > silenceMs;
    if (layer1 || layer2) {
      console.log(
        `[self-heal] 触发自动重注册 layer1=${layer1} layer2=${layer2} sinceReg=${Math.round(sinceReg / 3600000)}h`,
      );
      await this.registerWithX();
    }
  }

  async ensure(forceRegister) {
    this.closed = false;
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);

    if (this.ws && this.ws.readyState === 1) {
      if (forceRegister) {
        await this.registerWithX();
      } else {
        const meta = await this.loadMeta();
        this.lastRegisterAt = meta.lastRegisterAt || 0;
        this.lastNotificationAt = meta.lastNotificationAt || null;
        await this.maybeAutoRegister();
      }
      return;
    }
    if (this.connecting) return this.connecting;

    const persist = await this.loadPersist();
    const meta = await this.loadMeta();
    this.lastRegisterAt = meta.lastRegisterAt || 0;
    this.lastNotificationAt = meta.lastNotificationAt || null;
    this.decryptor = await createDecryptor(persist?.jwk, persist?.auth);
    this.channelId = persist?.channelId || crypto.randomUUID();
    this.savedEndpoint = persist?.endpoint || null;
    this.uaid = persist?.uaid || "";
    this.remoteBroadcasts = persist?.remoteBroadcasts || {};

    this.connecting = this.connect().finally(() => (this.connecting = null));
    await this.connecting;
    if (forceRegister || this.savedEndpoint !== this.currentEndpoint) {
      await this.registerWithX();
    } else {
      await this.maybeAutoRegister();
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      console.log("[autopush] connecting ->", AUTOPUSH_URL);
      this.ws = new WebSocket(AUTOPUSH_URL);

      // 15 秒内没完成握手+注册就算失败，避免 promise 永远挂着
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { this.ws.close(); } catch {}
          reject(new Error("connect timeout (15s no register)"));
        }
      }, 15000);

      // 握手完成后调用：清掉超时器，之后连接长期存活
      const settle = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
        }
      };

      this.ws.addEventListener("open", () => {
        console.log("[autopush] ws open, sending hello, uaid=", this.uaid || "(new)");
        this.reconnectDelay = 1000;
        // 注意：不要发高频 ping。实测 AutoPush 对 5 秒级 ping 会在第 2 次后
        // 以 code=1011 reason=SM 主动断开（Firefox 客户端是几分钟才 ping 一次）。
        // 依赖「断开后 1 秒重连 + hello 带 channelIDs 让服务端补投队列」即可。
        this.wsSend({
          messageType: "hello",
          use_webpush: true,
          uaid: this.uaid || "",
          // Firefox 标准姿势：重连时直接声明自己的 channel，服务端会补投排队消息
          channelIDs: this.channelId ? [this.channelId] : [],
          broadcasts: this.remoteBroadcasts || {},
        });
      });

      this.ws.addEventListener("message", (event) => {
        this.onMessage(String(event.data), resolve, reject, settle).catch((e) => {
          console.log("[autopush] onMessage error:", e?.stack || String(e));
          this.lastError = String(e?.message || e);
        });
      });

      this.ws.addEventListener("close", (event) => {
        console.log(`[autopush] ws closed code=${event?.code} reason=${event?.reason || "-"}`);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`ws closed before register: code=${event?.code}`));
        }
        this.scheduleReconnect();
      });

      this.ws.addEventListener("error", () => {
        console.log("[autopush] ws error");
        this.lastError = "websocket error";
        if (!settled) {
          settled = true;
          reject(new Error("websocket error"));
        }
        // close 事件随后会触发 scheduleReconnect
      });
    });
  }

  async onMessage(raw, resolve, reject, markSettled) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log("[autopush] non-json message:", raw.slice(0, 200));
      return;
    }
    switch (msg.messageType) {
      case "hello":
        console.log("[autopush] hello ok, uaid=", msg.uaid);
        {
          const reused = this.uaid && msg.uaid === this.uaid;
          this.uaid = msg.uaid;
          if (msg.broadcasts) this.remoteBroadcasts = msg.broadcasts;
          if (reused && this.savedEndpoint) {
            // 老身份被服务端认出：跳过 register，endpoint 保持稳定，不用打扰 X
            console.log("[autopush] uaid 复用，跳过 register，endpoint 不变");
            this.currentEndpoint = this.savedEndpoint;
            markSettled();
            resolve(this.savedEndpoint);
          } else {
            // 全新身份：走 register 流程拿 endpoint，并重新向 X 注册
            this.wsSend({
              channelID: this.channelId,
              messageType: "register",
              key: VAPID_KEY,
            });
          }
        }
        break;

      case "register":
        if (msg.status === 200) {
          console.log("[autopush] register ok, endpoint=", msg.pushEndpoint);
          this.currentEndpoint = msg.pushEndpoint;
          await this.persistState();
          markSettled();
          resolve(msg.pushEndpoint);
        } else {
          console.log("[autopush] register failed:", JSON.stringify(msg));
          this.lastError = `register failed: ${msg.status}`;
          reject(new Error(this.lastError));
        }
        break;

      case "notification":
        console.log("[autopush] notification received, version=", msg.version);
        // 先 ack，再解密推送
        this.wsSend({
          messageType: "ack",
          updates: [{ channelID: msg.channelID, version: msg.version, code: 100 }],
        });
        this.handleNotification(msg);
        break;
    }
  }

  async persistState() {
    const endpoint = this.currentEndpoint;
    this.savedEndpoint = endpoint;
    await this.state.storage.put("persist", {
      uaid: this.uaid,
      channelId: this.channelId,
      endpoint,
      remoteBroadcasts: this.remoteBroadcasts || {},
      jwk: this.decryptor.jwk,
      auth: this.decryptor.auth,
    });
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      this.ensure(false).catch((e) => (this.lastError = String(e?.message || e)));
    }, this.reconnectDelay);
  }

  wsSend(obj) {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket 已死，交给 close/reconnect 处理 */
    }
  }

  // ---- 收到 X 推送：解密 -> 过滤 -> Bark ----

  async handleNotification(msg) {
    try {
      const payload = b64urlToBytes(msg.data);
      const json = await decryptPayload(
        this.decryptor,
        msg.headers.crypto_key,
        msg.headers.encryption,
        payload.buffer,
      );
      const n = JSON.parse(json);
      this.lastNotificationAt = Date.now();
      await this.saveMeta({ lastNotificationAt: this.lastNotificationAt });

      const d = n.data || {};
      const type = d.type || "";
      const who = n.title || d.title || "";
      // 注意：必须用 ?? 而不是 ||——纯图片推文的 body 是空串（假值），
      // 用 || 会被短路跳过；bundle_text 是 X 的 ICU 聚合模板
      // （"{num_total, number} new ..."），没有实际内容，不能兜底
      const rawText = n.body ?? d.body ?? "";
      const tag = d.tag || n.tag || "";

      // 去重：tag 带 ID 的（tweet-123 / reply-123...）直接用 tag；
      // tag 是字面量（如 "follower"）或缺 tag 的（私信），用 type + 唯一标识兜底，
      // 避免不同事件互相误杀
      const tagId0 = tag.match(/-(\d+)$/)?.[1];
      const dedupKey = tagId0
        ? tag
        : `${type}|${d.xchat_message?.["message-id"] || d.uri || rawText.slice(0, 80)}`;
      if (await this.isDuplicate(dedupKey)) return;

      // 链接规则：优先 canonical 形式 x.com/<handle>/status/<id>（网页版与 App 都识别）；
      // 其次用 data.uri 绝对化后的地址；两者都没有才兜底 /i/status/<id>。
      // handle 仅在 tag ID 与 uri ID 一致时才可信（原创/引用/回复/点赞，uri 就是这条推）；
      // 转推/回复别人时 tag ID 属于另一条推、handle 不可知，退回归属明确的 data.uri
      const tagId = tagId0;
      const uriStr = d.uri || "";
      const uriId = uriStr.match(/\/status\/(\d+)/)?.[1] || "";
      const uriHandle = uriStr.match(/^\/([A-Za-z0-9_]{1,15})\//)?.[1] || "";
      const absUri = uriStr.startsWith("http") ? uriStr : uriStr ? `https://x.com${uriStr.startsWith("/") ? "" : "/"}${uriStr}` : "";
      let link = "";
      if (tagId && tagId === uriId && uriHandle) {
        link = `https://x.com/${uriHandle}/status/${tagId}`;
      } else if (absUri) {
        link = absUri;
      } else if (tagId) {
        link = `https://x.com/i/status/${tagId}`;
      }

      // 通知文案映射（2026-11 实测 6 种 type / 7 种情形，对照表见 PRINCIPLES.md）：
      // 只有 4 个特殊分支，其余全部走 default 原样透传
      let heading = who || "X 通知";
      let content = rawText.replace(
        /(^|[^/\w])\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/g,
        "$1https://x.com/$2/status/$3",
      ).trim();
      // 与 X 网页版通知保持一致：纯图片/无文字推文正文为空就推空内容，
      // 只显示标题（账号显示名），不造文案

      switch (type) {
        case "favorite": {
          // title 是 "Liked by <handle>"，不是显示名，需单独解析
          const by = who.match(/^Liked by (.+)$/)?.[1];
          if (by) heading = `被 ${by} 点赞`;
          break;
        }
        case "follower": {
          // body 文案不固定（"followed you back!" 等），无条件使用固定模板
          const handle =
            (d.uri || "").replace(/^\/+|\/+$/g, "").split("/")[0] ||
            rawText.match(/^@(\w+)/)?.[1] || "";
          content = handle ? `@${handle} 关注了你！` : rawText.trim();
          if (handle) link = `https://x.com/${handle}`;
          break;
        }
        case "reply": {
          // 正文形如 "@handle replied: 内容"（实测原文从不带斜杠，正则里的 /{0,2}
          // 只是宽松兜底早期误判的 "@//handle/" 形式），统一转成中文"回复说："
          const m = rawText.match(/@\/{0,2}(\w+)\/?\s*replied:\s*([\s\S]*)/);
          if (m) {
            content = `@${m[1]} 回复说： ${m[2].trim()}`;
          }
          break;
        }
        case "xchat_message_received": {
          // 私信内容端到端加密，读不到正文，固定文案
          content = "发送了一条私信";
          break;
        }
      }

      if (!passTypeFilter(this.env, type)) return;
      await this.barkPush(heading, content, link, n.icon);
    } catch (e) {
      this.lastError = `notification: ${String(e?.message || e)}`;
    }
  }

  async barkPush(heading, content, link = "", icon = "") {
    const key = this.env.BARK_KEY;
    if (!key) throw new Error("缺少 BARK_KEY");
    const server = (this.env.BARK_SERVER || "https://api.day.app").replace(/\/+$/, "");
    // 用 POST JSON 而不是 GET URL：GET /key/只有一段时那段算「正文」不算标题，
    // 空正文推送会被 iOS 用应用名 Bark 顶替标题行；POST 可精确控制字段，
    // 空正文时不带 body 字段，通知只显示标题（与 X 网页版一致）
    const payload = {
      device_key: key,
      title: heading,
      group: "x2bark",
    };
    if (content) payload.body = content.slice(0, 400);
    if (link) payload.url = link;
    if (icon) payload.icon = icon;
    const res = await fetch(`${server}/push`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Bark 推送失败: ${res.status}`);
  }

  // ---- 向 X 注册推送订阅（移植自 twitter.ts）----

  async registerWithX() {
    // 记录重注册时间（含失败），供自愈退避使用，避免疯狂重试
    this.lastRegisterAt = Date.now();
    await this.saveMeta({ lastRegisterAt: this.lastRegisterAt });
    if (!this.currentEndpoint) throw new Error("尚未获得 AutoPush endpoint");
    const cookies = {
      auth_token: this.env.AUTH_TOKEN,
      ct0: this.env.CT0,
    };
    if (!cookies.auth_token || !cookies.ct0) throw new Error("缺少 AUTH_TOKEN / CT0");

    const [headerJson, pairs] = await Promise.all([
      fetch(HEADER_URL).then((r) => r.json()),
      fetch(PAIR_URL).then((r) => r.json()),
    ]);

    const chromeFetch = Object.fromEntries(
      Object.entries(headerJson["chrome-fetch"]).filter(([k]) => !["host", "connection"].includes(k)),
    );
    const headers = {
      ...chromeFetch,
      "accept-encoding": "identity",
      pragma: "no-cache",
      referer: "https://x.com",
      priority: "u=1, i",
      "x-twitter-client-language": "en",
      "x-twitter-active-user": "yes",
      authorization: `Bearer ${BEARER_TOKEN}`,
      "x-twitter-auth-type": "OAuth2Session",
      "x-csrf-token": cookies.ct0,
    };

    const path = "/1.1/notifications/settings/login.json";
    const pair = pairs[Math.floor(Math.random() * pairs.length)];
    const tid = await generateTransactionId("POST", path, pair.verification, pair.animationKey);

    const res = await fetch(`https://x.com/i/api${path}`, {
      method: "POST",
      headers: {
        ...headers,
        cookie: encodeCookies(cookies),
        "content-type": "application/json",
        "x-client-transaction-id": tid,
      },
      body: JSON.stringify({
        push_device_info: {
          os_version: "Web/Chrome",
          // 每次注册生成唯一设备 ID，避免 X 按 udid 去重把推送绑到旧 endpoint
          udid: `Web/Chrome/${crypto.randomUUID()}`,
          env: 3,
          locale: "en",
          protocol_version: 1,
          token: this.currentEndpoint,
          encryption_key1: this.decryptor.pub,
          encryption_key2: this.decryptor.auth,
        },
      }),
    });
    const bodyText = await res.text();
    console.log(`[x-register] status=${res.status} body=${bodyText.slice(0, 500)}`);
    if (!res.ok) {
      throw new Error(`login.json failed (${res.status}): ${bodyText}`);
    }
  }
}

// 只按通知类型过滤：NOTIFY_TYPES 留空则全部推送
function passTypeFilter(env, type) {
  const types = (env.NOTIFY_TYPES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return !(types.length > 0 && type && !types.includes(type));
}

function encodeCookies(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

// 把「小时」配置转成毫秒；<=0 或非数字视为关闭（返回 0）
function hoursToMs(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n * 3600 * 1000 : 0;
}

// 移植自 twitter.ts 的 generateTransactionId（Buffer -> btoa）
async function generateTransactionId(method, path, key, animationKey) {
  const DEFAULT_KEYWORD = "obfiowerehiring";
  const ADDITIONAL_RANDOM_NUMBER = 3;
  const timeNow = Math.floor((Date.now() - 1682924400 * 1000) / 1000);
  const timeNowBytes = [
    timeNow & 0xff,
    (timeNow >> 8) & 0xff,
    (timeNow >> 16) & 0xff,
    (timeNow >> 24) & 0xff,
  ];
  const data = `${method}!${path}!${timeNow}${DEFAULT_KEYWORD}${animationKey}`;
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  const hashBytes = Array.from(new Uint8Array(hashBuffer));
  const keyBytes = Array.from(b64ToBytes(key));
  const randomNum = Math.floor(Math.random() * 256);
  const bytesArr = [...keyBytes, ...timeNowBytes, ...hashBytes.slice(0, 16), ADDITIONAL_RANDOM_NUMBER];
  const out = new Uint8Array([randomNum, ...bytesArr.map((b) => b ^ randomNum)]);
  return bytesToB64(out).replace(/=/g, "");
}

// ---- base64 / base64url 工具（移植自 utils.ts，用 atob/btoa 实现）----

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToBytes(b64url) {
  return b64ToBytes(b64url.replace(/-/g, "+").replace(/_/g, "/"));
}

function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function bytesToB64url(buffer) {
  return bytesToB64(new Uint8Array(buffer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- 解密（移植自 decrypt.ts）----

async function createDecryptor(jwk, authB64url) {
  let privKey, savedJwk, pubRaw;
  if (jwk) {
    privKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const pubJwk = { ...jwk };
    delete pubJwk.d;
    delete pubJwk.key_ops;
    const pubKey = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
    pubRaw = await crypto.subtle.exportKey("raw", pubKey);
    savedJwk = jwk;
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    privKey = kp.privateKey;
    savedJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  }
  const authSecret = authB64url ? b64urlToBytes(authB64url) : crypto.getRandomValues(new Uint8Array(16));
  return {
    jwk: savedJwk,
    auth: bytesToB64url(authSecret.buffer ?? authSecret),
    pub: bytesToB64url(pubRaw),
    privKey,
    pubRaw,
    authSecret: authSecret instanceof Uint8Array ? authSecret : new Uint8Array(authSecret),
  };
}

async function decryptPayload(d, cryptoKeyHeader, encryptionHeader, payloadBuf) {
  const cryptoKeyParams = parseHeader(cryptoKeyHeader);
  const encryptionParams = parseHeader(encryptionHeader);

  const remotePubKeyBytes = b64urlToBytes(cryptoKeyParams.dh);
  const salt = b64urlToBytes(encryptionParams.salt);
  const rs = encryptionParams.rs ? parseInt(encryptionParams.rs) : 0;

  const remotePubKey = await crypto.subtle.importKey(
    "raw",
    remotePubKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: remotePubKey }, d.privKey, 256),
  );

  const authInfo = new TextEncoder().encode("Content-Encoding: auth\0");
  const ikm = await hkdf(d.authSecret, sharedSecret, authInfo, 32);

  const context = concat(
    new TextEncoder().encode("P-256\0"),
    new Uint8Array([0, 65]),
    new Uint8Array(d.pubRaw),
    new Uint8Array([0, 65]),
    remotePubKeyBytes,
  );

  const cekInfo = concat(new TextEncoder().encode("Content-Encoding: aesgcm\0"), context);
  const cek = await hkdf(salt, ikm, cekInfo, 16);

  const nonceInfo = concat(new TextEncoder().encode("Content-Encoding: nonce\0"), context);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);

  let decrypted;
  if (rs >= 18) {
    const chunks = splitPayload(payloadBuf, rs);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      parts.push(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: adjustNonce(nonce, i) }, cekKey, chunks[i]),
      );
    }
    const decBytes = concat(...parts.map((p) => new Uint8Array(p)));
    decrypted = decBytes.buffer;
  } else {
    decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, payloadBuf);
  }

  const view = new DataView(decrypted);
  const paddingLen = view.getUint16(0);
  const plaintext = decrypted.slice(2 + paddingLen);
  return new TextDecoder().decode(plaintext);
}

function parseHeader(header) {
  const result = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) result[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return result;
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  const infoWithCounter = new Uint8Array(info.length + 1);
  infoWithCounter.set(info);
  infoWithCounter[info.length] = 1;
  const expanded = await hmacSha256(prk, infoWithCounter);
  return expanded.slice(0, length);
}

function concat(...arrays) {
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function splitPayload(payload, rs) {
  const bytes = new Uint8Array(payload);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += rs) {
    chunks.push(bytes.slice(i, Math.min(i + rs, bytes.length)));
  }
  return chunks;
}

function adjustNonce(nonce, offset) {
  if (offset === 0) return nonce;
  const adjusted = new Uint8Array(nonce);
  for (let i = 11; i >= 6; i--) {
    adjusted[i] ^= (offset >>> ((11 - i) * 8)) & 0xff;
  }
  return adjusted;
}
