# 变更记录

> 本文件记录**每一次改动**，随仓库走。规则见 [`../AGENTS.md`](../AGENTS.md)。
>
> 写法约定（借鉴 Keep a Changelog，但不追求逐条对应 git tag）：
>
> - 每次提交都要在这里留一条，**在提交前写**，和代码一起提交；
> - **每条记录以日期开头**（`YYYY-MM-DD`，取改动实际落地那天）；提交号能填就写在条目末尾，没填不代表没提交；
> - 分类只用六种：`新增` / `修复` / `变更` / `性能` / `文档` / `测试`；
> - 每条一行说清「改了什么 + 为什么」，能指到文件就指到文件；
> - 已经有条目就**追加**，不要重写历史；发版时把 `[未发布]` 收成版本号并写日期；
> - **同一次改动还要在下面的「时间线」补一行**（按日期正序）；时间线只放先后顺序，细节留在分类里；
> - 用户可见的行为变化必须写；纯内部重构写一行即可，不必解释过程。
>
> 设计阶段的「结论变化」（v1→v6 的决策取舍）不在本文件，见
> `E:\dsh-config\docs\superpowers\specs\2026-11-09-dsh-mermaid-studio-changelog.md`。

## 时间线

时间线只回答「什么时候、按什么顺序」。细节看下面 `[未发布]` 的分类，不要在这里复述。

日期取提交时间（+08:00）。本文件 2026-11-12 才建立，之前的行只有主线，不逐条对应改动。

| 日期 | 阶段 | 发生了什么 | 提交 |
| --- | --- | --- | --- |
| 2026-11-09 15:55 | 起步 | 初始化仓库 | `3e97e0c` |
| 2026-11-09 23:11 | 可用版本 | 第一个能用的版本：DSH 对话里的 mermaid 围栏实时渲染成图 | `6add68e` |
| 2026-11-09 23:22 | 文档 | README 重写成中文默认 + 英文，补安装与协议说明 | `f328557`、`da7e045` |
| 2026-11-10 09:58 | 性能 | 删掉引擎空闲预热，加载期长任务 2×180 ms → 0 | `fc224d9` |
| 2026-11-10 10:21–10:26 | 交互 | 常驻工具栏换成悬浮按钮行，再挪到图表右上角 | `39f341e`、`840b0f0` |
| 2026-11-10 10:39 → 10:48 | 试错 | 视觉重做（画布跟随图走）提交 9 分钟后回退 | `ef81337` → `562bd55` |
| 2026-11-10 17:30–18:02 | 交互 | 统一图标集、全屏 overlay 换同套悬浮按钮、缩放改为可输入百分比 | `f0fac15`、`39b4dab`、`f07adeb` |
| 2026-11-10 20:08–20:38 | 发布准备 | `qa/` 退出跟踪、npm 元数据补齐、开发部署改 npm 命令 + lockfile、CI 按 tag 发布、包名改 scoped | `0163afe`…`41e5611` |
| 2026-11-11 21:21 | 修复 | 注册 ID 改成完整包名，修掉 DSH 启动时重复注册、插件不激活 | `fb90bc5` |
| 2026-11-12 15:38 | 性能 P0 | 耗时台账、字体守卫、骨架预留、受控预渲染 | `3802789` |
| 2026-11-12 15:40 | 文档 | 建立本文件与 `AGENTS.md`，定下「每次改动留一条」 | `3768836` |
| 2026-11-12 当前 | 修复 / 性能 / 文档 | 缓存键哨兵改整值判据、≥21 个围栏分批消费、缓存容量增量记账（工作区，未提交）；本文件加时间线 | — |
| 2026-11-12 20:30 | 修复 / 性能 / 变更 / 测试 | 第二轮：指令剥离爆栈、断路器出口、L1 字节预算、localStorage 全键扫描、sanitize 定位属性收紧、两处无界 Map、松手仍平移、切主题叠影；测试 39 → 86 条（`6011743`） | `6011743` |
| 2026-11-13 13:30 | 测试 / 修复 | 真实浏览器通道打通（playwright-core + 全量 harness 32/32）；浏览器用例揪出既有缺陷「中文 subgraph 标题被 id 白名单误杀」，并发现 #4/#21 两条旧用例把 bug 行为写成了契约 | `6011743` |
| 2026-11-13 14:20 | 文档 | README 中英按 `AGENTS.md` 第 5 节收窄（去掉性能、开发与 Limits，部署合成三条路） | `ccc05c6` |
| 2026-11-13 20:12 | 图标 | 换成时序线图标（64 网格），并补上 `package.json` 的 `icon` 字段 —— 此前插件页读不到本包图标；1024 深浅双版存进 `assets/icons/` | `4b7f815` |
| 2026-11-13 20:55 | 发布 | 0.2.0 发布到 npm（GitHub Actions，推送 tag `v0.2.0` 触发）；包内含新图标与 `assets/icons/` | `4b7f815` |
| 2026-11-13 21:06 | CI | publish 工作流的 checkout / setup-node 升到 v5（v4 仍以 Node 20 为目标，GitHub 已强制 Node 24）；0.2.1 发到 npm（tag `v0.2.1`） | `ad8f139` |
| 2026-11-13 21:15 | 文档 | README 顶部加插件图标，`<picture>` 按深浅主题切 light/dark 两套 SVG | — |
| 2026-11-14 12:00 | 性能 / 变更 | 多图串行渲染之间让出任务并按耗时冷却（8 张重图最长无帧间隔 517→333ms，帧 26→75）；待渲染卡片加遮罩与「排队中 / 渲染中」文案 | `becaf82` |
| 2026-11-14 12:30 | 文档 | README 图标从标题上方挪到标题下方居中 | `02353ff` |
| 2026-11-14 12:40 | 文档 | 提交身份改成 `KaiHan <hankai233@outlook.com>`，重写本轮 4 个已推送提交并强推；规则进 AGENTS.md 第 6 节 | `9233f01` |
| 2026-11-14 12:50 | 发布 | 0.2.2 发到 npm（推送 tag `v0.2.2` 触发 GitHub Actions） | `becaf82` |
| 2026-11-14 17:05 | 修复 | 清掉身份事故的残留：文档不再写错误身份的字面值、不再引用强推后作废的旧提交号，本机 reflog 与不可达对象一并清掉 | `a9edbfa` |

## [未发布]

### 修复

- 2026-11-14 · **清掉身份事故的残留，四处一起收。** ① 文档里不再写那个错误身份的字面值，只写清规则的成败：规则该记的是「不许用 `-c` 临时覆盖身份」，那个假地址留在文档里除了散布它没有任何作用。② `0.2.2` 的记录里引用了 4 个旧提交号：强推后它们已不在任何分支上，但 GitHub **仍能按 SHA 取到**（不可达对象不会立即回收），写进记录既指不到历史、又给那个错误身份多留一处入口 —— 改成描述换号这件事本身，不再指名旧号。③ 本机 reflog 与不可达对象仍留着那 4 个旧提交（`git log --reflog` 还查得到），已 `reflog expire --expire=now --all` + `gc --prune=now` 清掉，本机任何 git 视图都不会再显示那个作者。④ 需要留档的真实状态：那 4 个提交在 GitHub 上是**不可达但仍可取到**的对象，且被归到真实账号 `hanka`（显示名 Hanna Seweryn），所以仓库侧栏的 Contributors 仍会显示 2 个人 —— 默认分支、`/graphs/contributors`、`contributors` API 都只有 1 个（Hankai233）。客户端无法回收这些对象，彻底清除只能请 GitHub Support 处理（或等其内部 GC，不保证）。**教训**：`git fetch origin <sha>` 失败不代表对象在 GitHub 上不存在，那个判断是错的，正确做法是查 `repos/{owner}/{repo}/commits/{sha}`。（`AGENTS.md`、`docs/CHANGELOG.md`）（`a9edbfa`）

## 0.2.2 - 2026-11-14

这一版只做一件事：**多张图不再连着把主线程占满**。串行队列本来只保护 `mermaid.initialize()` 的全局配置，两张图之间没有让出任务，渲染多张时页面整段无法绘制、也无法响应输入（实测 8 张 120 节点的图，2.2 秒里 96% 是连续主线程块，最长 517ms 没有一帧）。现在两张图之间会真正停一下再开下一张，冷却按上一张的实际耗时自适应；等不到的卡片有遮罩和「排队中 / 渲染中」文案。README 的图标挪到标题下方居中，另外这次改动里 agent 写错了提交身份，已重写修正并把规则写进 `AGENTS.md`。

### 文档

- 2026-11-13 · **README 顶部加插件图标（中英双版），用 `<picture>` 跟随深浅主题。** GitHub 支持按 `prefers-color-scheme` 切 `<source>`：深色主题取 `assets/icons/icon-dark.svg`（`#5b7bff`），浅色取 `icon-light.svg`（`#002fa7`）—— 单张透明图在 GitHub 深色底上只有 1.8:1，等于看不见；`<img>` 保留作降级，npm 这类不解析 `<picture>` 的渲染器仍会显示浅色版。图标与插件页那张 64 网格的 `icon.svg` 同源，只是走 1024 的矢量版。（`README.md`、`README.en.md`）
- 2026-11-14 · **图标从标题上挪到标题下并居中。** 压在标题上面时，仓库页第一眼是一片空白加一张小图，标题被推到下面；改成「标题 → 居中图标 → 一句话简介」，`<p align="center">` 包住 `<picture>`，深浅两套的降级路径不变。（`README.md`、`README.en.md`）（`02353ff`）
- 2026-11-14 · **提交身份修正为 `KaiHan <hankai233@outlook.com>`，规则写进 `AGENTS.md` 第 6 节。** 本轮改动里 agent 用 `git -c user.name/user.email` 临时覆盖了身份，写进去的是一个不属于本账号的 `noreply` 地址 —— GitHub 按邮箱归因，那 4 个已推送的提交因此成了未关联作者，贡献也不计。已用 `git filter-branch --env-filter` 重写这 4 个提交（换号后强推，旧号作废），本文件里引用旧号的 7 处一并改成新号；仓库本地 `user.name` / `user.email` 已设成这个身份。（`AGENTS.md`、`docs/CHANGELOG.md`）

### 性能

- 2026-11-14 · **两张图之间让出任务并冷却，冷却值按上一张的实际耗时自适应（下限 32ms、上限 120ms）。** 串行只保证 `mermaid.initialize()` 的全局配置不被两张图抢，并不保证浏览器能画：`finish()` 里直接 `pump()`，下一张渲染接在同一任务后面。`qa/probe-freeze.mjs` 实测「8 张 120 节点图」整批 2219ms 里有 2129ms 是连续主线程块（占 96%），rAF 最长 517ms 没有一帧，长任务之间只有 5~8ms 缝隙。改成任务间冷却后同样 8 张：最长无帧间隔 517→333ms，整批期间画出的帧 26→75，>250ms 的无帧间隔 3→2；代价是整批耗时 2219→3280ms —— 工作总量没变，只是摊开成看得见的 8 步。第一张图不受影响（只在两张之间等），单张图仍然是「要就立刻渲」。（`src/client/queue.js`、`src/client/config.js`）（`becaf82`）
- 2026-11-14 · **冷却不做成一刀切。** 17ms 的小图付 120ms 空转，12 张就从 486ms 变成 1901ms；改成 `clamp(MIN_RENDER_GAP_MS, 上一张耗时, RENDER_COOLDOWN_MS)`（32/32~120）之后同样 12 张是 955ms，期间画出的帧 20→61 —— 快图只付一帧，慢图才用满上限。（`src/client/queue.js`）（`becaf82`）

### 变更

- 2026-11-14 · **待渲染卡片补上遮罩，并区分「排队中 / 渲染中」。** 此前记住了尺寸的卡片在 `data-sized="1"` 下把三根脉冲条藏掉，待渲染就是一个没有任何指示的空框；加了节流之后「等」变成常态，空框更容易被读成坏了。遮罩沿用画布底色，文案走 `::after{content:attr(data-label)}`（状态切换不加 DOM 节点），记住了尺寸的盒子改用横向扫光表示在干活，`prefers-reduced-motion` 下静止。`scan.js` 给前台作业挂 `onStart`，队列真正拿到槽位时才把文案从「排队中」换成「渲染中」—— 加了冷却之后这两个词才真的不是一回事。（`src/client/card.js`、`src/client/styles.js`、`src/client/scan.js`）（`becaf82`）

### 测试

- 2026-11-14 · 队列节流两条用例：相邻两张渲染之间有冷却且第一张不延迟；便宜图只付一帧而不是整个冷却上限。原有两条排序 / 断路器用例显式传 `cooldownMs: 0`，它们验的是顺序不是节奏。（`test/queue.test.mjs`）（`becaf82`）

## 0.2.1 - 2026-11-13

只有 CI 动过：publish 工作流的 `actions/checkout` 与 `actions/setup-node` 从 v4 升到 v5，消掉 0.2.0 那次运行里的 Node 20 弃用告警。插件代码、构建产物与包内容与 0.2.0 一致。

### 变更

- 2026-11-13 · **publish 工作流的 `actions/checkout` 与 `actions/setup-node` 从 v4 升到 v5。** 0.2.0 那次运行带了告警「Node.js 20 is deprecated…forced to run on Node.js 24」—— v4 系列的 action 仍以 Node 20 为目标，靠 runner 强制抬到 24 才跑起来；v5 自身就跑在 Node 24 上，告警随之消失。`node-version` 仍显式钉在 24、构建与测试步骤一字未动，所以这次只动 workflow。（`.github/workflows/npm-publish.yml`）

## 0.2.0 - 2026-11-13

插件页第一次真正显示本包的图标：换成时序线的 64 网格版，并补上 `package.json` 顶层一直缺的 `icon` 字段（没有它，宿主拿不到 `meta.icon`，旧图标从未被任何界面读到）。1024 的深浅双版留在 `assets/icons/` 给 README 与宣发。

### 新增

- 2026-11-13 · **换成时序线图标，并补上 `package.json` 里一直缺的 `icon` 字段 —— 这个字段不在，插件页根本读不到本包的图标。** 宿主插件页（`dsh-client-ui-plugin-manager`）用 `PackageArtwork` 把 `pkg.meta.icon` 当 `<img src>` 渲染：行内 30px、卡片 36px，外面套 `.rowIcon` 的 0.5px 边框；`meta.icon` 由 `package.json` 顶层 `icon` 字段解析（内置插件都这么写，如 `dsh-experimental-inspector` 的 `"icon": "./icon.svg"`），而本包此前只有 `files` 里的 `icon.svg`、没有 `icon` 字段，所以旧图标不会被任何界面读到。新 `icon.svg` 按 64 网格重画：三条生命线 + 一条消息 + 一条虚线回程，线宽 3.5、方框 10（缩到 30px 还剩 1.6px 笔画），并省掉 1024 版的第二枚箭头（30px 下两枚箭头只会糊成一片）；颜色取 `#3d6bff`，白色面上 4.2:1、深色面上 3.8:1 —— `<img>` 渲染拿不到 `currentColor`，旧文件里的 `stroke="currentColor"` 实际会被解析成黑色，所以深浅两个主题只能用一档中间色，而不是继承。`assets/icons/` 另存 1024 的深浅双版（`#002fa7` / `#5b7bff`，透明底）给 README 与宣发用，`files` 加上 `assets`。（`4b7f815`，`icon.svg`、`package.json`、`assets/icons/`）

### 文档

- 2026-11-13 · **README 收窄到 `AGENTS.md` 第 5 节的白名单内容（中英双版）。** 删掉「性能相关的三个机制」「怎么自己判断快慢」两节与英文版的 `Limits` 段：性能数字和调试台账属于本文件与代码注释，放进 README 会让首页变成性能报告；删掉「开发」一节，`npm run build` / `npm test` 的用法在第 2 节和 CI 里已经有约束。部署改成三条路：dsh desktop 输入包名安装（插件页 → 添加插件 → 安装第三方插件 → `@hankai233/dsh-mermaid-studio`）、从源代码构建后按本地目录装、让 Agent 构建安装；装后校验，以及与 `dsh-mermaid-smooth` 的冲突提示，也不进 README，白名单里没有这两项。顺带修掉 Agent 提示里的旧写法 —— 原先让人手改 `profile/package.json` 的 `dsh.profile.bundles`，且那里写的是短名 `dsh-mermaid-studio`，与 `package.json` 的 scoped 包名和第 3 节的注册 ID 不一致；现在改走插件页或 `plugin_manager install_bundle`，两边都对得上。（`ccc05c6`，`README.md`、`README.en.md`）

## 0.1.1 - 2026-11-13

0.1.0 已发布到 npm；0.1.1 是验收审查后的修复版本：三个高危（≥21 个围栏丢图、源码含 `undefined` 不渲染、缓存写路径全库扫）、两个中危（指令剥离爆栈、断路器后无出口）、七个低危 + 一条既有缺陷（中文 subgraph 标题误判）。单元 87 条、真实浏览器 32 条全绿。

### 修复

- 2026-11-11 · **注册 ID 与包名不一致，导致 DSH 启动时报 `web boot: 1 entry did not activate`。** `src/client/register.js` 用的是短名 `dsh-mermaid-studio`，而宿主按 `package.json` 的 `name`（`@hankai233/dsh-mermaid-studio`）建 client 模块行；短名让加载器判定「脚本执行了但没注册」，回退到单包 URL 再执行一遍，第二次 `__ModuleLoader__.load()` 撞上 `duplicate factory registration`，插件拿不到 fiber。改为完整包名并加回归测试。（`fb90bc5`）
- 2026-11-12 · **缓存键把源码里的 `undefined` 误判成哨兵，整图不渲染。** 哨兵判据是子串匹配（`value.indexOf('undefined') >= 0`），而 `src:` 段就是图源码，`A["is x undefined?"]`、叫 `null`/`unknown` 的节点、讲 JS 的图都会命中；异常抛在 `createRecord()` 的 `keyFor()` 里，**卡片还没创建**就被 flush 的 try/catch 吞成一条 stats 记录，用户只看到「这张图就是不渲染」且没有错误卡。改为整值相等（`=== 'undefined' / 'null' / 'unknown'`）：真缺失的字段因为字符串拼接结果恰好是整值仍会被抓住。（`src/client/key.js`）
- 2026-11-12 · **首次出现 ≥21 个围栏时，第 21 个起被静默丢弃、永远停在源码态。** `flush()` 用 `Array.from(candidates).slice(0, BATCH_MAX)` 后直接 `clear()`，超出 20 的候选永久消失；切会话/刷新/恢复长对话正是「root 一次就带满围栏」的形态，而静态历史不再有 mutation 把它们加回来。改为分批消费：从 Set 迭代器每批取 `BATCH_MAX` 个、取出即删（集合严格收缩，天然防死循环），剩余走与 `candidate()` 相同的 idle 调度再排一批；`dropRoot()` 之后该根不再恢复调度。（`src/client/scan.js`）
- 2026-11-12 · **指令剥离的递归把围栏直接逼到 `RangeError`，图永远不渲染。** `stripInitDirectives()` 每遇到一条要保留的 `%%{wrap}%%` 就递归一次尾巴，实测约 5000 条（≈60 KB）即 `Maximum call stack size exceeded`；异常被 `flush()` 捕获成一条 stats 计数，围栏既不出图也不报错。改成单向前进游标 + 一次 O(n) 扫描，栈深变 O(1)：同样输入从「爆栈」变成 0.75 ms，且 2000 条时的输出与旧实现逐字节相同。（`src/client/fence.js`）
- 2026-11-12 · **断路器打开后新卡片的骨架一直转，没有任何出口。** `pump()` 在 `breakerOpen` 时直接 return，但 `push()` 仍把 job 推进 `pending`；之后建的卡片 `resetButton.hidden` 初始为 true，只有 `showError()` 才会显示，于是既无超时、也无错误卡、也无重置按钮，`pending` 还随滚动持续增长。改为打开时立即结算：走原有 `onOutcome` 通道发 `timeout`（带 `breaker: true`）而非 `error` —— `error` 会写 `NEGATIVE_TTL_MS` 负缓存，`reset()` 之后那张卡还要被「5 分钟内不自动重试」卡住，恢复不干净；`timeout` 不写负缓存，而重置按钮的显示条件恰好是 `isBreakerOpen()`。（`src/client/queue.js`）
- 2026-11-12 · **松开鼠标后不按键移动也在平移图表。** `setPointerCapture` 失败被 try/catch 吞掉，而 `onPointerMove` 从不检查 `event.buttons`；捕获失败时在卡片外松手，`pointerup` 根本到不了本元素，`drag` 就一直非 null，直到下一次 `pointerdown`。补 `buttons === 0` 视为释放（`pointerType: 'touch'` 排除，避免把触摸拖拽误判成松开），并在捕获失败时挂一个 window 级一次性 `pointerup`/`pointercancel` 兜住「松手后再没有 move」的残留。（`src/client/viewport.js`）
- 2026-11-12 · **切换主题时旧图和新骨架叠在一起闪一下。** `decide()` 无条件 `card.showPending()`，而 `showPending()` 只翻 `data-mms-state`、不清 stage，骨架是覆盖层 —— 旧 SVG 还在，两者同时可见。改为按「**同一份源码**」判断（不是同一个 key：换主题时 key 变、source 不变），同源时保留旧图，新 SVG 落地直接被 `inject` 换掉。（`src/client/scan.js`）
- 2026-11-12 · **L1 里命中但不可用的记录被刷新成最新，永不淘汰。** L1 命中会把记录提到 LRU 尾部，而 `get()` 发现 `isUsable()` 为 false 时直接掉头去查 L2，那条过期/旧 schema 的记录从此稳坐最新位、占着坑。改为不可用即从 L1 删除（同时扣减字节计数），L2 照旧查（别的标签页可能写了可用副本）。（`src/client/cache.js`）
- 2026-11-12 · **两处只增不减的 Map。** 后台预渲染去重表 `bgAttempted` 每个不同源码留一个键、只在 dispose 清空；失败负缓存 `app.negative` 的 TTL 只在**读**时判断，条目永不删除。前者改为插入序 Map + 上限 400（按溢出量淘汰最旧，不清空 —— 清空会让所有离屏图立刻重排一遍，正是这道闸门要防的 burst）；后者改为写时清扫过期 + 上限 200（仍超限则丢最旧写入，方向只会让某张图**提前**可重试，不会变死路）。（`src/client/scan.js`）
- 2026-11-13 · **中文 subgraph 标题会让整张图变成错误卡（既有缺陷，不是本轮改动引入）。** mermaid 用 subgraph 的标题拼 cluster 的 id（`subgraph 分组甲` → `id="mms-b-1-1-分组甲"`），而 `sanitize.js` 的 `ID_VALUE` 只放行 ASCII，于是 `attrValueAllowed('id', …)` 判为 `unsafe value for id`，整张图被 `blocked` 成「渲染结果包含被阻止的内容」。节点与边标签走的是文本、不走 id，所以这个坑一直没暴露 —— 直到真实浏览器第一次渲染带中文 subgraph 的流程图。id 是文档内的名字，不能发起请求也不能执行脚本，收紧到 ASCII 换不来任何安全性，只会误杀；改为放行 Unicode 区段（`\u00A0-\uFFFF`），仍然拒绝空白、引号、`<>`、`#`、括号、反斜杠等可能冲出属性或选择器的字符。（`src/client/sanitize.js`）

### 性能

- 2026-11-12 · **`__mmsStats` 增加耗时台账。** 渲染耗时进环形缓冲（窗口 20），暴露 `renderLastMs` / `renderP50` / `renderP95` 与当次源码行数、字符数；`PerformanceObserver` 收整页 longtask，按队列记录的渲染窗口分出 `longTaskCount` 与 `longTaskRenderCount`。没有它，发布后每一次「很慢」的反馈都无法裁决。（`3802789`，`src/client/stats.js`、`src/client/queue.js`、`src/client/index.js`）
- 2026-11-12 · **缓存写入加字体守卫。** `document.fonts.status !== 'loaded'` 时跳过 L1/L2 写入：缓存记录会把量算尺寸冻结 30 天，字体未就绪时存进去的错几何无法自愈。平台没有 FontFaceSet 时视为就绪，不得因此关掉缓存。（`3802789`，`src/client/cache.js`，计数 `cacheSkipFont`）
- 2026-11-12 · **骨架预留尺寸，消除「空盒子 → 窜出大图」。** 新增 chunk `src/client/sizes.js`：按缓存键同步读 localStorage 尺寸备忘（上限 200 条、按龄剪枝），建卡即占住高度；无记录时按源码行数猜 96–420 px。读不到就猜，永不阻塞渲染。（`3802789`，`src/client/sizes.js`、`src/client/card.js`、`src/client/scan.js`）
- 2026-11-12 · **受控预渲染：把 ~240 ms 主线程阻塞从滚动时刻移走。** 视口外、源码稳定 ≥600 ms 的围栏在「用户停手 ≥1 s + 空闲」时提前渲染并写缓存。闸门是主体：仅 `cacheEnabled`、仅已发生至少一次手势之后（加载期保持零长任务）、标签页可见、队列空、一次一个；前台渲染插到后台任务之前并丢弃排队后台任务；后台失败不写负缓存、不弹错误卡、不计入熔断。（`3802789`，`src/client/scan.js`、`src/client/queue.js`、`src/client/index.js`、`src/client/config.js`）
- 2026-11-12 · **缓存写入不再每次都 `getAll()` 全库：字节总量改为增量记账。** 原来 `put()` 之后必跑 `enforceCapacity()`，而它用 `store.getAll()` 把整个 L2 反序列化进堆；缓存越满，每张图落盘越卡，卡顿正好落在「渲染完成」的尾部。现在打开库后惰性初始化一次总量，`put` 只做一次按键 `get` 拿旧尺寸（仅覆盖写需要差值），删除/淘汰扣减，**只有总量超过 cap 才允许一次全库扫描**，且该扫描兼作校准（把总量重算为快照精确值）；`dropDatabase()` 让计数器失效，配额重试分支保持原有行为。（`src/client/cache.js`）
- 2026-11-12 · **L1 内存缓存只按条数裁剪，不按字节 —— 真正的 OOM 源。** `L1_MAX = 50` 但每条记录随身带完整 SVG，50 张 1–2 MB 的图约 100 MB 常驻堆，而 `CACHE_MAX_MB = 32` 只管 L2，L1 完全没有反压。改为加字节预算（取 L2 cap 的一半，16 MB），覆盖写先扣旧值再加新值（否则同一张图反复渲染会把计数器顶爆），超预算按 LRU 从尾部淘汰；单条大于整条预算的记录不留在 L1（L2 仍有，下次是慢命中而非未命中）。（`src/client/cache.js`）
- 2026-11-12 · **每建一张卡就扫一遍 origin 的 localStorage 键。** `set()` 末尾用 `keys().length > max` 判断是否剪枝，而 `keys()` 要 `Object.keys(localStorage)` 过滤出本插件的行 —— localStorage 是整个 origin 共享的，宿主和别的插件可能有上千个键，而 localStorage 是同步阻塞的。改为进程内计数（首次成功写入扫一次，之后 O(1) 增减），每 32 次写入重新计数一次以纠正别的标签页造成的漂移；写入抛 quota 错时立即剪枝并重试一次。上限 200 仍然强制，`size()` 变 O(1)。（`src/client/sizes.js`）
- 2026-11-12 · **超长围栏在「判定超长」之前先被完整解析了一遍。** `parseFence()` 先 `stripGovernanceKeys(raw)`（内部走指令剥离，O(n·k) 且含每指令切片重拼），之后才计算 `overLong` —— 一个 200 KB 的「误贴进 ```mermaid 围栏的日志」会先被完整啃一遍再被丢弃。改为按 `raw.length` 先做廉价闸门，超长直接返回 `overLong` 短路，不做剥离与归一化。（`src/client/fence.js`）

### 变更

- 2026-11-12 · **删除 `baseConfig` 里从未生效的 `htmlLabels` 参数。** 它被接收但从未写入配置，也不在缓存键里，注释却称 per-call；不翻成 `false` 是因为插入布局实测只差约 0.5 ms，却会改变标签换行与裁剪。（`3802789`，`src/client/render.js`）
- 2026-11-12 · **收窄 sanitize 白名单里的定位类 CSS，并补上资源上限。** 白名单放行 `position/top/left/z-index/background`，因此 foreignObject 里一个 `position:fixed;inset:0;z-index:2147483647` 的面板理论上能盖住宿主 UI（图内容来自助手输出）。现在之所以打不穿，全靠 `.mms-card{overflow:hidden}` + `.mms-vp/.mms-stage` 的 `contain:paint` 兜着 —— 这是一条只差一行的防线。**没有删属性**（mermaid 的 htmlLabels 依赖 `position:absolute/relative` 排版），只收紧取值：`position` 只允许 `static/relative/absolute`，`z-index` 限 ±100（定 100 而非 10，是因为 mermaid 11.17.2 自己的主题 CSS 就发 `z-index:100`，定小会静默吃掉真实声明；其 dist 里 `position:fixed/sticky` 出现 0 次）。同时新增单属性值 100k 上限与 `<style>` 文本 200k 上限（走 `blocked` 拒绝，绝不截断 —— 截断 `d`/CSS 会产出语法残缺的 SVG），并删除不可达的 `styleValueSafe()`（`style` 属性在 `attrValueAllowed` 之前就被 `filterInlineStyle` 分支 `continue` 掉了，留着只会误导下一个改这里的人）。（`src/client/sanitize.js`）

### 文档

- 2026-11-12 · **建立本文件与 `AGENTS.md`：把「每次改动都要留一条记录」变成仓库约定**，并补上此前两条历史（注册 ID 修复、首版 P0 性能项）。README（中/英）加一行指向本文件。（`docs/CHANGELOG.md`、`AGENTS.md`）
- 2026-11-12 · README（中/英）补「三个性能机制」与「怎么自己判断快慢」，并把过时的「单张 50–90 ms」换成实测数字：120 节点/103 边约 230 ms，小图 10 ms 级，引擎首次求值另付约 180 ms。（`3802789`）
- 2026-11-12 · **CHANGELOG 加时间线：每条记录带日期，新增「时间线」一节按日期正序看完整脉络。** 分类只能看出「改了什么」，看不出先后 —— 哪几件事是同一轮试出来的、哪些隔了一天才补的，只有时间线能回答。同一条规矩写进 `AGENTS.md` 第 1 节。（`docs/CHANGELOG.md`、`AGENTS.md`）

### 测试

- 2026-11-12 · 新增 `test/stats.test.mjs`、`test/sizes.test.mjs`、`test/queue.test.mjs`（13 条）：分位与窗口上界、备忘剪枝与无存储降级、前后台抢占、后台超时不开熔断、字体守卫、耗时入账。
- 2026-11-12 · 新增 `test/key.test.mjs`、`test/cache.test.mjs`、`test/scan.test.mjs`（10 条）：哨兵整值判据（源码含 `undefined`/`null`/`unknown` 仍出 key、缺失字段仍抛）、写路径 `getAll` 调用数不随记录数增长（40 次 put 仅 1 次）且覆盖写不涨总量、超 cap 的回收仍把库压到 cap 以下、25/45 个候选全部分批建卡与 dispose 后不再建卡。合计 39 条全绿。
- 2026-11-12 · 验收用例新增 case 30（真实 Chromium）：断言「建卡即预留高度」「未发生手势前不预渲染」「视口外被预渲染且不计入 `renderCount`」。原 28 条全绿，合计 29/29。（`3802789`）
- 2026-11-12 · 新增 `test/fence-recursion.test.mjs`、`test/queue-breaker.test.mjs`、`test/cache-l1.test.mjs`、`test/sizes-keys.test.mjs`、`test/sanitize.test.mjs`、`test/scan-maps.test.mjs`、`test/viewport-drag.test.mjs`（47 条，合计 86 条全绿）：6000 条非 init 指令不再爆栈且 2000 条时输出与旧实现逐字节相同；断路器打开后 `push` 的 job 必定被结算、`reset()` 后恢复接单、`releaseSlot()` 会关窗口；40 次 put 的 `getAll` 恒为 1（证明 L1 记账没把上一轮的 L2 增量记账弄回去）、L1 字节总量不超预算、覆盖写不涨总量；1000 次 `set()` 的扫键次数 39（改前 1000）；`position:fixed` 被拒而 `position:absolute` 通过、超长属性与超长 `<style>` 被拒；`bgAttempted` 在 450 个不同 key 下不超过 400 且同 key 不重复预渲染、负缓存写入时清扫过期条目；`buttons === 0` 的 move 不产生平移而真实按住仍按 rAF 合并成每帧一次。**注意 `test/scan-maps.test.mjs` 里 `BG_CAP = 400` 是 `scan.js` `BG_ATTEMPTED_MAX` 的镜像值，改上限要同时改两处。**
- 2026-11-12 · 七份新测试都做了变异验证：把修复逐条注回「改前行为」（去掉有界 cap、去掉负缓存清扫、无条件 `showPending`、删掉 `buttons` 判断），对应断言必须变红 —— 用来排除「测试空转通过」。
- 2026-11-13 · 真实浏览器验收（Chromium + `qa/harness/run.mjs`）首次跑通全量：**32/32 通过（3 条 pending：11 需并装旧插件、18 需真 profile、24 需真实键盘）**。安装 `playwright-core` 用 `--no-save --no-package-lock`，`package.json`/lock 均未改动。
- 2026-11-13 · 新增验收用例 #31（恢复长对话：21 个围栏一次到位，断言全部建卡、每张有键、无错误态）、#32（收窄定位类 CSS 后 subgraph 边界盒与标签仍有非零尺寸、注入树里 `position:fixed/sticky` 为 0、`z-index` 全在 ±100 内）、#33（中文 subgraph 标题的 id 被放行）。三条都用独立 page，因为 #10 会卸载插件，共享页上再无关可观察。
- 2026-11-13 · 修订验收用例 #4 与 #21 的断言：**这两条原来把「旧的有 bug 行为」写成了契约** —— #4 用合成的 `pointermove` 且不带 `buttons`（真实浏览器拖拽必带 `buttons:1`），于是把「松手仍平移」的修复判成失败；#21 断言「剩余项留在队列等待重置」，而那条正是死路本身。改为按新契约断言，并各补一条反向守卫（`buttons=0` 的移动不得平移；熔断挡下的项必须当场结算且 `reset()` 后能恢复接单）。
- 2026-11-13 · 端到端结果：单元 87 条全绿（新增中文 id 用例），浏览器 32 条全绿，`npm run build` 产物 sha256 可复现。
