// 领奖逻辑（对应 client_parts/rewards.py + models.MissionRewardInfo/MissionRewardClaimResult）。
// 输出纯对象（camelCase，字段顺序与 Python dataclass 一致）；HTTP body 保留 snake_case。

import { coerceTaskInt } from "./task-parsing.js";

/** 对应 rewards.MISSION_RETRY_DELAYS。 */
export const MISSION_RETRY_DELAYS = [0, 1.5, 3.0];

/** 对应 normalize_task_id：trim，空串抛错。 */
export function normalizeTaskId(taskId) {
  const normalized = String(taskId ?? "").trim();
  if (!normalized) throw new Error("task_id 不能为空");
  return normalized;
}

/** 构造 MissionRewardInfo 纯对象，isClaimable/isClaimed 固化为字段。 */
export function makeMissionRewardInfo({
  taskId,
  taskName,
  status,
  message,
  actId,
  actName,
  rewardName,
}) {
  const st = coerceTaskInt(status);
  return {
    taskId,
    taskName,
    status: st,
    message,
    actId,
    actName,
    rewardName,
    isClaimable: st === 0, // 对应 MissionRewardInfo.is_claimable
    isClaimed: st === 6, // 对应 MissionRewardInfo.is_claimed
  };
}

/** 对应 parse_mission_reward_info。 */
export function parseMissionRewardInfo(payload, normalizedId) {
  if (!payload || payload.code !== 0) {
    throw new Error(`查询领奖信息失败: ${payload?.message ?? ""}`);
  }
  const data = payload.data || {};
  const rewardInfo = data.reward_info || {};
  return makeMissionRewardInfo({
    taskId: String(data.task_id || normalizedId),
    taskName: String(data.task_name || normalizedId),
    status: coerceTaskInt(data.status || 0),
    message: String(data.message || ""),
    actId: String(data.act_id || ""),
    actName: String(data.act_name || ""),
    rewardName: String(rewardInfo.award_name || ""),
  });
}

/** 对应 build_reward_receive_body（HTTP form body，保留 snake_case）。 */
export function buildRewardReceiveBody(info, csrf) {
  return {
    task_id: info.taskId,
    activity_id: info.actId,
    activity_name: info.actName,
    task_name: info.taskName,
    reward_name: info.rewardName,
    gaia_vtoken: "",
    receive_from: "missionPage",
    csrf,
    csrf_token: csrf,
  };
}

/** 对应 skipped_reward_claim_result：已领取/不可领 → 跳过结果；可领 → null。 */
export function skippedRewardClaimResult(info) {
  if (info.isClaimed) {
    return {
      taskId: info.taskId,
      taskName: info.taskName,
      rewardName: info.rewardName,
      status: info.status,
      message: info.message || "已领取",
      success: true,
      skipped: true,
      code: null,
    };
  }
  if (!info.isClaimable) {
    return {
      taskId: info.taskId,
      taskName: info.taskName,
      rewardName: info.rewardName,
      status: info.status,
      message: info.message || "当前状态不可领取",
      success: false,
      skipped: true,
      code: null,
    };
  }
  return null;
}

/** 对应 reward_claim_result_from_payload。 */
export function rewardClaimResultFromPayload(info, payload) {
  const code = payload?.code;
  let message = String(payload?.message || "");
  if (code === 0) {
    if (!message || message === "0") message = "领取成功";
    return {
      taskId: info.taskId,
      taskName: info.taskName,
      rewardName: info.rewardName,
      status: 6,
      message,
      success: true,
      skipped: false,
      code,
    };
  }
  return {
    taskId: info.taskId,
    taskName: info.taskName,
    rewardName: info.rewardName,
    status: info.status,
    message: message || "领取失败",
    success: false,
    skipped: false,
    code,
  };
}

/** 对应 failed_reward_claim_result。 */
export function failedRewardClaimResult(taskId, err) {
  return {
    taskId,
    taskName: taskId,
    rewardName: "",
    status: -1,
    message: String(err?.message ?? err),
    success: false,
    skipped: false,
    code: null,
  };
}
