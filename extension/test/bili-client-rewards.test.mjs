import { test } from "node:test";
import assert from "node:assert/strict";

import { BiliClient } from "../lib/bili-client.js";

const UA = "Mozilla/5.0 (Win64) Chrome/122";
const TASK_TOTALV2_URL = "https://api.bilibili.com/x/task/totalv2";
const MISSION_INFO_URL =
  "https://api.bilibili.com/x/activity_components/mission/info";
const MISSION_RECEIVE_URL =
  "https://api.bilibili.com/x/activity_components/mission/receive";

/**
 * 记录型 fake HttpClient：按 URL 脚本化响应；数组 → 逐次消费（限频重试用）。
 * 记录每次调用的 method/url/params/body/headers。
 */
function capturingHttp(responses) {
  const calls = [];
  const counters = {};
  const pick = (url) => {
    const r = responses[url];
    if (r === undefined) throw new Error(`unexpected call ${url}`);
    if (Array.isArray(r)) {
      const i = Math.min(counters[url] || 0, r.length - 1);
      counters[url] = (counters[url] || 0) + 1;
      return r[i];
    }
    return r;
  };
  const handle = (method, url, params, extra) => {
    calls.push({ method, url, params, ...extra });
    const entry = pick(url);
    if (entry?.throw) throw new Error(entry.throw);
    return entry?.payload;
  };
  return {
    calls,
    signedGetJson: (url, params, opts) =>
      handle("GET", url, params, { headers: opts?.headers }),
    signedPostFormJson: (url, params, body, opts) =>
      handle("POST-FORM", url, params, { body, headers: opts?.headers }),
    clearWbiCache() {},
  };
}

const noopSleep = () => Promise.resolve();
const recordingSleep = (log) => (ms) => {
  log.push(ms);
  return Promise.resolve();
};

const claimableInfo = {
  taskId: "t1",
  taskName: "n",
  status: 0,
  isClaimable: true,
  isClaimed: false,
  actId: "a",
  actName: "an",
  rewardName: "r",
  message: "",
};

// --- getTaskProgress ---

test("getTaskProgress: joins task_ids, includes csrf, returns parsed progresses", async () => {
  const http = capturingHttp({
    [TASK_TOTALV2_URL]: {
      payload: {
        code: 0,
        data: {
          list: [
            {
              task_id: "t1",
              task_name: "观看",
              indicators: [{ type: "watch_time", cur_value: 5, limit: 10 }],
            },
          ],
        },
      },
    },
  });
  const c = new BiliClient({ http, userAgent: UA, sleep: noopSleep });
  const prog = await c.getTaskProgress(["t1", "t2"], { csrf: "jct" });
  assert.equal(prog.length, 1);
  assert.equal(prog[0].taskId, "t1");
  assert.equal(prog[0].curValue, 5);
  assert.equal(http.calls[0].params.csrf, "jct");
  assert.equal(http.calls[0].params.task_ids, "t1,t2");
});

test("getTaskProgress: empty ids → [] and no request", async () => {
  const http = capturingHttp({});
  const c = new BiliClient({ http, userAgent: UA, sleep: noopSleep });
  const prog = await c.getTaskProgress([], { csrf: "jct" });
  assert.deepEqual(prog, []);
  assert.equal(http.calls.length, 0);
});

test("getTaskProgress: missing csrf throws", async () => {
  const c = new BiliClient({
    http: capturingHttp({}),
    userAgent: UA,
    sleep: noopSleep,
  });
  await assert.rejects(
    () => c.getTaskProgress(["t1"], { csrf: "" }),
    /缺少 bili_jct/,
  );
});

// --- getMissionRewardInfo ---

test("getMissionRewardInfo: rate-limited twice then success → 3 attempts, 2 backoff sleeps", async () => {
  const sleeps = [];
  const http = capturingHttp({
    [MISSION_INFO_URL]: [
      { payload: { code: -509, message: "请求过于频繁" } },
      { payload: { code: -509, message: "请求过于频繁" } },
      {
        payload: {
          code: 0,
          data: { task_id: "t1", status: 0, reward_info: { award_name: "辣条" } },
        },
      },
    ],
  });
  const c = new BiliClient({ http, userAgent: UA, sleep: recordingSleep(sleeps) });
  const info = await c.getMissionRewardInfo("t1");
  assert.equal(info.taskId, "t1");
  assert.equal(info.isClaimable, true);
  assert.equal(info.rewardName, "辣条");
  assert.equal(http.calls.length, 3);
  assert.deepEqual(sleeps, [1500, 3000]); // attempt 2 (1.5s) + attempt 3 (3.0s)
});

test("getMissionRewardInfo: success first try → 1 attempt, 0 sleeps", async () => {
  const sleeps = [];
  const http = capturingHttp({
    [MISSION_INFO_URL]: {
      payload: { code: 0, data: { task_id: "t1", status: 6 } },
    },
  });
  const c = new BiliClient({ http, userAgent: UA, sleep: recordingSleep(sleeps) });
  const info = await c.getMissionRewardInfo("t1");
  assert.equal(info.isClaimed, true);
  assert.equal(http.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

// --- receiveMissionReward ---

test("receiveMissionReward: already-claimed → skipped success, no POST", async () => {
  const http = capturingHttp({});
  const c = new BiliClient({ http, userAgent: UA, sleep: noopSleep });
  const r = await c.receiveMissionReward(
    { ...claimableInfo, status: 6, isClaimable: false, isClaimed: true },
    { csrf: "jct" },
  );
  assert.equal(r.skipped, true);
  assert.equal(r.success, true);
  assert.equal(http.calls.length, 0);
});

test("receiveMissionReward: not-claimable → skipped failure, no POST", async () => {
  const http = capturingHttp({});
  const c = new BiliClient({ http, userAgent: UA, sleep: noopSleep });
  const r = await c.receiveMissionReward(
    { ...claimableInfo, status: 2, isClaimable: false, isClaimed: false },
    { csrf: "jct" },
  );
  assert.equal(r.skipped, true);
  assert.equal(r.success, false);
  assert.equal(http.calls.length, 0);
});

test("receiveMissionReward: claimable → POST form body, success result", async () => {
  const http = capturingHttp({
    [MISSION_RECEIVE_URL]: { payload: { code: 0, message: "" } },
  });
  const c = new BiliClient({ http, userAgent: UA, sleep: noopSleep });
  const r = await c.receiveMissionReward(claimableInfo, { csrf: "jct" });
  assert.equal(r.success, true);
  assert.equal(r.skipped, false);
  assert.equal(r.status, 6);
  assert.equal(r.message, "领取成功");
  assert.equal(http.calls[0].body.csrf, "jct");
  assert.equal(http.calls[0].body.csrf_token, "jct");
  assert.equal(http.calls[0].body.task_id, "t1");
  assert.equal(http.calls[0].body.receive_from, "missionPage");
});

test("receiveMissionReward: rate-limited then success → 2 attempts", async () => {
  const http = capturingHttp({
    [MISSION_RECEIVE_URL]: [
      { payload: { code: -702, message: "频率限制" } },
      { payload: { code: 0, message: "" } },
    ],
  });
  const c = new BiliClient({ http, userAgent: UA, sleep: noopSleep });
  const r = await c.receiveMissionReward(claimableInfo, { csrf: "jct" });
  assert.equal(r.success, true);
  assert.equal(http.calls.length, 2);
});

test("receiveMissionReward: missing csrf throws", async () => {
  const c = new BiliClient({
    http: capturingHttp({}),
    userAgent: UA,
    sleep: noopSleep,
  });
  await assert.rejects(
    () => c.receiveMissionReward(claimableInfo, { csrf: "" }),
    /缺少 bili_jct/,
  );
});

// --- receiveAllMissionRewards ---

test("receiveAllMissionRewards: iterates with 1.2s interval; collects skip + failure", async () => {
  const sleeps = [];
  const http = capturingHttp({
    [MISSION_INFO_URL]: [
      { payload: { code: 0, data: { task_id: "t1", status: 6 } } }, // 已领 → 跳过
      { throw: "net err" }, // 第二个任务查询抛错 → failed
    ],
  });
  const c = new BiliClient({ http, userAgent: UA, sleep: recordingSleep(sleeps) });
  const results = await c.receiveAllMissionRewards(["t1", "t2"], { csrf: "jct" });
  assert.equal(results.length, 2);
  assert.equal(results[0].skipped, true);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.match(results[1].message, /net err/);
  assert.ok(
    sleeps.some((s) => s === 1200),
    "应有 1.2s 任务间隔 sleep",
  );
});
