import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTaskId,
  parseMissionRewardInfo,
  buildRewardReceiveBody,
  skippedRewardClaimResult,
  rewardClaimResultFromPayload,
  failedRewardClaimResult,
  MISSION_RETRY_DELAYS,
} from "../lib/rewards.js";
import { loadVectors } from "./helpers.mjs";

const rv = loadVectors().rewards;

test("MISSION_RETRY_DELAYS matches Python constant", () => {
  assert.deepEqual(MISSION_RETRY_DELAYS, [0, 1.5, 3.0]);
});

test("normalizeTaskId trims; empty throws", () => {
  assert.equal(normalizeTaskId("  abc  "), "abc");
  assert.throws(() => normalizeTaskId(""), /task_id 不能为空/);
  assert.throws(() => normalizeTaskId("   "), /task_id 不能为空/);
});

test("parseMissionRewardInfo matches Python (incl. missing-field fallback + error code)", () => {
  for (const c of rv.parse_mission_reward_info) {
    if (c.error) {
      assert.throws(
        () => parseMissionRewardInfo(c.payload, c.normalized_id),
        /查询领奖信息失败/,
        `should throw: ${c.note}`,
      );
    } else {
      assert.deepEqual(
        parseMissionRewardInfo(c.payload, c.normalized_id),
        c.expected,
        `note=${c.note}`,
      );
    }
  }
});

test("skippedRewardClaimResult: claimed→skip+success, not-claimable→skip+fail, claimable→null", () => {
  for (const c of rv.skipped_reward_claim_result) {
    const info = {
      taskId: "t1",
      taskName: "n",
      status: c.status,
      message: "",
      rewardName: "r",
      isClaimable: c.status === 0,
      isClaimed: c.status === 6,
    };
    const got = skippedRewardClaimResult(info);
    assert.deepEqual(got, c.expected, `status=${c.status} (${c.note})`);
  }
});

test("rewardClaimResultFromPayload matches Python (success msg default + fail)", () => {
  for (const c of rv.reward_claim_result_from_payload) {
    const got = rewardClaimResultFromPayload(c.info, c.payload);
    assert.deepEqual(got, c.expected, `note=${c.note}`);
  }
});

test("buildRewardReceiveBody matches Python structure (snake_case form body)", () => {
  const c = rv.build_reward_receive_body;
  const got = buildRewardReceiveBody(c.info, c.csrf);
  assert.deepEqual(got, c.expected);
});

test("failedRewardClaimResult carries exception message + code null", () => {
  const c = rv.failed_reward_claim_result;
  const got = failedRewardClaimResult(c.task_id, new Error("network down"));
  assert.deepEqual(got, c.expected);
});
