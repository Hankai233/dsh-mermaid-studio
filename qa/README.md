# qa —— 验收与契约坐实工具

对应设计文档：[2026-11-09-dsh-mermaid-studio-design.md](../../../docs/superpowers/specs/2026-11-09-dsh-mermaid-studio-design.md) 的 §15.0（执行通道）。状态类内容在 [UNKNOWNS.md](../../../docs/superpowers/specs/2026-11-09-dsh-mermaid-studio-unknowns.md)（未知项 / spike 清单）与 [BLOCKERS.md](../../../docs/superpowers/specs/2026-11-09-dsh-mermaid-studio-blockers.md)（P0/P1 台账 + Gate）。

本目录是**开工前与验收期**的产物，不属于 `lib/` 运行时包体，不参与 esbuild 打包。

## 目录

| 路径 | 用途 | 对应文档 |
| --- | --- | --- |
| `spike/` | 4 个契约坐实脚本，**开工前必须跑完**并把输出回填文档 | UNK-04…UNK-08、§8.2 P1-1 |
| `selftest.js` | §15.0 执行通道 ①：插件内置自测面板（无 DevTools 也能跑） | §15.0、§15、§15.1 |
| `acceptance.mjs` | §15.0 执行通道 ②：用例清单 / 结果归档 / Gate 判定（零依赖） | §15.0、BLOCKERS.md 放行 Gate |
| `harness/` | **本仓库实际使用的执行通道**：静态假宿主页 + 真 Chromium（playwright-core 驱动），26 条用例逐条断言并写 `results/<id>.json` | §15.0、§15.2 |
| `cases.json` | 用例清单单一事实源（26 条，P0 24 条） | §15、§15.1 |
| `fixtures/` | 固定图样与 payload，保证用例可复现 | §15.0 基线环境 |
| `results/` | 每条用例产出的 `<id>.json`（**不提交**，见 `.gitignore`） | §15.0 归档格式 |

## 三条硬规矩

1. **未跑过的用例只能报 `pending`，不得报 `pass`。** 面板与 runner 都对 `pending` 计数；无断言的用例也判 `pending`。
2. **每条结果必须带基线环境**（机型 / 核数 / 浏览器版本 / DPR / 是否 CPU 节流），`cpuThrottle` 仍是 `unknown` 的记录不算归档（§15.0）。
3. **执行通道没就位时，任何「已验收」表述都不成立**（BLOCKERS.md G2）。`qa/results/` 为空 = 执行数 0。

## 推荐执行顺序

```bash
# 0. 先跑契约坐实（不写实现代码就能做）
#    按 spike/README.md 在 GUI 控制台粘贴 / 装一次探针插件
#    输出逐字回填 §3.1.1 与 UNKNOWNS.md

# 1. 看用例清单
node qa/acceptance.mjs --list

# 2. 面板跑完 → 下载 JSON → 归档
node qa/acceptance.mjs --ingest mms-selftest-1731234567890.json

# 3. 校验归档完整性 + 判 Gate
node qa/acceptance.mjs --check     # 字段 / id / 空断言 / 基线环境
node qa/acceptance.mjs --gate      # 任一条 FAIL 则退出码 1
```

## 结果文件格式（§15.0 固定）

```json
{
  "id": "3",
  "name": "切换会话再切回（L1 命中）",
  "group": "cache",
  "p0": true,
  "status": "pass",
  "startedAt": "2026-11-09T09:12:03.114Z",
  "durationMs": 412,
  "env": { "machine": "…", "cores": 8, "browser": "Chrome/…", "dpr": 2, "cpuThrottle": "none" },
  "assertions": [
    { "name": "renderCount 不增", "expected": 3, "actual": 3, "pass": true }
  ],
  "note": ""
}
```

`status ∈ { pass, fail, pending, error }`。**没有 assertions 的 `pass` 会被 `--check` 判为非法**。

## 当前状态（2026-11-09）

- 执行通道：`qa/harness/run.mjs`（真 Chromium）。**26 条用例全部产出结果文件**：23 PASS / 3 PENDING / 0 FAIL。
- PENDING 三条都有明确原因：11（需装回旧插件复现双卡片）、18（回滚演练要真实 profile + 审批计时）、24（P1 键盘焦点，合成事件驱动不了焦点）。
- `node qa/acceptance.mjs --check` 退出码 0；`--gate` 仍失败（唯一卡点 #18）。**通道成立 ≠ 验收通过。**
- `selftest.js` 是通道 ① 的页面内面板，保留给没有终端的环境；本仓库的默认通道是 `harness/`。

## harness 怎么跑

```powershell
node qa/harness/run.mjs                  # 全部 26 条
node qa/harness/run.mjs --only 1,12,17   # 指定用例
node qa/harness/run.mjs --headed         # 看着它跑
node qa/harness/run.mjs --probe-file=qa/harness/probe-scope.js   # 一次性诊断
```

需要本机有 Chrome / Edge（自动探测）+ profile 里的 `playwright-core`。用例以 `qa/cases.json` 为 id 事实源，结果写 `qa/results/<id>.json`，`requiredAssertions` 会被 `--check` 逐名校验（缺一条即判归档不合法）。
