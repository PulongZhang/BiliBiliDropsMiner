// popup 控制面板：配置房间/会话/任务 → 通过 background 的 START/STOP/STATUS 消息驱动引擎。
// 不直接访问 offscreen，全部经 background 中继（OFS_* 由 background 转发）。

import { extractRoomIdFromLiveUrl } from "../lib/url-parsing.js";
import { extractTaskIdsFromInitialState, extractTaskIdsFromPageData } from "../lib/initial-state.js";

const form = document.getElementById("form");
const roomIdEl = document.getElementById("roomId");
const threadCountEl = document.getElementById("threadCount");
const taskIdsEl = document.getElementById("taskIds");
const taskIntervalEl = document.getElementById("taskInterval");
const detectBtn = document.getElementById("detect");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const badgeEl = document.getElementById("badgeState");
const accountEl = document.getElementById("account");
const loginLinkEl = document.getElementById("loginLink");
const autoClaimEl = document.getElementById("autoClaimRewards");
const messageEl = document.getElementById("message");
const taskProgressEl = document.getElementById("taskProgress");
const rewardResultsEl = document.getElementById("rewardResults");
const rewardSummaryEl = document.getElementById("rewardSummary");
const discoverBtn = document.getElementById("discover");
const applyBtn = document.getElementById("applyTasks");
const refreshBtn = document.getElementById("refreshTasks");
const claimBtn = document.getElementById("claimRewards");

const CONFIG_KEY = "mining";
let miningActive = false;
let runningRoomId = null;
let saving = Promise.resolve();
let starting = false;
let stopping = false;
let taskActionBusy = false;

function parseTaskIds(text) {
  return String(text || "")
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function gatherConfig() {
  return {
    roomId: Number(roomIdEl.value),
    threadCount: Math.max(1, Number(threadCountEl.value) || 1),
    taskIds: parseTaskIds(taskIdsEl.value),
    taskQueryIntervalSeconds: Math.max(10, Number(taskIntervalEl.value) || 30),
    autoClaimRewards: autoClaimEl.checked,
  };
}

function fillForm(cfg) {
  if (!cfg) return;
  if (cfg.roomId) roomIdEl.value = cfg.roomId;
  if (cfg.threadCount) threadCountEl.value = cfg.threadCount;
  if (Array.isArray(cfg.taskIds)) taskIdsEl.value = cfg.taskIds.join(", ");
  if (cfg.taskQueryIntervalSeconds) taskIntervalEl.value = cfg.taskQueryIntervalSeconds;
  autoClaimEl.checked = cfg.autoClaimRewards !== false;
}

async function sendMessage(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
}

function showMessage(message = "") {
  messageEl.textContent = message;
  messageEl.hidden = !message;
}

function savePreferences() {
  const config = gatherConfig();
  saving = saving.then(() => sendMessage({ type: "SAVE_CONFIG", config }));
  return saving;
}

function renderAccount(account) {
  if (!account) return;
  loginLinkEl.hidden = account.kind !== "invalid";
  accountEl.textContent = account.kind === "valid"
    ? `正在使用浏览器登录态：${account.uname}（UID ${account.uid}）`
    : account.kind === "invalid" ? "未登录或登录已失效"
    : account.kind === "error" ? account.message : "正在读取浏览器登录态…";
}

function formatProgress(task, label) {
  const state = task.status === 6 ? "已领取" : task.isCompleted ? "已完成" : "进行中";
  return `${label}：${task.curValue}/${task.limitValue} · ${state}`;
}

function renderTasks(monitor) {
  const lines = [];
  for (const task of monitor?.progresses || []) {
    lines.push(formatProgress(task, task.taskName || task.taskId));
    for (const point of task.checkPoints || []) {
      const award = point.awardName ? ` · ${point.awardName}${point.awardCount > 0 ? ` ×${point.awardCount}` : ""}` : "";
      lines.push("  " + formatProgress(point, point.alias || point.sid) + award);
    }
  }
  if (monitor?.lastUpdatedAt) lines.push(`更新于 ${new Date(monitor.lastUpdatedAt).toLocaleTimeString()}`);
  taskProgressEl.textContent = lines.join("\n") || "尚无任务进度";
  const results = monitor?.claimResults || [];
  rewardSummaryEl.textContent = `领奖结果（${results.length}）`;
  rewardResultsEl.textContent = results.map((result) => {
    const state = result.success ? (result.skipped ? "已领取" : "领取成功") : (result.skipped ? "跳过" : "失败");
    return `[${state}] ${result.taskName || result.taskId}${result.rewardName ? ` · ${result.rewardName}` : ""}：${result.message}`;
  }).join("\n") || "暂无领取记录";
}

function setBadge(text, cls) {
  badgeEl.textContent = text;
  badgeEl.className = `badge ${cls || ""}`.trim();
}

function renderStatus(st) {
  miningActive = Boolean(st?.active);
  runningRoomId = miningActive ? st.roomId : null;
  startBtn.disabled = starting || miningActive;
  stopBtn.disabled = stopping || !miningActive;
  roomIdEl.readOnly = miningActive;
  threadCountEl.readOnly = miningActive;
  refreshBtn.disabled = taskActionBusy || !miningActive;
  claimBtn.disabled = taskActionBusy || !miningActive;
  if (miningActive) {
    roomIdEl.value = st.roomId;
    threadCountEl.value = st.threadCount;
  }
  renderAccount(st?.account);
  renderTasks(st?.taskMonitor);
  if (!st || !st.active) {
    statusEl.textContent = st?.stopReason || "未运行";
    setBadge(st?.stopReason ? "已停止" : "未运行", st?.stopReason ? "error" : "");
    return;
  }
  const lines = [
    `运行中 · 房间 ${st.roomId} · ${st.threadCount} 会话`,
    `心跳：${st.running}/${st.total} 运行，${st.waiting} 等待，${st.idle} 空闲`,
    `累计心跳 ${st.heartbeats}`,
    `运行时长 ${Math.max(0, Math.floor((Date.now() - st.startedAt) / 60000))} 分钟`,
  ];
  if (st.taskMonitor) {
    const tm = st.taskMonitor;
    lines.push(`任务：${tm.taskIds.length} 个，已领 ${tm.claimedIds.length}`);
    if (tm.lastError) lines.push(`任务错误：${tm.lastError}`);
  }
  if (st.errors && st.errors.length) {
    lines.push(`会话错误 ${st.errors.length} 个（首个：${st.errors[0].error}）`);
  }
  statusEl.textContent = lines.join("\n");

  if (st.running >= st.total && st.total > 0) setBadge(`${st.running}/${st.total}`, "running");
  else if (st.running === 0 && st.total > 0) setBadge("0/" + st.total, "error");
  else if (st.total > 0) setBadge(`${st.running}/${st.total}`, "waiting");
  else setBadge("运行中", "running");
}

async function refreshStatus() {
  const resp = await sendMessage({ type: "STATUS" });
  if (resp?.ok) renderStatus(resp.status);
  else showMessage(resp?.error || "状态读取失败");
}

async function applyTaskSettings() {
  await savePreferences();
  const resp = await sendMessage({ type: "UPDATE_TASKS", ...gatherConfig() });
  if (!resp?.ok) throw new Error(resp?.error || "更新任务失败");
  renderStatus(resp.status);
}

async function useDiscoveredTasks(roomId, taskIds) {
  if (miningActive && roomId !== runningRoomId) throw new Error("请先停止挂机，再切换直播间");
  roomIdEl.value = roomId;
  if (!taskIds.length) {
    await savePreferences();
    showMessage("已识别房间，但未发现活动任务，请确认直播间或手动填写任务 ID");
    return;
  }
  taskIdsEl.value = taskIds.join(", ");
  if (miningActive) await applyTaskSettings();
  else await savePreferences();
  showMessage(`已识别房间 ${roomId}，${taskIds.length} 个任务${miningActive ? "，已应用到运行中的监控" : ""}`);
}

// --- 事件 ---

detectBtn.addEventListener("click", async () => {
  detectBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error("未找到当前标签页");
    const roomId = extractRoomIdFromLiveUrl(tab.url);
    if (!roomId) throw new Error("当前标签页不是 B 站直播间");
    if (miningActive && roomId !== runningRoomId) throw new Error("请先停止挂机，再切换直播间");

    let taskIds = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => ({
          state: { EraTasklistPc: window.__initialState?.EraTasklistPc },
          pageData: { layerTree: window.__BILIACT_EVAPAGEDATA__?.layerTree },
        }),
      });
      if (result) {
        taskIds = [...new Set([
          ...extractTaskIdsFromInitialState(result.state),
          ...extractTaskIdsFromPageData(result.pageData),
        ])];
      }
    } catch (err) {
      // 页面受限或正在导航时，继续尝试静态解析。
    }

    if (!taskIds.length) {
      const resp = await sendMessage({ type: "DISCOVER_TASKS", roomId });
      if (!resp?.ok) throw new Error(resp?.error || "活动页解析失败");
      taskIds = resp.taskIds;
    }
    await useDiscoveredTasks(roomId, taskIds);
  } catch (err) { showMessage(err.message); }
  finally { detectBtn.disabled = false; }
});

discoverBtn.addEventListener("click", async () => {
  discoverBtn.disabled = true;
  try {
    const roomId = Number(roomIdEl.value);
    const resp = await sendMessage({ type: "DISCOVER_TASKS", roomId });
    if (!resp?.ok) throw new Error(resp?.error || "获取任务失败");
    await useDiscoveredTasks(roomId, resp.taskIds);
  } catch (err) { showMessage(err.message); }
  finally { discoverBtn.disabled = false; }
});

form.addEventListener("input", savePreferences);
applyBtn.addEventListener("click", async () => {
  applyBtn.disabled = true;
  try { await applyTaskSettings(); showMessage("任务设置已应用"); }
  catch (err) { showMessage(err.message); }
  finally { applyBtn.disabled = false; }
});

for (const [button, type] of [[refreshBtn, "REFRESH_TASKS"], [claimBtn, "CLAIM_REWARDS"]]) {
  button.addEventListener("click", async () => {
    taskActionBusy = true;
    refreshBtn.disabled = true;
    claimBtn.disabled = true;
    try {
      await applyTaskSettings();
      const resp = await sendMessage({ type });
      if (!resp?.ok) throw new Error(resp?.error || "任务操作失败");
      renderStatus(resp.status);
      if (resp.status?.taskMonitor?.lastError) showMessage(resp.status.taskMonitor.lastError);
      else showMessage(type === "CLAIM_REWARDS" ? "领取完成，请查看领奖结果" : "进度已刷新");
      if (type === "CLAIM_REWARDS") document.getElementById("rewardDetails").open = true;
    } catch (err) { showMessage(err.message); }
    finally {
      taskActionBusy = false;
      refreshBtn.disabled = !miningActive;
      claimBtn.disabled = !miningActive;
    }
  });
}

async function refreshAccount() {
  const resp = await sendMessage({ type: "ACCOUNT" });
  if (resp?.ok) renderAccount(resp.account);
  else showMessage(resp?.error || "账号检查失败");
}

document.getElementById("checkAccount").addEventListener("click", async () => {
  await refreshAccount();
  await refreshStatus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!roomIdEl.value) {
    showMessage("请填写房间 ID");
    return;
  }
  startBtn.disabled = true;
  starting = true;
  const cfg = gatherConfig();
  await savePreferences();
  const resp = await sendMessage({ type: "START", ...cfg });
  starting = false;
  startBtn.disabled = miningActive;
  if (resp?.ok) {
    showMessage();
    renderStatus(resp.status);
  } else {
    showMessage(`启动失败：${resp?.error || "未知错误"}`);
    setBadge("错误", "error");
  }
});

stopBtn.addEventListener("click", async () => {
  stopping = true;
  stopBtn.disabled = true;
  const resp = await sendMessage({ type: "STOP" });
  stopping = false;
  stopBtn.disabled = !miningActive;
  if (resp?.ok) {
    showMessage();
    await refreshStatus();
  } else {
    showMessage(`停止失败：${resp?.error || "未知错误"}`);
  }
});

// --- 初始化：回填配置 + 拉取状态 ---

(async () => {
  const stored = await chrome.storage.local.get(["preferences", CONFIG_KEY]);
  fillForm(stored.preferences || stored[CONFIG_KEY]);
  await refreshAccount();
  await refreshStatus();
  // popup 打开期间每 2s 刷新一次状态
  setInterval(refreshStatus, 2000);
})();
