# @ospreycode/agent-host

本地后端：管理 session 和 task，持有凭据和配置，管理扩展，把其他包组装起来。CLI 和评测都只通过它的 SDK 使用 Host。设计见仓库里的 `docs/packages/agent-host.md`。

## 安装

```sh
npm install @ospreycode/agent-host
```

## 用法

`createHost` 创建 Host，`openSession` 检查配置和凭据、启动 agent 进程并完成握手。事件经 `onEvent` 送达，第一条是 `session.started`；需要用户回答的询问作为 `approval.requested` 到达，用 `session.respond` 回答。

`openSession` 的选项等同于启动参数。没写的项依次取仓库配置（项目根目录的 `.ospreycode/config.toml`）、用户级配置（Host 根目录的 `config.toml`）和内置默认值；仓库配置只能收紧权限，被忽略的键和更松的值紧跟在 `session.started` 之后作为 `warning` 发出。配置写错时抛出 `ConfigError`，带文件路径和出错的键。`host.resolveConfig(options)` 只合并并检查配置，不打开 session。用户级配置的例子：

```toml
model = "claude-haiku-5-5"
reasoning_effort = "low"

[credentials]
anthropic = { file = "~/.config/ospreycode/anthropic-key" }

[budget]
max_cost_usd = 2
max_duration = "30m"
```

每个 run 默认最多花 10 美元、发 200 次模型请求，`budget` 选项和 `[budget]` 可以改；启用费用上限时模型要有价格。超出时，审批策略不是 `never` 就发一条 `kind` 为 `budget` 的 `approval.requested`，批准就追加一份同样的额度；拒绝或审批策略为 `never` 时 task 以 `budget_exceeded` 结束，`task.ended` 的 `limit` 写明超出的是哪一项。

模型有 `read`、`edit`、`write`、`shell` 和 `request_permissions` 五个工具；配置的 `[tools]` 里写 `grep = true`、`ls = true` 可以再打开两个只读的工具：`grep` 按行搜索文件内容，`ls` 列出目录下的一层，它们由 agent 进程执行，能读到什么由沙盒决定。`request_permissions` 申请本任务内之后的命令和编辑共用的读写路径，同样经 `approval.requested` 询问，回答时可以用 `granted` 只批准一部分。文件工具由 agent 进程执行，只能改它的沙盒可写的位置（`workspace-write` 下是工作区和 session 的临时目录）；改其他位置的文件时，Host 先发一条 `approval.requested`（`request.kind` 为 `file_edits`，带将要写入的内容），批准后在只能写这几个文件的沙盒里写入。每次调用都有 `tool_call.started` 和 `tool_call.completed` 两个事件。

沙盒模式为 `read-only` 或 `workspace-write` 时，agent 进程和每条 shell 命令都在沙盒里运行：macOS 用 Seatbelt，Linux（x64 和 arm64）用 bubblewrap，后者还没有在真机上验证，要装的程序见 `@ospreycode/sandbox` 的平台要求；其他平台抛出 `SandboxUnavailableError`；`danger-full-access` 不启用沙盒，只能由启动参数指定。

沙盒模式也可以写用户级配置里命名权限配置（`[permissions.<名字>]`）的名字：它继承 `read-only` 或 `workspace-write`，再按路径设 `read`、`write` 或 `deny`，按域名设 `allow` 或 `deny`。`write` 写到受保护的路径上、或写法沙盒后端表达不了时，加载配置抛出 `ConfigError`；`deny` 的路径和域名任何批准都放不开。`session.config()` 的 `sandboxMode` 是这个名字，`baseSandboxMode` 是沙盒所按的内置模式，`permissionProfile` 是解析出的路径和域名。各个取值的效果见仓库里的 `docs/packages/sandbox.md`。

```toml
sandbox_mode = "strict"

[permissions.strict]
extends = "workspace-write"

[permissions.strict.paths]
"~/" = "deny"
"~/scratch" = "write"

[permissions.strict.domains]
"registry.npmjs.org" = "allow"
```

下面的例子用脚本模型，不联网，也不启用沙盒。实际使用时去掉 `streamModel`，在 `models` 里写真实的模型和服务地址，凭据文件写真实的 API key。

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, type TaskEndedEvent } from "@ospreycode/agent-host";
import { scriptedModel } from "@ospreycode/api/testing";

const base = mkdtempSync(join(tmpdir(), "osprey-example-"));
const workspace = join(base, "workspace");
mkdirSync(workspace);
const keyFile = join(base, "key");
writeFileSync(keyFile, "not-a-real-key", { mode: 0o600 });

const host = createHost({
	root: join(base, "root"),
	env: { PATH: process.env.PATH, HOME: base },
	streamModel: scriptedModel(() => ({
		content: [{ type: "text", text: "你好" }],
	})),
});
const ended = Promise.withResolvers<TaskEndedEvent>();
const session = await host.openSession({
	workspace,
	model: "example",
	models: {
		example: {
			protocol: "anthropic.messages",
			service: "example",
			base_url: "https://example.invalid/v1",
			model: "example",
			context_window: 200_000,
			max_output_tokens: 8_000,
			// 默认每个 run 有费用上限，要按价格计费
			price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
		},
	},
	credentials: { example: { file: keyFile } },
	sandboxMode: "danger-full-access",
	approvalPolicy: "never",
	onEvent: (event) => {
		if (event.type === "task.ended") ended.resolve(event);
	},
});
await session.submit("打个招呼");
console.log((await ended.promise).outcome);
await session.close();
rmSync(base, { recursive: true, force: true });
```

`submit`、`steer` 和 `followUp` 接受一段文字，或分好段的输入 `UserInput[]`：文字块、`{ type: "mention", path }`（`@` 提及的文件或目录，agent 进程在这条输入进入上下文时在沙盒里读取）和图片块 `{ type: "image", media_type, data }`（`data` 是原始字节的 base64，agent 进程在沙盒里缩放后才发给模型）。`task.started` 和排队事件里的图片是引用 `{ type: "image_ref", sha256, bytes }`，不带字节。task 运行时，`steer` 把输入插进当前 task，`followUp` 排到它完成之后，`dequeue` 取回，`inputQueue` 查看。

shell 工具放到后台的命令属于 session，task 结束后继续运行；`backgroundCommands()` 列出运行中的，`stopBackgroundCommand(id)` 停止一条。它们结束时 Host 会为通知开始新的 task（`task.started` 的 `source` 为 `notification`）。只执行一个任务的调用方在主任务之后用 `await session.whenIdle()` 等到没有进行中和接着要开始的 task，再看 `backgroundCommands()` 是否为空，决定继续等还是 `close()`。

会话中可以改设置：`setSandboxMode(mode)` 和 `reload()` 只能在 session 空闲时调用，会重启 agent 进程；`setApprovalPolicy`、`setModel` 和 `setReasoningEffort` 在 task 运行时也能调用。条件不满足时抛出 `SessionCommandError`、`ConfigError` 或 `CredentialError`，session 照常用原来的设置。`config()` 给出当前生效的配置，会话中换过的设置已经并在里面，前端用它显示当前的模型、沙盒模式和审批策略。agent 进程异常退出不关闭 session：下一次输入时启动新的进程，从 session 记录重建发给模型的历史；连续 3 次异常退出才关闭。

上下文到模型上限的 90%（`openai.chat` 85%）时 agent 进程自动压缩：当前模型把历史写成摘要，之后的请求从摘要接着做，session 记录里的原始内容保留，压缩完成时有 `context.compacted` 事件（`trigger`、`tokens_before`、`summary`）。`compact()` 在 session 空闲时手动压缩：开始一个 `task.started` 带 `kind: "compact"` 的 task 并返回它的 ID，结果看这个 task 的 `task.ended`；session 不空闲时抛出 `SessionCommandError`。

`host.resumeSession({ ...options, sessionId })` 恢复一个已有的 session：接着写原来的记录，agent 进程按记录重建发给模型的历史，没有指定模型时用上次的模型和推理强度；`session.history()` 给出当前对话里已经记下的事件，前端按它重画。上次没有正常关闭时，中断的 task 以 `failed` 结束；不知道有没有执行完的命令逐个发 `kind` 为 `resume_uncertain` 的 `approval.requested`，批准是重新执行，拒绝是跳过，审批策略为 `never` 时抛出 `SessionResumeError`、session 记录不变。中断前给出的批准都失效。

每次用户输入有一个检查点（`session.checkpoints()`）。Host 在工具调用前后给工作区做快照，放在根目录下 agent 的沙盒写不到的影子 git 仓库里；要求 git 2.32 以上，没有时这个 session 不做快照，发一条 `warning`。`session.diff(checkpointId)` 给出某个检查点以来 agent 的改动，`session.undo(checkpointId)` 把这些文件还原到那时：之后又被别处改过的列在 `conflicts` 里、不还原，传 `{ overwrite: true }` 才覆盖；没有快照的（超过大小上限或沙盒读不到的文件、快照已经清理的检查点）列在 `unsnapshotted` 里，编辑工具写到工作区之外的文件列在 `outside` 里，都撤销不了。被 `.gitignore` 忽略的文件不做快照，命令对它们的改动撤销不了，也不会列出；编辑工具改的文件即使被忽略也能撤销。每个 session 只留最近 100 个检查点的快照。

`session.rewind(checkpointId, { code })` 把对话回退到那次输入之前，`code` 为真时同时还原代码；被放弃的那一段留在记录里，`session.branches()` 列出它们，`session.switchBranch(id)` 切回去。`host.forkSession({ ...options, sessionId, checkpointId })` 从一个已关闭的 session 分叉出新的 session，沿用到分叉位置为止的对话和检查点，来源 session 不变。`undo`、`rewind` 和 `switchBranch` 只能在 session 空闲时调用，否则抛出 `SessionCommandError`。

长期记忆默认启用，模型另有 `memory_propose`、`memory_search`、`memory_read` 三个工具（不受 `[tools]` 控制）。记忆分 project 和 user 两种范围，各自一个 SQLite 文件，放在 Host 根目录的 `data` 下。模型提议的和后台从旧 session 里提取的都只是候选（`memory.candidates` 事件），用户确认后才生效；生效记忆的标题列在会话开始的上下文里，正文由模型按需读取（`memory.retrieved` 事件）。`session.memory` 是查看、确认、纠正和删除的接口（`list`、`get`、`add`、`confirm`、`reject`、`correct`、`rollback`、`retire`、`restore`、`expire`、`purge`），会改动的操作要带上看到的版本号，记忆在那之后被改过时抛出 `MemoryConflictError`。`purge` 彻底删除一条记忆，并把它留在 session 记录里的内容按事件脱敏：它依据的对话，和列过它的标题和正文的地方（给模型的索引、检索结果、候选列表；user 记忆在每个登记过的项目里找）。返回 `PurgedMemory`：`redacted` 是脱敏了的 session，`remaining` 是这一次脱敏不了的 session 和原因（比如它正打开着），之后用 `host.redactEvents` 处理，带上 `memoryIds`。评测用 `openSession` 的 `memory` 选项关掉长期记忆（`{ enabled: false }`）或换写入策略和注入方式，用 `session.extractMemory(sessionId)` 对一个已关闭的 session 立即提取。

子 agent 按配置里 `[agents.<名字>]` 的定义启动，一个定义也没有时模型没有这几个工具：

```toml
[agents.explorer]
description = "Looks things up in the repository without changing it."
sandbox_mode = "read-only"
tools = ["read", "grep", "ls"]

[agents.worker]
description = "Makes a change in its own copy of the repository."
workspace = "isolated"
```

有定义时模型另有 `spawn_agent`、`send_message`、`interrupt_agent` 三个工具。每个子 agent 是另一个 agent 进程，有自己的沙盒（沙盒模式取 session 当前模式和定义里较严的一个）和自己的 run，和启动它的 task 共用一份预算；`workspace = "isolated"` 的在 Host 根目录下项目仓库的一份克隆里运行（要求项目是有提交的 git 仓库），改动由主 agent 合并，session 关闭时删除。子 agent 的事件带它自己的 `agent_id`，开始和结束是 `subagent.started`、`subagent.ended`，结果作为通知交给主 agent；`session.history()`、回退、分叉和恢复只看主 agent 的对话。定义里的 `model` 只认用户级配置。

凭据按启动参数（`credentials`）、用户级配置的 `[credentials]`、系统凭据库的顺序取第一个找到的来源。macOS 上的系统凭据库是登录钥匙串，`host.saveCredential(id, value)` 写入；`createHost` 的 `credentialStore` 可以换成别的实现，传 `null` 不用。错误和警告写进根目录下的 `data/logs/`，日志、错误信息和事件里都去掉 Host 持有的凭据。

云厂商只发短期凭据的模型服务（Vertex AI、Entra ID、AWS 的临时凭据），凭据的来源可以写成一条输出凭据的命令：`{ command, args, timeout_ms, refresh_interval_ms }`，后两项默认 5 秒和 5 分钟。Host 不经 shell 运行它，当前目录是 Host 根目录，标准输出去掉首尾空白就是凭据；过了刷新间隔、或模型服务返回 401 之后重新运行。它在沙盒外运行，只认用户级配置和 `credentials` 选项，只能用于模型服务。云平台上的模型在 `[models.<ID>]` 里写全（字段的例子见 `@ospreycode/api` 的 README）：

```toml
[credentials]
vertex = { command = "gcloud", args = ["auth", "print-access-token"] }
# auth 为 aws-sigv4 的条目：凭据是 credential_process 格式的 JSON
bedrock = { command = "aws", args = ["configure", "export-credentials", "--format", "process"] }

# 模型服务自带的联网搜索和网页读取默认关闭，按服务打开；仓库配置只能关闭
[server_tools.anthropic]
web_search = true
web_fetch = true
```

打开的服务端工具由模型服务执行，不经过沙盒和审批：调用和结果作为 `opaque` 块留在 `message.completed` 的回复里，计费的次数记在用量的 `server_tools`，费用算进 run 的预算。开关在打开 session 时定下。

打开的 session 持有工作区锁：同一个工作区或互相包含的工作区同时只能有一个打开的 session，`close()` 时释放。Host 启动的进程记在根目录的 `data/processes.json` 里，Host 崩溃后残留的进程在下次打开同一工作区时结束。`host.listProjects()` 和 `host.linkProject(directory, projectId)` 查看和关联项目。

不打开 session 的方法，CLI 的子命令用它们：

- `host.listSessions({ directory })` 列出 session（标识、项目、工作区、创建和最近写入的时间、标题），最近写过的在前；不给 `directory` 时列出全部项目的。只读 session 记录，打开着的 session 也列得出来。
- `host.deleteSession({ directory, sessionId, withForks })` 彻底删除 `directory` 所在项目里的一个 session：记录、临时目录和输出文件、内容只来自它的长期记忆，返回删掉的 session 和记忆；`withForks` 把从它分出去的分叉（`host.sessionForks({ directory, sessionId })` 列出它们）一起删除。要删的 session 正被 Host 打开着时抛出 `WorkspaceError`。
- `host.exportSession({ directory, sessionId })` 返回可以遍历的 JSONL 行：第一行是元数据，之后每行一个事件，密钥这类内容换成 `[REDACTED]`；打开着的 session 也能导出。`host.rebuildSessions({ directory })` 从事件重建项目的会话树和检查点索引，项目里的 session 要都关着。
- `host.redactEvents({ directory, sessionId, eventIds, memoryIds, withSessions })` 按事件脱敏：把指名的事件（`event_id` 取自导出的每一行）和按编号找出的副本换成占位 `[REDACTED]`，包括目标协议的原文、工具调用的参数或结果、hooks 的输出、记忆检索的查询、`output/` 下的输出文件和之后的压缩摘要，返回覆盖了哪些事件、输出文件和波及的别的 session。`memoryIds` 是可选的，给记忆的编号（和 `eventIds` 至少给一样）：这条记忆的标题和正文在这个 session 的记录里的副本一起覆盖，记忆已经删除也能给。只能对没有打开的 session 做；会波及别的 session（分叉，或引用了同一份大内容的）时要带 `withSessions: true`，否则抛出 `WorkspaceError`。`host.redactionScope({ directory, sessionId, eventIds, memoryIds })` 只读地算出会覆盖什么，确认之前先给用户看。用户提交的输入在 `task.started` 和发给模型的 `message.sent` 里各有一份，两者带同一个 `message_id`，指名一个就一起覆盖；按编号找不到的副本（模型在回复里复述的内容、后台通知交给模型的那一份、之后读了同一个输出文件的调用）要另外指名。被覆盖的事件读回来结构不变，带 `redacted: true`。
- `host.cleanExpiredSessions()` 清理各个项目里到期的 session（最后一次写入在用户级配置的 `session_retention_days` 天之前，默认 30），返回删掉的；长期记忆保留。`createHost` 不会自己调用它，调用方在打开 session 之后调用。
- `host.clearCache({ directory })` 清空构建缓存，返回清空了的项目；不给 `directory` 时清空全部项目的。只删缓存目录里的内容，不管有没有打开的 session。
- `host.defaultService()` 给出用户级配置选用的默认模型所属的服务；`host.credentialStatus({ credentials })` 列出各个模型服务的凭据取自启动参数、用户级配置还是系统凭据库，不返回凭据的值。
- `host.runInSandbox({ workspace, permissions, command, stdio, onWarning })` 用和 session 的命令沙盒同一套策略运行一条命令：不询问，权限规则没有放行的域名直接拒绝，`stdio` 给出命令的标准输入、标准输出和标准错误接到哪里，返回命令的退出码或结束它的信号。
- `doctor({ root, env, workspace })` 检查运行环境（Node 版本、沙盒后端、登录钥匙串、git 版本、根目录、socket 路径长度、配置和权限规则文件），逐项返回是否通过和说明。它不是 `Host` 的方法：根目录有问题时 `createHost` 就会抛出错误。

对外的事件格式：`hostEventSchema` 是全部事件的 JSON Schema（`isHostEvent` 按它检查），`exitCodeFor` 给出非交互模式的退出码，`toJsonLine` 把事件写成 CLI JSON 输出里的一行。

其他导出：`newId()` 生成 Host 的各种标识；`redact`、`containsSecret` 检测和替换密钥；`readCredential` 按来源读凭据；Host 写入 session 记录的事件格式（task、批准、进程、协议原文）。记录里的图片只存一份：`message.sent`、`tool_call.completed` 和 `protocol.raw` 里图片的位置是对大内容的引用（`StoredImage`、`RawImage`），字节用 session-store 的 `blob` 按 `sha256` 取；经 `onEvent` 收到的 `tool_call.completed` 照旧带完整的图片块。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`，macOS 或 Linux。

## 许可证

Apache-2.0
