// WBI 签名（对应 Python wbi.py）。
// 关键：encodeQuery 必须复刻 Python urllib.parse.quote(safe="") 语义
// —— 仅保留 unreserved 集 [A-Za-z0-9_.-~]，其余按 UTF-8 百分号大写编码。
// 不能用 encodeURIComponent（它额外保留 !'()*）。

import { md5Raw, bytesToHex, utf8Encode } from "./crypto.js";

// WBI mixin key 打乱表（对应 constants.py WBI_MIXIN_KEY_ENC_TAB）
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const UNSAFE_FILTER = new Set(["!", "'", "(", ")", "*"]);

export function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let out = "";
  for (const idx of MIXIN_KEY_ENC_TAB) out += raw[idx];
  return out.slice(0, 32);
}

/** 从 nav 响应解析 WBI img/sub key（对应 parse_wbi_keys_from_nav）。 */
export function parseWbiKeysFromNav(payload) {
  const data = payload.data || {};
  const wbiImg = data.wbi_img || {};
  const imgUrl = String(wbiImg.img_url || "");
  const subUrl = String(wbiImg.sub_url || "");
  if (!imgUrl || !subUrl) throw new Error("nav 返回缺少 wbi_img");
  const imgKey = imgUrl.split("/").pop().split(".")[0];
  const subKey = subUrl.split("/").pop().split(".")[0];
  if (!imgKey || !subKey) throw new Error("wbi key 解析失败");
  return { imgKey, subKey };
}

const UNRESERVED = /^[A-Za-z0-9_.\-~]$/;

function pyQuote(str) {
  let out = "";
  for (const ch of str) {
    if (UNRESERVED.test(ch)) {
      out += ch;
    } else {
      for (const b of utf8Encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

export function encodeQuery(params) {
  const items = [];
  for (const [key, value] of Object.entries(params)) {
    // 复刻 Python：先按字符过滤掉 !'()*，再 percent-encode
    const filtered = [...String(value)]
      .filter((ch) => !UNSAFE_FILTER.has(ch))
      .join("");
    items.push(`${pyQuote(String(key))}=${pyQuote(filtered)}`);
  }
  return items.join("&");
}

/**
 * 对应 Python wbi.sign_wbi_params。
 * 返回带 wts 与 w_rid 的对象（键顺序与 Python signed 一致：params → wts → w_rid）。
 */
export function signWbiParams(params, { imgKey, subKey, timestamp }) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const signed = { ...params, wts: timestamp };
  const sortedKeys = Object.keys(signed).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = signed[k];
  const query = encodeQuery(sorted);
  const wRid = bytesToHex(md5Raw(utf8Encode(query + mixinKey)));
  return { ...params, wts: timestamp, w_rid: wRid };
}
