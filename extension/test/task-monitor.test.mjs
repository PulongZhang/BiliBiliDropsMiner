import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectClaimableTasks,
  buildProgressSnapshot,
  TaskMonitor,
} from "../lib/task-monitor.js";

// --- 纯函数 ---

test("selectClaimableTasks: completed+unclaimed selected; status 6 / locally-claimed / not-completed excluded", () => {
  const progresses = [
    { taskId: "t1", isCompleted: true, status: 0 }, // 完成，可领
    { taskId: "t2", isCompleted: true, status: 6 }, // 服务端已领
    { taskId: "t3", isCompleted: false, status: 0 }, // 未完成
    { taskId: "t4", isCompleted: true, status: 3 }, // 完成，status 非 6
  ];
  assert.deepEqual(selectClaimableTasks(progresses, []), ["t1", "t4"]);
  // t1 本地已领 → 排除
  assert.deepEqual(selectClaimableTasks(progresses, ["t1"]), ["t4"]);
});

test("buildProgressSnapshot: maps taskId → {curValue, limitValue, status}", () => {
  assert.deepEqual(
    buildProgressSnapshot([
      { taskId: "t1", curValue: 5, limitValue: 10, status: 0 },
      { taskId: "t2", curValue: 20, limitValue: 20, status: 3 },
    ]),
    {
      t1: { curValue: 5, limitValue: 10, status: 0 },
      t2: { curValue: 20, limitValue: 20, status: 3 },
    },
  );
});

// --- TaskMonitor 编排（fake client） ---

function fakeClient({ progresses, infos, results = {}, throws }) {
  const calls = {
    getTaskProgress: [],
    getMissionRewardInfo: [],
    receiveMissionReward: [],
  };
  return {
    calls,
    async getTaskProgress(taskIds, { csrf }) {
      calls.getTaskProgress.push({ taskIds: [...taskIds], csrf });
      if (throws?.getTaskProgress) throw new Error(throws.getTaskProgress);
      return taskIds.map((id) => progresses[id]).filter(Boolean);
    },
    async getMissionRewardInfo(taskId) {
      calls.getMissionRewardInfo.push(taskId);
      const info = infos[taskId];
      if (!info) throw new Error(`no info for ${taskId}`);
      return info;
    },
    async receiveMissionReward(info, { csrf }) {
      calls.receiveMissionReward.push(info.taskId);
      return (
        results[info.taskId] || {
          success: true,
          skipped: false,
          message: "领取成功",
          taskId: info.taskId,
          status: 6,
        }
      );
    },
  };
}

const baseProgresses = {
  t1: {
    taskId: "t1",
    taskName: "T1",
    isCompleted: true,
    status: 0,
    curValue: 60,
    limitValue: 60,
  },
  t2: {
    taskId: "t2",
    taskName: "T2",
    isCompleted: false,
    status: 0,
    curValue: 5,
    limitValue: 60,
  },
};
const baseInfos = {
  t1: { taskId: "t1", taskName: "T1", status: 0, isClaimable: true, isClaimed: false },
};

test("_runOnce: polls + claims completed only + marks claimed; returns intervalMs", async () => {
  const claims = [];
  const client = fakeClient({
    progresses: baseProgresses,
    infos: baseInfos,
    results: {
      t1: { success: true, skipped: false, message: "领取成功", taskId: "t1", status: 6 },
    },
  });
  const m = new TaskMonitor({
    client,
    taskIds: ["t1", "t2"],
    csrf: "jct",
    intervalMs: 30000,
    reconnectDelayMs: 10000,
    log: () => {},
    onClaim: (r) => claims.push(r),
  });
  const delay = await m._runOnce();
  assert.deepEqual(client.calls.getTaskProgress[0].taskIds, ["t1", "t2"]);
  assert.deepEqual(client.calls.receiveMissionReward, ["t1"]); // 只领 t1
  assert.deepEqual(claims.map((r) => r.taskId), ["t1"]);
  assert.deepEqual(m.claimedIds, ["t1"]);
  assert.equal(delay, 30000);
});

test("_runOnce: second pass does not re-claim already-claimed", async () => {
  const client = fakeClient({ progresses: baseProgresses, infos: baseInfos });
  const m = new TaskMonitor({
    client,
    taskIds: ["t1", "t2"],
    csrf: "jct",
    log: () => {},
  });
  await m._runOnce();
  client.calls.receiveMissionReward.length = 0;
  await m._runOnce();
  assert.deepEqual(client.calls.receiveMissionReward, []); // t1 已在 claimedIds
});

test("_runOnce: claim error captured but does not crash the cycle", async () => {
  const client = fakeClient({
    progresses: baseProgresses,
    infos: { t1: undefined }, // getMissionRewardInfo 抛 "no info"
  });
  const m = new TaskMonitor({
    client,
    taskIds: ["t1"],
    csrf: "jct",
    log: () => {},
  });
  const delay = await m._runOnce();
  assert.equal(delay, 30000); // 仍算成功周期（领奖失败在内部捕获）
  assert.deepEqual(m.claimedIds, []); // 未成功，不加 claimedIds
});

test("_runOnce: getTaskProgress throws → lastError set + reconnectDelayMs", async () => {
  const client = fakeClient({
    progresses: baseProgresses,
    throws: { getTaskProgress: "net down" },
  });
  const m = new TaskMonitor({
    client,
    taskIds: ["t1"],
    csrf: "jct",
    reconnectDelayMs: 10000,
    log: () => {},
  });
  const delay = await m._runOnce();
  assert.equal(delay, 10000);
  assert.match(String(m.lastError.message), /net down/);
});

test("stop sets stopped flag", () => {
  const m = new TaskMonitor({
    client: fakeClient({ progresses: {}, infos: {} }),
    taskIds: [],
    csrf: "jct",
    log: () => {},
  });
  m.stop();
  assert.equal(m.stopped, true);
});

test("snapshot diff fires onProgress only on change", async () => {
  const progressEvents = [];
  const progressesSeq = [
    { taskId: "t1", taskName: "T1", curValue: 5, limitValue: 10, status: 0, isCompleted: false },
    { taskId: "t1", taskName: "T1", curValue: 5, limitValue: 10, status: 0, isCompleted: false }, // 无变化
    { taskId: "t1", taskName: "T1", curValue: 8, limitValue: 10, status: 0, isCompleted: false }, // 变化
  ];
  let i = 0;
  const client = {
    calls: { getTaskProgress: [] },
    async getTaskProgress(taskIds) {
      this.calls.getTaskProgress.push(taskIds);
      return [progressesSeq[i++]];
    },
    async getMissionRewardInfo() { throw new Error("none completed"); },
    async receiveMissionReward() { throw new Error("unreachable"); },
  };
  const m = new TaskMonitor({
    client,
    taskIds: ["t1"],
    csrf: "jct",
    log: () => {},
    onProgress: (snap) => progressEvents.push(snap),
  });
  await m._runOnce(); // cur 5 → 事件
  await m._runOnce(); // cur 5 不变 → 无事件
  await m._runOnce(); // cur 8 → 事件
  assert.equal(progressEvents.length, 2);
});

test("aggregate task: completed checkpoints claim their own SID while later checkpoints are incomplete", async () => {
  const progress = { taskId: "parent", status: 0, isCompleted: false, checkPoints: [
    { sid: "one", status: 3, isCompleted: true },
    { sid: "two", status: 0, isCompleted: false },
    { sid: "claimed", status: 6, isCompleted: true },
  ] };
  assert.deepEqual(selectClaimableTasks([progress, { ...baseProgresses.t1, taskId: "one" }], []), ["one"]);
  const client = fakeClient({ progresses: { parent: progress }, infos: { one: { taskId: "one" } } });
  const m = new TaskMonitor({ client, taskIds: ["parent"], csrf: "jct", sleep: async () => {} });
  await m._runOnce();
  assert.deepEqual(client.calls.receiveMissionReward, ["one"]);
  assert.deepEqual(m.progresses, [progress]);
  assert.equal(m.claimResults[0].taskId, "one");
});

test("auto claim can be disabled and updated task IDs are used without replacing the monitor", async () => {
  const client = fakeClient({ progresses: baseProgresses, infos: baseInfos });
  const m = new TaskMonitor({ client, taskIds: ["t1"], csrf: "jct", autoClaimRewards: false });
  await m._runOnce();
  assert.deepEqual(client.calls.receiveMissionReward, []);
  m.update({ taskIds: ["t2"], intervalMs: 15000, autoClaimRewards: true });
  await m._runOnce();
  assert.deepEqual(client.calls.getTaskProgress.at(-1).taskIds, ["t2"]);
  assert.equal(m.intervalMs, 15000);
});

test("stopping or editing tasks during a slow query prevents stale progress and claims", async () => {
  for (const action of ["stop", "update"]) {
    let resolveQuery;
    const client = fakeClient({ progresses: baseProgresses, infos: baseInfos });
    client.getTaskProgress = () => new Promise((resolve) => { resolveQuery = resolve; });
    const m = new TaskMonitor({ client, taskIds: ["t1"], csrf: "jct" });
    const pending = m._runOnce();
    if (action === "stop") m.stop();
    else m.update({ taskIds: ["t2"] });
    resolveQuery([baseProgresses.t1]);
    await pending;
    assert.deepEqual(client.calls.receiveMissionReward, [], action);
    assert.deepEqual(m.progresses, [], action);
  }
});

test("stopping during reward info prevents the subsequent receive request", async () => {
  let resolveInfo;
  const client = fakeClient({ progresses: baseProgresses, infos: baseInfos });
  client.getMissionRewardInfo = () => new Promise((resolve) => { resolveInfo = resolve; });
  const m = new TaskMonitor({ client, taskIds: ["t1"], csrf: "jct" });
  const pending = m._runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  m.stop();
  resolveInfo(baseInfos.t1);
  await pending;
  assert.deepEqual(client.calls.receiveMissionReward, []);
});

test("manual refresh and manual claim remain serialized behind an existing query", async () => {
  const client = fakeClient({ progresses: baseProgresses, infos: baseInfos });
  let resolveFirst;
  let queries = 0;
  client.getTaskProgress = async () => {
    queries++;
    if (queries === 1) await new Promise((resolve) => { resolveFirst = resolve; });
    return [baseProgresses.t1];
  };
  const m = new TaskMonitor({ client, taskIds: ["t1"], csrf: "jct", autoClaimRewards: false });
  const initial = m._runOnce();
  const refreshed = m.refresh();
  const claimed = m.refresh({ claimAll: true });
  resolveFirst();
  await Promise.all([initial, refreshed, claimed]);
  assert.equal(queries, 3);
  assert.deepEqual(client.calls.receiveMissionReward, ["t1"]);
});

test("reward batches keep the 1.2s gap and reset tasks may claim in the next period", async () => {
  const progresses = { ...baseProgresses, t2: { ...baseProgresses.t2, isCompleted: true } };
  const client = fakeClient({ progresses, infos: { ...baseInfos, t2: { taskId: "t2" } } });
  const sleeps = [];
  const m = new TaskMonitor({ client, taskIds: ["t1", "t2"], csrf: "jct", sleep: async (ms) => { sleeps.push(ms); } });
  await m._runOnce();
  assert.deepEqual(client.calls.receiveMissionReward, ["t1", "t2"]);
  assert.deepEqual(sleeps, [1200]);
  progresses.t1 = { ...baseProgresses.t1, isCompleted: false, curValue: 0 };
  await m._runOnce();
  progresses.t1 = baseProgresses.t1;
  await m._runOnce();
  assert.deepEqual(client.calls.receiveMissionReward, ["t1", "t2", "t1"]);
});
