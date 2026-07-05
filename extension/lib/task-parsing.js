// 任务进度/指标解析的叶子工具（对应 client_parts/task_parsing.py）。
// 全部纯函数，与 Python 逐例对拍（见 fixtures/vectors.json#task_parsing）。

const WATCH_TYPES = new Set([
  "watch_time",
  "watch",
  "live_watch",
  "duration",
  "live_time",
]);

const TYPE_KEYS = ["type", "indicator_type", "indicator_id"];
const CUR_KEYS = ["cur_value", "cur", "current", "progress"];
const LIMIT_KEYS = ["limit", "target", "total", "max", "max_value"];

/** 对应 first_present_value：按 keys 顺序取第一个非 null/undefined/"" 的值。 */
export function firstPresentValue(mapping, keys) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return null;
  }
  for (const key of keys) {
    const value = mapping[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

/** 对应 coerce_task_number：字符串宽松解析，整数字符串返回整数，否则浮点；非法返回 0。 */
export function coerceTaskNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  // Python 中 bool 是 int 子类，原样返回（任务载荷实际不会出现，但保持对拍一致）
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (!text) return 0;
  const num = Number(text);
  if (!Number.isFinite(num)) return 0;
  return Number.isInteger(num) ? num : num;
}

/** 对应 coerce_task_int：先 number 化再取整。 */
export function coerceTaskInt(value) {
  const num = Number(coerceTaskNumber(value));
  if (!Number.isFinite(num)) return 0;
  return Math.trunc(num);
}

/** 对应 normalize_progress_candidates：dict → [dict]，list → 过滤 dict 项，其余 → []。 */
export function normalizeProgressCandidates(values) {
  if (values && typeof values === "object" && !Array.isArray(values)) return [values];
  if (Array.isArray(values)) return values.filter((x) => x && typeof x === "object" && !Array.isArray(x));
  return [];
}

/** 对应 normalize_checkpoint_candidates：list / 嵌套键 / 裸 dict 三种形态归一为 list。 */
export function normalizeCheckpointCandidates(values) {
  if (Array.isArray(values)) {
    return values.filter((x) => x && typeof x === "object" && !Array.isArray(x));
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  for (const key of ["check_points", "checkpoints", "items", "nodes"]) {
    const nested = values[key];
    if (Array.isArray(nested)) {
      return nested.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    }
  }
  return [values];
}

/**
 * 对应 extract_task_indicator_values：watch_type 指标优先（limit 最大者，>= 即覆盖）；
 * 无 watch_type 时取 limit 最大的非观看指标；空输入返回 [0, 0]。
 */
export function extractTaskIndicatorValues(indicators) {
  const candidates = normalizeProgressCandidates(indicators);
  if (candidates.length === 0) return [0, 0];

  let bestCur = 0;
  let bestLimit = 0;
  let watchCur = 0;
  let watchLimit = 0;

  for (const indicator of candidates) {
    const indicatorType = String(
      firstPresentValue(indicator, TYPE_KEYS) || "",
    ).toLowerCase();
    const curValue = coerceTaskNumber(firstPresentValue(indicator, CUR_KEYS));
    const limitValue = coerceTaskNumber(firstPresentValue(indicator, LIMIT_KEYS));
    if (WATCH_TYPES.has(indicatorType)) {
      if (limitValue >= watchLimit) {
        watchCur = curValue;
        watchLimit = limitValue;
      }
    } else if (limitValue >= bestLimit) {
      bestCur = curValue;
      bestLimit = limitValue;
    }
  }

  if (watchLimit > 0) return [watchCur, watchLimit];
  return [bestCur, bestLimit];
}

/** 对应 extract_checkpoint_progress_values：优先 list/indicators/indicator 子键。 */
export function extractCheckpointProgressValues(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return [0, 0];
  }
  for (const key of ["list", "indicators", "indicator"]) {
    const [cur, limit] = extractTaskIndicatorValues(checkpoint[key]);
    if (limit > 0) return [cur, limit];
  }
  const cur = coerceTaskNumber(firstPresentValue(checkpoint, CUR_KEYS));
  const limit = coerceTaskNumber(firstPresentValue(checkpoint, LIMIT_KEYS));
  return [cur, limit];
}
