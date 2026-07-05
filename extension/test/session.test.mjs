import { test } from "node:test";
import assert from "node:assert/strict";

import { BiliSession } from "../lib/session.js";

function makeSession(over = {}) {
  return {
    roomId: 22743115,
    ruid: 65537,
    parentAreaId: 2,
    areaId: 21,
    seqId: 0,
    ets: 1719740000,
    heartbeatInterval: 60,
    secretKey: "0xd4M3Ks9_pL2nQvR8wYb1",
    secretRule: [0, 1, 2],
    ...over,
  };
}

function makeFakeClient({ enterSession = makeSession() } = {}) {
  const calls = [];
  return {
    calls,
    enterSession,
    failEnter: false,
    failHeartbeat: false,
    async roomEntryAction(roomId) {
      calls.push({ m: "roomEntryAction", roomId });
    },
    async liveTraceEnter(roomId) {
      calls.push({ m: "liveTraceEnter", roomId });
      if (this.failEnter) throw new Error("enter boom");
      return { ...this.enterSession };
    },
    async liveTraceHeartbeat(session) {
      calls.push({ m: "liveTraceHeartbeat", seqBefore: session.seqId });
      if (this.failHeartbeat) throw new Error("heartbeat boom");
      return { ...session, seqId: session.seqId + 1, ets: session.ets + 60 };
    },
  };
}

function setup({ reconnectDelayMs = 8000, enterSession } = {}) {
  const nowMs = { v: 1_000_000 };
  const client = makeFakeClient({ enterSession });
  const s = new BiliSession({
    id: 1,
    client,
    room: { roomId: 22743115 },
    liveBuvid: "AUTO123",
    liveUuid: "uuid-x",
    userAgent: "UA",
    csrf: "jct",
    now: () => nowMs.v,
    reconnectDelayMs,
  });
  s.start();
  return { s, client, nowMs };
}

test("first tick enters: roomEntryAction + liveTraceEnter → running, schedules by interval", async () => {
  const { s, client, nowMs } = setup();
  await s.tick();
  assert.equal(s.state, "running");
  assert.deepEqual(
    client.calls.map((c) => c.m),
    ["roomEntryAction", "liveTraceEnter"],
  );
  assert.equal(s.nextDueAt, nowMs.v + 60 * 1000);
  assert.equal(s.session.roomId, 22743115);
});

test("running tick (due) sends heartbeat and increments count", async () => {
  const { s, client, nowMs } = setup();
  await s.tick(); // enter → nextDueAt = now + 60s
  nowMs.v += 60000;
  await s.tick(); // heartbeat due
  assert.equal(s.heartbeatCount, 1);
  assert.equal(s.session.seqId, 1);
  assert.deepEqual(client.calls.map((c) => c.m).slice(-1), ["liveTraceHeartbeat"]);
});

test("heartbeat uses returned heartbeatInterval to reschedule", async () => {
  const { s, nowMs } = setup({ enterSession: makeSession({ heartbeatInterval: 30 }) });
  await s.tick();
  assert.equal(s.nextDueAt, nowMs.v + 30 * 1000);
});

test("tick before nextDueAt is a no-op", async () => {
  const { s, client, nowMs } = setup();
  await s.tick();
  const callsBefore = client.calls.length;
  nowMs.v += 1000;
  await s.tick();
  assert.equal(client.calls.length, callsBefore);
});

test("enter failure → waiting, reconnect delay, session cleared", async () => {
  const { s, client, nowMs } = setup();
  client.failEnter = true;
  await s.tick();
  assert.equal(s.state, "waiting");
  assert.equal(s.session, null);
  assert.equal(s.nextDueAt, nowMs.v + 8000);
  assert.match(s.lastError.message, /enter boom/);
});

test("heartbeat failure → waiting, reconnect delay", async () => {
  const { s, client, nowMs } = setup();
  await s.tick(); // enter
  nowMs.v += 60000;
  client.failHeartbeat = true;
  await s.tick(); // heartbeat fails
  assert.equal(s.state, "waiting");
  assert.equal(s.session, null);
  assert.equal(s.nextDueAt, nowMs.v + 8000);
});

test("waiting session re-enters after reconnect delay", async () => {
  const { s, client, nowMs } = setup();
  client.failEnter = true;
  await s.tick();
  assert.equal(s.state, "waiting");
  client.failEnter = false;
  nowMs.v += 8000;
  await s.tick();
  assert.equal(s.state, "running");
  assert.equal(s.session.roomId, 22743115);
});

test("stop makes tick a no-op", async () => {
  const { s, client } = setup();
  s.stop();
  await s.tick();
  assert.equal(client.calls.length, 0);
  assert.equal(s.state, "idle");
});
