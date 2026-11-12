# AGENTS.md — 本仓库的硬性约定

给任何在这个仓库里改代码的 agent / 协作者。只写**会被违反**的约定，不写风格指南。

## 1. 每次改动都要写 CHANGELOG

**规则：任何改动（代码、构建、文档、测试）都必须在 `docs/CHANGELOG.md` 的 `[未发布]` 下追加一条，并在同一个提交里一起提交。**

- 分类只用六种：`新增` / `修复` / `变更` / `性能` / `文档` / `测试`。
- 每条一行说清「改了什么 + 为什么」；能指到文件就指到文件。
- 追加，不要重写已有条目；发版时把 `[未发布]` 收成版本号 + 日期。
- 只改 CHANGELOG 不写代码，或只写代码不改 CHANGELOG，都算这次改动没做完。

理由：这个插件的取舍经常是「某个数字换某个体验」（例如删过空闲预热、又为滚动卡顿引入受控预渲染）。不留记录，下一个人（包括未来的自己）会重复讨论同一个问题。

## 2. 构建产物必须一起提交

改 `src/client/**` 或 `scripts/build.mjs` 之后必须 `npm run build`，把 `lib/` 一起提交。CI 会校验「提交进库的 `lib/` 与本次构建结果一致」，不一致直接失败。

## 3. 注册 ID 等于包名

`src/client/register.js` 里的注册 ID 必须与 `package.json` 的 `name` 逐字相等（含 scope）。宿主按包名建 client 模块行，改包名时必须同步改这里 —— 否则启动会报 `duplicate factory registration` / `1 entry did not activate`。`test/register.test.mjs` 守着这条。

## 4. 验收通道不在仓库里

`qa/` 已 gitignore（结果按机器产生，fixture 是生成的）。跑验收用 `node qa/harness/run.mjs`；新增行为请加 case，而不是只在本地手动点一遍。
