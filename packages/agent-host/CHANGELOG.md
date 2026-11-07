# Changelog

## [Unreleased]

### Added

- `newId()`：生成 Host 的各种标识（UUID v4）。
- Host 写入 session 记录的事件格式：task 的开始和结束、批准的询问和决定、进程的启动和退出、协议原文。
- Host 的 SDK：`createHost({root, env, fetch, streamModel, agentEntry})` 和 `openSession`，返回的 session 可以开始 task、回答询问、取消和关闭，事件经 `onEvent` 送达（`HostEvent`，格式版本 `eventFormatVersion`）。现在只支持 `danger-full-access`。
- 对外的事件格式：`hostEventSchema` 和 `isHostEvent`（对外事件、api 的流式事件和 agent-runtime 的工具事件在同一份 schema 里），非交互模式的退出码 `exitCodeFor`，session 打开之前就失败时的 `startupErrorEvent` 和 `startupExitCode`，CLI 的 JSON 输出用的 `toJsonLine`（转义 U+2028、U+2029）和 `inJsonOutput`。
- 模块骨架：配置检查（`ConfigError`）、按文件或环境变量读凭据（`readCredential`、`CredentialError`）、密钥检测和替换（`containsSecret`、`redact`）、工作区和根目录的检查（`WorkspaceError`）、session 和 task 的生命周期、通道的服务端、工具调用的处理和询问、模型代理、agent 进程和命令的启动（`AgentStartError`）。
