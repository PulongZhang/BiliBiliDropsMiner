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
import { isRateLimited } from "./http.js";
import { normalizeTaskIds, parseTaskProgressPayload, resolveRewardTaskIds } from "./tasks.js";
import {
  MISSION_RETRY_DELAYS,
  normalizeTaskId,
  parseMissionRewardInfo,
  buildRewardReceiveBody,
  skippedRewardClaimResult,
  rewardClaimResultFromPayload,
  failedRewardClaimResult,
} from "./rewards.js";

const ROOM_INFO_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom";
const ENTRY_ACTION_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction";
const X25KN_E_URL =
  "https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/E";
const X25KN_X_URL =
  "https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/X";
const TASK_TOTALV2_URL = "https://api.bilibili.com/x/task/totalv2";
const MISSION_INFO_URL =
  "https://api.bilibili.com/x/activity_components/mission/info";
const MISSION_RECEIVE_URL =
  "https://api.bilibili.com/x/activity_components/mission/receive";

// 领奖间隔（对应 rewards.REWARD_CLAIM_INTERVAL_SECONDS）：批量领取时逐任务间停顿。
const REWARD_CLAIM_INTERVAL_SECONDS = 1.2;

export class BiliClient {
  constructor({ http, userAgent, sleep = defaultSleep }) {
    this.http = http;
    this.userAgent = userAgent;
    this.sleep = sleep;
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

  // --- 任务进度 + 自动领奖（对应 core.get_task_progress / get_mission_reward_info /
  //     receive_mission_reward / receive_all_mission_rewards） ---

  /** 查询任务进度（totalv2）。task_ids 逗号拼接，csrf 进参数。 */
  async getTaskProgress(taskIds, { csrf }) {
    const normalized = normalizeTaskIds(taskIds);
    if (normalized.length === 0) return [];
    if (!csrf) throw new Error("cookie 缺少 bili_jct，无法查询任务进度");
    const payload = await this.http.signedGetJson(
      TASK_TOTALV2_URL,
      { csrf, task_ids: normalized.join(","), web_location: "0.0" },
      { headers: missionHeaders(), retryOnWbiMiss: true },
    );
    return parseTaskProgressPayload(payload);
  }

  /** 查询领奖信息；带 MISSION_RETRY_DELAYS 限频重试。 */
  async getMissionRewardInfo(taskId) {
    const normalized = normalizeTaskId(taskId);
    let payload = {};
    for (let attempt = 0; attempt < MISSION_RETRY_DELAYS.length; attempt++) {
      const delay = MISSION_RETRY_DELAYS[attempt];
      if (delay > 0) await this.sleep(delay * 1000);
      payload = await this.http.signedGetJson(
        MISSION_INFO_URL,
        { task_id: normalized },
        { headers: missionHeaders(normalized), retryOnWbiMiss: true },
      );
      if (payload.code === 0 || !isRateLimited(payload)) break;
    }
    return parseMissionRewardInfo(payload, normalized);
  }

  /** 领取单个奖励：先判跳过（已领/不可领），再带限频重试 POST form。 */
  async receiveMissionReward(info, { csrf }) {
    const skipped = skippedRewardClaimResult(info);
    if (skipped) return skipped;
    if (!csrf) throw new Error("cookie 缺少 bili_jct，无法领取奖励");

    const body = buildRewardReceiveBody(info, csrf);
    let payload = {};
    for (let attempt = 0; attempt < MISSION_RETRY_DELAYS.length; attempt++) {
      const delay = MISSION_RETRY_DELAYS[attempt];
      if (delay > 0) await this.sleep(delay * 1000);
      payload = await this.http.signedPostFormJson(
        MISSION_RECEIVE_URL,
        {},
        body,
        { headers: missionHeaders(info.taskId), retryOnWbiMiss: true },
      );
      if (payload.code === 0 || !isRateLimited(payload)) break;
    }
    return rewardClaimResultFromPayload(info, payload);
  }

  /** 批量领取：逐任务 info → receive，任务间停顿 REWARD_CLAIM_INTERVAL_SECONDS。 */
  async receiveAllMissionRewards(taskIds, { csrf }) {
    const normalized = normalizeTaskIds(taskIds);
    if (normalized.length === 0) return [];
    let progresses = [];
    try {
      progresses = await this.getTaskProgress(normalized, { csrf });
    } catch (err) {
      if (err.name === "AbortError") throw err;
    }
    const rewardIds = resolveRewardTaskIds(normalized, progresses);
    const results = [];
    for (let index = 0; index < rewardIds.length; index++) {
      const taskId = rewardIds[index];
      try {
        const info = await this.getMissionRewardInfo(taskId);
        results.push(await this.receiveMissionReward(info, { csrf }));
      } catch (err) {
        if (err.name === "AbortError") throw err;
        results.push(failedRewardClaimResult(taskId, err));
      }
      if (index < rewardIds.length - 1) {
        await this.sleep(REWARD_CLAIM_INTERVAL_SECONDS * 1000);
      }
    }
    return results;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * 复刻 cookies.build_mission_headers（领奖相关请求的 Referer）。
 * 同样受 forbidden header 限制，真实覆写需 declarativeNetRequest。
 */
function missionHeaders(taskId) {
  const referer = taskId
    ? `https://www.bilibili.com/blackboard/era/award-exchange.html?task_id=${encodeURIComponent(taskId)}`
    : "https://www.bilibili.com/";
  return { Referer: referer, Origin: "https://www.bilibili.com" };
}
