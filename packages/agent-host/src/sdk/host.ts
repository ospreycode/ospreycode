import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolRegistry } from "@ospreycode/agent-runtime";
import {
	builtinModels,
	type CountTokens,
	countTokens,
	type StreamModel,
	streamModel,
} from "@ospreycode/api";
import type { ReasoningEffort } from "@ospreycode/api/protocol";
import type { ElicitationAnswer } from "@ospreycode/mcp";
import type { MemoryStore } from "@ospreycode/memory";
import {
	type ApprovalAnswer,
	type ApprovalPolicy,
	type GranularApproval,
	loadShellParser,
	type SandboxMode,
	type ShellParser,
} from "@ospreycode/sandbox";
import { checkSandboxSupport } from "@ospreycode/sandbox/backends";
import {
	type Position,
	SessionStore,
	type SessionWriter,
} from "@ospreycode/session-store";
import { SessionRules } from "../actions/session-rules.js";
import { ConfigError } from "../config/errors.js";
import {
	loadRuleFiles,
	userRulesDirectory,
} from "../config/permission-rules.js";
import { profileDomainRules } from "../config/sandbox-mode.js";
import {
	resolveSessionConfig,
	type SessionConfig,
	type SessionOptions,
} from "../config/session-config.js";
import {
	CredentialError,
	type LoadedCredential,
	loadCredential,
} from "../credentials/sources.js";
import {
	type CredentialStatus,
	type CredentialStatusOptions,
	credentialStatus,
	defaultService,
	userLayer,
} from "../credentials/status.js";
import { type CredentialStore, macosKeychain } from "../credentials/store.js";
import { DiagnosticLog } from "../diagnostics/log.js";
import { ExtensionAdmin } from "../extensions/admin.js";
import type { ExtensionInfo } from "../extensions/catalog.js";
import { PluginStore } from "../extensions/plugins.js";
import { TrustStore } from "../extensions/trust.js";
import { McpCredentials } from "../mcp-hub/credentials.js";
import type { McpServerState } from "../mcp-hub/hub.js";
import { VerdictCache } from "../mcp-hub/verdicts.js";
import type { MemoryExtractionEnded } from "../memory/events.js";
import type { MemoryManager } from "../memory/session-memory.js";
import { memoryPaths, openMemoryStore } from "../memory/session-sources.js";
import type { BackgroundCommandInfo } from "../processes/background.js";
import { ExtensionSandboxes } from "../processes/extension-sandbox.js";
import {
	bootId,
	type ProcessIdentity,
	processStartTime,
} from "../processes/info.js";
import { installDirectories } from "../processes/install-location.js";
import { Placeholders } from "../processes/placeholders.js";
import { ProcessRegistry } from "../processes/registry.js";
import {
	runInSandbox,
	type SandboxRunOptions,
	type SandboxRunResult,
} from "../processes/sandbox-run.js";
import {
	sandboxedSession,
	unsandboxedSession,
} from "../processes/sandboxed.js";
import { runGitInSandbox } from "../processes/sandboxed-git.js";
import { type ClearCacheOptions, clearCache } from "../project/cache.js";
import { projectKey, Registry } from "../project/identity.js";
import {
	acquireExclusiveLock,
	acquireWorkspaceLock,
	isLockHeld,
} from "../project/locks.js";
import {
	checkInstallLocation,
	checkSeparate,
	ensureDirectory,
	findProjectRoot,
	prepareRoot,
	resolveWorkspace,
	sessionPaths,
	WorkspaceError,
} from "../project/workspace.js";
import { redact } from "../redaction/redact.js";
import type {
	BranchInfo,
	CheckpointInfo,
	UndoResult,
} from "../sessions/checkpoints.js";
import { pathModel, type RecordedModel } from "../sessions/history.js";
import {
	HostSession,
	type HostSessionOptions,
	type ReloadedSettings,
} from "../sessions/host-session.js";
import { newId } from "../sessions/ids.js";
import type { InputQueueSnapshot, QueuedInput } from "../sessions/inputs.js";
import {
	type ListSessionsOptions,
	listSessions,
	type SessionInfo,
} from "../sessions/list.js";
import {
	cleanExpiredSessions,
	type DeletedSessions,
	type DeleteSessionOptions,
	deleteSession,
	exportSession,
	rebuildSessions,
	type SessionRef,
	sessionForks,
} from "../sessions/maintenance.js";
import {
	type RedactEventsOptions,
	type RedactionSummary,
	redactEvents,
	redactionScope,
	redactMemory,
} from "../sessions/redaction.js";
import { type ResumeState, readResumeState } from "../sessions/resume.js";
import type { UserInput } from "../sessions/user-input.js";
import type { ChangesDiff } from "../workspace/session-snapshots.js";
import type { HostEvent } from "./events.js";

/** 创建 Host 的选项。SDK 不改进程级的状态，依赖都由调用方传入。 */
export interface HostOptions {
	/** Host 根目录，CLI 用 `~/.ospreycode`；不存在时以 0700 创建。用户级配置是它下面的 `config.toml`。 */
	root: string;
	/** Host 启动时的环境变量：传给沙盒的白名单变量和环境变量来源的凭据从这里取。 */
	env: Readonly<Record<string, string | undefined>>;
	/**
	 * 发模型请求、连接远程 MCP server 和它们的授权服务器用的 `fetch`，需要代理时传入带代理的版本；
	 * 不传时用 Node 内置的。
	 */
	fetch?: typeof globalThis.fetch;
	/** 发起模型请求的函数；不传时按模型清单的协议发出真实请求。 */
	streamModel?: StreamModel;
	/** 调模型服务 token 计数接口的函数，上下文长度临界时用；不传时按模型清单的协议发出真实请求。 */
	countTokens?: CountTokens;
	/** agent 进程的入口文件；不传时从 `@ospreycode/agent-runtime` 的 exports 找到，`cli` 打包后传入打包的文件。 */
	agentEntry?: string;
	/** apply-edits 的入口文件，执行批准的、可写范围之外的文件改动；不传时同样从 exports 找到。 */
	applyEditsEntry?: string;
	/** 沙盒辅助进程的入口文件；不传时从 `@ospreycode/sandbox` 的 exports 找到。 */
	sandboxHelperEntry?: string;
	/**
	 * 系统凭据库：启动参数和用户级配置都没有指定某个凭据的来源时从这里读。不传时 macOS 上用登录钥匙串，
	 * 其他平台没有；传 `null` 表示不用系统凭据库。
	 */
	credentialStore?: CredentialStore | null;
}

/** 打开 session 的选项。 */
export interface OpenSessionOptions extends SessionOptions {
	/**
	 * 接收这个 session 的全部事件，第一条是 `session.started`，最后一条是 `session.ended`；
	 * 仓库配置里被忽略的键和更松的值紧跟在 `session.started` 之后作为 `warning` 发出。
	 */
	onEvent: (event: HostEvent) => void;
}

/** 恢复 session 的选项。 */
export interface ResumeSessionOptions extends OpenSessionOptions {
	/** 要恢复的 session：要是在当前工作区创建的。 */
	sessionId: string;
}

/** 分叉 session 的选项。 */
export interface ForkSessionOptions extends OpenSessionOptions {
	/** 从哪个 session 分叉：要是在当前工作区创建的。 */
	sessionId: string;
	/** 从哪个检查点的输入之前分叉；不给时从这个 session 的当前位置分叉。 */
	checkpointId?: string;
}

/** 打开 session 的方式：新建，接着已有的记录，或者从已有的记录分叉。 */
type SessionStart =
	| { kind: "new" }
	| { kind: "resume"; sessionId: string }
	| { kind: "fork"; sessionId: string; checkpointId?: string };

/** 一个打开的 session。 */
export interface Session {
	readonly id: string;
	/** session 关闭后兑现，包括 agent 进程意外退出。 */
	readonly ended: Promise<void>;
	/**
	 * 当前生效的配置：会话中换过的模型、推理强度、沙盒模式和审批策略已经并在里面。配置文件的改动要到
	 * `reload()` 之后才在里面，所以前端显示当前的设置时用它，不要自己再调 `resolveConfig`。
	 */
	config(): SessionConfig;
	/**
	 * 在 session 空闲时开始一个 task，返回 `task_id`。输入是一段文字，或分好段的输入：其中 `@` 提及的
	 * 路径由 runtime 在这条输入进入上下文时在沙盒里读取，文件内容放进这条用户消息。`steer` 和
	 * `followUp` 的输入相同。
	 */
	submit(input: string | UserInput[]): Promise<string>;
	/**
	 * task 运行时的输入，并入当前 task（steering）：在下一次模型请求之前插入，返回这条输入的编号。
	 * 取消时还没插入的 steering 立即交给模型，同一个 task 接着进行；task 结束时还没插入的随
	 * `input.dequeued`（`reason: "task_ended"`）交还，前端把它放回输入框。没有进行中的 task 时抛出。
	 */
	steer(input: string | UserInput[]): string;
	/**
	 * 排进 follow-up 列表，返回这条输入的编号：当前 task 以 `completed` 结束后，列表里的输入逐条作为
	 * 新的 task 开始（`task.started` 的 `source` 为 `follow_up`）；别的结果让列表暂停。session 空闲时
	 * 只有列表暂停着才能排，否则抛出。
	 */
	followUp(input: string | UserInput[]): string;
	/** 取回排队的 steering 和 follow-up：给了编号只取那一条，不给取回全部；返回取回的输入。 */
	dequeue(inputId?: string): QueuedInput[];
	/** 当前排队的 steering 和 follow-up，以及列表是不是暂停着。 */
	inputQueue(): InputQueueSnapshot;
	/**
	 * 会话树的当前路径上已经记下的事件，按先后，和当时发给 `onEvent` 的相同（只用于实时显示的流式
	 * 增量没有存，不在里面；分叉沿用的父 session 那一段也在里面）。前端在恢复、回退和分叉之后按它
	 * 重画对话。
	 */
	history(): HostEvent[];
	/**
	 * 这个 session 的检查点，按建立的先后：每次用户输入（task 的输入和 steering）一个，分叉沿用的
	 * 父 session 的也在里面。回退只能选在当前路径上的（`on_path`），还原代码只能选快照还在的
	 * （`restorable`）。
	 */
	checkpoints(): CheckpointInfo[];
	/**
	 * 从某个检查点到现在 agent 的改动（`/diff`），unified diff；不给检查点时是这个 session 的全部
	 * 改动。task 运行中也可以看。这个 session 没有做快照（找不到可用的 git），没有这个检查点或者它的
	 * 快照已经清理时抛出 `SessionCommandError`；快照做不成时抛出 `SnapshotError`。
	 */
	diff(checkpointId?: string): Promise<ChangesDiff>;
	/**
	 * 撤销改动（`/undo`）：把工作区的文件还原到某个检查点，对话不动。只还原 agent 改过的文件；之后又
	 * 被别处改过的列为冲突、不还原，`overwrite` 为真时照样还原。还在运行的后台命令先结束；还原了
	 * 文件时给模型留一条不唤醒 session 的通知。只能在 session 空闲时做，否则抛出
	 * `SessionCommandError`；别的出错情况同 `diff`。
	 */
	undo(
		checkpointId: string,
		options?: { overwrite?: boolean },
	): Promise<UndoResult>;
	/**
	 * 回退会话（`/rewind`）：把当前位置移到某个检查点的输入之前，之后的输入接在那里；被放弃的那一段
	 * 留在记录里。这个检查点之后启动的后台命令先结束，之前启动的保留；agent 进程重启，按新的路径
	 * 重建历史；模型和推理强度换成路径上最后一次请求用的。`code` 为真时同时把代码还原到这个检查点
	 * （同 `undo`，不另给模型留通知），返回还原的结果。完成后用 `history()` 重画对话，检查点的
	 * `text` 是可以放回输入框的那次输入。只能在 session 空闲时做，检查点要在当前路径上，否则抛出
	 * `SessionCommandError`；路径上的模型已经不在清单里或没有凭据时抛出 `ConfigError` 或
	 * `CredentialError`，这两种情况 session 不受影响。agent 进程没能重新启动时 session 关闭，抛出
	 * `AgentStartError`。
	 */
	rewind(
		checkpointId: string,
		options?: { code?: boolean; overwrite?: boolean },
	): Promise<UndoResult | undefined>;
	/**
	 * 被放弃的分支，按放弃的先后：回退之后留在记录里、不在当前路径上的各段对话。最后一次用户输入
	 * 也在当前路径上的不列（它只多出空闲时的事件）。
	 */
	branches(): BranchInfo[];
	/**
	 * 切回一个被放弃的分支：把当前位置移到它的末端，之后的输入接在那里，现在这一段成为被放弃的
	 * 分支。文件不动。不在那个分支上启动的后台命令先结束；agent 进程重启、模型和推理强度的处理同
	 * `rewind`。完成后用 `history()` 重画对话。只能在 session 空闲时做，没有这个分支时抛出
	 * `SessionCommandError`；别的出错情况同 `rewind`。
	 */
	switchBranch(branchId: string): Promise<void>;
	/**
	 * 让暂停的 follow-up 列表继续：session 空闲时马上开始列表的第一条。用户的下一次 `submit`
	 * 也会让列表继续。
	 */
	resumeFollowUps(): Promise<void>;
	/**
	 * 切换模型（`/model`），可以同时换推理强度：从下一次模型请求起生效，task 运行中也可以换。
	 * 切换前做和启动时相同的检查，不满足时抛出、session 不受影响：模型不在清单里或开启费用上限而
	 * 模型没有价格是 `ConfigError`，没有凭据是 `CredentialError`。实际换了之后，在用到新模型的
	 * 第一次请求之前发出 `model.changed`。新模型的凭据来自另一个文件、沙盒还读得到它时，按 `reload()`
	 * 处理（重启 agent 进程），只能在 session 空闲时做，否则抛出 `SessionCommandError`。
	 */
	setModel(model: string, reasoningEffort?: ReasoningEffort): Promise<void>;
	/**
	 * 切换推理强度（`/effort`）：从下一次模型请求起生效，task 运行中也可以换。实际换了之后，在用到
	 * 新级别的第一次请求之前发出 `reasoning_effort.changed`。
	 */
	setReasoningEffort(reasoningEffort: ReasoningEffort): Promise<void>;
	/**
	 * 压缩上下文（`/compact`）：开始一个只做压缩的 task，返回 `task_id`；它有自己的 run 和预算，
	 * `task.started` 带 `kind: "compact"`、输入为空。当前的模型把到此为止的历史写成摘要，成功时发出
	 * `context.compacted`，task 以 `completed` 结束；压缩不了时（上下文里还没有模型的回复、
	 * `PreCompact` hook 阻止、摘要请求出错）以 `failed` 结束并说明原因，历史不变。只能在 session
	 * 空闲时做，否则抛出 `SessionCommandError`。
	 */
	compact(): Promise<string>;
	/**
	 * 运行中的后台命令和监视（`/bg`），按开始的顺序。它们属于 session，task 结束后继续运行；开始和结束
	 * 另有 `background.started`、`background.ended` 事件，非交互模式据此等它们结束。
	 */
	backgroundCommands(): BackgroundCommandInfo[];
	/**
	 * 停止一条后台命令，等它和它的子孙进程结束；没有这个编号或已经结束时返回 false。用户停掉的命令
	 * 产生一条不唤醒 session 的通知，等下一次开始 task 时交给模型。
	 */
	stopBackgroundCommand(backgroundId: string): Promise<boolean>;
	/**
	 * 等 session 空闲下来：没有进行中的 task，task 结束后接着要开始的（follow-up、后台通知的唤醒）
	 * 也都结束了；session 关闭后立即兑现。还在运行的后台命令不算在内，用 `backgroundCommands()` 看。
	 * 非交互模式用它判断主任务之后还有没有通知要处理。
	 */
	whenIdle(): Promise<void>;
	/**
	 * 回答 `approval.requested`、`server_approval.requested`（都用 `ApprovalAnswer`）和
	 * `elicitation.requested`（用 `ElicitationAnswer`：接受并给出表单内容、拒绝或取消）；询问已经
	 * 有了结果时返回 false。
	 */
	respond(
		requestId: string,
		answer: ApprovalAnswer | ElicitationAnswer,
	): boolean;
	/**
	 * 这个 session 找到的全部扩展（skills、MCP server、hooks、插件）和它们的状态（`/extensions`）。
	 * 确认、启用和停用用 `Host.extensions`，改动在 `reload()` 之后生效。
	 */
	extensions(): ExtensionInfo[];
	/** 这个 session 的 MCP server 的状态和各自提供的工具，按标签排序。 */
	mcpServers(): McpServerState[];
	/**
	 * 切换审批策略（`/approval`）：马上生效，task 进行中也可以，完成后发出 `approval_policy.changed`。
	 * 挂起的询问在新策略下不该再问的，立即答为拒绝（`approval.decided` 的 `denied_by_policy`）。
	 * 和启动参数排在同一层：仓库配置收紧过的策略放不松，实际生效的策略以事件里的 `to` 为准。
	 * `granular` 按类别覆盖配置文件里的 `[approval_granular]`；换成 `granular` 而七个类别没有写全时
	 * 抛出 `ConfigError`。
	 */
	setApprovalPolicy(
		policy: ApprovalPolicy,
		granular?: Partial<GranularApproval>,
	): void;
	/** 取消当前的 run，task 以 `cancelled` 结束。 */
	cancel(): Promise<void>;
	/**
	 * 切换沙盒模式（`/sandbox`）：按新模式准备沙盒、重启 agent 进程，新进程按 session 记录重建发给
	 * 模型的历史，完成后发出 `sandbox_mode.changed`。只能在 session 空闲时做，`danger-full-access`
	 * 只能在启动时指定：这两种情况抛出 `SessionCommandError`，session 不受影响。模式不存在时抛出
	 * `ConfigError`，当前平台没有沙盒后端时抛出 `SandboxUnavailableError`。agent 进程没能重新启动时
	 * session 关闭，抛出 `AgentStartError`。
	 */
	setSandboxMode(mode: SandboxMode): Promise<void>;
	/**
	 * 重新加载配置（`/reload`）：重新读取全部配置和凭据，会话中切换过的沙盒模式保留；重新准备沙盒、
	 * 重启命令辅助进程和 agent 进程。只能在 session 空闲时做，否则抛出 `SessionCommandError`；
	 * 配置有错时抛出 `ConfigError` 或 `CredentialError`，session 照旧用原来的配置。
	 */
	reload(): Promise<void>;
	/**
	 * 查看、纠正和删除长期记忆，确认或拒绝候选（`/memory`）；打开 session 时关掉了长期记忆
	 * （`memory.enabled: false`）的没有。
	 */
	readonly memory: MemoryManager | undefined;
	/**
	 * 立即从同一项目里一个已关闭的 session 的记录提取记忆候选，返回这次提取的结果（同
	 * `memory.extraction.ended`）。只给评测用：后台提取平时只处理空闲 6 小时以上的 session。
	 * 没有启用长期记忆、那个 session 不存在、还开着或已经提取过时抛出。
	 */
	extractMemory(sourceSessionId: string): Promise<MemoryExtractionEnded>;
	/** 关闭 session，结束其中的全部进程，释放工作区锁。 */
	close(): Promise<void>;
}

/** 登记过的一个项目。 */
export interface ProjectInfo {
	project_id: string;
	/** 关联到这个项目的路径：git 公共目录，或不是 git 仓库的目录。 */
	paths: string[];
}

/** 本地后端。CLI 和评测都只通过它使用 Host。 */
export interface Host {
	/**
	 * 按启动参数、仓库配置、用户级配置和内置默认值的顺序合并配置并检查，不打开 session：
	 * CLI 用它在打开 session 之前取代理设置，`doctor` 用它检查配置能否加载。参数或配置有错时
	 * 抛出 `ConfigError` 或 `WorkspaceError`。
	 */
	resolveConfig(options: SessionOptions): SessionConfig;
	/**
	 * 新建一个 session：合并配置，检查凭据，取得工作区锁，结束这个工作区里上次残留的进程，启动 agent
	 * 进程并完成握手。参数或配置有错时抛出 `ConfigError`、`CredentialError` 或 `WorkspaceError`
	 * （包括工作区已经有打开的 session）；当前平台没有沙盒后端时抛出 `SandboxUnavailableError`；
	 * agent 进程没能启动时抛出 `AgentStartError`。
	 */
	openSession(options: OpenSessionOptions): Promise<Session>;
	/**
	 * 恢复一个已有的 session（`ospreycode resume`）：和 `openSession` 走同一条路径，接着写原来的记录，
	 * agent 进程按记录重建发给模型的历史；follow-up 列表按记录里最后一份队列恢复，上次的临时目录清空。
	 * 这个 session 不存在、不是在当前工作区创建的，或者正被别的 Host 打开时抛出 `WorkspaceError`。
	 *
	 * 上次没有正常关闭时，中断的 task 以 `failed` 结束（紧跟在 `session.started` 之后），没有结果的
	 * 工具调用里：文件改动按哈希核对磁盘补上结果；还没批准过的和重复执行没有副作用的，在下一个 task
	 * 开始时重新执行；其余的逐个发 `approval.requested`（`kind: "resume_uncertain"`）问用户，批准是
	 * 重新执行，拒绝是跳过，都回答之后 task 才结束、agent 进程才启动，这期间 `submit` 等着。审批策略
	 * 是 `never` 而有调用要问时抛出 `SessionResumeError`，session 记录不变。上次还在运行的后台命令
	 * 记 `background.ended`（`reason: "lost"`）。
	 */
	resumeSession(options: ResumeSessionOptions): Promise<Session>;
	/**
	 * 从一个已有的 session 分叉出新的 session（`/fork`）：新的 session 沿用来源 session 到分叉位置为止
	 * 的对话和检查点，之后各写各的，来源 session 不变。和 `openSession` 走同一条路径；来源 session 要先
	 * 关闭（一个工作区同时只有一个打开的 session）。没有另外指定模型时用路径上最后一次请求用的模型和
	 * 推理强度（`resumeSession` 相同）。来源 session 不存在、不是在当前工作区创建的、没有这个检查点、
	 * 分叉位置之前还没有对话，或者不给检查点而它上次没有正常关闭（停在没有结束的 task 里，要先恢复）
	 * 时抛出 `WorkspaceError`。
	 */
	forkSession(options: ForkSessionOptions): Promise<Session>;
	/** 登记过的项目（`ospreycode project list`）。 */
	listProjects(): ProjectInfo[];
	/**
	 * 把目录所在的项目关联到已有的项目（`ospreycode project link`）：仓库移动后路径变了就是新项目，
	 * 用它接上原来的记录。项目不存在时抛出 `ConfigError`。
	 */
	linkProject(directory: string, projectId: string): Promise<void>;
	/**
	 * 把凭据保存进系统凭据库（`ospreycode login`），已有的覆盖。没有系统凭据库的平台抛出
	 * `CredentialError`：那里用 `--credential-file` 或用户级配置的 `[credentials]` 指定来源。
	 */
	saveCredential(id: string, value: string): Promise<void>;
	/** 从系统凭据库删除凭据（`ospreycode logout`），本来就没有时返回 false。 */
	deleteCredential(id: string): Promise<boolean>;
	/**
	 * 用户级配置选用的默认模型所属的服务（`login`、`logout` 不写 `--service` 时用它）；没有选用模型，
	 * 或者选用的模型不在清单里时为空。只读用户级配置，和当前目录无关；它加载出错时抛出 `ConfigError`。
	 */
	defaultService(): string | undefined;
	/**
	 * 用户级配置里的 `proxy`：不打开 session 就要联网的命令（`ospreycode mcp login`）在发请求之前
	 * 用它开启代理；没有配置时为空。用户级配置加载出错时抛出 `ConfigError`。
	 */
	proxy(): string | undefined;
	/**
	 * 各个模型服务的凭据取自哪一层（`ospreycode login status`）：启动参数、用户级配置还是系统凭据库。
	 * 只说明来源，不返回凭据的值。用户级配置加载出错时抛出 `ConfigError`，系统凭据库锁定或不可用时
	 * 抛出 `CredentialError`。
	 */
	credentialStatus(
		options?: CredentialStatusOptions,
	): Promise<CredentialStatus[]>;
	/**
	 * 列出 session（`ospreycode session list`），最近写过的在前；给了目录只列它所在项目的。
	 * 只读 session 记录，不取工作区锁。目录不存在时抛出 `WorkspaceError`。
	 */
	listSessions(options?: ListSessionsOptions): SessionInfo[];
	/**
	 * 从这个 session 分出去的全部分叉（包括分叉的分叉），按创建的先后：删除之前用它告诉用户还有几个
	 * 分叉包含这段内容。项目里没有这个 session，或者目录不存在时抛出 `WorkspaceError`。
	 */
	sessionForks(ref: SessionRef): string[];
	/**
	 * 彻底删除一个 session（`ospreycode session delete`）：记录、临时目录和输出文件，以及内容只来自它的
	 * 长期记忆；它的工作区没有别的 session 时删掉影子仓库，项目的 session 都删除了时清空构建缓存。
	 * 在整个项目里找，给的目录不必是它的工作区。`withForks` 把分叉一起删除；不给时分叉留着，它们仍
	 * 引用的事件改记到它们名下。项目里没有这个 session，或者要删的 session 里有一个正被 Host 打开着
	 * 时抛出 `WorkspaceError`，什么也不删。
	 */
	deleteSession(options: DeleteSessionOptions): Promise<DeletedSessions>;
	/**
	 * 导出一个 session（`ospreycode session export`）：每项是 JSONL 的一行，第一行是元数据和存储格式
	 * 版本，之后每行一个事件，分叉先导出它沿用的父 session 的那一段；密钥这类内容换成 `[REDACTED]`。
	 * 只读，打开着的 session 也能导出。项目里没有这个 session 时调用就抛出 `WorkspaceError`；记录在
	 * 开始遍历时打开，遍历结束或中途停下（`for...of` 里 `break`）时关闭。
	 */
	exportSession(ref: SessionRef): Iterable<string>;
	/**
	 * 从事件表重建目录所在项目的会话树和检查点索引（`ospreycode session rebuild`）。项目里有 session
	 * 正被 Host 打开着，或者项目还没有 session 记录时抛出 `WorkspaceError`。
	 */
	rebuildSessions(options: { directory: string }): void;
	/**
	 * 按事件脱敏会覆盖什么：指名的事件、记录里存着同一份内容的副本（同一条消息和它在目标协议里的
	 * 原文、开始 task 的输入和放它的那条消息、工具调用登记的参数和结果、排队的输入、引用同一张图片的
	 * 事件、输出放在这条消息或这次调用里的 hooks 的运行、按这份输入或这次调用做的记忆检索的查询）、
	 * `memoryIds` 指名的记忆的标题和正文（索引、"记忆更新"、自动注入的正文、检索结果、候选列表）、
	 * 之后的上下文压缩，`output/` 下的文件，和也会受影响的别的 session（分叉，或引用了同一份大内容的
	 * session）。只读，不取锁，执行之前用它告诉用户范围。可以指名的事件是 `task.started`、
	 * `input.queued`、`message.sent`、`message.completed`、`tool_call.started`、
	 * `tool_call.completed`、`context.compacted` 和 `hooks.ran`；`eventIds` 和 `memoryIds` 至少给
	 * 一样。项目里没有这个 session，指名的事件不在它读得到的记录里（它自己的事件和分叉沿用的那段
	 * 路径上的）、类型不能指名，或者没有可覆盖的内容（都已经脱敏过，记录里没有指名的记忆的内容）时
	 * 抛出 `WorkspaceError`。
	 */
	redactionScope(
		ref: SessionRef & { eventIds: string[]; memoryIds?: string[] },
	): RedactionSummary;
	/**
	 * 按事件脱敏（`ospreycode session redact`）：把指名的事件和 `redactionScope` 列出的副本的内容换成
	 * 占位 `[REDACTED]`，事件的结构不变、带上 `redacted: true`；`output/` 下的文件也覆盖成占位，
	 * 标题取自被覆盖的输入时一起换掉。返回覆盖了什么。按编号找不到的副本不在其中，要另外指名：
	 * 模型在回复里复述的内容、后台通知交给模型的那一份、之后读了同一个输出文件的调用。
	 *
	 * 只能对没有打开的 session 做：打开着的 session 的 agent 进程内存里还有原文，脱敏之后要重新打开、
	 * 从记录重建历史。先取得它和受影响的 session 的写锁，有一个正被 Host 打开着时抛出 `WorkspaceError`，
	 * 什么也不改；会波及别的 session 而 `withSessions` 不为真时也一样。几个 session 的事件各在自己的
	 * 事务里覆盖，中途退出时一部分已经覆盖，用同样的参数再执行一次补完。
	 */
	redactEvents(options: RedactEventsOptions): Promise<RedactionSummary>;
	/**
	 * 清理到期的 session，返回删掉的：最后一次写入在用户级配置的 `session_retention_days` 天（默认 30）
	 * 之前的，在每个登记过的项目里彻底删除。和 `deleteSession` 的差别是长期记忆保留（来源标为
	 * "来源已删除"），分叉也留着。正被 Host 打开着的跳过；另一个 Host 正在清理时什么也不做，返回空数组。
	 * `createHost` 不会自己调用它，什么时候清理由调用方决定：CLI 在打开 session 之后调用。
	 * 用户级配置加载出错时抛出 `ConfigError`。
	 */
	cleanExpiredSessions(): Promise<string[]>;
	/**
	 * 清空构建缓存（`ospreycode cache clear`），返回清空了的项目的 `project_id`；给了目录只清它所在
	 * 项目的。只删缓存目录里的内容，不管有没有打开的 session；没有缓存时什么也不做。
	 */
	clearCache(options?: ClearCacheOptions): string[];
	/**
	 * 用和 session 的命令沙盒同一套策略运行一条命令（`ospreycode sandbox`）：不询问，权限规则没有
	 * 放行的域名直接拒绝，标准输入输出直通。配置有错时抛出 `ConfigError` 或 `WorkspaceError`，
	 * 当前平台没有沙盒后端时抛出 `SandboxUnavailableError`。
	 */
	runInSandbox(options: SandboxRunOptions): Promise<SandboxRunResult>;
	/**
	 * 不打开 session 的扩展管理（`ospreycode mcp`、`plugin`、`trust`、`hooks`）：查看扩展，确认、
	 * 启用和停用，安装、更新和卸载插件，改用户级的 `mcp.json`，保存 MCP 的凭据。
	 */
	readonly extensions: ExtensionAdmin;
}

function resolveEntry(specifier: string): string {
	return fileURLToPath(import.meta.resolve(specifier));
}

/**
 * 从来源 session 的哪个位置分叉：给了检查点是它的输入之前，不给是当前位置。分支点是用户输入的边界，
 * 停在没有结束的 task 里的当前位置不行。
 */
function forkPosition(
	store: SessionStore,
	sessionId: string,
	checkpointId: string | undefined,
): Position {
	if (checkpointId !== undefined) {
		const checkpoint = store
			.checkpoints(sessionId)
			.find(({ input_event_id }) => input_event_id === checkpointId);
		if (checkpoint === undefined) {
			throw new WorkspaceError(
				`session ${sessionId} 里没有检查点 ${checkpointId}`,
			);
		}
		if (checkpoint.before === null) {
			throw new WorkspaceError(
				"这个检查点之前还没有对话：从这里分叉就是新建一个 session",
			);
		}
		return checkpoint.before;
	}
	if (readResumeState(store, sessionId).interrupted !== undefined) {
		throw new WorkspaceError(
			`session ${sessionId} 上次没有正常关闭，停在一个没有结束的 task 里：先用 ospreycode resume 恢复它，或者指定从哪个检查点分叉`,
		);
	}
	const position = store.position(sessionId);
	if (position === null) {
		throw new WorkspaceError(
			`session ${sessionId} 里还没有对话，没有可以分叉的内容`,
		);
	}
	return position;
}

/** Host 进程自己的身份，写进锁文件和进程登记表。 */
function selfIdentity(): ProcessIdentity {
	const startTime = processStartTime(process.pid);
	if (startTime === undefined) throw new Error("读不到 Host 进程的启动时间");
	return { pid: process.pid, start_time: startTime, boot_id: bootId() };
}

/** 创建 Host。 */
export function createHost(options: HostOptions): Host {
	const root = prepareRoot(options.root);
	const data = join(root, "data");
	const agentEntry =
		options.agentEntry ?? resolveEntry("@ospreycode/agent-runtime/agent");
	const helperEntry =
		options.sandboxHelperEntry ?? resolveEntry("@ospreycode/sandbox/helper");
	const applyEditsEntry =
		options.applyEditsEntry ??
		resolveEntry("@ospreycode/agent-runtime/apply-edits");
	const agentCommand = [process.execPath, agentEntry];
	const programFiles = [
		fileURLToPath(import.meta.url),
		agentEntry,
		applyEditsEntry,
		helperEntry,
		process.execPath,
	];
	const owner = selfIdentity();
	// 越界执行的命令也不能写的位置：Host 根目录下 Host 会读的条目（不存在的也列出），和安装目录
	const hostEntries = [
		"config.toml",
		"mcp.json",
		"hooks.json",
		"rules",
		"AGENTS.md",
		"data",
		"hooks",
		"plugins",
		"plugin-data",
		"server-data",
		"server-cache",
		"snapshots",
		"cache",
		"tmp",
		"output",
	];
	const install = installDirectories(programFiles, process.execPath);
	// 规则匹配用的 bash 解析器：加载一次 WASM，这个 Host 的 session 共用
	let parser: Promise<ShellParser> | undefined;
	const shellParser = () => {
		parser ??= loadShellParser();
		return parser;
	};
	const registry = new Registry(data, owner);
	const processes = new ProcessRegistry(data, owner);
	/** 一个 session 的写锁：打开着的 session 一直持有。 */
	const sessionLock = (id: string) => join(data, "locks", `session-${id}.lock`);
	const maintenance = { root, data, registry, owner, sessionLock };
	const trust = new TrustStore(data, owner);
	const plugins = new PluginStore({
		root,
		data,
		owner,
		trust,
		runGit: (args, gitOptions) =>
			runGitInSandbox(args, gitOptions, {
				root,
				env: options.env,
				helperEntry,
				hostEntries,
				install,
			}),
	});
	// 上次没有打开的 session 在用的旧版本目录，和中断的安装留下的准备目录
	plugins.cleanVersions();
	const verdicts = new VerdictCache(data, owner);
	const store =
		options.credentialStore === undefined
			? process.platform === "darwin"
				? macosKeychain()
				: undefined
			: (options.credentialStore ?? undefined);
	// Host 读进内存的凭据，日志、错误信息和事件里都去掉它们
	const secrets = new Set<string>();
	const scrub = (text: string) => redact(text, [...secrets]);
	const log = new DiagnosticLog(join(data, "logs"), scrub);
	const redaction = { ...maintenance, scrub, log };
	const mcpCredentials = new McpCredentials({
		store,
		env: options.env,
		platform: process.platform,
		fetch: options.fetch ?? globalThis.fetch,
		onSecret: (value) => secrets.add(value),
	});
	const requireStore = (): CredentialStore => {
		if (store === undefined) {
			throw new CredentialError(
				"这个平台没有系统凭据库：用 --credential-file 或用户级配置的 [credentials] 指定凭据来源",
			);
		}
		return store;
	};

	/** 凭据按启动参数、用户级配置、系统凭据库的顺序取第一个找到的来源。 */
	const credentialFor = async (
		config: SessionConfig,
	): Promise<{ credential: LoadedCredential; file?: string }> => {
		const id = config.model.service;
		const source = config.credentials[id];
		if (source !== undefined) {
			return {
				credential: loadCredential(id, source, {
					workspace: config.workspace,
					env: options.env,
					platform: process.platform,
				}),
				...("file" in source ? { file: realpathSync(source.file) } : {}),
			};
		}
		const value = await store?.get(id);
		if (value === undefined) {
			throw new CredentialError(
				store === undefined
					? `没有模型服务 ${id} 的凭据来源：用 --credential-file 或用户级配置的 [credentials] 指定`
					: `没有模型服务 ${id} 的凭据：用 ospreycode login --service ${id} 保存，或用 --credential-file 指定`,
			);
		}
		return { credential: { id, value } };
	};

	/** 一份配置对应的凭据和权限规则，以及沙盒读写不到、任何批准也放不开的路径。 */
	const settingsFor = async (
		config: SessionConfig,
	): Promise<ReloadedSettings> => {
		const { credential, file } = await credentialFor(config);
		secrets.add(credential.value);
		const parser = await shellParser();
		return {
			config,
			credential,
			rules: new SessionRules({
				files: loadRuleFiles({
					root,
					projectRoot: config.projectRoot,
					startup: config.ruleFiles,
					parser,
				}),
				...(config.permissionProfile === undefined
					? {}
					: {
							profile: profileDomainRules(
								config.sandboxMode,
								config.permissionProfile,
							),
						}),
				parser,
				userRulesDir: userRulesDirectory(root),
				lockDir: join(data, "locks"),
				owner,
			}),
			denied: {
				read: [root, ...(file === undefined ? [] : [file]), ...config.denyRead],
				write: [...config.denyWrite],
			},
		};
	};

	/** 工作区和它所在的项目。 */
	const locate = (directory: string) => {
		const workspace = resolveWorkspace(directory);
		checkSeparate(root, workspace);
		return { workspace, project: findProjectRoot(workspace) };
	};

	const configAt = (
		sessionOptions: SessionOptions,
		{ workspace, project }: ReturnType<typeof locate>,
	): SessionConfig =>
		resolveSessionConfig(sessionOptions, {
			root,
			workspace,
			projectRoot: project.root,
			git: project.git,
			home: options.env.HOME,
			catalog: builtinModels,
			toolNames: [...toolRegistry.keys()],
			install,
		});

	const resolveConfig = (sessionOptions: SessionOptions): SessionConfig =>
		configAt(sessionOptions, locate(sessionOptions.workspace));

	/** 一份配置的凭据和权限规则；要开沙盒时确认这个平台支持。 */
	const checkedSettings = async (
		config: SessionConfig,
	): Promise<ReloadedSettings> => {
		const settings = await settingsFor(config);
		if (config.sandboxMode !== "danger-full-access") {
			checkSandboxSupport(process.platform);
		}
		return settings;
	};

	const openSession = async (
		sessionOptions: OpenSessionOptions,
		start: SessionStart,
	): Promise<Session> => {
		const location = locate(sessionOptions.workspace);
		const { workspace } = location;
		checkInstallLocation(workspace, programFiles);
		// 恢复和分叉没有另外指定模型时接着用路径上记录的模型：配置要有模型才能解析，等读过记录再做
		const opening =
			start.kind === "new"
				? {
						kind: "new" as const,
						settings: await checkedSettings(configAt(sessionOptions, location)),
					}
				: start;
		const userId = await registry.userId();
		const projectId = await registry.projectId(
			projectKey(location.project.root),
		);
		const lock = await acquireWorkspaceLock(
			join(data, "locks"),
			workspace,
			owner,
		);
		// 会话中换过的设置和启动参数排在同一层：重新加载配置时不被配置文件盖掉
		let current: SessionOptions = sessionOptions;
		/** 父 session 链上各个 session 的命令输出目录。 */
		const inheritedOutputs: string[] = [];
		let session: HostSession;
		let store: SessionStore | undefined;
		let writer: SessionWriter | undefined;
		let projectMemory: MemoryStore | undefined;
		let userMemory: MemoryStore | undefined;
		try {
			await processes.cleanWorkspace(workspace);
			const projectDir = join(data, "projects", projectId);
			ensureDirectory(join(data, "projects"));
			ensureDirectory(projectDir);
			store = SessionStore.open(join(projectDir, "sessions.sqlite"));
			const locker = (id: string) =>
				acquireExclusiveLock(sessionLock(id), owner, `session ${id} `);
			let sessionId: string;
			let resume: ResumeState | undefined;
			let fork: HostSessionOptions["fork"];
			let recorded: RecordedModel | undefined;
			let settings: ReloadedSettings;
			if (opening.kind !== "new") {
				const sourceId = opening.sessionId;
				const found = store
					.sessions()
					.find((session) => session.session_id === sourceId);
				if (found === undefined) {
					throw new WorkspaceError(
						`这个项目里没有 session ${sourceId}：用 ospreycode session list 查看`,
					);
				}
				if (found.workspace !== workspace) {
					throw new WorkspaceError(
						`session ${sourceId} 是在 ${found.workspace} 创建的，只能在那里${opening.kind === "resume" ? "恢复" : "分叉"}`,
					);
				}
				const forkAt =
					opening.kind === "fork"
						? forkPosition(store, sourceId, opening.checkpointId)
						: undefined;
				const position = forkAt ?? store.position(sourceId);
				// 模型和推理强度按路径上的记录；启动参数指定了模型的用指定的
				recorded = pathModel(store, sourceId, position);
				if (recorded !== undefined && sessionOptions.model === undefined) {
					current = {
						...sessionOptions,
						model: recorded.model,
						...(sessionOptions.reasoningEffort === undefined
							? { reasoningEffort: recorded.reasoningEffort }
							: {}),
					};
				}
				settings = await checkedSettings(configAt(current, location));
				if (forkAt === undefined) {
					sessionId = sourceId;
					writer = await store.resume(sessionId, locker);
					resume = readResumeState(store, sessionId);
					// 上次的临时文件不留：创建它们的进程都不在了
					rmSync(sessionPaths(root, sessionId).tmp, {
						recursive: true,
						force: true,
					});
				} else {
					sessionId = newId();
					// 父 session 当时的整个检查点索引：不在路径上的检查点改过的文件还在工作区里
					fork = {
						parentSessionId: sourceId,
						checkpoints: store
							.checkpoints(sourceId)
							.map(
								({
									input_event_id,
									kind,
									position,
									before,
									cleaned,
									snapshots,
								}) => ({
									input_event_id,
									kind,
									position,
									before,
									cleaned,
									snapshots,
								}),
							),
					};
					writer = await store.fork(
						{
							session_id: sessionId,
							workspace,
							created_at: new Date().toISOString(),
						},
						{ parent_session_id: sourceId, position: forkAt },
						locker,
					);
					resume = {
						agentId: undefined,
						position: forkAt,
						interrupted: undefined,
						queue: undefined,
						lostBackground: [],
					};
				}
				// 对话里提到的命令输出文件可能在父 session 链上：分叉的沙盒也能读它们
				for (
					let origin = store.session(sessionId).fork;
					origin !== undefined;
					origin = store.session(origin.parent_session_id).fork
				) {
					const { output } = sessionPaths(root, origin.parent_session_id);
					if (existsSync(output)) inheritedOutputs.push(output);
				}
			} else {
				settings = opening.settings;
				sessionId = newId();
				writer = await store.create(
					{
						session_id: sessionId,
						workspace,
						created_at: new Date().toISOString(),
					},
					locker,
				);
			}
			const { config } = settings;
			// 范围落实在文件上：这个项目的记忆库在它自己的目录里，user 记忆库所有项目共用
			if (config.memory !== undefined) {
				ensureDirectory(join(data, "user"));
				const paths = memoryPaths(data, projectId);
				projectMemory = openMemoryStore(paths.project, "project");
				userMemory = openMemoryStore(paths.user, "user");
			}
			session = await HostSession.open({
				store,
				writer,
				sessionId,
				...(resume === undefined ? {} : { resume }),
				...(fork === undefined ? {} : { fork }),
				...(recorded === undefined ? {} : { recorded }),
				root,
				...settings,
				scrub,
				onSecret: (value) => secrets.add(value),
				log,
				hostEnv: options.env,
				fetch: options.fetch ?? globalThis.fetch,
				streamModel: options.streamModel ?? streamModel,
				countTokens: options.countTokens ?? countTokens,
				tracker: processes.tracker(sessionId, workspace),
				lock,
				userId,
				projectId,
				...(projectMemory === undefined || userMemory === undefined
					? {}
					: {
							memory: {
								project: projectMemory,
								user: userMemory,
								owner,
								isSessionOpen: (id: string) =>
									isLockHeld(sessionLock(id), owner.boot_id),
							},
						}),
				extensions: {
					trust,
					plugins,
					verdicts,
					fetch: options.fetch ?? globalThis.fetch,
					locations: {
						root,
						home: options.env.HOME,
						workspace,
						projectRoot: config.projectRoot,
						projectId,
					},
					credentials: (server, sessionConfig) =>
						mcpCredentials.connect(server, {
							workspace,
							sources: sessionConfig.credentials,
							clients: sessionConfig.mcpClients,
							secrets: sessionConfig.mcpSecrets,
						}),
					secrets: (server, sessionConfig) =>
						mcpCredentials.secrets(server, {
							workspace,
							sources: sessionConfig.credentials,
							clients: sessionConfig.mcpClients,
							secrets: sessionConfig.mcpSecrets,
						}),
					resolveMode: (name) => {
						const resolved = resolveConfig({ ...current, sandboxMode: name });
						return {
							baseSandboxMode: resolved.baseSandboxMode,
							...(resolved.permissionProfile === undefined
								? {}
								: { permissionProfile: resolved.permissionProfile }),
						};
					},
				},
				// 切换沙盒模式和重新加载配置时再调用，所以模式和路径都取这一次给的
				createSandbox: async (context) => {
					const { denied, bash, env, directories, tracker } = context;
					const mode = context.config.baseSandboxMode;
					const profile = context.config.permissionProfile;
					if (mode === "danger-full-access") {
						return unsandboxedSession(agentCommand, bash);
					}
					if (env.HOME === undefined) {
						throw new ConfigError(
							"Host 的环境变量里没有 HOME，找不到要禁止读取的密钥位置",
						);
					}
					const policy = {
						mode,
						workspace,
						tmpdir: directories.tmp,
						cache: directories.cache,
						readOnly: [directories.output, ...inheritedOutputs],
						denyRead: [...denied.read],
						denyWrite: [...denied.write],
						home: env.HOME,
						hostRoot: root,
						hostEntries,
						install,
						...(profile === undefined ? {} : { profile }),
					};
					const capabilities = checkSandboxSupport(process.platform);
					const placeholders = new Placeholders(data, owner, workspace);
					const sandbox = await sandboxedSession({
						helperEntry,
						// agent 和它的命令只读已启用插件的版本目录：skills 的文件在那里
						policy: {
							...policy,
							readOnly: [...policy.readOnly, ...context.pluginDirectories],
						},
						capabilities,
						env,
						bash,
						agentCommand,
						applyEditsCommand: [process.execPath, applyEditsEntry],
						tracker,
						network: context.rules.networkLists(),
						ask: context.askNetwork,
						...(options.env.SSH_AUTH_SOCK === undefined
							? {}
							: { sshAuthSock: options.env.SSH_AUTH_SOCK }),
						placeholders,
						onWarning: context.onWarning,
						onProcess: context.onProcess,
					});
					// 扩展的沙盒不含别的插件的目录：每个插件的 server 和 hooks 只读自己的版本目录
					const sandboxes = new ExtensionSandboxes({
						helperEntry,
						policy,
						capabilities,
						env,
						bash,
						tracker,
						placeholders,
						onWarning: context.onWarning,
						onProcess: context.onProcess,
					});
					return {
						...sandbox,
						extensions: { sandboxes, policy },
						stop: async () => {
							await sandboxes.stop();
							await sandbox.stop();
						},
					};
				},
				onEvent: sessionOptions.onEvent,
			});
		} catch (error) {
			writer?.close();
			store?.close();
			projectMemory?.close();
			userMemory?.close();
			lock.release();
			throw error;
		}
		// 移动当前位置（回退、切换分支）：新路径上的模型和现在的不同时跟着换，先按新模型做完检查，
		// 不满足就不移动
		const withPathModel = async <T>(
			recorded: RecordedModel | undefined,
			move: () => Promise<T>,
		): Promise<T> => {
			const { model, reasoningEffort } = session.config;
			const next =
				recorded === undefined ||
				(recorded.model === model.id &&
					recorded.reasoningEffort === reasoningEffort)
					? undefined
					: { ...current, ...recorded };
			const settings =
				next === undefined ? undefined : await settingsFor(resolveConfig(next));
			const moved = await move();
			if (next !== undefined && settings !== undefined) {
				await session.setModel(settings);
				current = next;
			}
			return moved;
		};
		return {
			id: session.sessionId,
			ended: session.ended,
			config: () => session.config,
			submit: (input) => session.submit(input),
			steer: (input) => session.steer(input),
			followUp: (input) => session.followUp(input),
			dequeue: (inputId) => session.dequeue(inputId),
			inputQueue: () => session.inputQueue(),
			history: () => session.history(),
			checkpoints: () => session.checkpoints(),
			diff: (checkpointId) => session.diff(checkpointId),
			undo: (checkpointId, undoOptions = {}) =>
				session.undo(checkpointId, undoOptions.overwrite ?? false),
			rewind: async (checkpointId, rewindOptions = {}) =>
				withPathModel(session.modelBefore(checkpointId), () =>
					session.rewind(checkpointId, {
						code: rewindOptions.code ?? false,
						overwrite: rewindOptions.overwrite ?? false,
					}),
				),
			branches: () => session.branches(),
			switchBranch: async (branchId) =>
				withPathModel(session.modelOn(branchId), () =>
					session.switchBranch(branchId),
				),
			resumeFollowUps: () => session.resumeFollowUps(),
			async setModel(model, reasoningEffort) {
				const next = {
					...current,
					model,
					...(reasoningEffort === undefined ? {} : { reasoningEffort }),
				};
				await session.setModel(await settingsFor(resolveConfig(next)));
				current = next;
			},
			async setReasoningEffort(reasoningEffort) {
				const next = { ...current, reasoningEffort };
				await session.setModel(await settingsFor(resolveConfig(next)));
				current = next;
			},
			compact: () => session.compact(),
			backgroundCommands: () => session.backgroundCommands(),
			stopBackgroundCommand: (backgroundId) =>
				session.stopBackgroundCommand(backgroundId),
			whenIdle: () => session.whenIdle(),
			respond: (requestId, answer) => session.respond(requestId, answer),
			extensions: () => session.extensions(),
			mcpServers: () => session.mcpServers(),
			setApprovalPolicy(policy, granular) {
				const next = {
					...current,
					approvalPolicy: policy,
					...(granular === undefined ? {} : { granular }),
				};
				const config = resolveConfig(next);
				session.setApprovalPolicy(config.approvalPolicy, config.granular);
				current = next;
			},
			cancel: () => session.cancel(),
			memory: session.memory?.manager((purged) =>
				redactMemory(redaction, workspace, purged),
			),
			extractMemory: (sourceSessionId) =>
				session.extractMemory(sourceSessionId),
			close: () => session.close(),
			async setSandboxMode(mode) {
				const next = { ...current, sandboxMode: mode };
				const resolved = resolveConfig(next);
				if (resolved.baseSandboxMode !== "danger-full-access") {
					checkSandboxSupport(process.platform);
				}
				await session.setSandboxMode(resolved);
				current = next;
			},
			async reload() {
				const reloaded = await settingsFor(resolveConfig(current));
				if (reloaded.config.sandboxMode !== "danger-full-access") {
					checkSandboxSupport(process.platform);
				}
				await session.reload(reloaded);
			},
		};
	};

	return {
		resolveConfig,
		async openSession(sessionOptions) {
			try {
				return await openSession(sessionOptions, { kind: "new" });
			} catch (error) {
				log.write({
					level: "error",
					message: `打开 session 失败：${(error as Error).message}`,
				});
				throw error;
			}
		},
		async resumeSession({ sessionId, ...sessionOptions }) {
			try {
				return await openSession(sessionOptions, { kind: "resume", sessionId });
			} catch (error) {
				log.write({
					level: "error",
					message: `恢复 session ${sessionId} 失败：${(error as Error).message}`,
				});
				throw error;
			}
		},
		async forkSession({ sessionId, checkpointId, ...sessionOptions }) {
			try {
				return await openSession(sessionOptions, {
					kind: "fork",
					sessionId,
					...(checkpointId === undefined ? {} : { checkpointId }),
				});
			} catch (error) {
				log.write({
					level: "error",
					message: `分叉 session ${sessionId} 失败：${(error as Error).message}`,
				});
				throw error;
			}
		},
		listProjects: () => registry.projects(),
		async linkProject(directory, projectId) {
			const workspace = resolveWorkspace(directory);
			if (!registry.projects().some((p) => p.project_id === projectId)) {
				throw new ConfigError(`没有这个项目：${projectId}`);
			}
			await registry.link(
				projectKey(findProjectRoot(workspace).root),
				projectId,
			);
		},
		saveCredential: async (id, value) => requireStore().set(id, value),
		deleteCredential: async (id) => requireStore().delete(id),
		defaultService: () => defaultService(root, options.env.HOME),
		proxy: () => userLayer(root, options.env.HOME).proxy,
		credentialStatus: (statusOptions = {}) =>
			credentialStatus({ root, home: options.env.HOME, store }, statusOptions),
		listSessions: (listOptions = {}) =>
			listSessions(data, registry, listOptions),
		sessionForks: (ref) => sessionForks(maintenance, ref),
		deleteSession: (deleteOptions) => deleteSession(maintenance, deleteOptions),
		exportSession: (ref) => exportSession(maintenance, scrub, ref),
		rebuildSessions: ({ directory }) => rebuildSessions(maintenance, directory),
		redactionScope: (ref) => redactionScope(redaction, ref),
		redactEvents: (redactOptions) => redactEvents(redaction, redactOptions),
		cleanExpiredSessions: () =>
			cleanExpiredSessions(maintenance, options.env.HOME, new Date()),
		clearCache: (cacheOptions = {}) => clearCache(root, registry, cacheOptions),
		runInSandbox: (runOptions) =>
			runInSandbox(runOptions, {
				root,
				data,
				owner,
				env: options.env,
				helperEntry,
				hostEntries,
				install,
				registry,
				resolveConfig,
				shellParser,
			}),
		extensions: new ExtensionAdmin({
			root,
			data,
			owner,
			home: options.env.HOME,
			registry,
			trust,
			plugins,
			credentials: mcpCredentials,
		}),
	};
}
