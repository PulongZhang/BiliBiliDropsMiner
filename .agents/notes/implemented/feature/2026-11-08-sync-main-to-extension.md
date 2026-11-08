# Agent Note: 同步主分支功能到浏览器扩展

Status: implemented

## Problem

扩展分支基于 `90a4bca`，主分支已推进到 `0200d60`。仅合并 Python 文件不会让扩展获得聚合任务领奖、登录失效保护、新版活动页识别和运行中更新任务的能力。

历史检索：仓库没有 `.agents/notes/` 活跃笔记；现有[扩展设计](../../../../docs/superpowers/specs/2026-07-05-extension-port-design.md)部分重叠，继续保留其单房间、浏览器登录态、offscreen 引擎和 service worker 看门狗的边界。本篇负责新增功能的适配。

## Decision

- 将 `origin/main` 的 `0200d60` 合并到 `feat/extension-port`，保留扩展优先的 README 和来源说明；Python、Docker、macOS 功能随合并保留。
- 扩展仍复用浏览器 B 站登录态。已登录时显示正在使用的浏览器账号，仅确认未登录时显示「去 B 站登录」官方入口；检查中、网络故障时隐藏登录入口，避免让已登录用户误以为还需登录或切换账号。启动前校验账号，每分钟复查；明确失效或 UID 改变时停止并清除自动恢复意图，网络故障只显示错误并稍后重试。同一账号的 CSRF 更新同步给现有会话及任务监控。
- 任务发现同时支持 `__initialState`、`__BILIACT_EVAPAGEDATA__.layerTree` 和房间静态 HTML。继续汇总所有任务，适配旧版分组及新版扁平布局，不引入任务组选择界面。
- 运行中更新任务 ID、查询间隔和自动领奖开关时只更新任务监控，不重启心跳；配置编辑后持久化。
- 聚合任务按 checkpoint 的 `sid` 领奖，已完成子任务可独立领取，不等待全部档位完成；去重、限频退避和逐任务间隔保持有效。显示实际任务进度、子任务、领奖结果及运行时长，并保留手动刷新和领奖入口。
- 停止时中止正在进行的网络请求，防止迟到的 enter/领取动作继续执行；限频响应直接交给领奖退避处理，不通过刷新 WBI 立即重发。
- 仓库的 `npm run verify-notes` 直接使用笔记技能提供的树、格式和归档校验脚本，以 Node.js 22.18+ 的 TypeScript 支持运行，不引入运行时依赖。

## Alternatives considered

1. 只合并主分支：冲突少、上游历史完整，但扩展独立的 JavaScript 实现不会获得新增行为，不能满足功能同步。
2. 只挑选并翻译功能提交：改动范围较小，但会丢失主分支的 Python 修复、测试与分发能力，后续同步仍重复处理相同历史。选择合并历史并补齐扩展适配。
3. 在扩展复制 Python 扫码登录与 WebUI：入口与上游一致，但浏览器已有 Cookie 和官方扫码登录页，且现有 popup 足以展示单房间状态；继续复用浏览器登录和 popup。

## Verification

- 合并父提交为原扩展分支 `e0b3bea` 与 `origin/main` 的 `0200d60`；Python、测试、Docker 和打包文件与该主分支一致，README 和许可证冲突保留扩展入口与双方署名。
- `npm test`：123 项通过，包含 100 项原有测试及新增账号保护、子任务领奖、限频、任务识别、热更新、停止中断和浏览器消息链路回归。
- `uv run --no-project --python 3.12 --with-requirements requirements.txt --with-requirements requirements-web.txt python -m unittest discover -s tests -q`：130 项通过。
- 用最新 Python 模块重新运行 `extension/scripts/gen_vectors.py`，`test/fixtures/vectors.json` 无差异。
- 浏览器加载实际 popup HTML/CSS/JS，以离线 Chrome API 和接口替身检查账号及子任务展示、配置回填、识别后热更新、配置保存、刷新、领奖结果展开和停止；心跳启动消息没有被任务更新重复触发，无横向溢出。账号入口另覆盖初次检查、已登录、未登录、网络异常及恢复登录的状态切换，仅未登录时可见。
- `npm run verify-notes` 校验笔记树、格式和归档；`git diff --check` 校验合并结果。

## Consequences

扩展通过现有 popup 和 offscreen 获得主分支的账号保护、任务发现及领奖改进，任务设置更新不影响原会话身份、启动时间和累计心跳；上游历史保持完整，下一次同步可以沿主分支继续合并。

Python 与 JavaScript 两套实现仍需同时维护；账号复查周期为一分钟，无法保证 Cookie 改变时立即停止。配置草稿与运行意图分开保存，停止后的恢复意图先落盘，网络异常与明确失效分开处理。同账号续签更新 CSRF，账号变化必须停止并由用户重新启动。

离线回归和浏览器交互验证不证明真实活动计时或领奖被服务端接受；浏览器后台常驻及真实账号活动验收仍按 [runbook](../../../../docs/superpowers/specs/2026-07-05-extension-port-verification.md)执行。
