// x25Kn 签名 / 紧凑 JSON（对应 Python live_trace.py 的 compact_json + build_x25kn_signature）。

import { hmacByRule, utf8Encode, utf8Decode } from "./crypto.js";

/**
 * 等价 Python json.dumps(value, separators=(",", ":"), ensure_ascii=False)。
 * 直接用 JSON.stringify：紧凑、保留 unicode 原字、控制字符转义一致。
 * 仅用于「非整数索引键」的对象 / 数组 / 基元（签名 payload 都符合）。
 */
export function compactJson(value) {
  return JSON.stringify(value);
}

/**
 * 构造 x25Kn 心跳签名（对应 build_x25kn_signature）。
 * payload 字段顺序必须与 Python 字面量一致 —— JS 对字符串键保持插入顺序，
 * 故按 Python 顺序构造即可逐字节对齐。
 */
export async function buildX25knSignature({
  liveBuvid,
  liveUuid,
  parentAreaId,
  areaId,
  seqId,
  roomId,
  ets,
  duration,
  tsMs,
  secretKey,
  secretRule,
}) {
  const payload = {
    platform: "web",
    parent_id: parentAreaId,
    area_id: areaId,
    seq_id: seqId,
    room_id: roomId,
    buvid: liveBuvid,
    uuid: liveUuid,
    ets: ets,
    time: duration,
    ts: tsMs,
  };
  let current = utf8Encode(compactJson(payload));
  current = await hmacByRule(current, secretKey, secretRule);
  return utf8Decode(current);
}

// ---- 进出 / 心跳 参数构造与 payload 解析（对应 live_trace.py）----

function intOr(value, fallback) {
  // 对齐 Python `int(data.get(x) or fallback)`：
  // null/undefined/""/0 均视作 falsy → fallback，再 parseInt。
  const truthy = value !== null && value !== undefined && value !== "" && value !== 0;
  const n = parseInt(truthy ? value : fallback, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 构造 x25Kn/E 进直播间的请求参数（对应 build_live_trace_enter_params）。 */
export function buildEnterParams(room, { liveBuvid, liveUuid, userAgent, csrf, tsMs }) {
  return {
    id: compactJson([room.parentAreaId, room.areaId, 0, room.roomId]),
    device: compactJson([liveBuvid, liveUuid]),
    ruid: room.ruid,
    ts: tsMs,
    is_patch: 0,
    heart_beat: "[]",
    ua: userAgent,
    web_location: "444.8",
    csrf,
  };
}

/** 解析 x25Kn/E 响应，构造会话状态（对应 live_trace_session_from_enter_payload）。 */
export function parseEnterPayload(payload, room) {
  const data = payload.data || {};
  let heartbeatInterval = intOr(data.heartbeat_interval, 60);
  const ets = intOr(data.timestamp, 0);
  const secretKey = String(data.secret_key || "");
  const secretRule = (data.secret_rule || []).map((x) => parseInt(x, 10));

  if (!secretKey || secretRule.length === 0) {
    throw new Error(`x25Kn/E 返回缺少签名参数 room_id=${room.roomId}`);
  }
  if (heartbeatInterval <= 0 || !Number.isFinite(heartbeatInterval)) {
    heartbeatInterval = 60;
  }
  if (ets <= 0) {
    throw new Error(`x25Kn/E timestamp 无效 room_id=${room.roomId}`);
  }

  return {
    roomId: room.roomId,
    ruid: room.ruid,
    parentAreaId: room.parentAreaId,
    areaId: room.areaId,
    seqId: 0,
    ets,
    heartbeatInterval,
    secretKey,
    secretRule,
  };
}

/** 构造 x25Kn/X 心跳请求参数（对应 build_live_trace_heartbeat_params）。 */
export function buildHeartbeatParams(
  session,
  { liveBuvid, liveUuid, userAgent, csrf, signature, nextSeq, duration, tsMs },
) {
  return {
    s: signature,
    id: compactJson([session.parentAreaId, session.areaId, nextSeq, session.roomId]),
    device: compactJson([liveBuvid, liveUuid]),
    ruid: session.ruid,
    ets: session.ets,
    benchmark: session.secretKey,
    time: duration,
    ts: tsMs,
    trackid: -99998,
    ua: userAgent,
    web_location: "444.8",
    csrf,
  };
}

/** 应用 x25Kn/X 响应到会话（更新 ets/secret/seq，对应 apply_live_trace_heartbeat_payload）。 */
export function applyHeartbeatPayload(session, payload, nextSeq) {
  const data = payload.data || {};
  let heartbeatInterval = intOr(
    data.heartbeat_interval,
    intOr(session.heartbeatInterval, 60),
  );
  if (heartbeatInterval <= 0 || !Number.isFinite(heartbeatInterval)) {
    heartbeatInterval = 60;
  }

  session.seqId = nextSeq;
  session.ets = intOr(data.timestamp, session.ets);
  session.heartbeatInterval = heartbeatInterval;

  const nextSecretKey = String(data.secret_key || "").trim();
  const nextSecretRuleRaw = data.secret_rule;
  if (nextSecretKey) session.secretKey = nextSecretKey;
  if (Array.isArray(nextSecretRuleRaw) && nextSecretRuleRaw.length > 0) {
    session.secretRule = nextSecretRuleRaw.map((x) => parseInt(x, 10));
  }
  return session;
}
