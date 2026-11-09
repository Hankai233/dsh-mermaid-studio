# dsh-mermaid-studio

对话里的 mermaid 围栏实时成图：缩放 / 平移 / 全屏、SVG / PNG / JPG 导出、图源切换、深浅色三态，**渲染结果落 IndexedDB**——切会话、刷新页面后不再重渲染。

DSH 插件（bundle），Host 半边只承载配置，全部功能在浏览器半边。

## 能力

| 能力 | 说明 |
| --- | --- |
| 围栏识别 | `div.md-code-block` 单元，语言判定取三路并集（banner 文本 / `language-*` 类 / 严格首行关键字），`python` 等围栏不会被误判 |
| 渲染 | mermaid 11 本地打包、串行队列（并发 1）、15 s 超时、永不 settle 时换新实例续跑、连续 2 次超时熔断；引擎在空闲窗口预热，缓存键不触发引擎求值 |
| 缓存 | L1 内存（50 条）+ L2 IndexedDB（32 MB / 30 天 TTL / 按 `lastUsed` 淘汰 / 按 `scopeHash` 按会话清理），不可用时静默降级；唯一配置键是 `cacheEnabled` |
| 交互 | Ctrl/⌘+滚轮以指针为锚点缩放、拖拽平移（按帧合并，20 次移动 1 次写入）、双击适应、全屏 overlay（Esc 关闭、焦点回拉）；缩放上限按 `LAYER_MAX_PX=8192` 反算，避免合成层超出 GPU 纹理预算。工具栏：图/源码切换 · 导出 SVG · 全屏 |
| 导出 | 只有 SVG：序列化当前已注入、已过滤的 DOM（实测一张 3693×1880 的图 1 ms / 39 KB）。位图导出需要第二次渲染 + 最大 27.8 Mpx 的 canvas 编码，那正是导出卡顿的来源，已按用户要求移除 |
| 主题 | **始终跟随宿主**（`body[data-ds-dark-theme]`），没有手动切换；两套 SVG 各自命中缓存，切回来是命中不是重画 |
| 安全 | SVG 白名单过滤 + 唯一注入出口 `injectSvg()`；`<style>` 用 CSSOM 重建并加 `#<renderId>` 前缀；`%%{init}%%` 治理键剥离；缓存键含 `san` 版本 |
| 卸载 | 移除全部卡片 / 样式 / observer / overlay，删除 IndexedDB 库，清空 `mms:*` 键与 `__mmsStats` |

## 目录

```
src/host/index.js          Host 半边：载体插件 + 配置注入
src/client/*.js            浏览器半边（按 build 顺序拼接）
scripts/build.mjs          构建：包一层 mermaid 11 + 拼接 chunk → lib/client.js
scripts/rollback.md        回滚手册（两条路径）
qa/harness/                无头 Chromium 验收通道（28 条用例）
qa/acceptance.mjs          归档校验与 Gate 判定
test/fence.test.mjs        纯逻辑单测（sha1 / 键 / 归一化 / 治理键剥离 / 配置）
lib/                       构建产物（lib/index.js + lib/client.js）
```

## 构建

需要本机有一份 `mermaid@11.17.2`（`node_modules`、`$DSH_PROFILE_DIR/node_modules` 或 `$DSH_HOME/profiles/desktop/node_modules` 任一命中即可，版本不符会直接报错）。

```powershell
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"
node scripts/build.mjs
```

产物 `lib/client.js` 约 3.55 MB（mermaid 引擎占绝大部分），脚本会打印 `sha256`——输入不变则哈希不变（设计 §13.1 的可复现要求）。

## 测试

```powershell
node test/fence.test.mjs          # 纯逻辑单测（无需浏览器）
node qa/harness/run.mjs           # 无头 Chromium 跑 28 条验收用例
node qa/acceptance.mjs --check    # 归档完整性（字段 / id / 空断言 / 基线环境）
node qa/acceptance.mjs --gate     # 放行 Gate
```

验收结果落在 `qa/results/<id>.json`（不进版本库）。**没有断言的结果一律 pending，不会显示为 pass。**

## 安装

见设计文档 §14；手工安装步骤与回滚见 [scripts/rollback.md](./scripts/rollback.md)。

## 已知边界

- 作用域 `scopeHash` 的会话 ID 取自 URL / 聊天容器属性；**当前宿主两处都没有会话 id**，所以退化为共享作用域：不同对话里的同一份源码会命中同一条缓存（`__mmsStats.scopeSource === 'none'` 即为这种情况）。一旦宿主给出 `data-session-id` 之类的标记，会自动按会话隔离，不需要改代码。
- 深色 / 浅色两套 SVG 并存，各占一份缓存；容量按字节而非条数淘汰。
- 智能文件名、完整键盘与焦点陷阱属于 P1，未实现；单图主题覆盖已随手动主题删除（v9）。
- `node test/fence.test.mjs` 是纯逻辑单测；`node qa/harness/run.mjs` 是 27 条用例的无头验收通道。

## 许可

本项目按仓库根目录的 **GPL-3.0**（见 LICENSE）发布。打包进 `lib/client.js` 的 mermaid 引擎为 **MIT**，两者兼容。

## 关于 `lib/`

`lib/` 是 `node scripts/build.mjs` 的产物（`lib/index.js` + `lib/client.js`），**仍然入库**：DSH 以「包目录」安装插件，没有 `lib/` 就不能直接 `install_bundle`。改动请改 `src/` 后重新构建，不要手改 `lib/client.js`。
