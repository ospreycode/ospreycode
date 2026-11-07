# Changelog

## [Unreleased]

### Added

- 权限的格式：沙盒模式、审批策略和 `granular` 的七个类别、命名权限配置、权限请求、Permission 的判断、用户的回答、命令规则、域名规则、MCP 工具规则和后端能力说明。
- `decideCommand`：按沙盒模式和审批策略判断一条 shell 命令直接执行、询问还是拒绝；`askOrDeny`：需要询问的动作在当前审批策略下询问还是拒绝。权限规则和危险命令判断在 P1 加入。
