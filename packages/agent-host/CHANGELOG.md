# Changelog

## [Unreleased]

### Added

- `newId()`：生成 Host 的各种标识（UUID v4）。
- Host 写入 session 记录的事件格式：task 的开始和结束、批准的询问和决定、进程的启动和退出、协议原文。
- Host 的 SDK：`createHost({root, env, fetch, streamModel, agentEntry, sandboxHelperEntry})` 和 `openSession`，返回的 session 可以开始 task、回答询问、取消和关闭，事件经 `onEvent` 送达（`HostEvent`，格式版本 `eventFormatVersion`）。
- 配置的分层：`openSession` 的选项等同于启动参数，按启动参数、仓库配置（项目根目录的 `.ospreycode/config.toml`）、用户级配置（Host 根目录的 `config.toml`）和内置默认值的顺序合并。模型清单以 `@ospreycode/api` 的内置清单打底，选项里的 `models` 是按模型 ID 的表，按字段覆盖清单或新增模型；`credentials` 按凭据 ID；另有 `reasoningEffort`、`granular`、`budget`（`BudgetOptions`）、`denyRead`、`denyWrite` 和 `environment`。仓库配置只能收紧（沙盒模式只能改成 `read-only`，审批策略只能改严，上限只能调低），只认用户级配置的键在仓库配置里忽略；被忽略的键和更松的值紧跟在 `session.started` 之后作为 `warning` 发出。配置文件加载出错时抛出 `ConfigError`，带文件路径和出错的键，TOML 语法错误只报行号和列号。`host.resolveConfig(options)` 不打开 session，只合并并检查配置，返回 `SessionConfig`。
- 项目身份和目录：`user_id` 保存在 `data/identity.json`；`project_id` 按 git 公共目录（linked worktree 核对双向引用后归到主仓库，`.git` 的符号链接和核对不成立的 `.git` 文件按新项目）登记在 `data/projects.json`，`session.started` 带 `user_id` 和 `project_id`。`host.listProjects()` 列出项目，`host.linkProject(directory, projectId)` 把目录关联到已有项目。Host 根目录在网络文件系统上、根目录下放开给沙盒的目录是符号链接、Host 的程序文件在工作区里时抛出 `WorkspaceError`。
- 工作区锁和进程登记表：打开 session 时取得工作区锁，同一个工作区或互相包含的工作区已有打开的 session 时抛出 `WorkspaceError`，持锁进程已经不在的锁被接管；agent 进程、辅助进程和每条命令记进 `data/processes.json`，Host 崩溃后残留的进程在下次打开同一工作区时按 pid 加启动时间核对后结束。
- 凭据：同一个 ID 按启动参数、用户级配置、系统凭据库的顺序取第一个找到的来源。macOS 上的系统凭据库是登录钥匙串（`macosKeychain()`，基于 `@napi-rs/keyring` 2.1.2），`createHost` 的 `credentialStore` 可以换成别的实现（`CredentialStore`）或传 `null` 不用；`host.saveCredential(id, value)` 和 `host.deleteCredential(id)` 保存和删除凭据。凭据来自文件时，服务返回 401 就重新读取文件，值变了用新值重发一次。
- session 记录：会存储的事件（task、run、模型回复、工具调用、批准）和 runtime 经 `record/append` 上报的事件写进项目的 `data/projects/<project_id>/sessions.sqlite`，带定义它的包的格式版本；每个 run 以 `run.started` 开始（在 `task.started` 之前），接在上一个 run 的最后一个事件之后；session 的标题取第一条输入的第一行。session 的写锁是 `data/locks/session-<id>.lock`。
- 诊断日志：错误和警告写进 Host 根目录下的 `data/logs/<UTC 日期>.log`。日志、`error` 和 `warning` 事件、`task.ended` 的 `error` 都先去掉 Host 持有的凭据和疑似密钥。
- 沙盒：macOS 上 `read-only` 和 `workspace-write` 的 session 由离线的辅助进程启动 agent 进程，每条 shell 命令由命令的辅助进程单独包装；批准的 `with_additional_permissions`（文件路径）只加在这一条命令的沙盒上。`require_escalated`、`unix_sockets` 和 `local_binding` 暂不支持，在询问之前拒绝。其他平台的沙盒模式抛出 `SandboxUnavailableError`。
- 对外的事件格式：`hostEventSchema` 和 `isHostEvent`（对外事件、api 的流式事件和 agent-runtime 的工具事件在同一份 schema 里），非交互模式的退出码 `exitCodeFor`，session 打开之前就失败时的 `startupErrorEvent` 和 `startupExitCode`，CLI 的 JSON 输出用的 `toJsonLine`（转义 U+2028、U+2029）和 `inJsonOutput`。
- 模块骨架：配置检查（`ConfigError`）、按文件或环境变量读凭据（`readCredential`、`CredentialError`）、密钥检测和替换（`containsSecret`、`redact`）、工作区和根目录的检查（`WorkspaceError`）、session 和 task 的生命周期、通道的服务端、工具调用的处理和询问、模型代理、agent 进程和命令的启动（`AgentStartError`）。
