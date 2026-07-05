// 任务进度解析（对应 client_parts/tasks.py + models.TaskProgress/TaskCheckpointProgress）。
// 输出纯对象（camelCase），isCompleted 在解析时计算并固化为字段。

import {
  firstPresentValue,
  coerceTaskInt,
  coerceTaskNumber,
  extractCheckpointProgressValues,
  extractTaskIndicatorValues,
  normalizeCheckpointCandidates,
} from "./task-parsing.js";

/** 对应 normalize_task_ids：trim + 过滤空串。 */
export function normalizeTaskIds(taskIds) {
  return (taskIds || [])
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);
}

/**
 * 对应 TaskProgress.is_completed / TaskCheckpointProgress.is_completed：
 * limit>0 时看 cur>=limit，否则仅信任明确终态 status∈{3,6}。
 */
function isCompleted(curValue, limitValue, status) {
  const limit = Number(limitValue);
  const cur = Number(curValue);
  if (Number.isFinite(limit) && Number.isFinite(cur) && limit > 0) {
    return cur >= limit;
  }
  return status === 3 || status === 6;
}

/** 对应 parse_task_checkpoints。 */
export function parseTaskCheckpoints(checkPoints) {
  const checkpoints = [];
  for (const item of normalizeCheckpointCandidates(checkPoints)) {
    const sid = String(
      firstPresentValue(item, ["sid", "task_id", "id", "checkpoint_id"]) || "",
    );
    const alias = String(
      firstPresentValue(item, ["alias", "task_name", "name", "title"]) || sid,
    );
    const status = coerceTaskInt(
      firstPresentValue(item, ["status", "task_status"]),
    );
    const [curValue, limitValue] = extractCheckpointProgressValues(item);
    const awardName = String(
      firstPresentValue(item, ["award_name", "reward_name"]) || "",
    );
    const awardCount = coerceTaskNumber(
      firstPresentValue(item, ["count", "award_count", "num"]),
    );
    checkpoints.push({
      sid,
      alias,
      status,
      curValue,
      limitValue,
      awardName,
      awardCount,
      isCompleted: isCompleted(curValue, limitValue, status),
    });
  }
  return checkpoints;
}

/** 对应 parse_task_progress_payload：totalv2 响应 → TaskProgress[]。 */
export function parseTaskProgressPayload(payload) {
  if (!payload || payload.code !== 0) {
    throw new Error(`查询任务进度失败: ${payload?.message ?? ""}`);
  }

  const data = payload.data;
  let taskList;
  if (Array.isArray(data)) {
    taskList = data;
  } else if (data && typeof data === "object") {
    taskList = data.list || data.tasks || [];
  } else {
    taskList = [];
  }

  const progresses = [];
  for (const item of taskList) {
    if (!item || typeof item !== "object") continue;

    const taskId = String(
      firstPresentValue(item, ["task_id", "sid", "id"]) || "",
    );
    const taskName = String(
      firstPresentValue(item, ["task_name", "name", "title", "alias"]) || taskId,
    );
    const status = coerceTaskInt(
      firstPresentValue(item, ["task_status", "status"]),
    );
    let [curValue, limitValue] = extractTaskIndicatorValues(item.indicators);
    let checkPoints = parseTaskCheckpoints(item.check_points);
    if (checkPoints.length === 0) {
      checkPoints = parseTaskCheckpoints(item.accumulative_check_points);
    }
    if (limitValue <= 0) {
      limitValue = coerceTaskNumber(
        firstPresentValue(item, ["limit", "target", "total"]),
      );
    }
    if (curValue <= 0) {
      curValue = coerceTaskNumber(
        firstPresentValue(item, ["cur_value", "cur", "progress"]),
      );
    }
    if (limitValue <= 0 && checkPoints.length > 0) {
      // Python max(key=...) 在并列时取首个 → 用严格 > 保留首个
      let best = checkPoints[0];
      for (const cp of checkPoints) {
        if (cp.limitValue > best.limitValue) best = cp;
      }
      curValue = best.curValue;
      limitValue = best.limitValue;
    }

    progresses.push({
      taskId,
      taskName,
      status,
      curValue,
      limitValue,
      checkPoints,
      taskType: coerceTaskInt(item.task_type),
      statisticType: coerceTaskInt(item.statistic_type),
      periodType: coerceTaskInt(item.period_type),
      awardType: coerceTaskInt(item.award_type),
      canEdit: coerceTaskInt(item.can_edit),
      isNeedPolling: coerceTaskInt(item.is_need_polling),
      isCompleted: isCompleted(curValue, limitValue, status),
    });
  }
  return progresses;
}
