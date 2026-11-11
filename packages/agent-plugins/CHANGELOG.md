# Changelog

## [Unreleased]

### Added

- `readPlugin(directory, {pluginData, maxSkills, maxSkillFiles})`：按 Agent Plugins 1.0.0 读取并校验一个插件目录，返回清单（`PluginManifest`）、`skills/` 下一层合规的 skills、`mcp.json` 里有效的 server 定义和本项目命名空间目录 `dev.ospreycode/` 的位置；问题写在 `diagnostics`（`PluginDiagnostic`）里，按规范的最小范围处理：拒绝整个插件、停用一类组件、跳过一个 skill 或 server，或拒绝访问一个路径。
- `parseManifest(text)`：解析并校验 `plugin.json`。未知的顶层字段和不是对象的 `extensions` 报告后忽略，其他 schema 违规拒绝插件；按 `$schema` 选用本地支持的版本（`pluginSchemaIds`），不联网获取 schema。
- `parseMcpConfig(text, {pluginRoot, pluginData, userLevel, manifestVersion?, serverDirectories?})`：解析并校验 `mcp.json`（`mcpSchemaIds`），返回 `@ospreycode/mcp` 的 server 定义。`serverDirectories` 按 server 给出各自的插件根目录和数据目录，插件之外的 `mcp.json` 用它。`userLevel` 为 true 时 `command` 另外允许写绝对路径；`sse` 传输不支持，跳过并说明原因；`type: "http"` 无效，提示改成 `streamable-http`。
- `pluginEnvironment(base, configured, directories)`：按规范的顺序组合插件子进程的环境变量，`PLUGIN_ROOT` 和 `PLUGIN_DATA` 最后设置。
- 路径检查 `staysInside(path, root)`、`isInside(child, parent)` 和占位符展开 `expandPlaceholders(text, directories)`；本项目的命名空间 `ospreyNamespace`（`dev.ospreycode`）。
