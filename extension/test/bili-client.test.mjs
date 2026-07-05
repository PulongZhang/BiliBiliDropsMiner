import { test } from "node:test";
import assert from "node:assert/strict";

import { BiliClient } from "../lib/bili-client.js";

// 注入式 fake HttpClient：按 URL 返回脚本化 payload。
function fakeHttp(script) {
  const calls = [];
  const fn = async (method, url) => {
    calls.push({ method, url });
    const entry = script[url];
    if (!entry) throw new Error(`unexpected ${method} ${url}`);
    if (entry.throw) throw new Error(entry.throw);
    return entry.payload;
  };
  return {
    calls,
    signedGetJson: (url) => fn("GET", url),
    signedPostJson: (url) => fn("POST-JSON", url),
    signedPostQueryJson: (url) => fn("POST-QUERY", url),
    signedPostFormJson: (url) => fn("POST-FORM", url),
    clearWbiCache() {},
  };
}

const UA = "Mozilla/5.0 (Win64) Chrome/122";
const ROOM_INFO_URL = "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom";
const ENTRY_URL = "https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction";
const E_URL = "https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/E";
const X_URL = "https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/X";

const roomInfoPayload = {
  code: 0,
  data: { room_info: { room_id: 22743115, uid: 65537, parent_area_id: 2, area_id: 21, live_status: 1 } },
};
const enterPayload = {
  code: 0,
  data: { timestamp: 1719740000, heartbeat_interval: 60, secret_key: "0xd4M3Ks9_pL2nQvR8wYb1", secret_rule: [0, 1, 2] },
};
const hbPayload = {
  code: 0,
  data: { timestamp: 1719740060, heartbeat_interval: 60, secret_key: "nextKey9876", secret_rule: [2] },
};

const id = { liveBuvid: "AUTO7654321098765432", liveUuid: "11111111-2222-3333-4444-555555555555", userAgent: UA, csrf: "jctx" };

test("liveTraceEnter chains getInfoByRoom → E, returns parsed session", async () => {
  const http = fakeHttp({
    [ROOM_INFO_URL]: { payload: roomInfoPayload },
    [E_URL]: { payload: enterPayload },
  });
  const c = new BiliClient({ http, userAgent: UA });
  const session = await c.liveTraceEnter(22743115, id);
  assert.equal(session.roomId, 22743115);
  assert.equal(session.ruid, 65537);
  assert.equal(session.parentAreaId, 2);
  assert.equal(session.ets, 1719740000);
  assert.equal(session.secretKey, "0xd4M3Ks9_pL2nQvR8wYb1");
  assert.deepEqual(session.secretRule, [0, 1, 2]);
  assert.equal(session.seqId, 0);
  // 调用顺序：先 room info，后 E
  assert.deepEqual(http.calls.map((x) => x.url), [ROOM_INFO_URL, E_URL]);
});

test("liveTraceEnter throws when E returns non-zero code", async () => {
  const http = fakeHttp({
    [ROOM_INFO_URL]: { payload: roomInfoPayload },
    [E_URL]: { payload: { code: -3, message: "风控" } },
  });
  const c = new BiliClient({ http, userAgent: UA });
  await assert.rejects(() => c.liveTraceEnter(22743115, id), /x25Kn\/E 失败/);
});

test("liveTraceHeartbeat signs + posts X + applies payload (rotates secret)", async () => {
  const http = fakeHttp({
    [ROOM_INFO_URL]: { payload: roomInfoPayload },
    [E_URL]: { payload: enterPayload },
    [X_URL]: { payload: hbPayload },
  });
  const c = new BiliClient({ http, userAgent: UA });
  const session = await c.liveTraceEnter(22743115, id);
  const updated = await c.liveTraceHeartbeat(session, id);
  assert.equal(updated.seqId, 1);
  assert.equal(updated.ets, 1719740060);
  assert.equal(updated.secretKey, "nextKey9876");
  assert.deepEqual(updated.secretRule, [2]);
  assert.deepEqual(http.calls.map((x) => x.url), [ROOM_INFO_URL, E_URL, X_URL]);
});

test("liveTraceHeartbeat throws when X returns non-zero code", async () => {
  const http = fakeHttp({
    [ROOM_INFO_URL]: { payload: roomInfoPayload },
    [E_URL]: { payload: enterPayload },
    [X_URL]: { payload: { code: -403, message: "bad sig" } },
  });
  const c = new BiliClient({ http, userAgent: UA });
  const session = await c.liveTraceEnter(22743115, id);
  await assert.rejects(() => c.liveTraceHeartbeat(session, id), /x25Kn\/X 失败/);
});

test("roomEntryAction posts and throws on non-zero code", async () => {
  const http = fakeHttp({
    [ENTRY_URL]: { payload: { code: 0 } },
  });
  const c = new BiliClient({ http, userAgent: UA });
  await c.roomEntryAction(22743115, { csrf: "jctx" });
  assert.equal(http.calls[0].url, ENTRY_URL);

  const http2 = fakeHttp({ [ENTRY_URL]: { payload: { code: -101, message: "no csrf" } } });
  const c2 = new BiliClient({ http: http2, userAgent: UA });
  await assert.rejects(() => c2.roomEntryAction(22743115, { csrf: "x" }), /roomEntryAction 失败/);
});
