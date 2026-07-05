import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTaskIds,
  parseTaskCheckpoints,
  parseTaskProgressPayload,
} from "../lib/tasks.js";
import { loadVectors } from "./helpers.mjs";

const tasksVectors = loadVectors().tasks;

test("parseTaskProgressPayload matches Python for all totalv2 shapes", () => {
  for (const c of tasksVectors) {
    if (c.error) {
      assert.throws(
        () => parseTaskProgressPayload(c.payload),
        /查询任务进度失败/,
        `should throw: ${c.note}`,
      );
    } else {
      assert.deepEqual(
        parseTaskProgressPayload(c.payload),
        c.expected,
        `note=${c.note}`,
      );
    }
  }
});

test("parseTaskProgressPayload throws on missing payload", () => {
  assert.throws(() => parseTaskProgressPayload(null), /查询任务进度失败/);
});

test("normalizeTaskIds trims and drops empties", () => {
  assert.deepEqual(normalizeTaskIds(["  a  ", "", "b", "   "]), ["a", "b"]);
  assert.deepEqual(normalizeTaskIds(null), []);
  assert.deepEqual(normalizeTaskIds([123, " 456 "]), ["123", "456"]);
});

test("parseTaskCheckpoints on empty input returns []", () => {
  assert.deepEqual(parseTaskCheckpoints(null), []);
  assert.deepEqual(parseTaskCheckpoints([]), []);
});
