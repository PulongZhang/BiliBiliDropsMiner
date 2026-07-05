// offscreen/offscreen.js
// 心跳引擎宿主：在 offscreen document 内用 SessionManager 驱动 N 个 BiliSession。
//
// 与 Python miner.py 对齐的关键点：
//   - 1 个共享 HttpClient（nav/WBI key 只拉一次，账号级缓存）+ 1 个 BiliClient；
//   - N 个 BiliSession，每个独占 {liveBuvid, liveUuid}（miner.py:57 每会话新建 client，
//     即每会话独立 buvid/uuid），共享同一 bili_jct(csrf)；
//   - SessionManager 以 1s stagger 铺开首次 enter（miner.py:49 实测 1s 是 128 线程的下限）。
//
// 边界：签名层（wbi/live-trace/crypto）、HTTP 重试、单会话状态机、SessionManager
// 均已测试绿；本文件是浏览器 IO 粘合层，通过标准为真实服务器接受签名请求并返回 code==0。
//
// 已知风险：Referer/Origin/User-Agent 在扩展 fetch 中是 forbidden header，浏览器会丢弃。
// 若服务器校验 Referer==live.bilibili.com，需在集成期加 declarativeNetRequest 规则覆写。

import { HttpClient } from "../lib/http.js";
import { BiliClient } from "../lib/bili-client.js";
import { BiliSession } from "../lib/session.js";
import { SessionManager } from "../lib/session-manager.js";
import { parseWbiKeysFromNav } from "../lib/wbi.js";

const TAG = "[BDM-OF]";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const BILIBILI_ROOT = "https://www.bilibili.com";
// ua 作为 x25Kn 签名 payload 的 ua 字段（非 HTTP 头），与 Python 客户端一致。
const PAYLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TICK_INTERVAL_MS = 250;
const STAGGER_MS = 1000;

let engine = null; // { manager, timer, config, startedAt }

const logInfo = (...a) => console.log(TAG, ...a);
const logWarn = (...a) => console.warn(TAG, ...a);

// --- 身份生成（对应 cookies.generate_live_buvid + uuid.uuid4）---
function generateLiveBuvid() {
  // Python: uuid4().int % 1e16，左侧补零到 16 位。这里 64 位随机源 % 1e16，
  // 分布在 [0, 1e16) 内一致（足够唯一），格式与 Python 串完全相同。
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  const v = buf[0] % 10n ** 16n;
  return "AUTO" + v.toString().padStart(16, "0");
}

/**
 * 按 index 复用持久化身份，不足则补齐。永不截断已存身份，
 * 这样 thread_count 在 1↔N 之间来回切换时，已分配的 buvid/uuid 保持稳定。
 * （Python 实际每次新建 client 即每次新身份；持久化是扩展端的优化，避免重启换脸。）
 */
async function loadIdentities(n) {
  const cur = (await chrome.storage.local.get("identities")).identities || [];
  while (cur.length < n) {
    cur.push({ liveBuvid: generateLiveBuvid(), liveUuid: crypto.randomUUID() });
  }
  await chrome.storage.local.set({ identities: cur });
  return cur.slice(0, n);
}

async function getCsrf() {
  const c = await chrome.cookies.get({ url: BILIBILI_ROOT, name: "bili_jct" });
  if (!c || !c.value) throw new Error("未取到 bili_jct（请先在 bilibili.com 登录）");
  return c.value;
}

// --- WBI keys provider：拉 nav → 解析 img/sub key（账号级，全程共享）---
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
    logWarn("已有引擎运行中，先停止再重启");
    await stop();
  }
  if (!roomId) throw new Error("缺少 roomId");
  const n = Math.max(1, Math.floor(threadCount));

  const identities = await loadIdentities(n);
  const csrf = await getCsrf();
  logInfo(
    `start room=${roomId} threads=${n} csrf=${csrf.slice(0, 4)}***` +
      ` buvid[0]=${identities[0].liveBuvid} ... buvid[${n - 1}]=${identities[n - 1].liveBuvid}`,
  );

  const http = new HttpClient({
    fetchImpl: (url, opts) => fetch(url, opts), // buildRequest 已带 credentials:include
    wbiKeysProvider: fetchWbiKeys,
  });
  const client = new BiliClient({ http, userAgent: PAYLOAD_UA });

  const sessions = identities.map((id, i) => {
    const s = new BiliSession({
      id: `s${i}`,
      client,
      room: { roomId },
      liveBuvid: id.liveBuvid,
      liveUuid: id.liveUuid,
      userAgent: PAYLOAD_UA,
      csrf,
      log: (lvl, msg) => (lvl === "warn" ? logWarn(msg) : logInfo(msg)),
    });
    return s;
  });

  const manager = new SessionManager({
    sessions,
    staggerMs: STAGGER_MS,
  });
  manager.start();

  const timer = setInterval(() => {
    manager.tick().catch((err) => logWarn("tick error:", err));
  }, TICK_INTERVAL_MS);

  engine = { manager, timer, config: { roomId, threadCount: n }, startedAt: Date.now() };
  logInfo(`engine started: ${n} session(s), stagger ${STAGGER_MS}ms`);
}

async function stop() {
  if (!engine) return;
  clearInterval(engine.timer);
  engine.manager.stop();
  const st = engine.manager.status();
  logInfo(
    `stopped room=${engine.config.roomId} threads=${engine.config.threadCount}` +
      ` heartbeats=${st.heartbeats}`,
  );
  engine = null;
}

function status() {
  // 用 active 表示引擎是否运行；manager.status() 的 running 是「处于 running 态的
  // 会话数」。两者键名不同，spread 不会互相覆盖（watchdog.badgeFromStatus 依赖此约定）。
  if (!engine) return { active: false };
  return {
    active: true,
    roomId: engine.config.roomId,
    threadCount: engine.config.threadCount,
    startedAt: engine.startedAt,
    ...engine.manager.status(),
  };
}

// 只接受 OFS_ 前缀消息（来自 background 转发）；popup 直发的 START 会被忽略。
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

logInfo("offscreen loaded（SessionManager 驱动）");
