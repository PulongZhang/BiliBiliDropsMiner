// Watchdog 决策逻辑（M4 纯函数）。
// chrome.alarms 触发时由 background.js 调用 decideWatchdogAction，
// 根据返回的 action（idle / recreate / none）和 badge 应用副作用。
//
// status 形状（offscreen.js status()）：
//   active: 引擎是否运行；total: 会话数；running: running 态会话数；waiting: waiting 态会话数。

export const BADGE_COLORS = Object.freeze({
  GREEN: "#2e8b57",
  YELLOW: "#d9a300",
  RED: "#c0392b",
  GRAY: "#888888",
});

/** 由聚合状态推导角标：全绿显总数，部分黄显运行数，全红显 0，未运行留空。 */
export function badgeFromStatus(status) {
  if (!status || !status.active) {
    return { text: "", color: BADGE_COLORS.GRAY };
  }
  const total = status.total || 0;
  if (total === 0) return { text: "ON", color: BADGE_COLORS.GREEN };

  const running = status.running || 0;
  if (running >= total) return { text: String(total), color: BADGE_COLORS.GREEN };
  if (running === 0) return { text: "0", color: BADGE_COLORS.RED };
  return { text: String(running), color: BADGE_COLORS.YELLOW };
}

/**
 * 看门狗决策：
 * - 配置缺失/未激活 → idle（不干预，清角标）
 * - 激活但 offscreen 已死 → recreate（重建 offscreen 并按配置重启；角标 RST）
 * - 激活且存活 → none（仅刷新角标）
 */
export function decideWatchdogAction({ config, offscreenAlive, status = null }) {
  if (!config || !config.active || !config.roomId) {
    return { action: "idle", badge: badgeFromStatus(null) };
  }
  if (!offscreenAlive) {
    return { action: "recreate", badge: { text: "RST", color: BADGE_COLORS.YELLOW } };
  }
  return { action: "none", badge: badgeFromStatus(status) };
}
