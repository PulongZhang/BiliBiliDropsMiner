// 直播间信息解析（对应 Python live.parse_live_room_info）。

function intOr(value, fallback) {
  // 对齐 Python `int(x or fallback)`：null/undefined/""/0 视作 falsy → fallback。
  const truthy = value !== null && value !== undefined && value !== "" && value !== 0;
  const n = parseInt(truthy ? value : fallback, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 getInfoByRoom 响应为直播间信息对象（对应 parse_live_room_info）。 */
export function parseLiveRoomInfo(payload, roomId) {
  if (payload.code !== 0) {
    throw new Error(`获取直播间信息失败 room_id=${roomId}: ${payload.message}`);
  }
  const data = payload.data || {};
  const roomInfo = data.room_info || {};

  const realRoomId = intOr(roomInfo.room_id, roomId);
  const ruid = intOr(roomInfo.uid, 0);
  const parentAreaId = intOr(roomInfo.parent_area_id, 0);
  const areaId = intOr(roomInfo.area_id, 0);
  const liveStatus = intOr(roomInfo.live_status, 0);

  if (realRoomId <= 0 || ruid <= 0) {
    throw new Error(`直播间信息不完整 room_id=${roomId}`);
  }
  if (parentAreaId <= 0 || areaId <= 0) {
    throw new Error(
      `直播分区信息缺失 room_id=${roomId} parent_area_id=${parentAreaId} area_id=${areaId}`,
    );
  }

  return { roomId: realRoomId, ruid, parentAreaId, areaId, liveStatus };
}
