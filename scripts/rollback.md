# 回滚手册（dsh-mermaid-studio）

对应设计文档 §14 / §14.1。**回滚只负责「停新插件、恢复旧插件」，不清理数据**——IndexedDB 库与 `mms:*` 键由插件自身的卸载钩子在停用事件里删除（§11），所以清理不在本手册的步骤里。

## 前提：先备份

安装/启用前先备份 profile 的两个文件（`<DSH_HOME>` 默认 `C:\Users\<你>\.dsh`）：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json" "$p\package.json.bak-mms-$(Get-Date -Format yyyyMMddHHmm)"
Copy-Item "$p\pnpm-lock.yaml" "$p\pnpm-lock.yaml.bak-mms-$(Get-Date -Format yyyyMMddHHmm)"
```

## 路径 A（有插件管理器时，首选）

1. `plugin_manager set_bundle`，target `dsh-mermaid-studio`，`enabled: false`
2. `plugin_manager set_bundle`，target `dsh-mermaid-smooth`，`enabled: true`
3. 判据：返回体 `application: applied`；刷新页面后旧插件成图

## 路径 B（没有插件管理器时）

编辑 `<DSH_HOME>/profiles/desktop/package.json` 两处：

- `dependencies`：把 `dsh-mermaid-studio` 从依赖里删掉（或改成 `"link:"` 指向仓库，如果想保留源码调试）
- `dsh.profile.bundles`：删掉 `dsh-mermaid-studio`，把 `dsh-mermaid-smooth` 加回列表
- 删掉 `node_modules/dsh-mermaid-studio`（符号链接/目录）
- 刷新页面；若界面没有变化，完全退出并重启 DSH 桌面端

**本手册在 `workspace-write` 沙箱内无法执行**（profile 在 session workspace 之外），必须在沙箱外操作，或让具备审批能力的会话执行。

## 回滚后仍需要确认的三件事

| 检查 | 判据 |
| --- | --- |
| 旧插件恢复 | 对话里 mermaid 围栏重新成图，≤60 秒内完成（审批等待时间单独计时） |
| 新插件痕迹清空 | `document.querySelectorAll('.mms-card').length === 0`；`document.getElementById('mms-styles') === null` |
| 数据已清 | `indexedDB.databases()` 不含 `dsh-mermaid-studio`；`localStorage` 无 `mms:` 前缀键 |

## 故障速查

| 现象 | 先看什么 |
| --- | --- |
| 围栏完全不成图，代码块正常 | `window.__mmsStats`（不存在 = 客户端半边没加载）；宿主日志里搜 `[mms]` |
| 卡片出现但一直骨架 | `__mmsStats.renderCount` 不增 = 队列卡住；看 `__mmsStats.queueBreaker` |
| 图重复（两张卡） | 旧插件没停用（§14 步 4） |
| 刷新后重复渲染 | `__mmsStats.configSource` 为 `default`/`localStorage` 说明注入通道未生效；`cacheHitL2` 是否增长 |
