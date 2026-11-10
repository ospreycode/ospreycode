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

凭据按启动参数（`credentials`）、用户级配置的 `[credentials]`、系统凭据库的顺序取第一个找到的来源。macOS 上的系统凭据库是登录钥匙串，`host.saveCredential(id, value)` 写入；`createHost` 的 `credentialStore` 可以换成别的实现，传 `null` 不用。错误和警告写进根目录下的 `data/logs/`，日志、错误信息和事件里都去掉 Host 持有的凭据。

打开的 session 持有工作区锁：同一个工作区或互相包含的工作区同时只能有一个打开的 session，`close()` 时释放。Host 启动的进程记在根目录的 `data/processes.json` 里，Host 崩溃后残留的进程在下次打开同一工作区时结束。`host.listProjects()` 和 `host.linkProject(directory, projectId)` 查看和关联项目。

不打开 session 的方法，CLI 的子命令用它们：

- `host.listSessions({ directory })` 列出 session（标识、项目、工作区、创建和最近写入的时间、标题），最近写过的在前；不给 `directory` 时列出全部项目的。只读 session 记录，打开着的 session 也列得出来。
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
