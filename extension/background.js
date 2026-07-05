// background.js (MV3 service worker)
// 职责：按需创建 offscreen document、转发 start/stop、持久化 mining 配置、
// 浏览器/扩展重启后续跑。M4 会补 chrome.alarms 看门狗（offscreen 被回收时重建）。
//
// 消息约定：popup/外部发 "START"/"STOP"/"STATUS"；本 SW 收到后转发 "OFS_*" 给 offscreen。
// offscreen 只认 OFS_*，避免 popup 直发消息被两端重复处理。

const TAG = "[BDM-BG]";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const CONFIG_KEY = "mining";

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

async function startMining({ roomId, threadCount = 1 }) {
  if (!roomId) throw new Error("缺少 roomId");
  await setConfig({ roomId, threadCount, active: true });
  await ensureOffscreen();
  console.log(TAG, "→ OFS_START", { roomId, threadCount });
  return await chrome.runtime.sendMessage({
    type: "OFS_START",
    roomId,
    threadCount,
  });
}

async function stopMining() {
  const prev = await getConfig();
  if (prev) await setConfig({ ...prev, active: false });
  if (await hasOffscreen()) {
    console.log(TAG, "→ OFS_STOP");
    await chrome.runtime.sendMessage({ type: "OFS_STOP" });
  }
}

async function queryStatus() {
  if (!(await hasOffscreen())) return { ok: true, status: { running: false } };
  return await chrome.runtime.sendMessage({ type: "OFS_STATUS" });
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

chrome.runtime.onStartup.addListener(resumeIfNeeded);
chrome.runtime.onInstalled.addListener(resumeIfNeeded);

// --- M2 调试钩子（M6 popup 落地后移除）---
// 在 SW 控制台（chrome://extensions → service worker）直接调用：
//   await bdm.start({ roomId: 22743115 })
//   await bdm.stop()
//   await bdm.status()
globalThis.bdm = { start: startMining, stop: stopMining, status: queryStatus };

console.log(TAG, "background loaded（M2 relay）");
