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
import { checkAccount, accountStopReason } from "./lib/account.js";
import { extractTaskIdsFromHtml } from "./lib/initial-state.js";
import { normalizeTaskIds } from "./lib/tasks.js";

const TAG = "[BDM-BG]";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const BILIBILI_ROOT = "https://www.bilibili.com";
const CONFIG_KEY = "mining";
const ALARM_NAME = "bdm-watchdog";
const WATCHDOG_PERIOD_MIN = 1;
let account = { kind: "checking" };
let miningOperation = Promise.resolve();

function serializeMining(fn) {
  const pending = miningOperation.then(fn);
  miningOperation = pending.catch(() => {});
  return pending;
}

function taskSettings(cfg) {
  return {
    taskIds: [...new Set(normalizeTaskIds(cfg.taskIds || []))],
    taskQueryIntervalSeconds: Math.max(10, Number(cfg.taskQueryIntervalSeconds) || 30),
    autoClaimRewards: cfg.autoClaimRewards !== false,
  };
}

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
    autoClaimRewards: cfg.autoClaimRewards !== false,
    csrf,
    identities,
  };
}

function updateBadge(badge) {
  chrome.action.setBadgeText({ text: badge.text });
  if (badge.color) chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

async function queryStatus() {
  const config = await getConfig();
  let status = { active: false };
  try {
    if (await hasOffscreen()) {
      const resp = await chrome.runtime.sendMessage({ type: "OFS_STATUS" });
      if (!resp?.ok) throw new Error(resp?.error || "引擎状态读取失败");
      status = resp.status;
    }
    return { ok: true, status: { ...status, account, stopReason: config?.stopReason || "" } };
  } catch (err) {
    return { ok: false, status: { active: false }, error: String(err.message || err) };
  }
}

async function startMining(msg) {
  const roomId = Number(msg.roomId);
  const n = Number(msg.threadCount ?? 1);
  if (!Number.isSafeInteger(roomId) || roomId <= 0) throw new Error("请填写有效房间 ID");
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("会话数必须为正整数");
  account = await checkAccount();
  if (account.kind !== "valid") {
    if (account.kind === "invalid") await stopMining(accountStopReason(account));
    throw new Error(account.kind === "invalid" ? "请先在 bilibili.com 登录" : account.message);
  }
  const cfg = { roomId, threadCount: n, ...taskSettings(msg), uid: account.uid, active: false, stopReason: "" };
  const payload = await buildStartPayload(cfg);
  await stopMining();
  await setConfig(cfg);
  await ensureOffscreen();
  console.log(TAG, "→ OFS_START", { roomId, threadCount: n });
  const resp = await chrome.runtime.sendMessage(payload);
  if (!resp?.ok) throw new Error(resp?.error || "引擎启动失败");
  await setConfig({ ...cfg, active: true });
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

async function stopMining(stopReason = "") {
  const prev = await getConfig();
  if (prev) await setConfig({ ...prev, active: false, stopReason });
  if (await hasOffscreen()) {
    console.log(TAG, "→ OFS_STOP");
    await chrome.runtime.sendMessage({ type: "OFS_STOP" });
  }
  updateBadge({ text: "", color: "#888888" });
}

async function refreshAccount(config = null) {
  account = await checkAccount();
  const cfg = config || await getConfig();
  if (cfg?.active) {
    const reason = accountStopReason(account, cfg.uid);
    if (reason) await stopMining(reason);
    else if (account.kind === "valid" && await hasOffscreen()) {
      await chrome.runtime.sendMessage({ type: "OFS_UPDATE_AUTH", csrf: await getCsrf() });
    }
  }
  return account;
}

async function updateTasks(msg) {
  const cfg = await getConfig();
  if (cfg?.active && Number(msg.roomId) !== cfg.roomId) {
    throw new Error("运行中更新任务时，房间 ID 必须与当前挂机房间一致");
  }
  const settings = taskSettings(msg);
  if (cfg?.active && await hasOffscreen()) {
    const resp = await chrome.runtime.sendMessage({ type: "OFS_UPDATE_TASKS", ...settings });
    if (!resp?.ok) throw new Error(resp?.error || "更新任务失败");
  }
  if (cfg) await setConfig({ ...cfg, ...settings });
  return queryStatus();
}

async function discoverTasks(roomId) {
  if (!Number.isSafeInteger(roomId) || roomId <= 0) throw new Error("请先填写房间 ID");
  const response = await fetch(`https://live.bilibili.com/${roomId}`, {
    credentials: "include",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`获取活动页失败（HTTP ${response.status}）`);
  return { ok: true, taskIds: extractTaskIdsFromHtml(await response.text()) };
}

/**
 * 看门狗一个周期：配置 + offscreen 存活 + 最新 status → decideWatchdogAction →
 * recreate 则重建并按配置重启；始终刷新角标。
 */
async function runWatchdog() {
  const config = await getConfig();
  if (config?.active) {
    await refreshAccount(config);
    if (accountStopReason(account, config.uid)) return;
  }
  const offscreenAlive = await hasOffscreen();
  let status = null;
  if (offscreenAlive) {
    const resp = await queryStatus();
    status = resp?.ok ? resp.status : null;
  }
  const decision = decideWatchdogAction({ config, offscreenAlive, status });
  console.log(TAG, "watchdog:", decision.action);
  if (decision.action === "recreate" && config) {
    // 网络故障时保持运行意图，待下一次确认账号后恢复。
    if (account.kind !== "valid") return;
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage(await buildStartPayload(config));
      if (!resp?.ok) throw new Error(resp?.error || "恢复引擎失败");
      if (!config.uid) await setConfig({ ...config, uid: account.uid });
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const types = ["START", "STOP", "STATUS", "ACCOUNT", "SAVE_CONFIG", "UPDATE_TASKS", "DISCOVER_TASKS", "REFRESH_TASKS", "CLAIM_REWARDS"];
  if (!types.includes(msg?.type)) return false;
  (async () => {
    try {
      if (msg.type === "START") sendResponse(await serializeMining(() => startMining(msg)));
      else if (msg.type === "STOP") {
        await serializeMining(() => stopMining());
        sendResponse({ ok: true });
      } else if (msg.type === "STATUS") sendResponse(await queryStatus());
      else if (msg.type === "ACCOUNT") sendResponse({ ok: true, account: await serializeMining(() => refreshAccount()) });
      else if (msg.type === "SAVE_CONFIG") {
        await chrome.storage.local.set({ preferences: msg.config });
        sendResponse({ ok: true });
      } else if (msg.type === "UPDATE_TASKS") sendResponse(await serializeMining(() => updateTasks(msg)));
      else if (msg.type === "DISCOVER_TASKS") sendResponse(await discoverTasks(Number(msg.roomId)));
      else if (msg.type === "REFRESH_TASKS" || msg.type === "CLAIM_REWARDS") {
        if (!(await getConfig())?.active || !(await hasOffscreen())) throw new Error("请先启动挂机");
        sendResponse(await chrome.runtime.sendMessage({
          type: msg.type === "CLAIM_REWARDS" ? "OFS_CLAIM_REWARDS" : "OFS_REFRESH_TASKS",
        }));
      }
      // OFS_* 由 offscreen 处理，这里不响应
    } catch (err) {
      console.warn(TAG, err);
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) serializeMining(runWatchdog).catch((e) => console.warn(TAG, e));
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await serializeMining(runWatchdog);
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await serializeMining(runWatchdog);
});

// SW 唤醒后立即跑一次看门狗，让角标/offscreen 尽快自愈
serializeMining(runWatchdog).catch((e) => console.warn(TAG, "init watchdog:", e));

// --- 调试钩子（popup 为正式 UI；此钩子便于在 SW 控制台做真实服务器验证）---
//   await bdm.start({ roomId: 22743115, threadCount: 100, taskIds: ["xxx"] })
//   await bdm.stop() / bdm.status() / bdm.watchdog()
globalThis.bdm = {
  start: (cfg) => serializeMining(() => startMining(cfg)),
  stop: () => serializeMining(() => stopMining()),
  status: queryStatus,
  watchdog: () => serializeMining(runWatchdog),
};

console.log(TAG, "background loaded");
