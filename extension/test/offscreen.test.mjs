import { test } from "node:test";
import assert from "node:assert/strict";

test("offscreen: updates empty task monitoring without restarting heartbeats; stop aborts pending requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let listener;
  globalThis.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
  let blockQuery = false;
  let querySignal;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push(url);
    if (url.includes("/nav")) return { ok: true, json: async () => ({ code: 0, data: { wbi_img: {
      img_url: "https://x/7cd93e4b9c0b7f6a8d2e5c1f4a6b8c0d.png",
      sub_url: "https://x/e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6.png",
    } } }) };
    if (url.includes("/totalv2")) {
      querySignal = opts.signal;
      if (blockQuery) return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      });
      return { ok: true, json: async () => ({ code: 0, data: [{ task_id: "parent", check_points: [
        { sid: "child", alias: "观看奖励", status: 3, cur_value: 10, limit: 10 },
      ] }] }) };
    }
    if (url.includes("/mission/info")) return { ok: true, json: async () => ({ code: 0, data: { task_id: "child", status: 0 } }) };
    if (url.includes("/mission/receive")) return { ok: true, json: async () => ({ code: 0 }) };
    throw new Error(`unexpected request: ${url}`);
  };
  await import("../offscreen/offscreen.js");
  const send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
  t.after(() => send({ type: "OFS_STOP" }));
  const started = await send({
    type: "OFS_START", roomId: 123, threadCount: 2, taskIds: [], csrf: "test-jct",
    identities: [{ liveBuvid: "b1", liveUuid: "u1" }, { liveBuvid: "b2", liveUuid: "u2" }],
  });
  const updated = await send({ type: "OFS_UPDATE_TASKS", taskIds: ["parent"], taskQueryIntervalSeconds: 15, autoClaimRewards: false });
  assert.equal(updated.status.startedAt, started.status.startedAt);
  assert.equal(updated.status.total, 2);
  assert.deepEqual(updated.status.taskMonitor.taskIds, ["parent"]);
  await send({ type: "OFS_UPDATE_AUTH", csrf: "renewed-jct" });
  const refreshed = await send({ type: "OFS_REFRESH_TASKS" });
  assert.equal(refreshed.status.taskMonitor.progresses[0].checkPoints[0].sid, "child");
  assert.equal(requests.some((url) => url.includes("/mission/receive")), false);
  assert.equal(new URL(requests.find((url) => url.includes("/totalv2"))).searchParams.get("csrf"), "renewed-jct");
  const claimed = await send({ type: "OFS_CLAIM_REWARDS" });
  assert.equal(claimed.status.taskMonitor.claimResults[0].taskId, "child");
  assert.equal(claimed.status.taskMonitor.claimResults[0].success, true);
  blockQuery = true;
  const pending = send({ type: "OFS_REFRESH_TASKS" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(querySignal.aborted, false);
  await send({ type: "OFS_STOP" });
  assert.equal(querySignal.aborted, true);
  assert.equal((await pending).status.active, false);
  assert.equal((await send({ type: "OFS_STATUS" })).status.taskMonitor.claimResults.length, 1);
  assert.equal(listener({ type: "START" }, {}, () => {}), false);
});
