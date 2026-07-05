import { test } from "node:test";
import assert from "node:assert/strict";

import { getMixinKey, encodeQuery, signWbiParams, parseWbiKeysFromNav } from "../lib/wbi.js";
import { loadVectors } from "./helpers.mjs";

const vectors = loadVectors();

test("getMixinKey matches Python's ENC_TAB scramble", () => {
  for (const v of vectors.mixin_key.filter((c) => !c.error)) {
    assert.equal(
      getMixinKey(v.img_key, v.sub_key),
      v.expected,
      `${v.img_key}|${v.sub_key}`,
    );
  }
});

test("encodeQuery matches Python: strip !'()* then percent-encode", () => {
  for (const v of vectors.wbi) {
    // 重建 Python 侧的排序后输入（含 wts），逐键比对
    const withWts = { ...v.params, wts: v.wts };
    const sorted = Object.keys(withWts)
      .sort()
      .reduce((acc, k) => ((acc[k] = withWts[k]), acc), {});
    assert.equal(
      encodeQuery(sorted),
      v.expected_query,
      JSON.stringify(v.params),
    );
  }
});

test("signWbiParams produces Python-identical w_rid", () => {
  for (const v of vectors.wbi) {
    const signed = signWbiParams(v.params, {
      imgKey: v.img_key,
      subKey: v.sub_key,
      timestamp: v.wts,
    });
    assert.equal(signed.w_rid, v.expected_w_rid, JSON.stringify(v.params));
    assert.equal(signed.wts, v.wts);
  }
});

test("parseWbiKeysFromNav extracts img/sub key from nav wbi_img urls", () => {
  for (const v of vectors.wbi_keys) {
    assert.deepEqual(parseWbiKeysFromNav(v.payload), v.expected);
  }
});

test("parseWbiKeysFromNav throws when wbi_img missing", () => {
  assert.throws(() => parseWbiKeysFromNav({ code: 0, data: {} }));
});
