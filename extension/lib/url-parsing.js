// URL 解析工具（对应 gui_parts/browser_utils.extract_room_id_from_live_url）。
// 用于 popup 的「从当前标签页自动识别房间号」。

const ROOM_URL_PATTERNS = [
  /https?:\/\/live\.bilibili\.com\/blanc\/(\d+)/,
  /https?:\/\/live\.bilibili\.com\/(\d+)/,
  /live\.bilibili\.com\/blanc\/(\d+)/,
  /live\.bilibili\.com\/(\d+)/,
];

/** 从任意文本（通常是当前标签页 URL）提取直播间房间号；无效返回 null。 */
export function extractRoomIdFromLiveUrl(text) {
  if (!text) return null;
  for (const pattern of ROOM_URL_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const roomId = Number(match[1]);
    if (Number.isInteger(roomId) && roomId > 0) return roomId;
  }
  return null;
}
