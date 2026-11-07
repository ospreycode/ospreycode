# Changelog

## [Unreleased]

### Added

- 工具调用的格式：工具声明 `ToolSpec`、工具结果 `ToolResult`、工具调用事件 `tool_call.started` 和 `tool_call.completed`、runtime 自己的事件，以及格式版本 `contractsVersion`。
- 通道：按行分帧的 JSON 消息（`LineDecoder`、`encodeMessage`，单条上限 16 MiB）、两端通用的 `ChannelPeer`（请求、响应、通知、流式通知、LSP 式的取消、写入背压），P0 的全部操作的类型，以及 Host 一侧按 schema 检查每条消息的 `openHostChannel`。
- agent 进程的入口 `@ospreycode/agent-runtime/agent`：从继承的 fd 3 连上通道，`initialize` 报告包版本 `version`，取得配置后运行 loop，Host 关闭通道后退出。也可以用 `runAgent(stream)` 在给定的连接上运行。
- `protocolSchemas`：内部协议和工具调用格式的 schema（消息、流式事件、工具结果、工具调用事件等），供组合别的 schema 使用。
- 最小的 loop：请求模型、按顺序执行工具调用、限流和服务过载时最多重试 3 次、取消时补上未完成调用的结果；`shell` 工具的声明和参数的 schema `shellArgumentsSchema`。
