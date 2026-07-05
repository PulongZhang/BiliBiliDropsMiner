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
