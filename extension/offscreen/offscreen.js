// offscreen/offscreen.js
// M2 真实集成驱动：在 offscreen document 内构造 HttpClient（真实 fetch + credentials:include）
// + BiliClient + 单个 BiliSession，setInterval 周期 tick 维持 x25Kn 心跳。
//
// 边界说明：签名层（wbi/live-trace/crypto）、HTTP 重试、单会话状态机均已 39 测试绿；
// 本文件是浏览器 IO 粘合层（chrome.cookies / fetch / setInterval / chrome.runtime），
// 其「通过标准」是真实 bilibili 服务器接受签名请求并返回 code==0，只能在浏览器里验证。
//
// 已知风险：Referer/Origin/User-Agent 在扩展 fetch 中是 forbidden header，浏览器会丢弃。
// 若服务器校验 Referer==live.bilibili.com，需在集成期加 declarativeNetRequest 规则覆写。

import { HttpClient } from "../lib/http.js";
import { BiliClient } from "../lib/bili-client.js";
import { BiliSession } from "../lib/session.js";
import { parseWbiKeysFromNav } from "../lib/wbi.js";

const TAG = "[BDM-OF]";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const BILIBILI_ROOT = "https://www.bilibili.com";
// ua 作为 x25Kn 签名 payload 的 ua 字段（非 HTTP 头），必须与 Python 客户端一致。
const PAYLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TICK_INTERVAL_MS = 250;

let engine = null; // { session, timer, config, startedAt }

const logInfo = (...a) => console.log(TAG, ...a);
const logWarn = (...a) => console.warn(TAG, ...a);

// --- 身份生成（对应 cookies.generate_live_buvid + uuid.uuid4）---
function generateLiveBuvid() {
  // Python: uuid4().int % 1e16，左侧补零到 16 位。这里取 64 位随机源 % 1e16，
  // 分布在 [0, 1e16) 内一致（足够唯一），格式与 Python 串完全相同。
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  const v = buf[0] % 10n ** 16n;
  return "AUTO" + v.toString().padStart(16, "0");
}

async function loadIdentity() {
  const cur = (await chrome.storage.local.get("identity")).identity;
  if (cur && cur.liveBuvid && cur.liveUuid) return cur;
  const fresh = { liveBuvid: generateLiveBuvid(), liveUuid: crypto.randomUUID() };
  await chrome.storage.local.set({ identity: fresh });
  return fresh;
}

async function getCsrf() {
  const c = await chrome.cookies.get({ url: BILIBILI_ROOT, name: "bili_jct" });
  if (!c || !c.value) throw new Error("未取到 bili_jct（请先在 bilibili.com 登录）");
  return c.value;
}

// --- WBI keys provider：拉 nav → 解析 img/sub key ---
async function fetchWbiKeys() {
  const resp = await fetch(NAV_URL, { credentials: "include" });
  if (!resp.ok) throw new Error(`nav HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload.code !== 0) {
    throw new Error(`nav code=${payload.code} ${payload.message}`);
  }
  const keys = parseWbiKeysFromNav(payload);
  logInfo("wbi keys:", keys);
  return keys;
}

async function start({ roomId, threadCount = 1 }) {
  if (engine) {
    logWarn("已有会话运行中，先停止再重启");
    await stop();
  }
  if (!roomId) throw new Error("缺少 roomId");

  const identity = await loadIdentity();
  const csrf = await getCsrf();
  logInfo(
    `start room=${roomId} threadCount=${threadCount}（M2 仅驱动 1）` +
      ` buvid=${identity.liveBuvid} uuid=${identity.liveUuid}` +
      ` csrf=${csrf.slice(0, 4)}***`,
  );

  const http = new HttpClient({
    fetchImpl: (url, opts) => fetch(url, opts), // buildRequest 已带 credentials:include
    wbiKeysProvider: fetchWbiKeys,
  });
  const client = new BiliClient({ http, userAgent: PAYLOAD_UA });

  const session = new BiliSession({
    id: "m2-0",
    client,
    room: { roomId },
    liveBuvid: identity.liveBuvid,
    liveUuid: identity.liveUuid,
    userAgent: PAYLOAD_UA,
    csrf,
    log: (lvl, msg) => (lvl === "warn" ? logWarn(msg) : logInfo(msg)),
  });
  session.start();

  const timer = setInterval(() => {
    session.tick().catch((err) => logWarn("tick error:", err));
  }, TICK_INTERVAL_MS);

  engine = { session, timer, config: { roomId, threadCount }, startedAt: Date.now() };
  logInfo("engine started");
}

async function stop() {
  if (!engine) return;
  clearInterval(engine.timer);
  engine.session.stop();
  logInfo(
    `stopped room=${engine.config.roomId} heartbeats=${engine.session.heartbeatCount}`,
  );
  engine = null;
}

function status() {
  if (!engine) return { running: false };
  const s = engine.session;
  return {
    running: true,
    roomId: engine.config.roomId,
    startedAt: engine.startedAt,
    state: s.state,
    heartbeats: s.heartbeatCount,
    lastError: s.lastError ? String(s.lastError.message || s.lastError) : null,
  };
}

// 仅接受带 OFS_ 前缀的消息（来自 background 转发）；popup 直发的 START 会被忽略。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "OFS_START") {
        await start(msg);
        sendResponse({ ok: true, status: status() });
      } else if (msg.type === "OFS_STOP") {
        await stop();
        sendResponse({ ok: true });
      } else if (msg.type === "OFS_STATUS") {
        sendResponse({ ok: true, status: status() });
      }
      // 其余类型静默：交由 background 处理
    } catch (err) {
      logWarn("message error:", err);
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true; // 异步响应
});

logInfo("offscreen loaded（M2 单会话驱动）");
