import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "../lib/session-manager.js";

// 轻量 fake：只暴露 SessionManager 依赖的 BiliSession 协议面
// （id/state/heartbeatCount/lastError/stopped/nextDueAt + start/tick/stop）。
// BiliSession 自身已由 session.test.mjs 覆盖。
function fakeSession({ id, state = "idle", heartbeatCount = 0, lastError = null }) {
  return {
    id,
    state,
    heartbeatCount,
    lastError,
    stopped: false,
    nextDueAt: Infinity,
    startCalls: 0,
    tickCalls: 0,
    start() {
      this.startCalls++;
      this.nextDueAt = 0;
    },
    async tick() {
      this.tickCalls++;
    },
    stop() {
      this.stopped = true;
    },
  };
}

test("start staggers nextDueAt by index * staggerMs (1s spread for N sessions)", () => {
  const nowMs = 100000;
  const sessions = [
    fakeSession({ id: "a" }),
    fakeSession({ id: "b" }),
    fakeSession({ id: "c" }),
  ];
  const mgr = new SessionManager({
    sessions,
    now: () => nowMs,
    staggerMs: 1000,
  });
  mgr.start();
  assert.equal(sessions[0].nextDueAt, 100000);
  assert.equal(sessions[1].nextDueAt, 101000);
  assert.equal(sessions[2].nextDueAt, 102000);
  for (const s of sessions) assert.equal(s.startCalls, 1);
});

test("default staggerMs is 1000ms", () => {
  const mgr = new SessionManager({ sessions: [] });
  assert.equal(mgr.staggerMs, 1000);
});

test("tick fans out to every session", async () => {
  const sessions = [fakeSession({ id: "a" }), fakeSession({ id: "b" })];
  const mgr = new SessionManager({ sessions });
  mgr.start();
  await mgr.tick();
  assert.equal(sessions[0].tickCalls, 1);
  assert.equal(sessions[1].tickCalls, 1);
});

test("tick is reentrancy-guarded: overlapping ticks do not run sessions concurrently", async () => {
  const sessions = [fakeSession({ id: "a" })];
  const mgr = new SessionManager({ sessions });
  mgr.start();
  let inside = false;
  let overlapped = false;
  sessions[0].tick = async () => {
    if (inside) overlapped = true;
    inside = true;
    await new Promise((r) => setTimeout(r, 20));
    inside = false;
  };
  const p1 = mgr.tick();
  const p2 = mgr.tick(); // 应被 _busy 守卫直接跳过
  await Promise.all([p1, p2]);
  assert.equal(overlapped, false);
});

test("stop stops all sessions", () => {
  const sessions = [fakeSession({ id: "a" }), fakeSession({ id: "b" })];
  const mgr = new SessionManager({ sessions });
  mgr.start();
  mgr.stop();
  assert.ok(sessions.every((s) => s.stopped));
});

test("status aggregates running/waiting/idle counts, heartbeats, and errors", () => {
  const sessions = [
    fakeSession({ id: "a", state: "running", heartbeatCount: 5 }),
    fakeSession({ id: "b", state: "running", heartbeatCount: 3 }),
    fakeSession({
      id: "c",
      state: "waiting",
      heartbeatCount: 0,
      lastError: new Error("net"),
    }),
    fakeSession({ id: "d", state: "idle", heartbeatCount: 0 }),
  ];
  const mgr = new SessionManager({ sessions });
  const st = mgr.status();
  assert.equal(st.total, 4);
  assert.equal(st.running, 2);
  assert.equal(st.waiting, 1);
  assert.equal(st.idle, 1);
  assert.equal(st.heartbeats, 8);
  assert.equal(st.errors.length, 1);
  assert.equal(st.errors[0].id, "c");
  assert.match(st.errors[0].error, /net/);
});
