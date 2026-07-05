// background.js (MV3 service worker)
// 职责：按需创建 offscreen document、转发 start/stop、持久化 mining 配置、
// 浏览器/扩展重启后续跑、看门狗（offscreen 死亡则重建）、角标刷新。
//
// 消息约定：popup/外部发 "START"/"STOP"/"STATUS"；本 SW 收到后转发 "OFS_*" 给 offscreen。
// offscreen 只认 OFS_*，避免 popup 直发消息被两端重复处理。

import { decideWatchdogAction } from "./lib/watchdog.js";

const TAG = "[BDM-BG]";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const CONFIG_KEY = "mining";
const ALARM_NAME = "bdm-watchdog";
const WATCHDOG_PERIOD_MIN = 1; // chrome.alarms 周期下限

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER"],
    justification:
      "维持 x25Kn 心跳计时器并解析 bilibili API JSON 响应（SW 会被回收，无法承载数十秒级定时器）",
  });
}

async function getConfig() {
  return (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || null;
}

async function setConfig(cfg) {
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
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
    // offscreen 刚好这一刻不在 / 无响应：当作未运行
    return { ok: false, status: { active: false }, error: String(err.message || err) };
  }
}

async function startMining({ roomId, threadCount = 1, taskIds, taskQueryIntervalSeconds }) {
  if (!roomId) throw new Error("缺少 roomId");
  await setConfig({ roomId, threadCount, taskIds: taskIds || [], taskQueryIntervalSeconds, active: true });
  await ensureOffscreen();
  console.log(TAG, "→ OFS_START", { roomId, threadCount, taskIds });
  const resp = await chrome.runtime.sendMessage({
    type: "OFS_START",
    roomId,
    threadCount,
    taskIds: taskIds || [],
    taskQueryIntervalSeconds,
  });
  // 立即刷新角标，不必等下个 alarm tick
  const st = resp?.ok ? resp.status : null;
  if (st) updateBadge(decideWatchdogAction({ config: await getConfig(), offscreenAlive: true, status: st }).badge);
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
 * 看门狗一个周期：
 * 1. 拉配置 + offscreen 存活 + 最新 status；
 * 2. decideWatchdogAction 给出 action/badge；
 * 3. recreate → 重建 offscreen 并按配置重启；始终应用 badge。
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
      await chrome.runtime.sendMessage({
        type: "OFS_START",
        roomId: config.roomId,
        threadCount: config.threadCount || 1,
        taskIds: config.taskIds || [],
        taskQueryIntervalSeconds: config.taskQueryIntervalSeconds,
      });
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
  await chrome.runtime.sendMessage({
    type: "OFS_START",
    roomId: cfg.roomId,
    threadCount: cfg.threadCount || 1,
    taskIds: cfg.taskIds || [],
    taskQueryIntervalSeconds: cfg.taskQueryIntervalSeconds,
  });
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

// SW 每次唤醒（被 idle kill 后重启）立即跑一次看门狗，确保角标/offscreen 尽快自愈
runWatchdog().catch((e) => console.warn(TAG, "init watchdog:", e));

// --- 调试钩子（popup 为正式 UI；此钩子便于在 SW 控制台做真实服务器验证）---
// 在 SW 控制台（chrome://extensions → service worker）直接调用：
//   await bdm.start({ roomId: 22743115, threadCount: 100, taskIds: ["xxx"] })
//   await bdm.stop()
//   await bdm.status()
//   await bdm.watchdog()   // 手动触发一次看门狗周期
globalThis.bdm = {
  start: startMining,
  stop: stopMining,
  status: queryStatus,
  watchdog: runWatchdog,
};

console.log(TAG, "background loaded（M4 watchdog）");
