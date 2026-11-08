# 扩展版验证 Runbook（M7）

> 配套设计：`2026-07-05-extension-port-design.md`。本文给出「真实服务器接受签名」的
> 分阶段验证流程，以及与 Python 原版平行对比的方法。所有「通过标准」都只能在浏览器里判定。

## 前置条件

- Chrome / Edge（Chromium 内核，支持 MV3 offscreen）
- 已在 `https://www.bilibili.com` 登录（SESSDATA / bili_jct / DedeUserID 等 cookie 就位）
- 想要平行对比的话：本地能跑 Python 原版（`uv run bilibili.py` 或 GUI）

## 0. 加载扩展

1. `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `D:\Workspace\BiliBiliDropsMiner\extension`
3. 确认无加载错误（Service worker / Offscreen / Popup 三个视图都应就绪）

## 1. 单会话心跳冒烟（验证 M2 真实集成）

**目的**：确认扩展 fetch 能带上 SESSDATA、WBI/x25Kn 签名被真实服务器接受。

打开扩展的 **service worker 控制台**（`chrome://extensions` → 该扩展「service worker」链接），执行：

```js
await bdm.start({ roomId: <你的测试房间号>, threadCount: 1 })
await bdm.status()
```

打开 **offscreen 的 inspect view**（`chrome://extensions` → 该扩展「检查视图：offscreen」）观察日志。

**通过标准**：
- offscreen 日志出现 `session s0 entered room=<id>`
- `status()` 返回 `active:true`、`running:1`、`heartbeats` 每 ~60s 递增、`lastError:null`
- 真实服务器返回 `code==0`（无 -3 / 风控字样）

**失败排查**：
- `未取到 bili_jct` → 没登录 bilibili.com
- `nav code=<非0>` → cookie 未携带，确认 host_permissions 含 `*://*.bilibili.com/*` 且 fetch 带 `credentials:"include"`
- `x25Kn/E 失败` / `-3` / 「风控」「频率」→ 见下方「Referer 风险」一节，极可能要上 declarativeNetRequest

## 2. 多会话负载（验证 M3）

```js
await bdm.start({ roomId: <id>, threadCount: 100 })
```

**通过标准**：
- 100 路 enter 在 ~0..99s 内按 1s 错峰完成（offscreen 日志逐个 `entered`）
- `status().running` 逐步升到 100，`waiting/idle` 归零
- 持续 10 分钟，`heartbeats` 线性增长（≈ 100 × 每 60s 一次）
- 无集中限频（`waiting` 不持续聚集）

**调优旋钮**：
- 会话间错峰过密触发限频 → 增大 `STAGGER_MS`（offscreen.js，目前 1000ms；miner.py:49 实测 1s 是 128 线程下限）
- 单会话重连过频 → 增大 `reconnectDelayMs`（session.js，目前 8000ms）

## 3. 任务监控 + 自动领奖（验证 M5）

填入一个**已完成或接近完成**的任务 ID（从掉宝页 URL 取 `task_id`）：

```js
await bdm.start({ roomId: <id>, threadCount: 100, taskIds: ["<task_id>"], taskQueryIntervalSeconds: 30 })
```

或在 popup 里填「任务 ID」框点启动。

**通过标准**：
- offscreen 日志周期输出 `任务进度: <名> <cur>/<limit>`
- 任务达到完成（cur≥limit）后自动出现 `已领取: <名> (领取成功)`
- `status().taskMonitor.claimedIds` 含该 task_id，下一周期不重复领取
- 不领取 status==6（服务端已领）的任务

## 4. 平行对比（Python 原版 vs 扩展）

目标：相同房间、相同时段、相同账号下，两边的心跳计数与任务进度增长一致。

1. **同一账号**：扩展用浏览器登录态；Python 用同一账号的 cookie（GUI 粘贴或 `--cookie`）
2. 选一个**正在开播**的房间（确保 ets 能增长；非开播房间两边都不会增长时长，仅维持心跳）
3. 同时启动：
   - Python：`thread_count=100`
   - 扩展：popup 填 `会话数=100`
4. 跑 **10 分钟**，每分钟记录：
   - Python GUI 日志的「任务进度」`cur/limit`
   - 扩展 `await bdm.status()` 的 `heartbeats` 与 `taskMonitor` 快照
5. 对比：
   - 两边任务 `cur_value` 增长曲线应基本重合（都按真实观看时长上报）
   - 扩展 `heartbeats ≈ 100 × (600/60) = 1000` 次（10 分钟）
   - 若扩展 `cur` 明显落后 Python → 多半是 Referer 被服务器拒导致心跳无效（见下节）

> 注：同一账号同时开 Python + 扩展 = 双倍会话数（200），服务器看到的是 200 路观看。
> 对比的是「增长趋势」而非绝对值。若担心相互干扰，可分两时段各跑 10 分钟比趋势。

## 5. Referer / Origin 风险与 declarativeNetRequest 兜底

**风险**：扩展 fetch 的 `Referer`/`Origin` 是 forbidden header，浏览器会覆写为
`chrome-extension://<id>`。若 bilibili 的 x25Kn / live-trace / mission 端点校验
Referer 来源，签名正确也会被拒（典型表现：`x25Kn/E 失败`、code -3、风控字样）。

**判定**：第 1 步若签名层都正确但仍报错 → 几乎可确定是 Referer。

**兜底（按需启用）**：在 `manifest.json` 加 `"declarativeNetRequest"` 权限，新增
`rules/referer_rules.json` 并在 `background.js` 注册静态规则，把发往 bilibili 的
请求头改成 Python 语义：

```jsonc
// manifest.json 末尾加
"declarative_net_request": { "rule_resources": [{ "id": "referer", "enabled": true, "path": "rules/referer_rules.json" }] }
```

```json
// rules/referer_rules.json —— 按 host 设 Referer/Origin（origin 级，不带 roomId）
[
  { "id": 1, "priority": 1,
    "action": { "type": "modifyHeaders", "requestHeaders": [
      { "header": "Referer", "operation": "set", "value": "https://live.bilibili.com/" },
      { "header": "Origin",  "operation": "set", "value": "https://live.bilibili.com" } ] },
    "condition": { "urlFilter": "||live-trace.bilibili.com", "resourceTypes": ["xmlhttprequest"] } },
  { "id": 2, "priority": 1,
    "action": { "type": "modifyHeaders", "requestHeaders": [
      { "header": "Referer", "operation": "set", "value": "https://live.bilibili.com/" },
      { "header": "Origin",  "operation": "set", "value": "https://live.bilibili.com" } ] },
    "condition": { "requestDomains": ["api.live.bilibili.com"], "resourceTypes": ["xmlhttprequest"] } },
  { "id": 3, "priority": 1,
    "action": { "type": "modifyHeaders", "requestHeaders": [
      { "header": "Referer", "operation": "set", "value": "https://www.bilibili.com/" },
      { "header": "Origin",  "operation": "set", "value": "https://www.bilibili.com" } ] },
    "condition": { "requestDomains": ["api.bilibili.com"], "resourceTypes": ["xmlhttprequest"] } }
]
```

> User-Agent 无法用 DNR 改（需要 `declarativeNetRequest` 的 `userAgent` modify，
> 较新 Chrome 才支持）。目前 `ua` 仅作为 x25Kn 签名 payload 字段（与 Python 一致），
> 真实 HTTP UA 由浏览器自带，通常不被校验。若实测发现 UA 也被查，再单独加规则。

设计上选择「先验证再加 DNR」，避免一开始就引入额外权限；上面这段是即用即贴的补丁。

## 6. 续跑 / 看门狗（验证 M4）

1. 扩展运行中 → 关闭浏览器再开 → 扩展应自动恢复（onStartup 续跑）
2. 手动停掉 offscreen（devtools 里 `location.reload()` offscreen 文档）→ 看门狗
   应在 ≤1min 内重建并恢复心跳，期间角标显示 `RST`
3. 角标颜色：全绿显 `100`，部分黄显运行数，全红显 `0`

## 7. 主分支功能同步验收（扩展 0.2.0）

离线验证（仓库根目录，Node.js 22.18+，Python 测试依赖由 uv 临时提供）：

```bash
npm test
npm run verify-notes
uv run --no-project --python 3.12 --with-requirements requirements.txt --with-requirements requirements-web.txt python -m unittest discover -s tests -q
```

Node 测试使用浏览器 API 和 HTTP 替身，不产生真实心跳或领奖。真实环境在原有步骤外检查：

1. 重新加载扩展，确认面板显示当前浏览器登录账号；未登录时启动应失败。
2. 对同一活动分别使用「识别当前页」和「按房间获取任务」，旧版页面、EVA 分组及扁平任务列表应均能提取任务。
3. 从空任务列表启动，再识别或手动填写任务；识别后直接应用，编辑后点「应用任务设置」。房间、会话数、启动时间与累计心跳应连续，任务监控开始更新。
4. 聚合任务首档完成、后档未完成时，检查首档用 checkpoint SID 领取，父 ID 不应被当作奖励 ID；已领项不重复 POST。关闭自动领取后，确认只刷新进度，点击「领取奖励」仍可手动领取并展开结果。
5. 在进房、任务查询或领奖重试期间停止，确认挂起请求被中止，不再发出下一步 enter/receive 请求。
6. 运行中退出 B 站或切换账号，等待一分钟内自动停止；看门狗不能恢复。重新登录后需手动启动。临时断网只应显示检查错误，联网后继续复查。
7. 编辑配置后关闭并重新打开面板，确认配置恢复；重启浏览器后仅恢复已成功启动且未停止的配置，账号必须与保存的 UID 一致。

本次适配边界及验证记录见[同步决策](../../../.agents/notes/implemented/feature/2026-11-08-sync-main-to-extension.md)。

## 完成判据

- [ ] 第 1 步单会话 code==0、心跳递增
- [ ] 第 2 步 100 会话稳定、无限频聚集
- [ ] 第 3 步任务自动领取、不重领
- [ ] 第 4 步与 Python 平行对比，任务进度趋势一致
- [ ] 第 6 步关闭浏览器后自动续跑
- [ ] （若命中）第 5 步 DNR 补丁生效，Referer 报错消失
