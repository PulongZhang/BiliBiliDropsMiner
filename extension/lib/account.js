const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";

/** 网络故障不等同于 Cookie 失效；返回值不包含 Cookie 或接口原文。 */
export async function checkAccount(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(NAV_URL, {
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("nav HTTP error");
    const payload = await response.json();
    if (payload?.code === -101 || (payload?.code === 0 && payload.data?.isLogin === false)) {
      return { kind: "invalid" };
    }
    const uid = Number(payload?.data?.mid);
    if (payload?.code !== 0 || payload.data?.isLogin !== true || !Number.isSafeInteger(uid) || uid <= 0) {
      throw new Error("invalid nav payload");
    }
    return { kind: "valid", uid, uname: String(payload.data.uname || "") };
  } catch {
    return { kind: "error", message: "账号检查失败，请稍后重试" };
  }
}

export function accountStopReason(account, expectedUid) {
  if (account.kind === "invalid") return "登录已失效，已自动停止，请重新登录后启动";
  if (account.kind === "valid" && expectedUid && account.uid !== expectedUid) {
    return "登录账号已变化，已自动停止，请确认账号后启动";
  }
  return "";
}
