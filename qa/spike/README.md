# spike/ —— 开工前的 4 个契约坐实

对应设计文档 UNK-04…UNK-08 与 §8.2 P1-1。**这四个 spike 全部做完并通过，才算 BLOCKERS.md 的 G1 契约就位。**

原则（§17.4 工程纪律 ①）：**不做无契约的实现**。这里拿到的真实输出要**逐字回填文档**，不一致就改文档，不改实现。

| # | 脚本 | 回答什么问题 | 回填到 | 判定 |
| --- | --- | --- | --- | --- |
| S1 | `s1-dom.js`（控制台） | 聊天侧真实 DOM 是什么？`.md-code-block` / banner 语言文本 / `language-*` 类到底存不存在？ | §3.1.1、§4.1、§3.3、UNK-08 | 见下「S1 判定」 |
| S2 | `probe-plugin/`（临时装一次） | `factory` 的实参形状？`ctx` 从哪来？`ctx.get('theme')` 的访问器与字段？ | §3.1.1、§6.1 | 见下「S2 判定」 |
| S3 | 同 `probe-plugin/` | Host 能否经 `webserver/index-inject` 把配置送进渲染进程？ | §3.1.1、§10、UNK-06 | 见下「S3 判定」 |
| S4 | `s4-foreignobject.js`（控制台） | `foreignObject` 走 `<img>` → canvas 会不会丢标签？ | §8.2、验收 #7 | 见下「S4 判定」 |

---

## S1 · DOM 契约（5 分钟）

1. 在对话里先发一条含 mermaid 围栏的消息，**再发一条 python 围栏**（用来验证不会误判）。
2. GUI 页面开控制台，整段粘贴 `s1-dom.js`，回车。
3. 看三处输出：`counts` 表、`verdict`、以及第一条 `.md-code-block` 的 `outerHTML` 开头 220 字符。

**S1 判定**

| 观察 | 结论 |
| --- | --- |
| `counts.block > 0` 且 `verdict.blockContainerStable = true` | 锚点用 `.md-code-block` 成立 |
| `counts.bannerText > 0` | banner 语言文本可作为第一路判定 |
| `verdict.nonEmptyHasLanguageClass = false` | 证实「非空围栏无 language class」，§4.1 三路并集方案成立 |
| `legacy` 三项全 0 | 证实 `code[data-lang]` / `div[data-language]` / `pre.shiki` 应作废 |
| `counts.block = 0` | **候选单元也不对**，停下来重新找容器，不要写实现 |

把 `window.__mmsSpikeS1` 整段贴进 UNK-08 的证据栏。

---

## S2 · factory 实参与 theme 取值（10 分钟）

S2 和 S3 共用同一个探针插件，因为这两问都只能在「插件真的被宿主加载」时才答得出。

```bash
# 1. 装（把绝对路径换成你的实际路径；需要审批能力）
#    plugin_manager install_bundle  target = qa/spike/probe-plugin
# 2. 刷新 GUI 页面，开控制台
# 3. 看 [mms-probe] 分组输出，以及 window.__mmsProbe
```

**S2 判定**

| 字段 | 通过形态 | 不通过时怎么办 |
| --- | --- | --- |
| `factory.argTypes` | `["function"]`（只有 require） | 若出现第二个对象实参，把它当 ctx，§3.1.1 的「两处冲突」即按实测定稿 |
| `ctx.present` | true 且 `ctx.hasGet` | 为 false 时，ctx 要从其它注入面取，先记 `unreachable`，不许猜 |
| `ctx.get('theme')` | 返回含 `revision` / `fontFamilies` / `fontSizes` 的对象 | 形状不符 → §6.1 的键字段再改，**不要**退回扁平 `fontFamily` |
| `theme.fontFamilies.code` | 有值 | 为 undefined → §6.1 改用哨兵 `unknown` 且不读缓存 |

**用完必须删掉探针插件**（`set_bundle ... enabled: false` + 从 `dependencies` 移除），它不参与正式交付。

---

## S3 · 配置注入通道（同一次加载即可）

看 `window.__mmsProbe.config`：

- `present: true` → 通道生效。把 `value` 逐字回填 §3.1.1 的「配置注入通道」行，§10 的读取方式定稿。
- `present: false` → 通道不成立，**触发 §10 的翻转条件**：

> 若注入通道也被证伪，则 `cacheEnabled` / `themeMode` 降级为 localStorage-only，并从 §17.1 的 Must 移出；**不允许**留一条静默兜底了事。

即：不要写「读不到就用默认值」然后继续当 P0 用 —— 那正是 P0-5 要消灭的形态。

---

## S4 · foreignObject 保真（5 分钟）

1. 页面里先渲染好一张**带文字标签**的 mermaid 图（旧插件渲染的就行）。
2. 粘贴 `s4-foreignobject.js`，等 `[mms spike S4]` 输出。
3. 看 `verdict` 与那张预览图。

**S4 判定**

| 观察 | 结论 |
| --- | --- |
| `FO_RENDERED` 且 `deltaRatio > 0.02` | 维持 §8.2 现状；把「标签区域非背景像素 > 0」写进验收 #7 |
| `FO_CONTENT_LOST` | 按 §8.2 二选一：① 序列化前 `foreignObject` → `<text>`；② 导出走 `htmlLabels:false` 的第二条渲染路径（需安全侧确认白名单覆盖并集） |
| `INCONCLUSIVE` / 解码失败 | 导出管线在源串这一层就断了，先修序列化（缺 `xmlns` / `width` / `height`） |

---

## 记录模板

每个 spike 完成后，往 UNKNOWNS.md 对应行填证据：

```
S<n> 执行 <日期时间> · 环境 <机型/Browser/DPR> · 结果 <一句话> · 原始输出见 <粘贴的 JSON 或文档附录>
```

**没有原始输出的「通过」不算通过。**
