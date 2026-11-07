# Changelog

## [Unreleased]

### Added

- `newId()`：生成 Host 的各种标识（UUID v4）。
- Host 写入 session 记录的事件格式：task 的开始和结束、批准的询问和决定、进程的启动和退出、协议原文。
- Host 的 SDK：`createHost({root, env, fetch, streamModel, agentEntry, sandboxHelperEntry})` 和 `openSession`，返回的 session 可以开始 task、回答询问、取消和关闭，事件经 `onEvent` 送达（`HostEvent`，格式版本 `eventFormatVersion`）。
- 配置的分层：`openSession` 的选项等同于启动参数，按启动参数、仓库配置（项目根目录的 `.ospreycode/config.toml`）、用户级配置（Host 根目录的 `config.toml`）和内置默认值的顺序合并。选项里的 `models` 是按模型 ID 的表，按字段覆盖清单；`credentials` 按凭据 ID；另有 `reasoningEffort`、`granular`、`budget`（`BudgetOptions`）、`denyRead`、`denyWrite` 和 `environment`。仓库配置只能收紧（沙盒模式只能改成 `read-only`，审批策略只能改严，上限只能调低），只认用户级配置的键在仓库配置里忽略；被忽略的键和更松的值紧跟在 `session.started` 之后作为 `warning` 发出。配置文件加载出错时抛出 `ConfigError`，带文件路径和出错的键，TOML 语法错误只报行号和列号。`host.resolveConfig(options)` 不打开 session，只合并并检查配置，返回 `SessionConfig`。
- 沙盒：macOS 上 `read-only` 和 `workspace-write` 的 session 由离线的辅助进程启动 agent 进程，每条 shell 命令由命令的辅助进程单独包装；批准的 `with_additional_permissions`（文件路径）只加在这一条命令的沙盒上。`require_escalated`、`unix_sockets` 和 `local_binding` 暂不支持，在询问之前拒绝。其他平台的沙盒模式抛出 `SandboxUnavailableError`。
- 对外的事件格式：`hostEventSchema` 和 `isHostEvent`（对外事件、api 的流式事件和 agent-runtime 的工具事件在同一份 schema 里），非交互模式的退出码 `exitCodeFor`，session 打开之前就失败时的 `startupErrorEvent` 和 `startupExitCode`，CLI 的 JSON 输出用的 `toJsonLine`（转义 U+2028、U+2029）和 `inJsonOutput`。
- 模块骨架：配置检查（`ConfigError`）、按文件或环境变量读凭据（`readCredential`、`CredentialError`）、密钥检测和替换（`containsSecret`、`redact`）、工作区和根目录的检查（`WorkspaceError`）、session 和 task 的生命周期、通道的服务端、工具调用的处理和询问、模型代理、agent 进程和命令的启动（`AgentStartError`）。
