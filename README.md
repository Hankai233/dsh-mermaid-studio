# dsh-mermaid-studio

DeepSeek Harness 插件：**对话里的 mermaid 围栏直接渲染成图**。可缩放、可全屏、可导出 SVG，渲染结果留在本地——同一张图切回来不再重画。

[English](README.en.md) | 中文

![浅色主题下的图表卡片](docs/screenshots/card-light.png)

## 功能

- **围栏识别**——认 `mermaid` / `mmd`。宿主把围栏横幅标成通用的「代码块」，插件照样能认；`python`、`ts` 这类带真实语言名的围栏不会被误判。
- **渲染**——mermaid 11.17.2 内联在插件里，不联网。串行队列 + 15 秒超时 + 熔断：一张坏图不会拖住后面的图。
- **缓存**——内存 + IndexedDB 两级。命中直接注入，不闪；刷新、重启后仍然命中。
- **交互**——Ctrl/⌘ + 滚轮以指针为锚点缩放，拖拽平移，双击在适应与 1:1 之间切换。
- **卡片控件**——没有常驻工具栏：鼠标移到图上，右上角浮出一排图标按钮（放大 / 缩小 / 重置 / 源码 / 导出 / 全屏），移开即隐藏。
- **全屏**——CSS overlay，不抢系统 F11；Esc 关闭，焦点回到原按钮。缩放百分比可以直接输入。
- **导出**——只导出 SVG，序列化的是已经过滤好的那棵树。
- **主题**——始终跟随 DSH 的深浅色，亮暗两套各自缓存。

## 效果预览

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/card-light.png" alt="浅色主题下的图表卡片"><br><sub>浅色：图直接成卡，鼠标移上去右上角浮出控件</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/card-dark.png" alt="暗色主题下的图表卡片"><br><sub>暗色：跟随 DSH，亮暗两套各自缓存</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/source-view.png" alt="源码视图"><br><sub>点 <code>&lt;/&gt;</code> 回到源码，控件行停在代码块上方</sub></td>
    <td align="center"><img src="docs/screenshots/fullscreen.png" alt="全屏查看"><br><sub>全屏：缩放百分比可以直接输入</sub></td>
  </tr>
</table>

## 工作原理

插件是「Host + Client」两半的 bundle：Host 半边只承载配置，界面和渲染都在浏览器半边。一份围栏走六步：

1. **认围栏**——扫描宿主渲染的 `div.md-code-block`，语言判定取三条线索：横幅文字、`language-*` 类、严格首行关键字。宿主的横幅对 mermaid 显示的是本地化通用标签，所以首行规则是兜底。命中后把卡片插在代码块前面，**代码块本身不动**（插件不写宿主的节点）。
2. **拆治理键**——`%%{init: …}%%` 和 frontmatter 里的 `securityLevel`、`htmlLabels`、`fontFamily`、`themeVariables` 等会被剥离，免得一张图改掉全局渲染配置；剥离时控件行会标出来。
3. **查缓存**——键是 `sha1(源码 · 主题 · 字体 · 引擎版本 · 过滤规则版本)`。先查内存（50 条），再查 IndexedDB（32 MB、30 天、按字节 LRU）。
4. **渲染**——只有都没命中才进串行队列。mermaid 需要 DOM，只能在主线程跑，单张 50–90 ms；队列保证不会并发（引擎的 `initialize()` 是全局配置，并发会串色）。
5. **过滤后注入**——渲出的 SVG 先解析成游离文档，按元素/属性白名单过滤，`<style>` 用 CSSOM 重建并加 `#<renderId>` 前缀，最后 `importNode` 插入。**缓存命中也走同一条出口**：库里的字符串按不可信输入处理，同源脚本随时可能写进去。
6. **卸载即清**——移除卡片、`<style>`、两个 observer，删 IndexedDB 库，清本地键。

## 部署

要求 DSH `>= 0.2.1-rc.2`，桌面版与 Web 版都可用。

### 从源码部署

仓库已经带构建产物 `lib/`，可以直接装；改过 `src/` 才需要重新构建。

```powershell
git clone https://github.com/Hankai233/dsh-mermaid-studio.git
cd dsh-mermaid-studio

# 可选：重新构建（npm install 会装上构建用的 mermaid@11.17.2）
npm install
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"
npm run build
```

把插件注册到 profile（两种方式选一）：

- **插件管理器**：`plugin_manager install_bundle`，target 指到这个目录的绝对路径。
- **手工**：编辑 `<DSH_HOME>/profiles/desktop/package.json`
  - `dependencies` 加 `"@hankai233/dsh-mermaid-studio": "link:<仓库绝对路径>"`
  - `dsh.profile.bundles` 数组加 `"@hankai233/dsh-mermaid-studio"`
  - 在 `node_modules` 里建一个指向仓库目录的链接（Windows：`New-Item -ItemType Junction`）
  - 完全退出并重启 DSH

装完检查：随便发一条 mermaid 围栏，应该直接成图；鼠标移到图上，右上角浮出六个图标按钮。控制台执行 `window.__mmsStats` 能看到计数器。如果还装着 `dsh-mermaid-smooth`，先停用它——两个插件会往同一个代码块插卡片。回滚步骤见 [scripts/rollback.md](scripts/rollback.md)。

### 让 Agent 帮你装

把下面这段整段发给 DSH 里的 Agent，它会自己克隆、构建、注册并验证：

```text
帮我在这台机器上安装 DSH 插件 @hankai233/dsh-mermaid-studio。

仓库：https://github.com/Hankai233/dsh-mermaid-studio

请按这个顺序做，每步结束确认结果再做下一步：
1. 选一个合适目录克隆仓库（不要放进 DSH 自己的安装目录）。
2. 检查 clone 下来的 lib/index.js 与 lib/client.js 是否存在且非空。
   如果缺失，或者我要求从源码构建，就设置 DSH_PROFILE_DIR 后运行
   node scripts/build.mjs（需要 mermaid@11.17.2；版本不符会直接报错，别改成别的版本）。
3. 打开 <DSH_HOME>/profiles/desktop/package.json：
   - dependencies 里加 "@hankai233/dsh-mermaid-studio": "link:<克隆目录的绝对路径>"
   - dsh.profile.bundles 里加 "dsh-mermaid-studio"
   - 在 node_modules 下建一个指向克隆目录的链接（Windows 用 junction）
4. 如果 dsh-mermaid-smooth 还在 dsh.profile.bundles 里，把它移除（依赖条目可以留着）。
5. 重启 DSH，然后在对话里发一条 mermaid 围栏，确认出现图表卡片、
   鼠标移上去右上角浮出放大/缩小/重置/源码/导出/全屏六个按钮。
6. 汇报：改了哪些文件的绝对路径、构建产物的 sha256、第 5 步实际看到的结果。

不要改插件源码；不要为了通过验证去关掉 DSH 的安全设置。
```

## 边界

- **缓存跨对话共享**：宿主没有暴露会话 id，作用域退化为常量，同一份源码在不同对话命中同一条记录。删对话不会清掉它的图，出口是 30 天过期、卸载、或把 `cacheEnabled` 设为 `false`。
- **每张新图 50–90 ms 同步渲染**：mermaid 需要 DOM，移不进 Worker。
- **只导出 SVG**：PNG/JPG 需要第二次渲染加最大 27.8 Mpx 的 canvas 编码，那正是导出会卡住的原因，所以去掉了。

## 开发

```powershell
npm install        # 装构建用的 mermaid@11.17.2（devDependency）
npm run build      # 产出 lib/，打印 sha256；同样的输入两次构建结果一致
npm test           # 纯逻辑单测（node --test），不需要浏览器
```

## 开源协议

本项目基于 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。
