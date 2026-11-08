// offscreen/offscreen.js
// 心跳引擎宿主：在 offscreen document 内用 SessionManager 驱动 N 个 BiliSession。
//
// 与 Python miner.py 对齐的关键点：
//   - 1 个共享 HttpClient（nav/WBI key 只拉一次，账号级缓存）+ 1 个 BiliClient；
//   - N 个 BiliSession，每个独占 {liveBuvid, liveUuid}（miner.py:57 每会话新建 client，
//     即每会话独立 buvid/uuid），共享同一 bili_jct(csrf)；
//   - SessionManager 以 1s stagger 铺开首次 enter（miner.py:49 实测 1s 是 128 线程的下限）。
//
// 职责边界：身份（liveBuvid/liveUuid）与 csrf(bili_jct) 由 SW 经 OFS_START 消息传入。
// offscreen 不碰 chrome.storage / chrome.cookies（实测部分环境为 undefined），
// 只依赖 fetch（credentials:include 带 cookie）+ chrome.runtime.onMessage + 计算。
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
import { TaskMonitor } from "../lib/task-monitor.js";
import { parseWbiKeysFromNav } from "../lib/wbi.js";
import { normalizeTaskIds } from "../lib/tasks.js";

const TAG = "[BDM-OF]";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
// ua 作为 x25Kn 签名 payload 的 ua 字段（非 HTTP 头），与 Python 客户端一致。
const PAYLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TICK_INTERVAL_MS = 250;
const STAGGER_MS = 1000;

let engine = null; // { manager, timer, config, startedAt }
let stoppedStatus = null;

const logInfo = (...a) => console.log(TAG, ...a);
const logWarn = (...a) => console.warn(TAG, ...a);

// 身份（liveBuvid/liveUuid）与 bili_jct(csrf) 由 SW 经 OFS_START 消息传入：
// offscreen 对 chrome.storage / chrome.cookies 支持不稳定，集中在 SW 处理。

// --- WBI keys provider：拉 nav → 解析 img/sub key（账号级，全程共享）---
async function fetchWbiKeys(fetchImpl) {
  const resp = await fetchImpl(NAV_URL, { credentials: "include" });
  if (!resp.ok) throw new Error(`nav HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload.code !== 0) {
    throw new Error(`nav code=${payload.code} ${payload.message}`);
  }
  const keys = parseWbiKeysFromNav(payload);
  logInfo("wbi keys:", keys);
  return keys;
}

async function start({
  roomId,
  threadCount = 1,
  taskIds,
  taskQueryIntervalSeconds,
  autoClaimRewards = true,
  csrf,
  identities: provided = [],
}) {
  if (engine) {
    logWarn("已有引擎运行中，先停止再重启");
    await stop();
  }
  if (!roomId) throw new Error("缺少 roomId");
  if (!csrf) throw new Error("缺少 csrf（bili_jct）");
  const n = Math.max(1, Math.floor(threadCount));
  const normalizedTaskIds = normalizeTaskIds(taskIds || []);

  const identities = provided.slice(0, n);
  if (identities.length < n) {
    throw new Error(`身份不足：需 ${n}，收到 ${identities.length}`);
  }
  logInfo(
    `start room=${roomId} threads=${n}` +
      ` buvid[0]=${identities[0].liveBuvid} ... buvid[${n - 1}]=${identities[n - 1].liveBuvid}`,
  );

  const controller = new AbortController();
  const fetchImpl = (url, opts = {}) => fetch(url, {
    ...opts,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
  });
  const sleep = (ms) => new Promise((resolve, reject) => {
    controller.signal.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(controller.signal.reason); };
    const timer = setTimeout(() => {
      controller.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const http = new HttpClient({
    fetchImpl,
    wbiKeysProvider: () => fetchWbiKeys(fetchImpl),
    sleep,
  });
  const client = new BiliClient({ http, userAgent: PAYLOAD_UA, sleep });

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

  // 空任务列表也保留监控器，运行中识别新任务时可直接热更新。
  const intervalMs = Math.max(10, Number(taskQueryIntervalSeconds) || 30) * 1000;
  const monitor = new TaskMonitor({
    client,
    taskIds: normalizedTaskIds,
    csrf,
    intervalMs,
    autoClaimRewards,
    sleep,
    log: (lvl, msg) => (lvl === "warn" ? logWarn(msg) : logInfo(msg)),
  });
  monitor.start();
  stoppedStatus = null;

  engine = {
    manager,
    timer,
    monitor,
    controller,
    config: { roomId, threadCount: n, taskIds: normalizedTaskIds },
    startedAt: Date.now(),
  };
  logInfo(`engine started: ${n} session(s), stagger ${STAGGER_MS}ms`);
}

async function stop() {
  if (!engine) return;
  stoppedStatus = { ...status(), active: false, stoppedAt: Date.now() };
  clearInterval(engine.timer);
  engine.manager.stop();
  engine.monitor?.stop();
  engine.controller.abort();
  const st = engine.manager.status();
  logInfo(
    `stopped room=${engine.config.roomId} threads=${engine.config.threadCount}` +
      ` heartbeats=${st.heartbeats}`,
  );
  engine = null;
}

function updateTasks({ taskIds, taskQueryIntervalSeconds, autoClaimRewards }) {
  if (!engine) throw new Error("引擎未运行");
  engine.monitor.update({
    taskIds,
    intervalMs: Math.max(10, Number(taskQueryIntervalSeconds) || 30) * 1000,
    autoClaimRewards,
  });
  engine.config.taskIds = engine.monitor.taskIds;
}

function status() {
  // 用 active 表示引擎是否运行；manager.status() 的 running 是「处于 running 态的
  // 会话数」。两者键名不同，spread 不会互相覆盖（watchdog.badgeFromStatus 依赖此约定）。
  if (!engine) return stoppedStatus || { active: false };
  const m = engine.monitor;
  return {
    active: true,
    roomId: engine.config.roomId,
    threadCount: engine.config.threadCount,
    startedAt: engine.startedAt,
    ...engine.manager.status(),
    taskMonitor: m
      ? {
          taskIds: m.taskIds,
          claimedIds: [...m.claimedIds],
          progresses: m.progresses,
          claimResults: m.claimResults,
          autoClaimRewards: m.autoClaimRewards,
          lastUpdatedAt: m.lastUpdatedAt,
          lastError: m.lastError ? String(m.lastError.message || m.lastError) : null,
        }
      : null,
  };
}

// 只接受 OFS_ 前缀消息（来自 background 转发）；popup 直发的 START 会被忽略。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!["OFS_START", "OFS_STOP", "OFS_STATUS", "OFS_UPDATE_TASKS", "OFS_UPDATE_AUTH", "OFS_REFRESH_TASKS", "OFS_CLAIM_REWARDS"].includes(msg?.type)) return false;
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
      } else if (msg.type === "OFS_UPDATE_TASKS") {
        updateTasks(msg);
        sendResponse({ ok: true, status: status() });
      } else if (msg.type === "OFS_UPDATE_AUTH") {
        if (engine && msg.csrf) {
          for (const session of engine.manager.sessions) session.csrf = msg.csrf;
          engine.monitor.update({ csrf: msg.csrf });
        }
        sendResponse({ ok: true });
      } else if (msg.type === "OFS_REFRESH_TASKS" || msg.type === "OFS_CLAIM_REWARDS") {
        if (!engine) throw new Error("引擎未运行");
        await engine.monitor.refresh({ claimAll: msg.type === "OFS_CLAIM_REWARDS" });
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
