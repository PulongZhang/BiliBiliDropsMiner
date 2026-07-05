import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTaskIdsFromInitialState } from "../lib/initial-state.js";
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
