import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpClient, isRateLimited } from "../lib/http.js";

// 注入式 fetch：按脚本依次返回预设响应（或抛网络异常）。
function makeFakeFetch(script) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.throw) throw new TypeError("network error: " + step.throw);
    return {
      ok: step.ok !== false,
      status: step.status ?? 200,
      async json() {
        return step.payload;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const fixedKeys = {
  imgKey: "7cd93e4b9c0b7f6a8d2e5c1f4a6b8c0d",
  subKey: "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
};

function makeClient(script) {
  return new HttpClient({
    fetchImpl: makeFakeFetch(script),
    wbiKeysProvider: async () => fixedKeys,
    sleep: async () => {}, // 测试中不真等
  });
}

test("signedGetJson signs params (wts + w_rid) and returns code==0 payload", async () => {
  const client = makeClient([{ payload: { code: 0, data: { ok: 1 } } }]);
  const payload = await client.signedGetJson("https://x/api", {
    foo: "bar",
    web_location: "444.8",
  });
  assert.deepEqual(payload, { code: 0, data: { ok: 1 } });
  const url = client.fetch.calls[0].url;
  assert.match(url, /wts=\d+/);
  assert.match(url, /w_rid=[0-9a-f]{32}/);
  assert.match(url, /foo=bar/);
});

test("signedGetJson retries once on wbi miss (non-zero code) then clears cache", async () => {
  let providerCalls = 0;
  const client = new HttpClient({
    fetchImpl: makeFakeFetch([
      { payload: { code: -403, message: "wbi sign error" } },
      { payload: { code: 0, data: {} } },
    ]),
    wbiKeysProvider: async () => {
      providerCalls++;
      return fixedKeys;
    },
    sleep: async () => {},
  });
  const payload = await client.signedGetJson("https://x/api", { k: 1 });
  assert.equal(payload.code, 0);
  assert.equal(client.fetch.calls.length, 2, "should retry once");
  assert.equal(providerCalls, 2, "should re-fetch keys after wbi cache clear");
});

test("signedGetJson returns last payload when retries exhausted", async () => {
  const client = makeClient([
    { payload: { code: -403, message: "wbi sign error" } },
    { payload: { code: -403, message: "wbi sign error" } },
  ]);
  const payload = await client.signedGetJson("https://x/api", { k: 1 });
  assert.equal(payload.code, -403);
  assert.equal(client.fetch.calls.length, 2);
});

test("transient network error is retried with backoff then succeeds", async () => {
  const client = new HttpClient({
    fetchImpl: makeFakeFetch([
      { throw: "ETIMEDOUT 1" },
      { throw: "ETIMEDOUT 2" },
      { payload: { code: 0, data: {} } },
    ]),
    wbiKeysProvider: async () => fixedKeys,
    sleep: async () => {},
  });
  const payload = await client.signedGetJson("https://x/api", { k: 1 });
  assert.equal(payload.code, 0);
  assert.equal(client.fetch.calls.length, 3);
});

test("retryOnWbiMiss=false does not retry on non-zero code", async () => {
  const client = makeClient([{ payload: { code: -403 } }]);
  const payload = await client.signedGetJson(
    "https://x/api",
    { k: 1 },
    { retryOnWbiMiss: false },
  );
  assert.equal(payload.code, -403);
  assert.equal(client.fetch.calls.length, 1);
});

test("isRateLimited detects -702 / -509 / 频率 / 频繁", () => {
  assert.equal(isRateLimited({ code: -702 }), true);
  assert.equal(isRateLimited({ code: -509 }), true);
  assert.equal(isRateLimited({ code: 0, message: "操作过于频繁" }), true);
  assert.equal(isRateLimited({ code: -101, message: "请求频率超限" }), true);
  assert.equal(isRateLimited({ code: 0, message: "ok" }), false);
  assert.equal(isRateLimited({}), false);
});
