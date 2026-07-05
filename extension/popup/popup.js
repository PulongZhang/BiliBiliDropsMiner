// popup 控制面板：配置房间/会话/任务 → 通过 background 的 START/STOP/STATUS 消息驱动引擎。
// 不直接访问 offscreen，全部经 background 中继（OFS_* 由 background 转发）。

import { extractRoomIdFromLiveUrl } from "../lib/url-parsing.js";
import { extractTaskIdsFromInitialState } from "../lib/initial-state.js";

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

const CONFIG_KEY = "mining";

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
  };
}

function fillForm(cfg) {
  if (!cfg) return;
  if (cfg.roomId) roomIdEl.value = cfg.roomId;
  if (cfg.threadCount) threadCountEl.value = cfg.threadCount;
  if (Array.isArray(cfg.taskIds)) taskIdsEl.value = cfg.taskIds.join(", ");
  if (cfg.taskQueryIntervalSeconds) taskIntervalEl.value = cfg.taskQueryIntervalSeconds;
}

async function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function setBadge(text, cls) {
  badgeEl.textContent = text;
  badgeEl.className = `badge ${cls || ""}`.trim();
}

function renderStatus(st) {
  if (!st || !st.active) {
    statusEl.textContent = "未运行";
    setBadge("未运行", "");
    return;
  }
  const lines = [
    `运行中 · 房间 ${st.roomId} · ${st.threadCount} 会话`,
    `心跳：${st.running}/${st.total} 运行，${st.waiting} 等待，${st.idle} 空闲`,
    `累计心跳 ${st.heartbeats}`,
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
}

// --- 事件 ---

detectBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    statusEl.textContent = "未找到当前标签页";
    return;
  }
  const roomId = extractRoomIdFromLiveUrl(tab.url);
  if (roomId) roomIdEl.value = roomId;

  // 直播间页面：注入 MAIN world 读 window.__initialState.EraTasklistPc 提取掉宝任务 ID
  let taskIds = null;
  if (roomId) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () =>
          window.__initialState ? window.__initialState.EraTasklistPc : null,
      });
      if (result) {
        taskIds = extractTaskIdsFromInitialState({ EraTasklistPc: result });
      }
    } catch (err) {
      // 页面受限 / 正在导航 —— 忽略，仅回填房间号
    }
  }

  if (!roomId && !taskIds) {
    statusEl.textContent = "当前标签页不是直播间（live.bilibili.com/<id>）";
    return;
  }
  const parts = [];
  if (roomId) parts.push(`房间号 ${roomId}`);
  if (taskIds && taskIds.length) {
    taskIdsEl.value = taskIds.join(", ");
    parts.push(`${taskIds.length} 个任务 ID`);
  } else if (roomId) {
    parts.push("页面未发现掉宝任务（__initialState 无 EraTasklistPc）");
  }
  statusEl.textContent = "已识别：" + parts.join("，");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!roomIdEl.value) {
    statusEl.textContent = "请填写房间 ID";
    return;
  }
  startBtn.disabled = true;
  const cfg = gatherConfig();
  const resp = await sendMessage({ type: "START", ...cfg });
  startBtn.disabled = false;
  if (resp?.ok) {
    renderStatus(resp.status);
  } else {
    statusEl.textContent = `启动失败：${resp?.error || "未知错误"}`;
    setBadge("错误", "error");
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  const resp = await sendMessage({ type: "STOP" });
  stopBtn.disabled = false;
  if (resp?.ok) {
    renderStatus({ active: false });
  } else {
    statusEl.textContent = `停止失败：${resp?.error || "未知错误"}`;
  }
});

// --- 初始化：回填配置 + 拉取状态 ---

(async () => {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  fillForm(stored);
  await refreshStatus();
  // popup 打开期间每 2s 刷新一次状态
  setInterval(refreshStatus, 2000);
})();
