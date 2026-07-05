import { test } from "node:test";
import assert from "node:assert/strict";

import { decideWatchdogAction, badgeFromStatus } from "../lib/watchdog.js";

// status 形状（与 offscreen.js status() 对齐）：
//   active: 引擎是否运行；total: 会话数；running: 处于 running 态的会话数；
//   waiting: 处于 waiting 态的会话数。active 与 running 不同义，避免 spread 时互相覆盖。

test("badgeFromStatus: null / not active → blank gray", () => {
  assert.deepEqual(badgeFromStatus(null), { text: "", color: "#888888" });
  assert.deepEqual(badgeFromStatus({ active: false }), { text: "", color: "#888888" });
});

test("badgeFromStatus: green with total count when all sessions running", () => {
  assert.deepEqual(
    badgeFromStatus({ active: true, total: 100, running: 100, waiting: 0 }),
    { text: "100", color: "#2e8b57" },
  );
});

test("badgeFromStatus: red when no session running but engine active", () => {
  assert.deepEqual(
    badgeFromStatus({ active: true, total: 100, running: 0, waiting: 100 }),
    { text: "0", color: "#c0392b" },
  );
});

test("badgeFromStatus: yellow with running count when partial", () => {
  assert.deepEqual(
    badgeFromStatus({ active: true, total: 100, running: 98, waiting: 2 }),
    { text: "98", color: "#d9a300" },
  );
});

test("badgeFromStatus: engine active but total 0 → ON green", () => {
  assert.deepEqual(badgeFromStatus({ active: true, total: 0 }), {
    text: "ON",
    color: "#2e8b57",
  });
});

test("decideWatchdogAction: no config → idle + blank badge", () => {
  const d = decideWatchdogAction({ config: null, offscreenAlive: false });
  assert.equal(d.action, "idle");
  assert.equal(d.badge.text, "");
});

test("decideWatchdogAction: config inactive → idle", () => {
  const d = decideWatchdogAction({
    config: { roomId: 1, threadCount: 5, active: false },
    offscreenAlive: true,
  });
  assert.equal(d.action, "idle");
});

test("decideWatchdogAction: active config but offscreen dead → recreate + RST", () => {
  const d = decideWatchdogAction({
    config: { roomId: 1, threadCount: 5, active: true },
    offscreenAlive: false,
    status: null,
  });
  assert.equal(d.action, "recreate");
  assert.equal(d.badge.text, "RST");
});

test("decideWatchdogAction: active + alive → none + status-derived badge", () => {
  const d = decideWatchdogAction({
    config: { roomId: 1, threadCount: 100, active: true },
    offscreenAlive: true,
    status: { active: true, total: 100, running: 97, waiting: 3 },
  });
  assert.equal(d.action, "none");
  assert.equal(d.badge.text, "97");
  assert.equal(d.badge.color, "#d9a300");
});
