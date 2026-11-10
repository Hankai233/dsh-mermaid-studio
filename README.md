# dsh-mermaid-studio

中文 · [English](README.en.md)

DSH 插件。对话里的 mermaid 围栏渲染成图，可以缩放、全屏、导出 SVG；渲染结果存在浏览器本地，切回同一张图不再重画。

引擎是 mermaid 11.17.2，内联在插件包里，不联网。

---

## 功能

### 围栏识别

- 以 `div.md-code-block` 为单元，语言判定取三条线索：横幅文字、`language-*` 类、严格首行关键字。
- 宿主的代码块横幅对 mermaid 显示的是本地化通用标签「代码块」，不是 `mermaid`。插件把这类通用标签交给首行规则判断，带真实语言名的围栏（`python`、`ts` 等）仍不会被误判。
- `%%{init: …}%%` 和 frontmatter 里的治理键（`securityLevel`、`htmlLabels`、`maxTextSize`、`fontFamily`、`themeVariables` 等）会从源码中剥离后再渲染。被剥离时卡片角标显示「已忽略 init 指令」，图照常出。
- 空围栏、只有注释或只有 init 指令的围栏不建卡、不进队列。

### 渲染

- 串行队列，并发 1。mermaid 的 `initialize()` 是全局配置，并发渲染会串色。
- 单项 15 s 超时只改卡片状态，不释放队列槽位；渲染永不返回时（2 倍超时）放弃当前引擎实例，换新实例继续，并记 `renderIsolated`。连续 2 次超时熔断，卡片上给出「重置渲染器」。
- 缓存键读取的是构建期注入的版本常量，不会因为算键而求值 3.5 MB 的引擎。引擎只在真的要画图时求值，并与渲染拆成两个任务，中间先画骨架。
- 懒渲染：围栏进入视口前只显示骨架。

### 缓存

| 层 | 介质 | 作用 |
| --- | --- | --- |
| L1 | 内存 `Map`，最多 50 条 | 同页滚动、切换会话后切回，同步命中 |
| L2 | IndexedDB 库 `dsh-mermaid-studio` | 刷新、重启后命中 |
| L3 | mermaid 渲染 | 只有前两层都没命中才执行 |

- 32 MB 上限，按字节做 LRU；条目 30 天过期；写入时顺手清理过期和 schema 不符的记录。
- 命中直接注入，不会出现「先看到代码、再闪成图」。
- `cacheEnabled = false` 时 L1、L2、负缓存全部关闭，并清空既有记录。
- IndexedDB 打不开（隐私模式、配额异常）时只用内存，`console.warn` 一次，功能不中断。
- 缓存键由源码、主题、字体、引擎版本、过滤规则版本组成，任一项变化都会换新条目。

### 交互

- Ctrl/⌘ + 滚轮以指针为锚点缩放；不带修饰键的滚轮仍然滚动页面。
- 拖拽平移，位移按帧合并（连续 20 次 `pointermove` 只写 1 次样式）。双击在「适应全图」和 100% 之间切换。
- 缩放上限按图的实际尺寸反算（`LAYER_MAX_PX = 8192`），避免合成层超过 GPU 纹理预算。
- 全屏是 CSS overlay，不是 Fullscreen API：Esc 关闭，焦点回到触发按钮，`body.style.overflow` 还原为进入前的值。全屏里同一套图标按钮悬浮在右上角：指针一动出现、静止 1.6 秒淡出。顺序是「放大 · 缩放百分比 · 缩小 · 重置 · 导出 · 退出」，百分比可以直接输入（回车或失焦生效），重置回到 100%。

### 导出

只有 SVG。序列化的是当前已注入、已过滤的那棵 DOM，不是缓存里的原始字符串——独立打开 `.svg` 时没有宿主 CSP 兜底，只有过滤后的树可以当交付物。

导出前补齐 `xmlns`、`xmlns:xlink`、`width`/`height`/`viewBox`，并追加 fallback 字体栈。

### 主题

始终跟随宿主的 `body[data-ds-dark-theme]`，没有手动切换。宿主切主题时先查缓存，命中就注入，所以切回来是命中而不是重画；亮、暗两套 SVG 各自成一条记录。

### 错误与降级

| 情况 | 表现 |
| --- | --- |
| 语法错误 | 卡片保留源码 + 可折叠错误条 + 重试；5 分钟内不自动重试，点重试立即生效；不写持久缓存 |
| 源码超过 50,000 字符 | 直接进错误态「源码过长，已跳过渲染」，不进队列，不显示重试 |
| 渲染结果含被阻止内容 | 错误条「渲染结果包含被阻止的内容」，`sanitizeRejected` +1，不写缓存 |
| 渲染结果无法解析 | 错误条「图表标记无法解析」，换宽松解析重试一次 |
| mermaid 加载失败 | 卡片降级为纯代码块 |
| 缓存的 SVG 被污染 | 阻止注入、角标提示、重新渲染并覆盖该记录 |

### 卸载

移除全部卡片与 `<style id="mms-styles">`，断开全部 MutationObserver / IntersectionObserver，清理全屏 overlay 与 body 样式，删除 IndexedDB 库，清空 `mms:*` 本地键和 `__mmsStats`。宿主（React）拥有的节点全程没有被写入属性，不需要恢复。

---

## 安装

要求：DSH `>= 0.2.1-rc.2`。桌面版和 Web 版都可用。

插件是「Host + Client」两半的 bundle：Host 半边只承载配置，界面和渲染全在浏览器半边。

### 从源码目录安装

仓库已经包含构建产物 `lib/`（`lib/index.js`、`lib/client.js`），可以直接装；改代码后重新构建即可。

```powershell
# 1) 构建（可选，仓库已带 lib/）
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"
node scripts/build.mjs

# 2) 构建脚本需要本机的 mermaid@11.17.2：
#    node_modules / $DSH_PROFILE_DIR/node_modules / $DSH_HOME/profiles/desktop/node_modules
#    任一处有精确版本即可，版本不符会直接报错，不会静默降级
```

注册到 profile，两种方式选一：

- **有插件管理器**：`plugin_manager install_bundle`，target 指到本目录的绝对路径。
- **手工**（没有插件管理器时）：编辑 `<DSH_HOME>/profiles/desktop/package.json`
  - `dependencies` 加 `"dsh-mermaid-studio": "link:<本目录绝对路径>"`
  - `dsh.profile.bundles` 数组加 `"dsh-mermaid-studio"`
  - 在 `node_modules` 里建一个指向本目录的链接（Windows：`New-Item -ItemType Junction`）
  - 完全退出并重启 DSH（或刷新页面）

装完检查两件事：

1. 如果还装着 `dsh-mermaid-smooth`，把它停用。两个插件都会往同一个代码块插卡片，会出现两套工具栏。
2. 对话里发一条 mermaid 围栏，应该直接成图。把鼠标移到图上，右上角浮出一排图标按钮（放大 / 缩小 / 重置 / 源码 / 导出 / 全屏，悬停有中文提示）；浏览器控制台执行 `window.__mmsStats` 能看到计数器。

回滚步骤和故障速查见 [scripts/rollback.md](scripts/rollback.md)。

### npm

尚未发布到 npm。仓库里的 `package.json` 已经按 bundle 规范写好（`dsh.client`、`exports["./client"]`、`cordis.patch.yml`），发布时会带 `lib/`，安装方不需要自己构建。

### 配置

只有一个配置键 `cacheEnabled`（默认 `true`）。写 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-mermaid-studio
  name: dsh-mermaid-studio
  config:
    cacheEnabled: true
```

配置在页面刷新后生效。读不到注入值时会退回 localStorage；两条都没有时用默认值，并把 `__mmsStats.configSource` 记成 `default` 而不是假装读到了。

---

## 安全边界

`svg` 字符串来自 IndexedDB，按不可信输入处理：同源的任意脚本都能写这个库，而且记录会留存 30 天。

- 注入只有一条出口 `injectSvg()`：先解析成游离文档，再过滤，最后 `importNode` 插入。渲染成功路径和缓存命中路径共用这一条。
- 解析先严格按 XML；失败时用惰性的 `<template>` HTML 解析（mermaid 的标签里会输出未闭合的 `<br>`，整串不是合法 XML），过滤规则不变。
- 元素白名单（含 `foreignObject` 及其内部的文本级 HTML）、属性真白名单、按声明过滤的内联样式与 `<style>`；`<style>` 用 CSSOM 重建，每条规则加 `#<renderId>` 前缀，无法重写的整条丢弃。
- `href` 只允许 `#` 片段和光栅 `data:image/(png|jpeg|gif|webp)`；`url()` 只允许 `#`。填色、描边、滤镜、蒙版这类能发起请求的属性都要校验值，不只是名字。
- 出现 `script`、`iframe`、事件属性、SMIL 事件元素等，整条围栏进错误态，不写缓存。
- 导出的 SVG 复用的是这棵已过滤的树。

---

## 已知边界

这些是有意留下的，不是待修的 bug：

- **缓存跨对话共享**：宿主的 URL 和聊天 DOM 都没有暴露会话 id，作用域退化为常量，同一份源码在不同对话命中同一条记录。收益是同一张图到处秒开；代价是删对话不会清它的图，出口只有 TTL 到期、卸载、或 `cacheEnabled=false`。
- **每张新图 50–90 ms 的同步渲染**：mermaid 需要 DOM，无法放进 Worker。串行队列保证不会并发，但没法再拆。
- **导出只有 SVG**：PNG/JPG 需要第二次渲染加最大 27.8 Mpx 的 canvas 编码，那正是上一版导出卡顿的来源，已移除。
- **主题只跟随**：没有手动切换，也没有单图覆盖。
- **源码视图没有图可以悬停**：切到源码后，同一行按钮改为常驻在代码块上方；全屏 overlay 有自己的工具条（含缩放百分比与「关闭」）。
- 智能文件名、完整键盘操作、完整焦点陷阱属于 P1，未实现。

---

## 开发

```powershell
node scripts/build.mjs               # 产出 lib/index.js + lib/client.js，打印 sha256
node test/fence.test.mjs             # 纯逻辑单测（无需浏览器）
node qa/harness/run.mjs              # 无头 Chromium 跑验收用例
node qa/acceptance.mjs --check       # 校验归档（字段 / id / 必备断言 / 基线环境）
node qa/harness/run.mjs --headed     # 想看它跑就加这个
```

```
src/host/index.js       Host 半边：载体插件 + 配置注入
src/client/*.js         浏览器半边，18 个 chunk，按 build 顺序拼接
scripts/build.mjs       构建：包一层 mermaid + 拼接 chunk
scripts/rollback.md     回滚手册
qa/harness/             验收通道（真 Chromium + 假宿主页）
qa/acceptance.mjs       归档校验与 Gate 判定
test/                   纯逻辑单测
lib/                    构建产物（入库，安装需要）
```

`lib/client.js` 约 3.6 MB，主要是内联的 mermaid 引擎。构建不带时间戳，同样的输入两次构建的 sha256 相同。

### 验收现状

26 条用例：23 条通过、3 条待人工（旧插件并存复现、回滚演练、P1 键盘焦点）。纯逻辑单测 11 条。

`node qa/acceptance.mjs --gate` 目前仍不通过，卡点是回滚演练需要真实停用/启用插件并计时，脚本代跑不了。

### 实测数据

本机（Chromium 156、16 核、DPR 1、无节流），测试图 3693×1880、30 个标签：

| 指标 | 值 |
| --- | --- |
| 页面加载完成 | 93 ms，**加载期长任务 0**（删除空闲预热前：2 × 180 ms） |
| 首次出现图到就绪 | 302 ms（引擎求值 185 ms + 渲染 97 ms，两个任务，中间显示骨架） |
| 第二张图（引擎已热） | 82 ms |
| 缓存键计算 | 0.3 ms |
| 导出 SVG | 1 ms / 39 KB |

---

## 开源协议

本项目按 **GPL-3.0**（[LICENSE](LICENSE)）发布。

打包进 `lib/client.js` 的 mermaid 11.17.2 采用 MIT 许可，与 GPL-3.0 兼容。
