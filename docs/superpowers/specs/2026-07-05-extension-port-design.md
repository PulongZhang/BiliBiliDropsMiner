# BiliBiliDropsMiner 浏览器扩展化改造设计

- 日期：2026-07-05
- 状态：待评审
- 作者：与用户协作（brainstorming）
- 关联代码：`bilibili_drops_miner/`（Python 原版，已验证可用）

---

## 1. 背景与动机

原版是 Python + PySide6 的桌面程序，核心是向 B 站直播 x25Kn 心跳接口持续上报观看时长以累积「掉宝」奖励。痛点：

- 需要安装 Python 环境，分发门槛高
- 登录态依赖 `SESSDATA`（HttpOnly），原版靠 selenium 启浏览器 + 临时扩展抓 cookie，链路重
- 仅桌面端

改成 MV3 浏览器扩展后：

- `fetch` 同源/带 `credentials:include`，cookie（含 SESSDATA）自动携带，**彻底告别手动 cookie**
- 跨平台、零依赖、解压即用
- 用户日常跑 **100 并发会话**（在原版验证过的 128 上限内），扩展需同等吞吐

## 2. 目标 / 非目标

### 目标

- 行为与原版**协议层完全一致**（URL、参数、WBI/HMAC 签名、headers、字段顺序逐字节对齐）
- 支持 N 并发 x25Kn 会话（默认 100），含 1s 错峰启动
- 自动领奖（轮询 `totalv2` + `mission/receive`，含限频退避）
- 未开播房间照常挂机
- 标签页无需保持打开；浏览器重启后自动续跑
- 自用 / 朋友圈解压侧载分发（**不上 Chrome Web Store**）

### 非目标（明确砍掉）

- 多房间同时挂（仅单房间）
- 通知推送（弹幕 WebSocket、`notify_urls` 全砍）
- Chrome Web Store 上架（offscreen reason 灰区不构成阻塞）
- GUI 等价物（popup 即可，不做复杂 dashboard）

## 3. 关键决策一览

| 维度 | 决定 | 理由 |
|---|---|---|
| 时序方案 | **offscreen document + setInterval** | 多会话需 1s 精确错峰；chrome.alarms 最小 30s 且同边界合并，无法错峰 |
| 鲁棒性 | **SW chrome.alarms 看门狗**兜底重建 offscreen | 防 offdocument 被回收 / 崩溃；浏览器重启后续跑 |
| 多会话 | 单调度器 tick（250ms）管 N=100 条独立会话 | 比开 100 个独立 setInterval 更可控、错峰天然 |
| 领奖 | 自动（主会话 #1 每 30s 查进度 + receive） | 用户要省心；原版是手动，属**新增**，需额外验证 |
| Cookie | 全程 `credentials:include` + host_permissions | 自动带 cookie，不碰 SESSDATA |
| 状态落盘 | intent + 每会话 buvid/uuid 落 `storage.local`；心跳态只在内存 | 降低写压力；崩溃由看门狗重进恢复（等同原版崩溃重连语义） |
| 分发 | 解压侧载 | offscreen reason 灰区不影响自用 |
| 通知 | 砍 | 用户确认 |

## 4. 执行上下文架构

```
┌────────────────────────────────────────────────────────────────┐
│ Offscreen Document  ← 引擎（常驻，非 tab，不被冻结）             │
│  · SessionManager 管 N 条独立 x25Kn 会话                         │
│  · 单调度器 setInterval(250ms)：到点的会话触发 enter/heartbeat  │
│  · 启动错峰：会话 i 首次 enter 于 startTime + i*1000ms           │
│  · 每会话独立：buvid/uuid/secret_key/rule/ets/seq/状态机        │
│  · #1 主会话额外：每 30s 查 totalv2 → 完成则 mission/receive     │
│  · 所有 fetch 走 lib/http.js（credentials:include + 重试 + 限频）│
│  · 状态快照周期性写入 chrome.storage.session 供 popup 读        │
└────────────────────────────────────────────────────────────────┘
                              ↕ chrome.runtime messaging
┌────────────────────────────────────────────────────────────────┐
│ Service Worker  ← 启动器 / 看门狗 / 中继 / badge                 │
│  · START：写 intent → chrome.offscreen.createDocument → 通知启动 │
│  · STOP：通知 offscreen 停 → closeDocument → 清 intent           │
│  · chrome.alarms 每 60s 看门狗：offscreen 不在则重建并续跑       │
│  · 中继 popup ↔ offscreen（状态查询、读 __initialState）        │
│  · chrome.action.setBadgeText 显示运行状态                      │
│  · 浏览器重启：alarm 唤醒 → 检查 intent.mining → 自动续跑       │
└────────────────────────────────────────────────────────────────┘
                              ↕ chrome.runtime messaging
┌────────────────────────────────────────────────────────────────┐
│ Popup  ← 控制面板                                                │
│  · 自动探测：当前 active tab URL 解析 room_id；读 __initialState │
│    填 task_ids（可手改）                                         │
│  · 字段：room_id / task_ids / thread_count(默认 100) / 开始·停止 │
│  · 状态视图：会话心跳计数、任务进度、领奖结果                    │
│  · 登录态检查：经 SW 调 nav 接口判断                             │
└────────────────────────────────────────────────────────────────┘

Content Script（按需一次性注入）
  · chrome.scripting.executeScript({world:'MAIN'}) 读 window.__initialState
  · 返回 task_ids + 确认 room_id；无循环、无状态
```

### 为什么是这个架构（决策溯源）

- **不用 content script 跑循环**：未开播房间无媒体播放，标签页后台会被冻结，心跳停。用户明确需要未开播照挂。
- **不用 chrome.alarms 跑心跳**：alarms 同周期边界会合并触发，100 会话会挤在同一秒一起炸，触发 B 站限流（原版 `miner.py:49` 注释：「0.5s stagger triggers server throttle」）。
- **offscreen 是 MV3 里唯一能精确常驻定时的官方机制**：它是扩展进程内的文档，不是 tab，setInterval 不被节流/冻结。

## 5. 目录与模块结构

```
extension/
├── manifest.json
├── background.js                  # SW：生命周期/看门狗/中继/badge
├── offscreen/
│   ├── offscreen.html             # <script type="module" src="offscreen.js">
│   └── offscreen.js               # 引擎入口：SessionManager + 调度器
├── content/
│   └── (无独立文件，用 chrome.scripting 注入 inline 函数)
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── lib/                           # ES 模块，被 offscreen.js / popup.js 引用
│   ├── wbi.js                     # 翻译 wbi.py
│   ├── live-trace.js              # 翻译 live_trace.py（x25Kn E/X 参数 + HMAC 输入构造）
│   ├── crypto.js                  # SubtleCrypto HMAC + MD5/SHA224 polyfill
│   ├── http.js                    # 翻译 http.py（瞬时重试 + 限频识别）
│   ├── task-parsing.js            # 翻译 task_parsing.py + utils.py(__initialState 解析)
│   ├── rewards.js                 # 翻译 rewards.py（领奖信息/领取 + 退避）
│   └── session.js                 # 单会话状态机（翻译 x25kn_worker._trace_heartbeat_loop）
└── icons/{16,48,128}.png
```

### manifest.json 关键字段

```jsonc
{
  "manifest_version": 3,
  "name": "BiliBili Drops Miner",
  "version": "0.1.0",
  "permissions": ["offscreen", "storage", "alarms", "scripting", "tabs", "activeTab"],
  "host_permissions": ["*://*.bilibili.com/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup/popup.html" },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

- 不申请 `cookies` 权限：所有请求靠 `credentials:include` 自动带 cookie，登录态检查走 nav 接口。
- offscreen 创建时声明 reason（自用侧载，选 `WORKERS` 或 `DOM_PARSER` 配 justification 字符串即可，运行时不强制校验真实用途）。

## 6. 组件详细设计

### 6.1 Session（单会话状态机）—— `lib/session.js`

复刻 `x25kn_worker.py:_trace_heartbeat_loop`（行 114–162）与 `_run_once`（行 80–112）。

状态：

```
IDLE ──start(i)──► ENTERING ──enter ok──► RUNNING ──heartbeat tick──► RUNNING
                       │                       │
                       │ enter fail            │ heartbeat fail
                       ▼                       ▼
                   (等 reconnect_delay)    (等 reconnect_delay)
                       │                       │
                       └───────────────► ENTERING（重进）
```

字段（每会话）：

```js
{
  id: 1,                    // session_no，1=主会话
  buvid: "AUTO...",         // 持久化，跨重进稳定（翻译 cookies.generate_live_buvid）
  uuid: "uuid-v4",          // 持久化
  state: "idle" | "entering" | "running" | "waiting",
  live: null | {            // LiveTraceSession（翻译 live_trace.py:LiveTraceSession）
    secretKey, secretRule:[...], ets, seqId,
    heartbeatInterval, roomId, ruid, parentAreaId, areaId
  },
  nextDueAt: <ms>,          // 下次该动作的时间（调度器读这个）
  reconnectDelay: 8000,     // 失败退避，默认 8s（config.reconnect_delay_seconds）
  heartbeatCount: 0,        // 供 popup 显示
  lastError: null
}
```

进入序列（对应原版 `_trace_heartbeat_loop` 进入分支）：

1. `getInfoByRoom`（拿 room_info：real_room_id/ruid/parent_area_id/area_id/live_status）
2. `roomEntryAction`（POST，需 bili_jct —— 由 cookie 自动带）
3. `live_trace_enter`（x25Kn/E）→ 解析 `secret_key`/`secret_rule`/`ets`/`heartbeat_interval`
4. `live_status != 1` 仅日志警告，照常（复刻 `core.py:400-405`）

心跳（对应 `_trace_heartbeat_loop` 心跳分支）：

1. `seqId += 1`
2. 构造签名输入（`build_x25kn_signature`，见 6.3）
3. `live_trace_heartbeat`（x25Kn/X）→ 更新 `ets`/`secretKey`/`secretRule`/`heartbeatInterval`（复刻 `apply_live_trace_heartbeat_payload`）
4. `duration` 用 `heartbeat_interval` 固定值（复刻 `core.py:435`，**不**用实际 elapsed）

失败：state 置 `waiting`，`nextDueAt = now + reconnectDelay`，`live = null`，到点重进。

主会话（id=1）额外任务监控循环（对应 `_task_monitor_loop`，行 164–219）：每 30s（`task_query_interval_seconds`）查 `totalv2`，进度变化记日志，完成的任务自动 `mission/info` → `mission/receive`（见 6.5）。

### 6.2 SessionManager + 调度器 —— `offscreen.js`

单调度器（**不开 100 个 setInterval**）：

```js
setInterval(tick, 250);  // 250ms 粒度，对 60s 心跳足够精确
function tick() {
  const now = Date.now();
  for (const s of sessions) {
    if (now >= s.nextDueAt && s.state !== 'running'/*防重入*/) {
      s.nextDueAt = Infinity;       // 占位，动作完成后重设
      runSessionAction(s);          // 按 state 决定 enter 还是 heartbeat
    }
  }
}
```

错峰启动：创建会话时设 `sessions[i].nextDueAt = startTime + i*1000`，100 会话在 100s 内逐个首次 enter，天然 1s 间隔（复刻 `miner.py:49-53` 的 `(thread_index-1)*1` 错峰）。

并发保护：单会话动作串行（同一会话不会并发 enter/heartbeat）；跨会话天然异步并发（fetch 是 async，不阻塞调度器）。

状态快照：每 5s 把会话摘要（state/seq/heartbeatCount/lastError）+ 任务进度 + 领奖结果写 `chrome.storage.session.status`，popup 打开时读 + 每 1s 刷新。

### 6.3 签名层 —— `lib/live-trace.js` + `lib/crypto.js` + `lib/wbi.js`

#### WBI 签名（翻译 `wbi.py` + `core.sign_wbi`）

- 从 `api.bilibili.com/x/web-interface/nav` 取 `data.wbi_img.img_url` / `sub_url`，截文件名得 `img_key`/`sub_key`
- `get_mixin_key`：用 `WBI_MIXIN_KEY_ENC_TAB`（`constants.py`，硬编码表）打乱拼接，取前 32 字符
- 签名：参数加 `wts=now`，按 key 排序，拼成 query，追加 `&wrv=` `MD5(query + mixin_key)`
- 缓存 mixin_key（数小时轮换），失败清缓存重取（复刻 `http.py` 的 `retry_on_wbi_miss`）

#### x25Kn HMAC 签名（翻译 `live_trace.py:build_x25kn_signature`）

签名输入是紧凑 JSON：

```js
const payload = {
  platform:"web", parent_id, area_id, seq_id, room_id,
  buvid, uuid, ets, time:duration, ts:ts_ms
};
const json = compactJson(payload);   // 必须逐字节等于 Python json.dumps(separators=(",",":"))
let current = new TextEncoder().encode(json);
for (const rule of secretRule) {
  current = await hmac(current, secretKey, rule);  // rule: 0=md5 1=sha1 2=sha256 3=sha224 4=sha512 5=sha384
}
signature = hex(current);
```

#### crypto.js 实现要点

- SHA-1/256/384/512：`SubtleCrypto.importKey` + `sign`（原生支持）
- **MD5(0)/SHA-224(3)**：SubtleCrypto **不支持**，需引入纯 JS 实现（候选：`crypto-js` 子集或自实现），**必须和 Python `hmac` 逐字节对拍**（见 §8 测试）
- HMAC 摘要按 `hmac_by_rule` 的 digest_map 迭代（支持 secret_rule 多轮嵌套，`live_trace.py:60-63`）

#### compact JSON 字段顺序（高风险点）

JS `JSON.stringify` 对**字符串键保持插入顺序**，故必须**显式按 Python 字典字面量顺序构造对象**：

- `build_x25kn_signature` payload 顺序：`platform, parent_id, area_id, seq_id, room_id, buvid, uuid, ets, time, ts`（对齐 `live_trace.py:48-59`）
- `enter` 的 `id`/`device` 字段是预先 compact_json 好的字符串，再放进外层参数（对齐 `live_trace.py:76-77`）

`JSON.stringify(obj)` 默认无空格，等价 Python `json.dumps(separators=(",",":"))`，但需测试验证无 `undefined`/数字精度差异。

### 6.4 HTTP 层 —— `lib/http.js`

翻译 `http.py`：

- `requestWithTransientRetry`：fetch 网络异常（抛 `TypeError`）按 `(0.35s, 0.8s)` 退避重试（对齐 `http.py:26`）
- `signedGetJson` / `signedPostJson` / `signedPostQueryJson` / `signedPostFormJson`：先 WBI 签名 → 请求 → code==0 返回；非 0 且 `retry_on_wbi_miss` 则清 WBI 缓存重试一次
- `isRateLimited`：code ∈ {-702,-509} 或 message 含「频率/频繁」（对齐 `http.py:11-14`）
- 所有请求 `credentials:"include"`，headers 含 `Referer`/`Origin`/`User-Agent`（由 `cookies.build_live_headers` 翻译，注意：浏览器会自动设部分 header，`User-Agent` 不可在 fetch 里改，需评估是否影响风控——见 §9 风险）

### 6.5 领奖 —— `lib/rewards.js`

翻译 `rewards.py` + `core.receive_mission_reward`：

- 主会话每 30s 查 `totalv2`，发现 `is_completed` 且未领的任务
- `mission/info` 查奖励信息 → `mission/receive` 领取
- 限频退避：`MISSION_RETRY_DELAYS`（翻译为 JS 数组），命中限频按延迟重试
- 领取间隔 `REWARD_CLAIM_INTERVAL_SECONDS`，逐任务串行
- 结果写入 `chrome.storage.session.status.claims` 供 popup 显示

**注**：原版领奖是手动（`task_controller.py:213`），自动领奖是**新增**，需在实测中重点验证不触发风控。

### 6.6 Service Worker —— `background.js`

消息协议（popup/offscreen ↔ SW）：

```js
// popup → SW
{ type:"START", roomId, taskIds, threadCount }
{ type:"STOP" }
{ type:"GET_STATUS" }            // SW 转发 offscreen 或直接读 storage.session
{ type:"READ_INITIAL_STATE", tabId }  // SW 用 chrome.scripting 读页面状态返回

// SW → offscreen
{ type:"START", intent }
{ type:"STOP" }
{ type:"GET_STATUS" }

// offscreen → SW（主动推送状态变化）
{ type:"STATUS", status }
```

看门狗：

```js
chrome.alarms.create("watchdog", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  const intent = await storage.local.get("intent");
  if (!intent?.mining) return;
  if (!(await chrome.offscreen.hasDocument())) {
    await createOffscreen();
    sendToOffscreen({ type:"START", intent });  // 重进所有会话
  }
});
```

浏览器启动时 `chrome.runtime.onInstalled` / `chrome.runtime.onStartup` 检查 intent.mining，true 则建 offscreen 续跑。

badge：`mining` 时显示绿点 + 会话数，停止时清空。

### 6.7 Popup —— `popup/popup.js`

打开时：

1. `chrome.tabs.query({active:true,currentWindow:true})` 拿当前 tab URL → 解析 room_id（复刻 `browser_utils.extract_room_id_from_live_url` 正则）
2. 若在 `live.bilibili.com/{id}`，发 `READ_INITIAL_STATE` 给 SW → 填 task_ids
3. 读 `chrome.storage.local` 上次的 threadCount（默认 100）填入
4. 订阅状态：读 `storage.session.status` + 每秒刷新

字段：room_id（可手填）、task_ids（可手改）、threadCount、[开始]/[停止] 按钮、登录态指示、状态区。

## 7. 数据模型

### chrome.storage.local（持久，跨重启）

```js
{
  intent: {
    mining: boolean,
    roomId: number,
    taskIds: string[],
    threadCount: number,
    sessions: [           // 每会话稳定身份（生成一次，永久复用）
      { id:1, buvid:"AUTO...", uuid:"..." },
      ...
    ]
  },
  settings: { threadCount: 100 }  // 记忆用户上次填的会话数
}
```

### chrome.storage.session（运行期，popup 读）

```js
{
  status: {
    startedAt: number,
    sessions: {
      "1": { state:"running", seq:42, heartbeatCount:120, ets:..., lastError:null },
      ...
    },
    tasks: [ { taskId, taskName, cur, limit, status, completed } ],
    claims: [ { taskId, ok, awardName, at, error } ],
    primarySessionLastQuery: number
  }
}
```

**不逐心跳落盘**：心跳态只存在 offscreen 内存；崩溃由看门狗重建后从 intent 重进（语义等同原版崩溃重连，损失至多一个心跳周期）。状态快照每 5s 写一次 `storage.session`（仅供展示，丢失无害）。

## 8. 测试策略

### 8.1 单元（签名层逐字节对拍）

构造一组 Python 参考向量（`live_trace.build_x25kn_signature`、`wbi.sign_wbi_params` 对固定输入的输出），在 JS 侧跑同样输入，**逐字节比对**：

- HMAC 全 6 种 rule（尤其 MD5/SHA224 polyfill）
- WBI 签名（含 `wts`）
- compact JSON（含字段顺序、中文转义、数字）

这些是「能用」的根基，必须先过。

### 8.2 集成（真实房间）

- 加载扩展 → popup 自动填 room/task → 开始
- 在 SW + offscreen 控制台观察：100 会话在 100s 内逐个 enter 成功，之后每会话按 heartbeat_interval 心跳
- 检查请求签名与原版抓包一致

### 8.3 平行对比（验证吞吐与计时不亏）

原版与扩展版**先后**（避免同账号双倍并发）对同一房间各跑 1 小时（threadCount=100），对比：

- 掉宝进度增量
- B 站侧观看时长增量（若可观测）
- 心跳请求速率

若扩展版明显少累计，排查 alarm/错峰/interval 偏差。

### 8.4 故障注入

- kill offscreen（`chrome.offscreen.closeDocument`）→ 看门狗应 60s 内重建并续跑
- 模拟限频响应 → 退避重试生效
- 浏览器重启 → intent.mining 触发自动续跑

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| MD5/SHA224 polyfill 与 Python 不一致 | 中 | 高（签名错，心跳全废） | §8.1 逐字节对拍，过不了不发版 |
| compact JSON 字段顺序/转义差异 | 中 | 高 | 同上；显式构造对象字段顺序 |
| fetch 无法改 `User-Agent` | 中 | 中（风控可能区分） | 其余 header 全对齐；若被风控，评估用 `declarativeNetRequest` 改 UA（需加权限） |
| 100 会话 enter 阶段限流 | 中 | 中 | 1s 错峰 + reconnect_delay 退避（原版验证过 128 上限） |
| offscreen 被回收 | 低 | 中 | 看门狗 alarm 60s 内重建 |
| 自动领奖触发风控 | 低-中 | 中 | 限频退避；领取间隔串行；实测观察 |
| B 站区分扩展请求来源 | 低 | 中 | headers 完全对齐 Python；同源请求天然像页面自发 |
| `heartbeat_interval < 250ms` 调度精度 | 极低 | 低 | 调度粒度 250ms，heartbeat 通常 60s，无影响 |

## 10. 工作量与里程碑

估 **5–8 天**专注工作量。建议里程碑：

1. **签名层 + 单测对拍**（wbi/hmac/compact-json，含 polyfill）——1.5 天，硬门槛
2. **HTTP 层 + 单会话状态机**（offscreen + 1 会话能 enter + heartbeat）——1.5 天
3. **SessionManager 多会话调度 + 错峰**（100 会话跑起来）——1.5 天
4. **看门狗 + 续跑 + badge**——0.5 天
5. **任务监控 + 自动领奖**——1 天
6. **Popup + content script 读 __initialState**——1 天
7. **平行对比实测 + 调优**——1 天

里程碑 1 是 go/no-go 关卡：签名对不上，后面全白做。

## 11. 未决 / 未来

- 若日后要上架 Web Store：offscreen reason 需重新评估，可能退回 alarms 单会话（吞吐降级）或寻找合规 reason。
- 多房间支持：当前 `intent` 结构已预留单房间；未来扩展为房间数组 + 多 SessionManager。
- 通知恢复：若要，可在领奖成功后接 `chrome.notifications`（本地通知，无需外部服务）。
