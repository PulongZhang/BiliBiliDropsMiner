// 高层 B 站客户端（对应 core.py 的 room_entry_action / live_trace_enter / live_trace_heartbeat）。
// 组合 HttpClient + 解析器 + live-trace 签名，向上暴露会话生命周期方法。
// 依赖注入 HttpClient（测试用 fake；生产用带 credentials:"include" 的真实 fetch）。

import { parseLiveRoomInfo } from "./live.js";
import {
  buildEnterParams,
  parseEnterPayload,
  buildHeartbeatParams,
  applyHeartbeatPayload,
  buildX25knSignature,
} from "./live-trace.js";

const ROOM_INFO_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom";
const ENTRY_ACTION_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction";
const X25KN_E_URL =
  "https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/E";
const X25KN_X_URL =
  "https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/X";

export class BiliClient {
  constructor({ http, userAgent }) {
    this.http = http;
    this.userAgent = userAgent;
  }

  /** 对应 get_live_room_info → parse_live_room_info。 */
  async getLiveRoomInfo(roomId) {
    const payload = await this.http.signedGetJson(
      ROOM_INFO_URL,
      { room_id: roomId, web_location: "444.8" },
      { headers: liveHeaders(roomId), retryOnWbiMiss: true },
    );
    return parseLiveRoomInfo(payload, roomId);
  }

  /** 对应 room_entry_action。 */
  async roomEntryAction(roomId, { csrf }) {
    const payload = await this.http.signedPostJson(
      ENTRY_ACTION_URL,
      { csrf },
      { room_id: roomId, platform: "pc" },
      { headers: liveHeaders(roomId), retryOnWbiMiss: true },
    );
    if (payload.code !== 0) {
      throw new Error(`roomEntryAction 失败 room_id=${roomId}: ${payload.message}`);
    }
  }

  /** 对应 live_trace_enter：getInfoByRoom → 校验开播 → x25Kn/E → 解析会话。 */
  async liveTraceEnter(roomId, { liveBuvid, liveUuid, userAgent, csrf }) {
    const room = await this.getLiveRoomInfo(roomId);
    if (room.liveStatus !== 1) {
      console.warn?.(
        `room=${roomId} 当前非开播 live_status=${room.liveStatus}，计时可能不增（照常挂）`,
      );
    }
    const ua = userAgent || this.userAgent;
    const params = buildEnterParams(room, {
      liveBuvid,
      liveUuid,
      userAgent: ua,
      csrf,
      tsMs: Date.now(),
    });
    const payload = await this.http.signedPostQueryJson(
      X25KN_E_URL,
      params,
      { headers: liveHeaders(room.roomId, { lite: true }), retryOnWbiMiss: true },
    );
    if (payload.code !== 0) {
      throw new Error(`x25Kn/E 失败 room_id=${room.roomId}: ${payload.message}`);
    }
    return parseEnterPayload(payload, room);
  }

  /** 对应 live_trace_heartbeat：签名 → x25Kn/X → 应用响应（含 secret 轮换）。 */
  async liveTraceHeartbeat(session, { liveBuvid, liveUuid, userAgent, csrf }) {
    const nextSeq = session.seqId + 1;
    const duration = Math.max(1, session.heartbeatInterval);
    const tsMs = Date.now();
    const signature = await buildX25knSignature({
      liveBuvid,
      liveUuid,
      parentAreaId: session.parentAreaId,
      areaId: session.areaId,
      seqId: nextSeq,
      roomId: session.roomId,
      ets: session.ets,
      duration,
      tsMs,
      secretKey: session.secretKey,
      secretRule: session.secretRule,
    });
    const params = buildHeartbeatParams(session, {
      liveBuvid,
      liveUuid,
      userAgent: userAgent || this.userAgent,
      csrf,
      signature,
      nextSeq,
      duration,
      tsMs,
    });
    const payload = await this.http.signedPostQueryJson(
      X25KN_X_URL,
      params,
      {
        headers: liveHeaders(session.roomId, { lite: true }),
        followRedirects: true,
        retryOnWbiMiss: true,
      },
    );
    if (payload.code !== 0) {
      throw new Error(
        `x25Kn/X 失败 room_id=${session.roomId}: ${payload.message}`,
      );
    }
    return applyHeartbeatPayload(session, payload, nextSeq);
  }
}

/**
 * 复刻 cookies.build_live_headers。注意：Referer/Origin/User-Agent 在扩展
 * fetch 中是 forbidden header，会被浏览器丢弃；真实覆写由 declarativeNetRequest
 * 规则在集成期按需提供。这里传入是为对齐 Python 语义 + 单测可读性。
 */
function liveHeaders(roomId, { lite = false } = {}) {
  const referer = lite
    ? `https://live.bilibili.com/blanc/${roomId}?liteVersion=true`
    : `https://live.bilibili.com/${roomId}`;
  return {
    Referer: referer,
    Origin: "https://live.bilibili.com",
  };
}
