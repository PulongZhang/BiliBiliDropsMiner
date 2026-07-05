// HTTP 层（对应 Python http.py + core.py 的 signed_*_json 系列）。
// 通过依赖注入接收 fetchImpl / wbiKeysProvider / sleep，便于单元测试。
// 真实使用时，调用方（offscreen/SW）传入带 credentials:"include" 的 fetch。

import { signWbiParams } from "./wbi.js";

const TRANSIENT_DELAYS_MS = [350, 800]; // 对应 http.py:26 的 (0.35, 0.8)

/** 识别限频响应（对应 http.is_rate_limited_payload）。 */
export function isRateLimited(payload) {
  const code = String(payload?.code ?? "");
  const message = String(payload?.message ?? "");
  return (
    code === "-702" ||
    code === "-509" ||
    message.includes("频率") ||
    message.includes("频繁")
  );
}

export class HttpClient {
  constructor({ fetchImpl, wbiKeysProvider, sleep = defaultSleep }) {
    this.wbiKeysProvider = wbiKeysProvider;
    this.sleep = sleep;
    this._wbiKeys = null;
    this._calls = [];

    // 包一层 fetch：构造 URL/opts、记录调用、委托给注入的 fetchImpl。
    this.fetch = (method, url, params, headers, body) => {
      const { fullUrl, opts } = buildRequest(method, url, params, headers, body);
      this._calls.push({ url: fullUrl, opts });
      return fetchImpl(fullUrl, opts);
    };
    this.fetch.calls = this._calls; // 共享引用，测试可读
  }

  clearWbiCache() {
    this._wbiKeys = null;
  }

  async signWbi(params) {
    if (!this._wbiKeys) this._wbiKeys = await this.wbiKeysProvider();
    return signWbiParams(params, {
      ...this._wbiKeys,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  /** 瞬时网络异常退避重试（对应 request_with_transient_retry）。 */
  async _transientRetry(requestFn, method, url) {
    const total = TRANSIENT_DELAYS_MS.length + 1;
    for (let attempt = 0; attempt < total; attempt++) {
      try {
        return await requestFn();
      } catch (err) {
        if (attempt >= total - 1) throw err;
        await this.sleep(TRANSIENT_DELAYS_MS[attempt]);
      }
    }
    throw new Error(`unreachable retry state: ${method} ${url}`);
  }

  async _signedRequest(method, url, params, { headers, body, retryOnWbiMiss = true } = {}) {
    const retries = retryOnWbiMiss ? 2 : 1;
    let payload = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      const signedParams = await this.signWbi(params);
      const resp = await this._transientRetry(
        () => this.fetch(method, url, signedParams, headers, body),
        method,
        url,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${method} ${url}`);
      payload = await resp.json();
      if (payload.code === 0) return payload;
      if (attempt === 0 && retryOnWbiMiss) this.clearWbiCache();
    }
    return payload;
  }

  signedGetJson(url, params, opts = {}) {
    return this._signedRequest("GET", url, params, opts);
  }

  signedPostJson(url, params, body, opts = {}) {
    return this._signedRequest("POST-JSON", url, params, { ...opts, body });
  }

  signedPostQueryJson(url, params, opts = {}) {
    // params 走 query，无 body（x25Kn E/X 风格）
    return this._signedRequest("POST-QUERY", url, params, opts);
  }

  signedPostFormJson(url, params, body, opts = {}) {
    return this._signedRequest("POST-FORM", url, params, { ...opts, body });
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequest(method, url, params, headers, body) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) qs.append(k, String(v));
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = url + sep + qs.toString();
  const opts = { method: "GET", credentials: "include", headers: { ...headers } };
  if (method === "POST-JSON") {
    opts.method = "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body ?? {});
  } else if (method === "POST-FORM") {
    opts.method = "POST";
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body ?? {})) form.append(k, String(v));
    opts.body = form.toString();
  } else if (method === "POST-QUERY") {
    opts.method = "POST";
  }
  return { fullUrl, opts };
}
