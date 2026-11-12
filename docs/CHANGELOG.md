# 变更记录

> 本文件记录**每一次改动**，随仓库走。规则见 [`../AGENTS.md`](../AGENTS.md)。
>
> 写法约定（借鉴 Keep a Changelog，但不追求逐条对应 git tag）：
>
> - 每次提交都要在这里留一条，**在提交前写**，和代码一起提交；
> - 分类只用六种：`新增` / `修复` / `变更` / `性能` / `文档` / `测试`；
> - 每条一行说清「改了什么 + 为什么」，能指到文件就指到文件；
> - 已经有条目就**追加**，不要重写历史；发版时把 `[未发布]` 收成版本号并写日期；
> - 用户可见的行为变化必须写；纯内部重构写一行即可，不必解释过程。
>
> 设计阶段的「结论变化」（v1→v6 的决策取舍）不在本文件，见
> `E:\dsh-config\docs\superpowers\specs\2026-11-09-dsh-mermaid-studio-changelog.md`。

## [未发布]

0.1.0 尚未发布到 npm。

### 修复

- **注册 ID 与包名不一致，导致 DSH 启动时报 `web boot: 1 entry did not activate`。** `src/client/register.js` 用的是短名 `dsh-mermaid-studio`，而宿主按 `package.json` 的 `name`（`@hankai233/dsh-mermaid-studio`）建 client 模块行；短名让加载器判定「脚本执行了但没注册」，回退到单包 URL 再执行一遍，第二次 `__ModuleLoader__.load()` 撞上 `duplicate factory registration`，插件拿不到 fiber。改为完整包名并加回归测试。（`fb90bc5`）

### 性能

- **`__mmsStats` 增加耗时台账。** 渲染耗时进环形缓冲（窗口 20），暴露 `renderLastMs` / `renderP50` / `renderP95` 与当次源码行数、字符数；`PerformanceObserver` 收整页 longtask，按队列记录的渲染窗口分出 `longTaskCount` 与 `longTaskRenderCount`。没有它，发布后每一次「很慢」的反馈都无法裁决。（`3802789`，`src/client/stats.js`、`src/client/queue.js`、`src/client/index.js`）
- **缓存写入加字体守卫。** `document.fonts.status !== 'loaded'` 时跳过 L1/L2 写入：缓存记录会把量算尺寸冻结 30 天，字体未就绪时存进去的错几何无法自愈。平台没有 FontFaceSet 时视为就绪，不得因此关掉缓存。（`3802789`，`src/client/cache.js`，计数 `cacheSkipFont`）
- **骨架预留尺寸，消除「空盒子 → 窜出大图」。** 新增 chunk `src/client/sizes.js`：按缓存键同步读 localStorage 尺寸备忘（上限 200 条、按龄剪枝），建卡即占住高度；无记录时按源码行数猜 96–420 px。读不到就猜，永不阻塞渲染。（`3802789`，`src/client/sizes.js`、`src/client/card.js`、`src/client/scan.js`）
- **受控预渲染：把 ~240 ms 主线程阻塞从滚动时刻移走。** 视口外、源码稳定 ≥600 ms 的围栏在「用户停手 ≥1 s + 空闲」时提前渲染并写缓存。闸门是主体：仅 `cacheEnabled`、仅已发生至少一次手势之后（加载期保持零长任务）、标签页可见、队列空、一次一个；前台渲染插到后台任务之前并丢弃排队后台任务；后台失败不写负缓存、不弹错误卡、不计入熔断。（`3802789`，`src/client/scan.js`、`src/client/queue.js`、`src/client/index.js`、`src/client/config.js`）

### 变更

- **删除 `baseConfig` 里从未生效的 `htmlLabels` 参数。** 它被接收但从未写入配置，也不在缓存键里，注释却称 per-call；不翻成 `false` 是因为插入布局实测只差约 0.5 ms，却会改变标签换行与裁剪。（`3802789`，`src/client/render.js`）

### 文档

- **建立本文件与 `AGENTS.md`：把「每次改动都要留一条记录」变成仓库约定**，并补上此前两条历史（注册 ID 修复、首版 P0 性能项）。README（中/英）加一行指向本文件。（`docs/CHANGELOG.md`、`AGENTS.md`）
- README（中/英）补「三个性能机制」与「怎么自己判断快慢」，并把过时的「单张 50–90 ms」换成实测数字：120 节点/103 边约 230 ms，小图 10 ms 级，引擎首次求值另付约 180 ms。（`3802789`）

### 测试

- 新增 `test/stats.test.mjs`、`test/sizes.test.mjs`、`test/queue.test.mjs`（13 条）：分位与窗口上界、备忘剪枝与无存储降级、前后台抢占、后台超时不开熔断、字体守卫、耗时入账。
- 验收用例新增 case 30（真实 Chromium）：断言「建卡即预留高度」「未发生手势前不预渲染」「视口外被预渲染且不计入 `renderCount`」。原 28 条全绿，合计 29/29。（`3802789`）
