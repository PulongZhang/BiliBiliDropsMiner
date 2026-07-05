// 从直播间页面的 window.__initialState 提取掉宝任务 ID（对应 utils._extract_task_ids_from_task_group
// 遍历 EraTasklistPc）。扩展用 chrome.scripting.executeScript world:"MAIN" 直接读页面对象，
// 无需像 Python 那样正则切 HTML 字符串。
//
// 扩展场景是「全部任务都挂」，故扁平提取所有任务组的 taskId 并去重，
// 不复刻 Python 的 panel/position 分组（那是 GUI 让用户选任务组用的）。

/**
 * @param {any} state 直播间页面的 window.__initialState 对象
 * @returns {string[]} 去重后的 taskId 列表（保持出现顺序）
 */
export function extractTaskIdsFromInitialState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  const groups = state.EraTasklistPc;
  if (!Array.isArray(groups)) return [];

  const seen = new Set();
  const out = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const list = group.tasklist;
    if (!Array.isArray(list)) continue;
    for (const task of list) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      const id = String(task.taskId ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
