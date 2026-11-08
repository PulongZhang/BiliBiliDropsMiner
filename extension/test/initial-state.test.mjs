import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTaskIdsFromInitialState, extractTaskIdsFromPageData, extractTaskIdsFromHtml } from "../lib/initial-state.js";
import { loadVectors } from "./helpers.mjs";

const cases = loadVectors().initial_state;

test("extractTaskIdsFromInitialState matches Python over varied __initialState shapes", () => {
  for (const c of cases) {
    assert.deepEqual(
      extractTaskIdsFromInitialState(c.state),
      c.expected,
      `name=${c.name}`,
    );
  }
});

test("extractTaskIdsFromInitialState: non-object state → []", () => {
  assert.deepEqual(extractTaskIdsFromInitialState(null), []);
  assert.deepEqual(extractTaskIdsFromInitialState(undefined), []);
  assert.deepEqual(extractTaskIdsFromInitialState("string"), []);
  assert.deepEqual(extractTaskIdsFromInitialState([1, 2]), []);
});

const component = (tasks, extra = {}) => ({
  type: "Component", name: "EraTasklistPc", props: { tasklist: tasks.map((taskId) => ({ taskId })) }, ...extra,
});

test("task discovery: flat and nested EVA trees collect all tasks once", () => {
  const pageData = { layerTree: [
    component(["a", "b"]),
    { type: "Component", name: "EvaTabs", slots: [{ children: [
      { children: [component(["b", "c"])] },
    ] }] },
  ] };
  assert.deepEqual(extractTaskIdsFromPageData(pageData), ["a", "b", "c"]);
  assert.deepEqual(extractTaskIdsFromPageData(null), []);
});

test("static HTML: accepts whitespace variants and braces inside JSON strings without executing scripts", () => {
  const html = `<script>window.__BILIACT_EVAPAGEDATA__= ${JSON.stringify({
    layerTree: component(["x"], { props: { label: 'a } \\" { b', tasklist: [{ taskId: "x" }] } }),
  })}; throw new Error("must never execute");</script>`;
  assert.deepEqual(extractTaskIdsFromHtml(html), ["x"]);
  assert.deepEqual(extractTaskIdsFromHtml('<script>window.__initialState = {"EraTasklistPc":[{"tasklist":[{"taskId":"old"}]}]};</script>'), ["old"]);
  assert.deepEqual(extractTaskIdsFromHtml('window.__BILIACT_EVAPAGEDATA__ = {bad}; window.__initialState={"EraTasklistPc":[{"tasklist":[{"taskId":"fallback"}]}]}'), ["fallback"]);
  assert.deepEqual(extractTaskIdsFromHtml("<html>no activity</html>"), []);
});
