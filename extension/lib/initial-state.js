// 从运行时状态、EVA 组件树或静态 HTML 提取任务 ID（对应 utils.py）。
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

export function extractTaskIdsFromPageData(pageData) {
  const groups = [];
  function visit(node) {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      if (node.type === "Component" && node.name === "EraTasklistPc" && node.props) {
        groups.push(node.props);
      }
      visit(node.children);
      if (Array.isArray(node.slots)) node.slots.forEach((slot) => visit(slot?.children));
    }
  }
  visit(pageData?.layerTree);
  return extractTaskIdsFromInitialState({ EraTasklistPc: groups });
}

/** 只解析 JSON，不执行活动页脚本；扫描括号时跳过 JSON 字符串中的括号。 */
function readPageObject(html, name) {
  const marker = new RegExp(`window\\.${name}\\s*=\\s*\\{`, "g");
  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

export function extractTaskIdsFromHtml(html) {
  const ids = extractTaskIdsFromPageData(readPageObject(html, "__BILIACT_EVAPAGEDATA__"));
  return ids.length ? ids : extractTaskIdsFromInitialState(readPageObject(html, "__initialState"));
}
