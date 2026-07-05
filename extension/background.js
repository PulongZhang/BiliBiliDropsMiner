// background.js (MV3 service worker)
// 职责：按需创建 offscreen document、转发 start/stop、持久化 mining 配置 + 会话身份、
// 取 bili_jct(csrf)、浏览器/扩展重启后续跑、看门狗（offscreen 死亡则重建）、角标刷新。
//
// 为什么 storage/cookies 放 SW 而非 offscreen：offscreen document 对 chrome.storage /
// chrome.cookies 这类扩展 API 支持不稳定（实测部分环境为 undefined）。SW 是扩展 API 的
// 可靠入口，把数据读出后随 OFS_* 消息传给 offscreen，offscreen 只剩 fetch + 计算。
//
// 消息约定：popup/外部发 "START"/"STOP"/"STATUS"；本 SW 收到后转发 "OFS_*" 给 offscreen。

import { decideWatchdogAction } from "./lib/watchdog.js";

const TAG = "[BDM-BG]";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const BILIBILI_ROOT = "https://www.bilibili.com";
const CONFIG_KEY = "mining";
const ALARM_NAME = "bdm-watchdog";
const WATCHDOG_PERIOD_MIN = 1;

// --- offscreen 生命周期（并发安全：promise 锁 + 容忍「已存在」）---

async function hasOffscreen() {
  // 枚举值是 "OFFSCREEN_DOCUMENT"，误写 "OFFSCREEN" 会触发参数校验错误
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return ctxs.length > 0;
}

let ensuringOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (ensuringOffscreen) return ensuringOffscreen;
  ensuringOffscreen = (async () => {
    try {
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ["DOM_PARSER"],
          justification:
            "维持 x25Kn 心跳计时器并解析 bilibili API JSON 响应（SW 会被回收，无法承载数十秒级定时器）",
        });
      } catch (err) {
        // 并发/已存在：复查，确实已建好就当成功；否则原样抛出
        if (!(await hasOffscreen())) throw err;
      }
    } finally {
      ensuringOffscreen = null;
    }
  })();
  return ensuringOffscreen;
}

// --- 扩展 API 数据（storage / cookies）——offscreen 不可用，集中在 SW ---

async function getConfig() {
  return (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || null;
}

async function setConfig(cfg) {
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
}

function generateLiveBuvid() {
  // 对应 Python cookies.generate_live_buvid：uuid4().int % 1e16，左侧补零 16 位
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  const v = buf[0] % 10n ** 16n;
  return "AUTO" + v.toString().padStart(16, "0");
}

/** 按 n 取/补齐持久化身份；永不截断，切换 thread_count 时已分配身份保持稳定。 */
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

/** 组装 OFS_START 载荷：读 csrf + 身份（按 threadCount）。resume/watchdog/start 共用。 */
async function buildStartPayload(cfg) {
  const n = Math.max(1, Math.floor(cfg.threadCount || 1));
  const [csrf, identities] = await Promise.all([getCsrf(), loadIdentities(n)]);
  return {
    type: "OFS_START",
    roomId: cfg.roomId,
    threadCount: n,
    taskIds: cfg.taskIds || [],
    taskQueryIntervalSeconds: cfg.taskQueryIntervalSeconds,
    csrf,
    identities,
  };
}

function updateBadge(badge) {
  chrome.action.setBadgeText({ text: badge.text });
  if (badge.color) chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

async function queryStatus() {
  if (!(await hasOffscreen())) return { ok: true, status: { active: false } };
  try {
    return await chrome.runtime.sendMessage({ type: "OFS_STATUS" });
  } catch (err) {
    return { ok: false, status: { active: false }, error: String(err.message || err) };
  }
}

async function startMining({ roomId, threadCount = 1, taskIds, taskQueryIntervalSeconds }) {
  if (!roomId) throw new Error("缺少 roomId");
  const n = Math.max(1, Math.floor(threadCount));
  await setConfig({
    roomId,
    threadCount: n,
    taskIds: taskIds || [],
    taskQueryIntervalSeconds,
    active: true,
  });
  const payload = await buildStartPayload({
    roomId,
    threadCount: n,
    taskIds: taskIds || [],
    taskQueryIntervalSeconds,
  });
  await ensureOffscreen();
  console.log(TAG, "→ OFS_START", { roomId, threadCount: n });
  const resp = await chrome.runtime.sendMessage(payload);
  const st = resp?.ok ? resp.status : null;
  if (st) {
    updateBadge(
      decideWatchdogAction({
        config: await getConfig(),
        offscreenAlive: true,
        status: st,
      }).badge,
    );
  }
  return resp;
}

async function stopMining() {
  const prev = await getConfig();
  if (prev) await setConfig({ ...prev, active: false });
  if (await hasOffscreen()) {
    console.log(TAG, "→ OFS_STOP");
    await chrome.runtime.sendMessage({ type: "OFS_STOP" });
  }
  updateBadge({ text: "", color: "#888888" });
}

/**
 * 看门狗一个周期：配置 + offscreen 存活 + 最新 status → decideWatchdogAction →
 * recreate 则重建并按配置重启；始终刷新角标。
 */
async function runWatchdog() {
  const config = await getConfig();
  const offscreenAlive = await hasOffscreen();
  let status = null;
  if (offscreenAlive) {
    const resp = await queryStatus();
    status = resp?.ok ? resp.status : null;
  }
  const decision = decideWatchdogAction({ config, offscreenAlive, status });
  console.log(TAG, "watchdog:", decision.action);
  if (decision.action === "recreate" && config) {
    try {
      await ensureOffscreen();
      await chrome.runtime.sendMessage(await buildStartPayload(config));
    } catch (err) {
      console.warn(TAG, "recreate 失败:", err);
    }
  }
  updateBadge(decision.badge);
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  }
}

async function resumeIfNeeded() {
  const cfg = await getConfig();
  if (!cfg || !cfg.active || !cfg.roomId) return;
  console.log(TAG, "resume on startup:", cfg);
  await ensureOffscreen();
  await chrome.runtime.sendMessage(await buildStartPayload(cfg));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "START") sendResponse(await startMining(msg));
      else if (msg.type === "STOP") {
        await stopMining();
        sendResponse({ ok: true });
      } else if (msg.type === "STATUS") sendResponse(await queryStatus());
      // OFS_* 由 offscreen 处理，这里不响应
    } catch (err) {
      console.warn(TAG, err);
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runWatchdog().catch((e) => console.warn(TAG, e));
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await resumeIfNeeded();
  await runWatchdog();
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await resumeIfNeeded();
});

// SW 唤醒后立即跑一次看门狗，让角标/offscreen 尽快自愈
runWatchdog().catch((e) => console.warn(TAG, "init watchdog:", e));

// --- 调试钩子（popup 为正式 UI；此钩子便于在 SW 控制台做真实服务器验证）---
//   await bdm.start({ roomId: 22743115, threadCount: 100, taskIds: ["xxx"] })
//   await bdm.stop() / bdm.status() / bdm.watchdog()
globalThis.bdm = {
  start: startMining,
  stop: stopMining,
  status: queryStatus,
  watchdog: runWatchdog,
};

console.log(TAG, "background loaded");
