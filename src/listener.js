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
      lastNotificationAt: this.lastNotificationAt,
      lastError: this.lastError,
    };
  }

  async loadPersist() {
    return (await this.state.storage.get("persist")) || null;
  }

  async ensure(forceRegister) {
    this.closed = false;
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);

    if (this.ws && this.ws.readyState === 1) {
      if (forceRegister) await this.registerWithX();
      return;
    }
    if (this.connecting) return this.connecting;

    const persist = await this.loadPersist();
    this.decryptor = await createDecryptor(persist?.jwk, persist?.auth);
    this.channelId = persist?.channelId || crypto.randomUUID();
    this.savedEndpoint = persist?.endpoint || null;
    this.uaid = persist?.uaid || "";
    this.remoteBroadcasts = persist?.remoteBroadcasts || {};

    this.connecting = this.connect().finally(() => (this.connecting = null));
    await this.connecting;
    if (forceRegister || this.savedEndpoint !== this.currentEndpoint) {
      await this.registerWithX();
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
          this.failCount = 0;
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
      this.lastNotificationAt = new Date().toISOString();

      const type = n.data?.type || "";
      let link = n.data?.uri || "";
      const who = n.title || n.data?.title || ""; // 通常是账号名/标题
      const rawText = n.body || n.data?.body || n.data?.bundle_text || ""; // 通常是推文内容

      // 提取 "用户名/status/推文ID"（正文和 uri 里都可能是相对路径）
      const sm = `${link} ${rawText}`.match(/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);

      // 补全网页版链接为绝对地址
      if (link && !link.startsWith("http")) {
        link = "https://x.com" + (link.startsWith("/") ? "" : "/") + link;
      }
      if ((!link || link === "https://x.com") && sm) {
        link = `https://x.com/${sm[1]}/status/${sm[2]}`;
      }

      // 正文里 X 给的链接是相对路径（/用户名/status/id），补全成完整网址：
      // 完整 x.com 链接点一下就能由 iOS Universal Link 直接拉起 X App
      const webLink = sm ? `https://x.com/${sm[1]}/status/${sm[2]}` : link;
      const text = webLink
        ? rawText.replace(/\S*\/status\/\d+\S*/g, webLink).trim()
        : rawText.trim();

      // 组合出尽量完整的内容：有内容就"账号名：内容"，只有名字就显示名字
      const content =
        who && text && text !== who ? `${who}：${text}` : (text || who || "新通知");
      const heading = `X · ${type || "通知"}`;

      if (!passFilter(this.env, who, text, type)) return;
      await this.barkPush(heading, content, webLink || "", n.icon);
    } catch (e) {
      this.lastError = `notification: ${String(e?.message || e)}`;
    }
  }

  async barkPush(heading, content, link = "", icon = "") {
    const key = this.env.BARK_KEY;
    if (!key) throw new Error("缺少 BARK_KEY");
    const server = (this.env.BARK_SERVER || "https://api.day.app").replace(/\/+$/, "");
    let url =
      `${server}/${encodeURIComponent(key)}/${encodeURIComponent(heading)}/` +
      `${encodeURIComponent(content.slice(0, 400))}` +
      `?group=x2bark` + (link ? `&url=${encodeURIComponent(link)}` : ``);
    if (icon) url += `&icon=${encodeURIComponent(icon)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bark 推送失败: ${res.status}`);
  }

  // ---- 向 X 注册推送订阅（移植自 twitter.ts）----

  async registerWithX() {
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

function passFilter(env, title, body, type) {
  const text = `${title} ${body}`;
  const types = (env.NOTIFY_TYPES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (types.length > 0 && type && !types.includes(type)) return false;
  const keywords = (env.KEYWORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keywords.length > 0 && !keywords.some((k) => text.includes(k))) return false;
  return true;
}

function encodeCookies(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
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
