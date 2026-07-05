import { test } from "node:test";
import assert from "node:assert/strict";

import { extractRoomIdFromLiveUrl } from "../lib/url-parsing.js";

test("extractRoomIdFromLiveUrl: full live url", () => {
  assert.equal(extractRoomIdFromLiveUrl("https://live.bilibili.com/22743115"), 22743115);
});

test("extractRoomIdFromLiveUrl: blanc lite url", () => {
  assert.equal(
    extractRoomIdFromLiveUrl("https://live.bilibili.com/blanc/22743115?liteVersion=true"),
    22743115,
  );
});

test("extractRoomIdFromLiveUrl: bare host without scheme", () => {
  assert.equal(extractRoomIdFromLiveUrl("live.bilibili.com/999"), 999);
});

test("extractRoomIdFromLiveUrl: embedded in surrounding text", () => {
  assert.equal(extractRoomIdFromLiveUrl("随便 live.bilibili.com/123 继续"), 123);
});

test("extractRoomIdFromLiveUrl: non-live url → null", () => {
  assert.equal(extractRoomIdFromLiveUrl("https://www.bilibili.com/"), null);
  assert.equal(extractRoomIdFromLiveUrl("https://api.bilibili.com/x"), null);
});

test("extractRoomIdFromLiveUrl: empty / 0 id → null", () => {
  assert.equal(extractRoomIdFromLiveUrl(""), null);
  assert.equal(extractRoomIdFromLiveUrl("https://live.bilibili.com/0"), null);
});

test("extractRoomIdFromLiveUrl: prefers blanc over plain when both patterns could match", () => {
  // blanc 路径优先于 plain：同一串里 blanc 匹配胜出
  assert.equal(
    extractRoomIdFromLiveUrl("https://live.bilibili.com/blanc/5566"),
    5566,
  );
});
