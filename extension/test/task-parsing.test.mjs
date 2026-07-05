import { test } from "node:test";
import assert from "node:assert/strict";

import {
  firstPresentValue,
  coerceTaskNumber,
  coerceTaskInt,
  normalizeProgressCandidates,
  normalizeCheckpointCandidates,
  extractTaskIndicatorValues,
  extractCheckpointProgressValues,
} from "../lib/task-parsing.js";
import { loadVectors } from "./helpers.mjs";

const v = loadVectors().task_parsing;

test("coerceTaskNumber matches Python (null/str/int/float/bool/illegal)", () => {
  for (const c of v.coerce_task_number) {
    assert.deepEqual(coerceTaskNumber(c.input), c.expected, `input=${JSON.stringify(c.input)}`);
  }
});

test("coerceTaskInt matches Python (truncation + fallback)", () => {
  for (const c of v.coerce_task_int) {
    assert.equal(coerceTaskInt(c.input), c.expected, `input=${JSON.stringify(c.input)}`);
  }
});

test("firstPresentValue: first non-empty wins; 0 is present; empty string is absent", () => {
  for (const c of v.first_present_value) {
    assert.deepEqual(
      firstPresentValue(c.mapping, c.keys),
      c.expected,
      JSON.stringify(c),
    );
  }
});

test("extractTaskIndicatorValues: watch_type priority, >= overwrite, no-watch max limit", () => {
  for (const c of v.extract_task_indicator_values) {
    assert.deepEqual(
      extractTaskIndicatorValues(c.indicators),
      c.expected,
      JSON.stringify(c.indicators),
    );
  }
});

test("extractCheckpointProgressValues: nested list/indicators then direct cur/limit", () => {
  for (const c of v.extract_checkpoint_progress_values) {
    assert.deepEqual(
      extractCheckpointProgressValues(c.checkpoint),
      c.expected,
      JSON.stringify(c.checkpoint),
    );
  }
});

test("normalizeCheckpointCandidates: list / nested-key / bare-dict / null", () => {
  for (const c of v.normalize_checkpoint_candidates) {
    assert.deepEqual(
      normalizeCheckpointCandidates(c.values),
      c.expected,
      JSON.stringify(c.values),
    );
  }
});

test("normalizeProgressCandidates: dict wraps, list filters, scalar empties", () => {
  assert.deepEqual(normalizeProgressCandidates({a: 1}), [{a: 1}]);
  assert.deepEqual(normalizeProgressCandidates([{a: 1}, "x", {b: 2}]), [{a: 1}, {b: 2}]);
  assert.deepEqual(normalizeProgressCandidates(null), []);
  assert.deepEqual(normalizeProgressCandidates("str"), []);
});
