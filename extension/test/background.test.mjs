import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let stored, alive, status, navPayload, navError, startError, csrf, calls, listener;
const event = () => ({ addListener() {} });
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(stored[key])]));
    },
    async set(value) { Object.assign(stored, structuredClone(value)); },
  } },
  cookies: { async get() { return csrf ? { value: csrf } : null; } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  alarms: { ...event(), onAlarm: event(), async get() { return {}; }, async create() {} },
  offscreen: { async createDocument() { calls.push("create"); alive = true; } },
  runtime: {
    onStartup: event(), onInstalled: event(),
    onMessage: { addListener(fn) { listener = fn; } },
    async getContexts() { return alive ? [{}] : []; },
    async sendMessage(msg) {
      calls.push(msg.type);
      if (msg.type === "OFS_START") {
        if (startError) return { ok: false, error: startError };
        status = { active: true, roomId: msg.roomId, total: msg.threadCount, running: 0, taskMonitor: { taskIds: msg.taskIds } };
      }
      if (msg.type === "OFS_STOP") status = { active: false };
      if (msg.type === "OFS_UPDATE_TASKS") status.taskMonitor = { ...msg };
      return { ok: true, status };
    },
  },
};
globalThis.fetch = async (url) => {
  if (url.includes("/nav")) {
    if (navError) throw new Error("network unavailable");
    return { ok: true, json: async () => navPayload };
  }
  return { ok: true, text: async () => 'window.__BILIACT_EVAPAGEDATA__={"layerTree":[{"type":"Component","name":"EraTasklistPc","props":{"tasklist":[{"taskId":"discovered"}]}}]}' };
};

function reset() {
  stored = {};
  alive = false;
  status = { active: false };
  navPayload = { code: 0, data: { isLogin: true, mid: 42, uname: "用户" } };
  navError = false;
  startError = null;
  csrf = "csrf-for-test";
  calls = [];
}
reset();
await import("../background.js");
await globalThis.bdm.watchdog();
beforeEach(reset);
const send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
const start = () => send({ type: "START", roomId: 123, threadCount: 2, taskIds: ["parent"] });

test("background: only successful authenticated starts enable automatic resume", async () => {
  navPayload = { code: -101 };
  assert.equal((await start()).ok, false);
  assert.equal(stored.mining?.active, undefined);
  assert.equal(calls.includes("OFS_START"), false);
  reset();
  startError = "engine unavailable";
  assert.equal((await start()).ok, false);
  assert.equal(stored.mining.active, false);
  reset();
  assert.equal((await start()).ok, true);
  assert.equal(stored.mining.active, true);
  assert.equal(stored.mining.uid, 42);
});

test("background: config drafts and live task updates preserve the running engine", async () => {
  await start();
  calls.length = 0;
  await send({ type: "SAVE_CONFIG", config: { roomId: 999, threadCount: 5 } });
  assert.equal(stored.preferences.roomId, 999);
  assert.equal(stored.mining.roomId, 123);
  const result = await send({ type: "UPDATE_TASKS", roomId: 123, taskIds: ["child", "child"], taskQueryIntervalSeconds: 15, autoClaimRewards: false });
  assert.equal(result.ok, true);
  assert.deepEqual(stored.mining.taskIds, ["child"]);
  assert.equal(stored.mining.autoClaimRewards, false);
  assert.equal(stored.mining.active, true);
  assert.equal(calls.includes("OFS_UPDATE_TASKS"), true);
  assert.equal(calls.includes("OFS_START"), false);
  assert.equal((await send({ type: "UPDATE_TASKS", roomId: 999, taskIds: [] })).ok, false);
  assert.deepEqual(stored.mining.taskIds, ["child"]);
});

test("background: logout or account switch clears resume intent and cannot be undone by watchdog", async () => {
  for (const payload of [{ code: -101 }, { code: 0, data: { isLogin: true, mid: 43 } }]) {
    reset();
    await start();
    navPayload = payload;
    await globalThis.bdm.watchdog();
    assert.equal(stored.mining.active, false);
    assert.match(stored.mining.stopReason, /失效|变化/);
    assert.equal(status.active, false);
    calls.length = 0;
    await globalThis.bdm.watchdog();
    assert.equal(calls.includes("OFS_START"), false);
    assert.equal((await send({ type: "STATUS" })).status.stopReason, stored.mining.stopReason);
  }
});

test("background: temporary account-check failure leaves a running engine alone and defers cold resume", async () => {
  await start();
  navError = true;
  calls.length = 0;
  await globalThis.bdm.watchdog();
  assert.equal(stored.mining.active, true);
  assert.equal(status.active, true);
  assert.equal(calls.includes("OFS_STOP"), false);
  alive = false;
  calls.length = 0;
  await globalThis.bdm.watchdog();
  assert.equal(calls.includes("OFS_START"), false);
  navError = false;
  await globalThis.bdm.watchdog();
  assert.equal(calls.includes("OFS_START"), true);
});

test("background: startup validates the persisted UID before recreating offscreen", async () => {
  stored.mining = { active: true, roomId: 123, threadCount: 1, uid: 9 };
  await globalThis.bdm.watchdog();
  assert.equal(stored.mining.active, false);
  assert.equal(calls.includes("create"), false);
});

test("background: renewed credentials for the same UID update auth without restarting sessions", async () => {
  await start();
  calls.length = 0;
  csrf = "renewed-jct";
  await send({ type: "ACCOUNT" });
  assert.equal(calls.includes("OFS_UPDATE_AUTH"), true);
  assert.equal(calls.includes("OFS_START"), false);
  assert.equal(stored.mining.active, true);
});

test("background: an idle offscreen engine resumes and concurrent start/stop ends stopped", async () => {
  await start();
  status = { active: false };
  calls.length = 0;
  await globalThis.bdm.watchdog();
  assert.equal(calls.includes("OFS_START"), true);
  const [started, stopped] = await Promise.all([start(), send({ type: "STOP" })]);
  assert.equal(started.ok, true);
  assert.equal(stopped.ok, true);
  assert.equal(stored.mining.active, false);
  assert.equal(status.active, false);
});

test("background: room discovery and task actions relay through the service worker", async () => {
  assert.deepEqual((await send({ type: "DISCOVER_TASKS", roomId: 123 })).taskIds, ["discovered"]);
  assert.equal((await send({ type: "DISCOVER_TASKS", roomId: 0 })).ok, false);
  assert.equal((await send({ type: "CLAIM_REWARDS" })).ok, false);
  await start();
  assert.equal((await send({ type: "REFRESH_TASKS" })).ok, true);
  assert.equal((await send({ type: "CLAIM_REWARDS" })).ok, true);
  assert.equal(calls.includes("OFS_CLAIM_REWARDS"), true);
  assert.equal(listener({ type: "OFS_STATUS" }, {}, () => {}), false);
});
