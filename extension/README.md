# BiliBili Drops Miner · MV3 扩展

B 站直播掉宝挂机的浏览器扩展版（MV3）。设计文档见
`docs/superpowers/specs/2026-07-05-extension-port-design.md`。

## 目录

```
extension/
├── manifest.json            # MV3 清单（随里程碑逐步完善）
├── background.js            # service worker（M4 完整实现）
├── offscreen/               # offscreen 引擎（M2/M3）
├── popup/                   # 控制面板（M6）
├── lib/                     # ES 模块
│   ├── crypto.js            # HMAC + MD5/SHA224（手写）+ SubtleCrypto ✅ M1
│   ├── wbi.js               # WBI 签名 ✅ M1
│   └── live-trace.js        # x25Kn 签名 + compactJson ✅ M1
├── test/                    # Node 内置 test，逐字节对拍 Python 真值
│   ├── fixtures/vectors.json  # 由 scripts/gen_vectors.py 生成
│   ├── crypto.test.mjs
│   ├── wbi.test.mjs
│   └── live-trace.test.mjs
└── scripts/gen_vectors.py   # 用项目 Python 模块生成签名真值向量
```

## 开发

```bash
cd extension
npm test                 # 跑签名层对拍测试（9 项，零依赖）
npm run gen-vectors      # 仅当项目签名逻辑变动时重新生成向量（需 uv）
```

## 加载扩展（开发期）

Chrome/Edge → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/` 目录。

当前 M0/M1 阶段：骨架可加载，签名层已对拍通过；挖矿引擎尚未接入（M2 起）。

## 签名层对拍策略（M1）

无 Python 真值无法保证字节一致。`scripts/gen_vectors.py` 用 stdlib `importlib`
按文件加载项目纯模块（`wbi.py`/`live_trace.py`），绕过 GUI 依赖链，零第三方包，
输出 `tests/fixtures/vectors.json`。JS 侧 `npm test` 对该文件逐字节断言。

- HMAC 6 种摘要（MD5/SHA224 为手写实现）+ 多轮嵌套
- WBI mixin key 推导、encode_query（复刻 `urllib.parse.quote(safe="")`）、w_rid
- compactJson、buildX25knSignature（含字段顺序）
