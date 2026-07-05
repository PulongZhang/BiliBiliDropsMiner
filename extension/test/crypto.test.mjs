import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hmacByRule,
  hmacOnce,
  bytesToHex,
  hexToBytes,
  utf8Encode,
} from "../lib/crypto.js";
import { loadVectors } from "./helpers.mjs";

const vectors = loadVectors();

test("hmacOnce matches Python for every single digest rule (0-5)", async () => {
  for (const v of vectors.hmac.filter((h) => !h.multiround)) {
    const out = await hmacOnce(hexToBytes(v.data_hex), v.key, v.rule);
    assert.equal(bytesToHex(out), v.expected_hex, `rule=${v.rule}`);
  }
});

test("hmacByRule iterates multi-round rules like Python", async () => {
  for (const v of vectors.hmac.filter((h) => h.multiround)) {
    const out = await hmacByRule(hexToBytes(v.data_hex), v.key, v.rule);
    assert.equal(
      bytesToHex(out),
      v.expected_hex,
      `rule=${JSON.stringify(v.rule)}`,
    );
  }
});

test("hmacByRule treats a single rule number as a one-element list", async () => {
  const v = vectors.hmac[0]; // rule 0 (MD5)
  const out = await hmacByRule(hexToBytes(v.data_hex), v.key, v.rule);
  assert.equal(bytesToHex(out), v.expected_hex);
});

test("bytesToHex ∘ hexToBytes round-trips arbitrary bytes", () => {
  const bytes = utf8Encode("abc中文\x00\xff");
  const restored = hexToBytes(bytesToHex(bytes));
  assert.equal(restored.length, bytes.length);
  assert.deepEqual(Array.from(restored), Array.from(bytes));
});
