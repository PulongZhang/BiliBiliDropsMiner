import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccount, accountStopReason } from "../lib/account.js";

const nav = (payload) => async () => ({ ok: true, json: async () => payload });

test("account: distinguishes logged out, valid account and transient failures", async () => {
  assert.equal((await checkAccount(nav({ code: -101 }))).kind, "invalid");
  assert.equal((await checkAccount(nav({ code: 0, data: { isLogin: false } }))).kind, "invalid");
  const valid = await checkAccount(nav({ code: 0, data: { isLogin: true, mid: 42, uname: "用户" } }));
  assert.deepEqual(valid, { kind: "valid", uid: 42, uname: "用户" });
  assert.equal((await checkAccount(nav({ code: -509 }))).kind, "error");
  assert.equal((await checkAccount(async () => { throw new Error("secret cookie"); })).kind, "error");
  assert.equal(JSON.stringify(await checkAccount(async () => { throw new Error("secret cookie"); })).includes("secret"), false);
});

test("account: invalid payload and missing UID are errors; confirmed logout or UID change stops", async () => {
  for (const payload of [null, {}, { code: 0 }, { code: 0, data: { isLogin: true, mid: 0 } }]) {
    assert.equal((await checkAccount(nav(payload))).kind, "error");
  }
  assert.equal(accountStopReason({ kind: "valid", uid: 42 }, 42), "");
  assert.equal(accountStopReason({ kind: "error" }, 42), "");
  assert.match(accountStopReason({ kind: "invalid" }, 42), /失效/);
  assert.match(accountStopReason({ kind: "valid", uid: 43 }, 42), /账号.*变化/);
});
