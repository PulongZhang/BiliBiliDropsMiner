# BiliBili Drops Miner · MV3 扩展

B 站直播掉宝挂机的 Chrome / Edge 扩展，运行时无需 Python 或 Node.js。

## 加载与使用

1. 打开 `chrome://extensions`（Edge 使用 `edge://extensions`），开启「开发者模式」。
2. 「加载已解压的扩展程序」，选择本目录；更新代码后在扩展管理页点「重新加载」。
3. 在浏览器登录 B 站，打开扩展面板确认账号；「登录 / 切换账号」进入官方登录页，可使用官方扫码登录。
4. 打开直播间后点「识别当前页」，或输入房间号后点「按房间获取任务」。两种方式兼容旧版状态、新版 EVA 组件树及扁平任务列表。
5. 设置会话数（默认 100）、任务查询间隔和自动领奖开关，点击「启动」。任务 ID 留空时只维持心跳。

## 运行中的操作

- 识别到当前房间的新任务后直接更新监控；手动编辑任务 ID、间隔或自动领奖开关后点「应用任务设置」。这些操作不重启心跳会话。
- 「刷新进度」立即查询任务；「领取奖励」按聚合任务的子任务 SID 逐个检查并领取，结果在可展开的「领奖结果」中显示。
- 自动领奖只处理已完成子任务，已领取项跳过；关闭自动领奖后仍可手动领取。
- 面板展示账号、运行时长、会话计数、累计心跳、任务及子任务进度、领奖结果。进度以服务端返回为准。
- 配置编辑后自动保存；运行中的房间和会话数保持固定，切换房间或会话数需先停止。
- 启动前检查账号，运行中每分钟复查。登录失效或 UID 改变会自动停止并清除续跑意图；短暂网络故障保留运行状态并稍后重试。
- 关掉直播间标签页后 offscreen 引擎继续工作；浏览器重启或 offscreen 回收后，看门狗在确认账号后按已保存配置恢复。

## 开发与验证

扩展测试使用 Node.js 内置 test，无第三方依赖；仓库笔记校验使用 Node.js 22.18+ 的 TypeScript 支持。

```bash
# 仓库根目录
npm test
npm run verify-notes

# 仅当签名协议变化时更新 Python 真值向量（需 uv）
cd extension
npm run gen-vectors
```

测试覆盖 HMAC/WBI/x25Kn 签名对拍、会话调度、任务识别、聚合领奖、限频、停止中断、热更新、账号保护与浏览器消息链路。浏览器 API 及任务接口使用离线替身，真实活动验收见 [runbook](../docs/superpowers/specs/2026-07-05-extension-port-verification.md)。

## 结构

- `background.js`：浏览器 API、配置、账号检查、消息中继和看门狗。
- `offscreen/`：心跳引擎、任务监控和网络请求中止。
- `popup/`：控制面板。
- `lib/`：协议、签名、解析器和状态机。
- `test/`：Node 回归测试与 `fixtures/vectors.json`。
- `scripts/gen_vectors.py`：用 Python 模块生成签名真值，绕过 GUI 依赖。

架构约束见[初版设计](../docs/superpowers/specs/2026-07-05-extension-port-design.md)，此次主分支同步的边界与取舍见[决策记录](../.agents/notes/implemented/feature/2026-11-08-sync-main-to-extension.md)。Python 扫码登录、Docker WebUI 和 macOS 打包随主分支合并保留在仓库中；扩展使用浏览器登录态和本地控制面板。
