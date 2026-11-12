import { mkdirSync, rmSync, statSync } from "node:fs";
import { arch, release } from "node:os";
import {
	type AgentConfig,
	type BlobReadParams,
	type BlobReadResult,
	ChannelClosedError,
	ChannelRequestError,
	type Empty,
	type HandlerContext,
	type HooksRunParams,
	type HooksRunResult,
	type ImagePutParams,
	type ImageReadParams,
	type ImageReadResult,
	type InitializeParams,
	type InputContent,
	type InputTakeResult,
	type MemoryProposeParams,
	type MemoryProposeResult,
	type MemoryReadParams,
	type MemoryReadResult,
	type MemorySearchParams,
	type MemorySearchResult,
	type ModelCountTokensParams,
	type ModelCountTokensResult,
	type ModelInfo,
	type ModelRequestParams,
	type ModelRequestResult,
	ProtocolError,
	ReceivedImages,
	type RecordAppendParams,
	type RecordReadParams,
	type RecordReadResult,
	type RuntimeRequests,
	version as runtimeVersion,
	type SkillLoadParams,
	type SkillLoadResult,
	type SubagentSendParams,
	type SubagentSendResult,
	type SubagentStartParams,
	type SubagentStartResult,
	type SubagentStopParams,
	type SubagentStopResult,
	subagentToolRegistry,
	type TaskEndParams,
	type TaskEndResult,
	type ToolCallCompleteParams,
	type ToolCallCompleteResult,
	type ToolCallRegisterParams,
	type ToolCallRegisterResult,
	type ToolCallRunParams,
	type ToolCallRunResult,
} from "@ospreycode/agent-runtime";
import type { CountTokens, StreamModel } from "@ospreycode/api";
import type { ElicitationAnswer } from "@ospreycode/mcp";
import type { MemoryStore } from "@ospreycode/memory";
import type {
	ApprovalAnswer,
	ApprovalPolicy,
	GranularApproval,
	PolicyContext,
} from "@ospreycode/sandbox";
import type { NetworkAnswer } from "@ospreycode/sandbox/backends";
import {
	type Checkpoint,
	type CheckpointCreated,
	type CheckpointRecord,
	type CheckpointsInherited,
	checkpointCreatedType,
	checkpointSnapshotType,
	checkpointsInheritedType,
	type Position,
	type SessionStore,
	type SessionWriter,
} from "@ospreycode/session-store";
import { Approvals } from "../actions/approvals.js";
import { settleInterruptedEdits } from "../actions/file-edits.js";
import { NetworkApprovals } from "../actions/network-approvals.js";
import type { SessionRules } from "../actions/session-rules.js";
import { ToolCalls } from "../actions/tool-calls.js";
import { type ChannelHandlers, serveChannel } from "../channel/serve.js";
import { ConfigError } from "../config/errors.js";
import { profileDomainRules } from "../config/sandbox-mode.js";
import type { SessionConfig } from "../config/session-config.js";
import { readUserInstructions } from "../config/user-instructions.js";
import { currentCredential } from "../credentials/command.js";
import type { LoadedCredential } from "../credentials/sources.js";
import type { DiagnosticLog } from "../diagnostics/log.js";
import type { ExtensionInfo, LoadedExtensions } from "../extensions/catalog.js";
import type { GitResult } from "../extensions/plugins.js";
import {
	type ExtensionServices,
	type HookScope,
	SessionExtensions,
} from "../extensions/session-extensions.js";
import { hookContext } from "../hooks/context.js";
import type { HookOutcome } from "../hooks/engine.js";
import type { McpServerState } from "../mcp-hub/hub.js";
import type { MemoryExtractionEnded } from "../memory/events.js";
import { MemoryExtractor } from "../memory/extractor.js";
import { SessionMemory } from "../memory/session-memory.js";
import { memoryTools } from "../memory/settings.js";
import { ModelProxy } from "../model-proxy/proxy.js";
import {
	type AgentProcess,
	type ProcessExit,
	startAgentProcess,
} from "../processes/agent-process.js";
import {
	type BackgroundCommandInfo,
	BackgroundCommands,
	defaultBackgroundLimits,
} from "../processes/background.js";
import { findBash, sandboxEnvironment } from "../processes/environment.js";
import { locateGit } from "../processes/git-runner.js";
import type { ProcessIdentity } from "../processes/info.js";
import type { ProcessTracker } from "../processes/registry.js";
import type {
	SessionSandbox,
	SnapshotSandbox,
} from "../processes/sandboxed.js";
import type { WorkspaceLock } from "../project/locks.js";
import {
	createSessionDirectories,
	ensureWorkersDirectory,
	type SessionDirectories,
	snapshotDirectory,
} from "../project/workspace.js";
import {
	eventFormatVersion,
	type HostEvent,
	type SessionEndReason,
} from "../sdk/events.js";
import { version as hostVersion } from "../version.js";
import { SnapshotError } from "../workspace/git.js";
import {
	type ChangesDiff,
	inheritSnapshots,
	SessionSnapshots,
	type ToolSnapshots,
} from "../workspace/session-snapshots.js";
import {
	ShadowRepository,
	snapshotLimits,
} from "../workspace/shadow-repository.js";
import { readBlob } from "./blob-read.js";
import type { BudgetLimit } from "./budget.js";
import {
	type BranchInfo,
	branchId,
	type CheckpointInfo,
	listBranches,
	listCheckpoints,
	outsideEdits,
	type UndoResult,
} from "./checkpoints.js";
import { EventSink } from "./emitter.js";
import type { ProcessEvent, TaskOutcome, TaskSource } from "./events.js";
import {
	hostEvents,
	pathHistory,
	pathModel,
	type RecordedModel,
} from "./history.js";
import { newId } from "./ids.js";
import {
	type InputQueueSnapshot,
	InputQueues,
	type Notice,
	type QueuedInput,
} from "./inputs.js";
import { ProtectedWatch } from "./protected-watch.js";
import { readRecord, recordedMessageIds } from "./record-read.js";
import type { ResumeState, UncertainCall } from "./resume.js";
import { addUsage, emptyUsage, Run } from "./run.js";
import { runtimeEventWarnings } from "./runtime-events.js";
import { coversPrevious } from "./sandbox-change.js";
import { type AgentScope, type PreparedAgent, Subagents } from "./subagents.js";
import { inputText, type UserInput, userInput } from "./user-input.js";

/** 等 agent 进程发来 `initialize` 的时间。 */
const initializeTimeoutMs = 30_000;

/** 取消后等 runtime 报告 task 结束的时间。 */
const cancelGraceMs = 5_000;

/** 同一个 session 连续这么多次异常退出、中间没有正常结束的 task，就关闭 session。 */
const maxConsecutiveExits = 3;

/** agent 进程没能启动：`initialize` 超时、版本不一致或提前退出（CLI 的退出码 1）。 */
export class AgentStartError extends Error {
	override name = "AgentStartError";
}

/**
 * 恢复不了这个 session：上次中断的 task 里有结果不确定的工具调用，要问用户重新执行还是跳过，
 * 而审批策略是 `never`、没有人能回答。session 记录没有动过，换成交互模式再恢复。
 */
export class SessionResumeError extends Error {
	override name = "SessionResumeError";
}

/** `SessionStart` hooks 阻止了打开 session；`message` 里有 hooks 给的原因。 */
export class SessionBlockedError extends Error {
	override name = "SessionBlockedError";
}

/** `UserPromptSubmit` hooks 阻止了这条输入，task 没有开始；`message` 是 hooks 给的原因。 */
export class InputBlockedError extends Error {
	override name = "InputBlockedError";
}

/** 会话内的操作现在做不了：session 不空闲，或者要切换到运行中不能换过去的模式。session 不受影响。 */
export class SessionCommandError extends Error {
	override name = "SessionCommandError";
}

/** 打开 session 用到的依赖，都已检查过。 */
export interface HostSessionOptions {
	sessionId: string;
	root: string;
	config: SessionConfig;
	/** 任何批准都放不开的路径：Host 根目录、凭据文件和配置里禁止读、写的路径。 */
	denied: { read: readonly string[]; write: readonly string[] };
	/** 这份配置读到的权限规则；会话中保存的规则也记在里面。 */
	rules: SessionRules;
	/** 模型服务的凭据。 */
	credential: LoadedCredential;
	/** 去掉文本里的凭据和疑似密钥。 */
	scrub: (text: string) => string;
	/** 读到新的凭据值时登记。 */
	onSecret: (value: string) => void;
	log: DiagnosticLog;
	hostEnv: Readonly<Record<string, string | undefined>>;
	fetch: typeof globalThis.fetch;
	streamModel: StreamModel;
	/** 调模型服务的 token 计数接口：runtime 在上下文长度临界时经 `model/count_tokens` 请求。 */
	countTokens: CountTokens;
	/**
	 * 按沙盒模式准备 agent 进程的启动命令和命令沙盒：打开 session、切换沙盒模式和重新加载配置时各调用
	 * 一次，每启动一个子 agent 再调用一次。
	 */
	createSandbox: (context: SandboxContext) => Promise<SessionSandbox>;
	/**
	 * 一份配置选用的模型的凭据，来自文件时带上文件的真实路径：子 agent 的定义指定了别的模型服务时，
	 * 启动它之前取。没有凭据时抛出 `CredentialError`。
	 */
	credentialFor: (
		config: SessionConfig,
	) => Promise<{ credential: LoadedCredential; file?: string }>;
	/**
	 * 给 worker 建工作区：在沙盒里把项目仓库克隆（`git clone --shared`）到 `directory` 下的 `repo/`。
	 * 沙盒无网络，只能写 `directory`。
	 */
	cloneRepository: (
		projectRoot: string,
		directory: string,
	) => Promise<GitResult>;
	/** 这个 session 启动的进程记进进程登记表。 */
	tracker: ProcessTracker;
	/** 扩展的信任记录、插件目录和 MCP 的凭据，以及在哪里找这个 session 的扩展。 */
	extensions: ExtensionServices;
	/** 已经取得的工作区锁，session 结束时释放。 */
	lock: WorkspaceLock;
	/** 这个项目的 session 记录，session 结束时关闭。 */
	store: SessionStore;
	/** 这个 session 的写入者，持有写锁。 */
	writer: SessionWriter;
	/** 恢复或分叉出的 session 从记录里读出的状态；新建的没有。 */
	resume?: ResumeState;
	/** 刚分叉出来、还没有自己的事件的 session：父 session 和它分叉时的检查点索引。 */
	fork?: { parentSessionId: string; checkpoints: CheckpointRecord[] };
	/** 恢复或分叉出的 session 的路径上最后一次模型请求用的模型和推理强度。 */
	recorded?: RecordedModel;
	userId: string;
	projectId: string;
	/**
	 * 长期记忆：这个项目的记忆库和 user 记忆库，session 结束时关闭；`owner` 是 Host 进程的身份，认领
	 * 后台提取时写进记忆库；`isSessionOpen` 判断一个 session 是不是还开着。配置里关掉了长期记忆时没有。
	 */
	memory?: {
		project: MemoryStore;
		user: MemoryStore;
		owner: ProcessIdentity;
		isSessionOpen: (sessionId: string) => boolean;
	};
	onEvent: (event: HostEvent) => void;
}

/** 重新加载配置时换掉的部分。 */
export type ReloadedSettings = Pick<
	HostSessionOptions,
	"config" | "denied" | "rules" | "credential"
>;

/** 准备沙盒时已经确定的东西。 */
export interface SandboxContext {
	/** 这个沙盒按它的沙盒模式和路径建立。 */
	config: SessionConfig;
	denied: HostSessionOptions["denied"];
	/** 域名规则编译成命令沙盒的名单。 */
	rules: SessionRules;
	bash: string;
	/** 沙盒里的进程的环境变量。 */
	env: Record<string, string>;
	directories: SessionDirectories;
	tracker: ProcessTracker;
	/** 启用的插件的版本目录：agent 沙盒和命令沙盒只读。 */
	pluginDirectories: readonly string[];
	/** 这是子 agent 的沙盒：主 agent 的沙盒还在运行，和它共用工作区时不能清理工作区里的占位。 */
	subagent: boolean;
	/**
	 * 沙盒里的程序连接名单之外的域名时由它回答，连接挂起到它返回。连接来自某条命令自己的代理时
	 * 带上 `toolCallId`。
	 */
	askNetwork: (
		request: { host: string; port: number },
		toolCallId?: string,
	) => Promise<NetworkAnswer>;
	/** 沙盒那边不影响继续运行的问题，作为 `warning` 事件发出。 */
	onWarning: (message: string) => void;
	/** 随 session 存在的沙盒辅助进程的启动和退出，记成进程事件。 */
	onProcess: (event: ProcessEvent) => void;
}

/** 一个 agent 进程和它的握手状态。 */
interface RunningAgent {
	process: AgentProcess;
	/** `initialize` 完成后兑现；超时、版本不一致或握手之前退出时拒绝。 */
	initialized: PromiseWithResolvers<void>;
	/** 已经发来过 `initialize`。 */
	greeted: boolean;
	/** Host 自己在结束它（关闭 session、重启、没能启动）：这时退出不算异常退出。 */
	stopping: boolean;
	/** 通道因协议错误失效的原因。 */
	failure: Error | undefined;
	/** 启动已经作为进程事件记下：退出时也记一条。 */
	recorded: boolean;
	/** 进程退出、从进程登记表里删掉、记下退出事件之后兑现。 */
	gone: Promise<void>;
}

/** 按一份配置准备好的沙盒和工具调用的处理。 */
interface Prepared extends PreparedAgent {
	/** 这个沙盒模式下运行影子仓库的 git 的沙盒。 */
	snapshotSandbox: SnapshotSandbox;
	/** Linux 上工作区可写时：准备沙盒那时工作区里受保护的路径。 */
	watch: ProtectedWatch | undefined;
	rules: SessionRules;
	/** 这份配置下找到的扩展；换上它们用 `#applyExtensions`。 */
	extensions: LoadedExtensions;
}

function describeExit(exit: ProcessExit): string {
	return exit.signal === null ? `退出码 ${exit.code}` : `信号 ${exit.signal}`;
}

/** 告诉 runtime 的模型信息：用哪个模型和推理强度，以及控制长度要用的能力。 */
function modelInfo(config: SessionConfig): ModelInfo {
	const { model } = config;
	return {
		id: model.id,
		protocol: model.protocol,
		reasoning_effort: config.reasoningEffort,
		context_window: model.context_window,
		...(model.max_input_tokens === undefined
			? {}
			: { max_input_tokens: model.max_input_tokens }),
		max_output_tokens: model.max_output_tokens,
	};
}

/** 配置里有子 agent 的定义时启用的三个工具；一个定义也没有时不启用。 */
function subagentTools(config: SessionConfig): string[] {
	return Object.keys(config.agents).length === 0
		? []
		: [...subagentToolRegistry.keys()];
}

function localDate(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 一个打开的 session：管理它的 agent 进程和通道，决定 task 的开始、结束和取消，
 * 把模型请求和工具调用交给模型代理和 actions。
 */
export class HostSession implements ChannelHandlers {
	readonly sessionId: string;
	/** 恢复的 session 沿用上次的标识。 */
	readonly agentId: string;
	/** session 关闭后兑现，包括 agent 进程意外退出。 */
	readonly ended: Promise<void>;
	#options: HostSessionOptions;
	#events: EventSink;
	#approvals: Approvals;
	#network: NetworkApprovals;
	/** 当前的沙盒模式和审批策略，会话中切换审批策略时换掉。 */
	#policy!: PolicyContext;
	#modelProxy: ModelProxy;
	/** runtime 交来过的图片：通道上的消息里图片只有引用，每张单独过一次通道（见 agent-runtime 的通道）。 */
	#images = new ReceivedImages();
	#toolCalls!: ToolCalls;
	/** 当前的 agent 进程；异常退出之后没有，等用户下一次输入时再启动。 */
	#agent: RunningAgent | undefined;
	#sandbox!: SessionSandbox;
	#snapshotSandbox!: SnapshotSandbox;
	/** 这个 session 的快照；找不到可用的 git、影子仓库打不开时没有，这时不能撤销改动。 */
	#snapshots: SessionSnapshots | undefined;
	/** 交给工具调用的处理：换沙盒时它跟着重建，快照是同一份。 */
	#toolSnapshots: ToolSnapshots = {
		before: async (paths) => this.#snapshots?.before(paths),
		after: async (toolCallId, paths) =>
			this.#snapshots?.after(toolCallId, paths),
	};
	/** 运行中的后台命令是哪次工具调用启动的：它结束时的快照记在这次调用名下。 */
	#backgroundCalls = new Map<string, string>();
	/** 这个工作区的影子仓库所在的目录。 */
	#snapshotDirectory!: string;
	#directories!: SessionDirectories;
	/** 沙盒里的进程的环境变量。 */
	#env: Record<string, string> = {};
	/** agent 沙盒的可写根，含 `TMPDIR`。 */
	#writableRoots: readonly string[] = [];
	#watch: ProtectedWatch | undefined;
	#run: Run | undefined;
	#usage = emptyUsage();
	#state: "starting" | "open" | "closing" | "closed" = "starting";
	/** `session.started` 发出之前启动的辅助进程的进程事件：它发出之后再记；没能打开的 session 不记。 */
	#earlyProcesses: ProcessEvent[] | undefined = [];
	/** 正在进行的重启，兑现为是否成功；失败时 session 随后关闭。 */
	#restarting: Promise<boolean> | undefined;
	/** task 结束后对受保护路径的检查（含它引起的重启），做完之前下一个 task 和设置的切换都等着。 */
	#checking: Promise<boolean> | undefined;
	/** 连续异常退出的次数，runtime 报告一个 task 结束后清零。 */
	#exits = 0;
	#cancelTimer: NodeJS.Timeout | undefined;
	/** 已经警告过"超出总长度上限、未放入"的规则文件。 */
	#warnedRuleFiles = new Set<string>();
	/** steering、follow-up 和后台通知的队列。 */
	#inputs = new InputQueues((event) => {
		const run = this.#recordRun();
		const before = this.#events.position;
		const eventId = this.#events.stored(run, event);
		// 运行中插入的输入也是一个检查点：回退到它就是回到这条输入插入之前
		if (event.type === "input.inserted") {
			this.#checkpointCreated(run, eventId, "steering", before);
		}
	});
	/** 最近结束的 run：session 空闲时队列和后台命令的事件记在它里面。 */
	#lastRun: Run | undefined;
	/**
	 * 恢复、回退和分叉之后、下一个 task 开始之前：空闲时的事件不能接着记在原来的 run 里（当前位置
	 * 可能在它的中间，或者在父 session 里），另开一个接在当前位置之后、没有 `task.started` 的 run。
	 */
	#idleRuns = false;
	/** 恢复时等用户回答"重新执行还是跳过"的那个中断的 run；关闭 session 时中止它，不再等回答。 */
	#resuming: Run | undefined;
	/** 恢复时在 `session.started` 之前产生的事件：它发出之后再交给前端。 */
	#held: HostEvent[] | undefined;
	/** 后台命令：属于 session，跨 task 保留，换沙盒和重启 agent 进程时不换。 */
	#background = new BackgroundCommands(defaultBackgroundLimits, {
		started: (run, started) => {
			this.#events.stored(run, { type: "background.started", ...started });
			this.#backgroundCalls.set(started.background_id, started.tool_call_id);
			this.#snapshots?.backgroundStarted(started.tool_call_id);
		},
		ended: (ended) => {
			this.#events.stored(this.#recordRun(), {
				type: "background.ended",
				...ended,
			});
			const toolCallId = this.#backgroundCalls.get(ended.background_id);
			if (toolCallId === undefined) {
				throw new Error(`后台命令 ${ended.background_id} 结束了，却没有开始过`);
			}
			this.#backgroundCalls.delete(ended.background_id);
			// 它启动之后的改动归启动它的那次工具调用
			void this.#snapshots?.backgroundEnded(toolCallId);
		},
		notify: (notice) => this.#notice(notice),
		// 结束了的 task 批准的域名只放行到它启动的后台命令都结束
		idle: () => this.#network.backgroundEnded(),
	});
	/** 换下来的沙盒，等后台命令都结束后停掉；停完的从这里去掉。 */
	#retired = new Set<Promise<void>>();
	/** 当前 task 的来源。 */
	#source: TaskSource = "user";
	/** 这个 session 的长期记忆；打开时关掉了的没有。 */
	readonly memory: SessionMemory | undefined;
	#extractor: MemoryExtractor | undefined;
	/** 上一次交给 runtime 的记忆配置（JSON）：每个 task 开始前和当前的比较，变了才发 `config/update`。 */
	#memorySent: string | undefined;
	/** 这个 session 的扩展：skills、MCP server 和 hooks。 */
	#extensions: SessionExtensions;
	/** 这个 session 的子 agent。 */
	#subagents: Subagents;
	/** `session.started` 发出之前扩展产生的事件和警告：它发出之后再发；没能打开的 session 不发。 */
	#earlyExtensions: (() => void)[] | undefined = [];
	/**
	 * `SessionStart` hooks 补充的信息：随下一个 task 的输入交给模型。`messageId` 是放那次输入的
	 * user 消息的编号，运行 hooks 时就定下并记进 `hooks.ran`，那个 task 照用。
	 */
	#startContext: { context: string; messageId: string } | undefined;
	/** 正在经 `UserPromptSubmit` hooks 检查、还没排队的 steering 和 follow-up：按提交的顺序逐条检查。 */
	#promptChecks: Promise<void> = Promise.resolve();
	#resolveEnded!: () => void;

	private constructor(options: HostSessionOptions) {
		this.sessionId = options.sessionId;
		this.agentId = options.resume?.agentId ?? newId();
		this.#options = options;
		this.#held = options.resume === undefined ? undefined : [];
		this.#events = new EventSink({
			sessionId: this.sessionId,
			agentId: this.agentId,
			listener: (event) => {
				if (this.#held !== undefined) {
					this.#held.push(event);
					return;
				}
				this.#observe(event);
				options.onEvent(event);
			},
			record: (event) => options.writer.append(event),
			putBlob: (data) => options.writer.putBlob(data),
			scrub: options.scrub,
			log: options.log,
			...(options.resume === undefined
				? {}
				: { position: options.resume.position }),
		});
		this.#approvals = new Approvals(this.#events);
		this.#network = new NetworkApprovals({
			events: this.#events,
			approvals: this.#approvals,
			currentRun: () => this.#run,
			// 归属不明的拒绝显示给用户，并作为一条不唤醒 session 的后台通知交给模型
			onDenied: (message) => {
				this.#events.session({ type: "warning", message });
				this.#notice({ background_id: null, text: message, wake: false });
			},
			pauseTimeout: (toolCallId) => this.#background.pauseTimeout(toolCallId),
			backgroundRunning: () =>
				this.#background.list().map((command) => command.background_id),
		});
		this.#extensions = new SessionExtensions({
			services: options.extensions,
			sessionId: this.sessionId,
			tracker: options.tracker,
			approvals: this.#approvals,
			emit: (event) => this.#afterStart(() => this.#events.extension(event)),
			onWarning: (message) =>
				this.#afterStart(() =>
					this.#events.session({ type: "warning", message }),
				),
			onProcess: (event) => {
				if (this.#earlyProcesses === undefined) this.#events.process(event);
				else this.#earlyProcesses.push(event);
			},
			settings: () => ({
				config: this.#options.config,
				policy: this.#policy,
				rules: this.#options.rules,
			}),
			onToolsChanged: () => this.#mcpToolsChanged(),
		});
		this.#modelProxy = new ModelProxy({
			sessionId: this.sessionId,
			entry: options.config.model,
			credential: options.credential,
			fetch: options.fetch,
			streamModel: options.streamModel,
			countTokens: options.countTokens,
			events: this.#events,
			images: this.#images,
			scrub: options.scrub,
			onSecret: options.onSecret,
			admit: (run) => this.#admit(run),
			...(options.recorded === undefined ? {} : { recorded: options.recorded }),
			serverTools: options.config.serverTools,
		});
		this.#subagents = new Subagents({
			events: this.#events,
			approvals: this.#approvals,
			background: this.#background,
			extensions: this.#extensions,
			tracker: options.tracker,
			fetch: options.fetch,
			streamModel: options.streamModel,
			countTokens: options.countTokens,
			scrub: options.scrub,
			onSecret: options.onSecret,
			settings: () => ({
				config: this.#options.config,
				denied: this.#options.denied,
				rules: this.#options.rules,
				credential: this.#options.credential,
				directories: this.#directories,
			}),
			credentialFor: options.credentialFor,
			cloneRepository: options.cloneRepository,
			prepare: (settings, scope) => this.#prepareAgent(settings, scope),
			agentConfig: (config, writableRoots) =>
				this.#agentConfig(config, writableRoots),
			admit: (run) => this.#admit(run),
			snapshots: this.#toolSnapshots,
			onEnded: (parent, agentId, text, quoted) => {
				// 结果和后台命令的通知走同一个队列：父 agent 的 runtime 在下一次模型请求之前取走
				this.#notice({ background_id: null, text, wake: false }, quoted);
				if (this.#run !== parent) return;
				this.#agent?.process.channel
					.notify("subagent/ended", { agent_id: agentId })
					.catch((error: unknown) => {
						if (!(error instanceof ChannelClosedError)) throw error;
					});
			},
		});
		this.ended = new Promise((resolve) => {
			this.#resolveEnded = resolve;
		});
		const { memory } = options;
		const settings = options.config.memory;
		if (memory !== undefined && settings !== undefined) {
			this.memory = new SessionMemory({
				project: memory.project,
				user: memory.user,
				settings,
				sessionId: this.sessionId,
				projectRoot: options.config.projectRoot,
				onUpdated: (change) => this.#events.memoryUpdated(change),
			});
			this.#extractor = new MemoryExtractor({
				memory: this.memory,
				sessions: options.store,
				sessionId: this.sessionId,
				projectRoot: options.config.projectRoot,
				owner: memory.owner,
				isSessionOpen: memory.isSessionOpen,
				// 会话中换过的模型和凭据在 `#options` 里，每次提取开始时取
				model: () => ({
					entry: this.#options.config.model,
					reasoningEffort: this.#options.config.reasoningEffort,
					apiKey: () => currentCredential(this.#options.credential),
				}),
				fetch: options.fetch,
				streamModel: options.streamModel,
				scrub: options.scrub,
				events: this.#events,
				onUsage: (usage) => {
					this.#usage = addUsage(this.#usage, usage);
				},
			});
		}
	}

	/** 启动 agent 进程、完成握手后返回；之后发出 `session.started`。 */
	static async open(options: HostSessionOptions): Promise<HostSession> {
		const session = new HostSession(options);
		await session.#start();
		return session;
	}

	async #start(): Promise<void> {
		const { config, root, resume } = this.#options;
		const uncertain = resume?.interrupted?.uncertain ?? [];
		// 没有人能回答时在写下任何东西之前失败：session 记录保持原样，换成交互模式还能恢复
		if (uncertain.length > 0 && config.approvalPolicy === "never") {
			const names = uncertain.map((call) => call.name).join("、");
			throw new SessionResumeError(
				`上次中断的 task 里有 ${uncertain.length} 次工具调用不能确定有没有执行（${names}），要由用户决定重新执行还是跳过：请在交互模式下恢复这个 session`,
			);
		}
		this.#directories = createSessionDirectories(
			root,
			this.sessionId,
			this.#options.projectId,
		);
		// 快照沙盒按路径放开它，要先建好
		this.#snapshotDirectory = snapshotDirectory(
			root,
			this.#options.projectId,
			config.workspace,
		);
		mkdirSync(this.#snapshotDirectory, { recursive: true, mode: 0o700 });
		const prepared = await this.#prepare(this.#options);
		this.#use(prepared);
		let agent: RunningAgent | undefined;
		let interrupted: Run | undefined;
		try {
			await this.#applyExtensions(prepared, false, () =>
				this.#sessionStartHooks(),
			);
			await this.#openSnapshots();
			if (resume !== undefined) interrupted = this.#restore(resume);
			// 有调用要问用户时先不启动 agent 进程：它握手时按记录重建历史，要等中断的 task 收完尾
			if (interrupted === undefined || uncertain.length === 0) {
				if (interrupted !== undefined) this.#failInterrupted(interrupted, []);
				agent = await this.#launchAgent();
			}
		} catch (error) {
			this.#state = "closed";
			await this.#extensions.close();
			await this.#sandbox.stop();
			throw error;
		}
		this.#state = "open";
		const held = this.#held ?? [];
		this.#held = undefined;
		this.#events.session({
			type: "session.started",
			format_version: eventFormatVersion,
			host_version: hostVersion,
			user_id: this.#options.userId,
			project_id: this.#options.projectId,
			workspace: config.workspace,
			model: config.model.id,
			sandbox_mode: config.sandboxMode,
			approval_policy: config.approvalPolicy,
		});
		for (const message of config.warnings) {
			this.#events.session({ type: "warning", message });
		}
		for (const event of held) {
			this.#observe(event);
			this.#options.onEvent(event);
		}
		// 辅助进程在 agent 进程之前启动，进程事件也按这个顺序
		for (const event of this.#earlyProcesses ?? []) this.#events.process(event);
		this.#earlyProcesses = undefined;
		for (const emit of this.#earlyExtensions ?? []) emit();
		this.#earlyExtensions = undefined;
		if (agent !== undefined) this.#recordStart(agent);
		else if (interrupted !== undefined) {
			this.#askUncertain(interrupted, uncertain);
		}
		// 非交互模式不做后台提取，免得在 `--max-cost` 之外花钱
		if (
			config.memory?.write === "extract" &&
			config.approvalPolicy !== "never"
		) {
			this.#extractor?.startBackground();
		}
	}

	/**
	 * 打开这个工作区的影子仓库。找不到可用的 git、影子仓库打不开时这个 session 不做快照，只发一条
	 * 警告：快照只用于撤销，不能因为它打不开 session。分叉出来的 session 在这里沿用父 session 的
	 * 检查点：先建好快照的引用，再写下检查点索引。
	 */
	async #openSnapshots(): Promise<void> {
		const { config, store, hostEnv, fork } = this.#options;
		const { workspace } = config;
		const unavailable = (problem: string) =>
			this.#afterStart(() =>
				this.#events.session({
					type: "warning",
					message: `这个 session 不做快照，不能撤销改动和还原代码：${problem}`,
				}),
			);
		const located = locateGit(hostEnv.PATH);
		let repository: ShadowRepository | undefined;
		if ("problem" in located) {
			unavailable(located.problem);
		} else {
			try {
				repository = await ShadowRepository.open({
					directory: this.#snapshotDirectory,
					projectRoot: config.projectRoot,
					workspace,
					git: located.git,
					// 会话中换沙盒模式时快照沙盒跟着换
					run: (argv, options) => this.#snapshotSandbox.run(argv, options),
					canRead: (path) => this.#snapshotSandbox.canRead(path),
					limits: snapshotLimits,
				});
				if (fork !== undefined) {
					await inheritSnapshots(
						repository,
						fork.parentSessionId,
						this.sessionId,
					);
				}
			} catch (error) {
				if (!(error instanceof SnapshotError)) throw error;
				repository = undefined;
				unavailable(error.message);
			}
		}
		if (fork !== undefined) {
			const inherited: CheckpointsInherited = { checkpoints: fork.checkpoints };
			this.#events.housekeeping(checkpointsInheritedType, inherited);
		}
		if (repository === undefined) return;
		this.#snapshots = new SessionSnapshots({
			repository,
			store,
			sessionId: this.sessionId,
			workspace,
			record: (snapshot) =>
				this.#events.checkpoint(
					this.#recordRun(),
					checkpointSnapshotType,
					snapshot,
				),
			warn: (message) =>
				this.#afterStart(() =>
					this.#events.session({ type: "warning", message }),
				),
			backgroundRunning: () => this.#background.list().length > 0,
		});
		// 上次留下的、不再被引用的检查点：不等它做完，排在这个 session 的第一次快照之前
		void this.#snapshots.clean();
	}

	/** 写下一个检查点：每次用户输入一个，之后的快照挂在它名下。 */
	#checkpointCreated(
		run: Run,
		inputEventId: string,
		kind: CheckpointCreated["kind"],
		before: Position | null,
	): void {
		const created: CheckpointCreated = {
			input_event_id: inputEventId,
			kind,
			before,
		};
		this.#events.checkpoint(run, checkpointCreatedType, created);
		this.#snapshots?.created(inputEventId);
	}

	/**
	 * 恢复 session 时在启动 agent 进程之前：换上记录里的队列；上次还在运行的后台命令已经不在了，
	 * 记下结束并留一条通知给模型；中断的 task 里登记过文件改动的调用按哈希补上结果。返回中断的 run。
	 */
	#restore(resume: ResumeState): Run | undefined {
		this.#idleRuns = true;
		if (resume.queue !== undefined) this.#inputs.restore(resume.queue);
		const { interrupted } = resume;
		let run: Run | undefined;
		if (interrupted !== undefined) {
			run = new Run(this.#options.config.budget, interrupted);
			run.usage = interrupted.usage;
			this.#lastRun = run;
		}
		for (const lost of resume.lostBackground) {
			// 输出文件在 Host 自己的目录里；已经不在时按没有输出算
			const bytes =
				statSync(lost.outputPath, { throwIfNoEntry: false })?.size ?? 0;
			this.#events.stored(this.#recordRun(), {
				type: "background.ended",
				background_id: lost.backgroundId,
				reason: "lost",
				exit_code: null,
				signal: null,
				output_bytes: bytes,
			});
			this.#notice({
				background_id: lost.backgroundId,
				text: [
					`Background command ${lost.backgroundId} was still running when the session was interrupted. It is no longer running and its exit status is unknown.`,
					`Command: ${lost.command}`,
					`Output: ${bytes} bytes in ${lost.outputPath}`,
				].join("\n"),
				wake: false,
			});
		}
		if (run !== undefined) {
			for (const { toolCallId, edits } of interrupted?.edits ?? []) {
				this.#events.stored(run, {
					type: "tool_call.completed",
					tool_call_id: toolCallId,
					result: settleInterruptedEdits(edits),
					duration_ms: 0,
				});
			}
			// 子 agent 不恢复：没有结果的子 agent 工具调用不会再有结果，也不重新执行
			for (const toolCallId of interrupted?.subagentCalls ?? []) {
				this.#events.stored(run, {
					type: "tool_call.completed",
					tool_call_id: toolCallId,
					result: {
						status: "interrupted",
						content: [
							{
								type: "text",
								text: "The session was interrupted while this tool call was running. Subagents do not survive an interruption: none of the subagents started before it is running any more.",
							},
						],
					},
					duration_ms: 0,
				});
			}
			// 它们的进程已经不在了，各自的 run 记下结束，再留一条通知给模型
			for (const lost of interrupted?.subagents ?? []) {
				const child = new Run(
					this.#options.config.budget,
					{ taskId: run.taskId, runId: lost.runId, seq: lost.seq },
					{ agentId: lost.agentId, parent: run, toolCallId: lost.toolCallId },
				);
				this.#events.stored(child, {
					type: "subagent.ended",
					outcome: "failed",
					usage: lost.usage,
					error: "上次运行时 session 没有正常关闭，这个子 agent 中断了",
				});
				this.#notice({
					background_id: null,
					text: `Subagent ${lost.name} (${lost.agentId}) was still running when the session was interrupted. It is no longer running, and whatever it had not finished is lost.`,
					wake: false,
				});
			}
		}
		return run;
	}

	/**
	 * 给中断的 task 收尾：用户选了跳过的调用记 `interrupted`，没插入的 steering 交还前端，follow-up
	 * 列表暂停，task 以 `failed` 结束。其余没有结果的调用留给 runtime 在下一个 task 开始时重新执行。
	 */
	#failInterrupted(run: Run, skipped: readonly UncertainCall[]): void {
		for (const call of skipped) {
			this.#events.stored(run, {
				type: "tool_call.completed",
				tool_call_id: call.toolCallId,
				result: {
					status: "interrupted",
					content: [
						{
							type: "text",
							text: "The session was interrupted while this tool call was running, so it is unknown whether it took effect. The user chose not to run it again.",
						},
					],
				},
				duration_ms: 0,
			});
		}
		this.#inputs.taskEnded("failed");
		this.#events.stored(run, {
			type: "task.ended",
			outcome: "failed",
			usage: run.usage,
			error: "上次运行时 session 没有正常关闭，这个 task 中断了",
		});
		run.ended.resolve();
	}

	/**
	 * 中断的 task 里不能确定有没有执行的调用逐个问用户：批准是重新执行，拒绝是跳过。都回答之后给
	 * task 收尾，再启动 agent 进程；这期间的输入和别的重启一样等着。session 在回答之前关闭时 task
	 * 不结束，下次恢复时再问。
	 */
	#askUncertain(run: Run, uncertain: readonly UncertainCall[]): void {
		this.#resuming = run;
		const resuming = (async () => {
			try {
				const answers = await Promise.all(
					uncertain.map((call) =>
						this.#approvals.ask(run, {
							kind: "resume_uncertain",
							tool_call_id: call.toolCallId,
							name: call.name,
							arguments: call.arguments,
							reasons: ["上次运行中断时这次调用已经开始，不知道有没有执行完"],
						}),
					),
				);
				if (run.cancelled) return false;
				this.#failInterrupted(
					run,
					uncertain.filter(
						(_, index) => answers[index]?.decision !== "approve",
					),
				);
				try {
					this.#recordStart(await this.#launchAgent());
				} catch (error) {
					this.#events.session({
						type: "error",
						message: `恢复 session 时 agent 进程没能启动：${(error as Error).message}\nsession 已关闭，请重新恢复`,
					});
					return false;
				}
				return true;
			} finally {
				this.#resuming = undefined;
				this.#restarting = undefined;
			}
		})();
		this.#restarting = resuming;
		void resuming.then(async (ok) => {
			if (!ok) await this.#shutdown("error");
		});
	}

	/** 按一份配置准备沙盒和工具调用的处理；换上它们用 `#use`。 */
	async #prepare(
		settings: Pick<HostSessionOptions, "config" | "denied" | "rules">,
	): Promise<Prepared> {
		const { config, rules } = settings;
		// Linux 上沙盒的保护停在包装的时刻。在准备沙盒之前记下：两者之间出现的仓库多重启一次，不会漏掉
		const watch =
			process.platform === "linux" &&
			config.baseSandboxMode === "workspace-write"
				? await ProtectedWatch.start(config.workspace)
				: undefined;
		const extensions = this.#extensions.load();
		const prepared = await this.#prepareAgent(settings, {
			network: this.#network,
			tools: [
				...config.tools,
				...memoryTools(config.memory),
				...(extensions.skills.length === 0 ? [] : ["skill_load"]),
				...subagentTools(config),
			],
			mcp: true,
			pluginDirectories: extensions.pluginDirectories,
			snapshots: this.#toolSnapshots,
			subagent: false,
		});
		let snapshotSandbox: SnapshotSandbox;
		try {
			snapshotSandbox = await prepared.sandbox.snapshots(
				this.#snapshotDirectory,
			);
		} catch (error) {
			await prepared.sandbox.stop();
			throw error;
		}
		return { ...prepared, snapshotSandbox, watch, rules, extensions };
	}

	/**
	 * 一个 agent 的沙盒和工具调用的处理：主 agent 的按 session 的配置，子 agent 的按它的定义收紧过的
	 * 配置。`scope` 是两者不同的部分。
	 */
	async #prepareAgent(
		settings: Pick<HostSessionOptions, "config" | "denied" | "rules">,
		scope: AgentScope,
	): Promise<PreparedAgent> {
		const { hostEnv, tracker, root } = this.#options;
		const { config, denied, rules } = settings;
		const { workspace } = config;
		const directories = this.#directories;
		const profile = config.permissionProfile;
		const writableRoots = [
			...{
				"read-only": [directories.tmp],
				"workspace-write": [workspace, directories.tmp],
				"danger-full-access": ["/"],
			}[config.baseSandboxMode],
			...(profile?.write ?? []),
		];
		const bash = findBash(hostEnv.PATH);
		const env = sandboxEnvironment(hostEnv, {
			tmpdir: directories.tmp,
			cache: directories.cache,
			workspace,
			bash,
			extra: config.environment,
		});
		const home = env.HOME;
		if (home === undefined) {
			throw new ConfigError(
				"Host 的环境变量里没有 HOME：权限规则和要保护的密钥位置都相对它",
			);
		}
		// 有 worker 的定义时，这个 session 的沙盒都能读 worker 目录：要在准备沙盒之前建好
		const workers = Object.values(config.agents).some(
			({ isolated }) => isolated,
		);
		if (workers) ensureWorkersDirectory(root, directories);
		const sandbox = await this.#options.createSandbox({
			config,
			denied,
			rules,
			bash,
			env,
			directories,
			tracker,
			pluginDirectories: scope.pluginDirectories,
			subagent: scope.subagent,
			askNetwork: (request, toolCallId) =>
				scope.network.ask(request, toolCallId),
			onWarning: (message) =>
				this.#events.session({ type: "warning", message }),
			onProcess: (event) => {
				// 子 agent 的起止由 `subagent.started`、`subagent.ended` 记录，它的沙盒的辅助进程不另记
				if (scope.subagent) return;
				if (this.#earlyProcesses === undefined) this.#events.process(event);
				else this.#earlyProcesses.push(event);
			},
		});
		const policy: PolicyContext = {
			sandboxMode: config.sandboxMode,
			approvalPolicy: config.approvalPolicy,
			...(config.granular === undefined ? {} : { granular: config.granular }),
		};
		const toolCalls = new ToolCalls({
			events: this.#events,
			approvals: this.#approvals,
			launcher: sandbox.commands,
			...(sandbox.edits === undefined ? {} : { editLauncher: sandbox.edits }),
			policy,
			rules,
			locations: {
				home,
				hostRoot: root,
				hostAllowed: [
					directories.tmp,
					directories.cache,
					directories.output,
					...(workers ? [directories.workers] : []),
				],
				// Host 根目录另按子目录判断，不算在凭据位置里；`~/.ssh` 这些常见密钥位置可以经批准读取，由沙盒拦
				credentialPaths: denied.read.filter((path) => path !== root),
				agentWritable: [
					workspace,
					directories.tmp,
					directories.cache,
					...(profile?.write ?? []),
				],
			},
			network: scope.network,
			background: this.#background,
			denied,
			...(profile === undefined ? {} : { profile }),
			workspace,
			writableRoots,
			outputDir: directories.output,
			env,
			tools: scope.tools,
			mcp: scope.mcp,
			tracker,
			extensions: this.#extensions,
			snapshots: scope.snapshots,
		});
		return { sandbox, toolCalls, writableRoots, env, policy };
	}

	/** `session.started` 发出之后再做：扩展在它之前产生的事件和警告先留着。 */
	#afterStart(emit: () => void): void {
		if (this.#earlyExtensions === undefined) emit();
		else this.#earlyExtensions.push(emit);
	}

	/**
	 * 换上准备好的扩展：重建 hooks，按这个沙盒启动 MCP server。换沙盒时（`restartLocal`）本地
	 * server 跟着重启：它们在旧沙盒的辅助进程下面。`beforeServers` 在 hooks 就绪之后、启动
	 * server 之前运行：打开 session 时会话开始的 hooks 排在这里。
	 */
	async #applyExtensions(
		prepared: Prepared,
		restartLocal: boolean,
		beforeServers?: () => Promise<void>,
	): Promise<void> {
		const { extensions } = prepared.sandbox;
		const warnings = this.#extensions.apply(prepared.extensions, {
			sandboxes: extensions?.sandboxes,
			policy: extensions?.policy,
			env: prepared.env,
		});
		for (const message of warnings) {
			this.#afterStart(() =>
				this.#events.session({ type: "warning", message }),
			);
		}
		await beforeServers?.();
		await this.#extensions.startServers(restartLocal);
	}

	/**
	 * 启动 agent 进程之前运行 `SessionStart` hooks：被阻止时 session 不打开；补充的信息随第一个
	 * task 的输入交给模型。
	 */
	async #sessionStartHooks(): Promise<void> {
		const { resume, fork } = this.#options;
		const source =
			fork !== undefined ? "fork" : resume === undefined ? "startup" : "resume";
		const messageId = newId();
		const outcome = await this.#extensions.runHooks(
			{
				event: "SessionStart",
				match: source,
				fields: { source },
			},
			({ blocked, additionalContext }) =>
				blocked || additionalContext === undefined
					? {}
					: { message_id: messageId },
		);
		if (outcome.blocked) {
			throw new SessionBlockedError(
				`SessionStart hook 阻止了打开 session：${outcome.reason ?? ""}`,
			);
		}
		this.#startContext =
			outcome.additionalContext === undefined
				? undefined
				: { context: outcome.additionalContext, messageId };
	}

	/** MCP 工具集变了（server 的 `list_changed`、退出、询问之后才启动完）：把完整的列表交给 runtime。 */
	#mcpToolsChanged(): void {
		this.#subagents.mcpToolsChanged();
		const agent = this.#agent;
		// 还没握手的进程在 `initialize` 的响应里拿到
		if (agent?.greeted !== true) return;
		agent.process.channel
			.notify("config/update", { mcp_tools: this.#extensions.mcpTools() })
			.catch((error: unknown) => {
				if (!(error instanceof ChannelClosedError)) throw error;
			});
	}

	#use(prepared: Prepared): void {
		this.#sandbox = prepared.sandbox;
		this.#snapshotSandbox = prepared.snapshotSandbox;
		this.#toolCalls = prepared.toolCalls;
		this.#writableRoots = prepared.writableRoots;
		this.#watch = prepared.watch;
		this.#env = prepared.env;
		this.#policy = prepared.policy;
		this.#network.configure({ policy: prepared.policy, rules: prepared.rules });
	}

	/**
	 * 用当前的沙盒启动一个 agent 进程，等它完成握手。没能启动（`initialize` 超时、版本不一致、
	 * 握手之前退出）时结束这个进程并抛出 `AgentStartError`。
	 */
	async #launchAgent(): Promise<RunningAgent> {
		const { tracker } = this.#options;
		const child = startAgentProcess({
			argv: this.#sandbox.agentArgv,
			reaper: this.#sandbox.agentReaper,
			env: this.#env,
			cwd: this.#options.config.workspace,
			onChannelFailure: (error) => {
				agent.failure = error;
				child.kill();
			},
		});
		const tracked = tracker.add(child.pid, "agent");
		const agent: RunningAgent = {
			process: child,
			initialized: Promise.withResolvers<void>(),
			greeted: false,
			stopping: false,
			failure: undefined,
			recorded: false,
			gone: child.exited.then(async (exit) => {
				await tracked;
				await tracker.remove(child.pid);
				if (child.reaperExitedEarly()) {
					this.#events.session({
						type: "warning",
						message:
							"agent 沙盒的收尾进程提前退出了，不能确认这个沙盒里的进程都已结束",
					});
				}
				if (!agent.recorded) return;
				this.#events.process({
					type: "process.exited",
					kind: "agent",
					pid: child.pid,
					exit_code: exit.code,
					signal: exit.signal,
				});
			}),
		};
		this.#agent = agent;
		serveChannel(child.channel, this);
		void child.exited.then((exit) => this.#onAgentExit(agent, exit));
		const timer = setTimeout(
			() =>
				agent.initialized.reject(
					new AgentStartError(
						`agent 进程 ${initializeTimeoutMs / 1000} 秒内没有发来 initialize\n${child.diagnostics()}`,
					),
				),
			initializeTimeoutMs,
		);
		try {
			await tracked;
			await agent.initialized.promise;
		} catch (error) {
			agent.stopping = true;
			this.#agent = undefined;
			child.kill();
			await agent.gone;
			throw error;
		} finally {
			clearTimeout(timer);
		}
		return agent;
	}

	/** 进程更替只记进程事件：`agent_id` 不变。 */
	#recordStart(agent: RunningAgent): void {
		agent.recorded = true;
		this.#events.process({
			type: "process.started",
			kind: "agent",
			pid: agent.process.pid,
		});
	}

	/** 结束当前的 agent 进程：关闭通道等它自己退出；`force` 时直接结束，它已经不响应了。 */
	async #stopAgent(force = false): Promise<void> {
		const agent = this.#agent;
		if (agent === undefined) return;
		agent.stopping = true;
		this.#agent = undefined;
		if (force) agent.process.kill();
		else await agent.process.stop();
		await agent.gone;
	}

	/**
	 * 重启 agent 进程：结束旧的，按当前设置启动新的，新进程握手时拿到 `resume`，按 session 记录
	 * 重建发给模型的历史。切换沙盒模式、取消超时、异常退出之后的下一次输入和重新加载配置都走这里，
	 * 只在没有进行中的 task 时调用。`change` 在两个进程之间换上新的设置。返回是否成功；
	 * 失败时按正常流程关闭 session。
	 */
	#restartAgent(
		reason: string,
		options: { force?: boolean; change?: () => Promise<void> } = {},
	): Promise<boolean> {
		const restarting = (async () => {
			try {
				await this.#stopAgent(options.force);
				await options.change?.();
				this.#recordStart(await this.#launchAgent());
				return true;
			} catch (error) {
				this.#events.session({
					type: "error",
					message: `重启 agent 进程失败（${reason}）：${(error as Error).message}\nsession 已关闭，请重新启动`,
				});
				return false;
			} finally {
				this.#restarting = undefined;
			}
		})();
		this.#restarting = restarting;
		return restarting.then(async (ok) => {
			if (!ok) await this.#shutdown("error");
			return ok;
		});
	}

	/**
	 * Linux 上 task 结束之后：这个 task 里新建的仓库不在 agent 沙盒的保护里，`.git` 的集合变了就按
	 * 当前的设置重新准备沙盒并重启 agent 进程；新出现的其他受保护路径只提醒用户。下一个 task 等检查
	 * 做完才开始。不在扫描到时立即重启：那会打断 task。
	 */
	#checkProtected(watch: ProtectedWatch): void {
		const checking: Promise<boolean> = (async () => {
			const found = await watch.check();
			if (found.timedOut) {
				this.#events.session({
					type: "warning",
					message:
						"task 结束时扫描工作区里受保护的路径超时了，没扫到的位置按没有变化处理",
				});
			}
			if (found.appeared.length > 0) {
				this.#events.session({
					type: "warning",
					message: `这个 task 里新出现了受保护的路径，在沙盒外进入这些目录之前请先查看：\n${found.appeared.join("\n")}`,
				});
			}
			this.#restarting = undefined;
			if (!found.repositoriesChanged || this.#state !== "open") return true;
			return this.#restartAgent("工作区里的仓库变了", {
				change: async () => {
					const old = this.#sandbox;
					const prepared = await this.#prepare(this.#options);
					this.#use(prepared);
					await this.#applyExtensions(prepared, true);
					await this.#retire(old);
				},
			});
		})();
		this.#restarting = checking;
		this.#checking = checking;
		void checking.then((ok) => {
			this.#checking = undefined;
			const agent = this.#agent;
			if (ok && agent !== undefined && this.#restarting === undefined) {
				this.#startNext(agent);
			}
		});
	}

	/**
	 * 停掉换下来的沙盒。还有后台命令在运行时先留着：它们用的是这个沙盒的命令辅助进程（网络代理），
	 * 等它们都结束再停。
	 */
	async #retire(sandbox: SessionSandbox): Promise<void> {
		if (this.#background.list().length === 0) {
			await sandbox.stop();
			return;
		}
		const stopped = this.#background.whenIdle().then(() => sandbox.stop());
		this.#retired.add(stopped);
		void stopped.then(() => this.#retired.delete(stopped));
	}

	/** 能接收 task 的 agent 进程：重启期间等新进程握手完成，异常退出之后在这里起新的进程。 */
	async #readyAgent(): Promise<RunningAgent> {
		for (;;) {
			const agent = this.#agent;
			if (agent !== undefined && this.#restarting === undefined) return agent;
			const ok = await (this.#restarting ??
				this.#restartAgent("上一个 agent 进程已经退出"));
			if (!ok) {
				throw new AgentStartError("agent 进程没能重新启动，session 已关闭");
			}
		}
	}

	/** 当前生效的配置：会话中换过的模型、推理强度、沙盒模式和审批策略，以及重新加载的配置都并在里面。 */
	get config(): SessionConfig {
		return this.#options.config;
	}

	/** 只能在空闲时做的操作：没有进行中的 task，也不在重启。 */
	#requireIdle(action: string): void {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#run !== undefined || this.#restarting !== undefined) {
			throw new SessionCommandError(
				`只能在 session 空闲时${action}：等当前的 task 结束，或者先取消它`,
			);
		}
	}

	/**
	 * 换上新的设置并重启 agent 进程。新的沙盒先准备好再结束旧进程：准备失败时 session 不受影响。
	 */
	async #reconfigure(
		settings: ReloadedSettings,
		action: string,
	): Promise<void> {
		// task 刚结束时的扫描不算 session 在忙：用户看到的是 task 已经结束，等它做完再判断
		await this.#checking;
		this.#requireIdle(action);
		const previous = this.#options.config.sandboxMode;
		const prepared = await this.#prepare(settings);
		try {
			this.#requireIdle(action);
		} catch (error) {
			await prepared.sandbox.stop();
			throw error;
		}
		const reach = (
			config: SessionConfig,
			writableRoots: readonly string[],
			{ denied, rules }: Pick<ReloadedSettings, "denied" | "rules">,
		) => ({
			writableRoots,
			denied,
			network: rules.networkLists(),
			...(config.permissionProfile === undefined
				? {}
				: { profile: config.permissionProfile }),
		});
		const covers = coversPrevious(
			reach(this.#options.config, this.#writableRoots, this.#options),
			reach(settings.config, prepared.writableRoots, settings),
		);
		const restarted = await this.#restartAgent(action, {
			change: async () => {
				const old = this.#sandbox;
				// 换到更窄的设置：撤销的权限不能在已经运行的后台命令身上继续生效
				if (!covers) await this.#background.stopAll("sandbox_mode");
				this.#options = {
					...this.#options,
					...settings,
					// 服务端工具的开关在打开 session 时定下：中途换了，提示缓存和之前的推理块都失效
					config: {
						...settings.config,
						serverTools: this.#options.config.serverTools,
					},
				};
				this.#use(prepared);
				this.#modelProxy.setModel(settings.config.model, settings.credential);
				await this.#applyExtensions(prepared, true);
				await this.#retire(old);
			},
		});
		if (!restarted) {
			throw new AgentStartError(
				`${action}时 agent 进程没能重新启动，session 已关闭`,
			);
		}
		const mode = settings.config.sandboxMode;
		if (mode !== previous) {
			this.#events.sandboxModeChanged({ from: previous, to: mode });
		}
	}

	/**
	 * 切换沙盒模式（`/sandbox`）：只在 session 空闲时，按新模式准备沙盒并重启 agent 进程。`next` 是
	 * 按新模式解析过的配置，这里只取其中的沙盒模式；换到命名权限配置时它的域名跟着换上。已经是
	 * 这个名字时什么也不做：命名权限配置的内容改了要重新加载配置。`danger-full-access` 只能在启动时
	 * 指定。不空闲或换不过去时抛出 `SessionCommandError`。
	 */
	async setSandboxMode(
		next: Pick<
			SessionConfig,
			"sandboxMode" | "baseSandboxMode" | "permissionProfile"
		>,
	): Promise<void> {
		const { denied, rules, credential } = this.#options;
		const { permissionProfile: _, ...config } = this.#options.config;
		const { sandboxMode, baseSandboxMode, permissionProfile } = next;
		if (sandboxMode === config.sandboxMode) return;
		if (baseSandboxMode === "danger-full-access") {
			throw new SessionCommandError(
				"danger-full-access 只能在启动时指定，运行中不能切换过去",
			);
		}
		await this.#reconfigure(
			{
				config: {
					...config,
					sandboxMode,
					baseSandboxMode,
					...(permissionProfile === undefined ? {} : { permissionProfile }),
				},
				denied,
				rules: rules.withProfile(
					permissionProfile === undefined
						? undefined
						: profileDomainRules(sandboxMode, permissionProfile),
				),
				credential,
			},
			"切换沙盒模式",
		);
	}

	/**
	 * 重新加载配置（`/reload`）：换上重新读取的配置、禁止的路径和凭据，重新准备沙盒（命令的
	 * 辅助进程跟着重启）并重启 agent 进程。只在 session 空闲时。
	 */
	async reload(settings: ReloadedSettings): Promise<void> {
		const mode = settings.config.sandboxMode;
		if (
			mode === "danger-full-access" &&
			mode !== this.#options.config.sandboxMode
		) {
			throw new SessionCommandError(
				"重新加载的配置把沙盒模式换成了 danger-full-access：它只能在启动时指定，请重新启动",
			);
		}
		await this.#reconfigure(settings, "重新加载配置");
	}

	/**
	 * 切换模型和推理强度（`/model`、`/effort`）：从下一次模型请求起生效，task 运行中也可以换。
	 * `settings` 是按新的模型重新检查过的配置和凭据，这里只取其中的模型、推理强度和凭据。
	 * 新模型的凭据文件不在沙盒禁止读取的路径里时，沙盒要跟着换：按重新加载配置处理，只能在空闲时做。
	 */
	async setModel(settings: ReloadedSettings): Promise<void> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		const denied = new Set(this.#options.denied.read);
		if (!settings.denied.read.every((path) => denied.has(path))) {
			await this.reload(settings);
			return;
		}
		const { model, reasoningEffort } = settings.config;
		const config = { ...this.#options.config, model, reasoningEffort };
		this.#options = {
			...this.#options,
			config,
			credential: settings.credential,
		};
		this.#modelProxy.setModel(model, settings.credential);
		const agent = this.#agent;
		// 还没握手的进程在 `initialize` 的响应里拿到新的模型
		if (agent?.greeted !== true) return;
		try {
			await agent.process.channel.notify("config/update", {
				model: modelInfo(config),
			});
		} catch (error) {
			// agent 进程已经退出：下一个进程在 `initialize` 的响应里拿到新的模型
			if (!(error instanceof ChannelClosedError)) throw error;
		}
	}

	/**
	 * 切换审批策略（`/approval`）：马上生效，不重启任何进程。挂起的询问在新策略下不该再问的，
	 * 立即答为拒绝（`denied_by_policy`）。
	 */
	setApprovalPolicy(policy: ApprovalPolicy, granular?: GranularApproval): void {
		if (this.#state !== "open") throw new Error("session 已关闭");
		const { config } = this.#options;
		const { granular: _, ...rest } = config;
		this.#options = {
			...this.#options,
			config: {
				...rest,
				approvalPolicy: policy,
				...(granular === undefined ? {} : { granular }),
			},
		};
		this.#policy = {
			sandboxMode: config.sandboxMode,
			approvalPolicy: policy,
			...(granular === undefined ? {} : { granular }),
		};
		this.#toolCalls.setPolicy(this.#policy);
		this.#network.configure({
			policy: this.#policy,
			rules: this.#options.rules,
		});
		this.#subagents.setApprovalPolicy(this.#policy, this.#options.rules);
		this.#approvals.reevaluate(this.#policy);
		this.#extensions.reevaluate(this.#policy);
		this.#events.approvalPolicyChanged({
			from: config.approvalPolicy,
			to: policy,
		});
	}

	/** 在 session 空闲时开始一个 task，返回 `task_id`。 */
	async submit(input: string | UserInput[]): Promise<string> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#run !== undefined) {
			throw new Error(
				"task 正在运行：用 steer 把输入并入当前 task，或用 followUp 排进列表",
			);
		}
		// 重启期间的输入等新进程握手完成，再作为新 task 开始
		const agent = await this.#readyAgent();
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#run !== undefined) {
			throw new Error("等 agent 进程重启时已经开始了另一个 task");
		}
		const content = this.#input(input);
		// 放这次输入的那条 user 消息的编号在运行 hooks 之前定下，hooks 的输出靠它和输入对上；
		// `SessionStart` hooks 补充的信息也进这条消息，它们已经定过编号时照用
		const messageId = this.#startContext?.messageId ?? newId();
		const checked = await this.#promptHooks(content, ({ blocked }) =>
			// 被阻止的输入不开始 task，不会有这条消息
			blocked ? {} : { message_id: messageId },
		);
		if (checked.blocked) throw new InputBlockedError(checked.reason ?? "");
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#run !== undefined) {
			throw new Error("hooks 检查这条输入时已经开始了另一个 task");
		}
		this.#options.writer.setTitle(inputText(content).split("\n", 1)[0] ?? "");
		return this.#startTask(
			agent,
			"user",
			content,
			undefined,
			checked.additionalContext,
			messageId,
		);
	}

	/** 用户的输入交给 runtime 之前运行 `UserPromptSubmit` hooks；`scope` 是它检查的是哪条输入。 */
	#promptHooks(
		content: InputContent[],
		scope: HookScope | ((outcome: HookOutcome) => HookScope),
	) {
		const run = this.#run;
		return this.#extensions.runHooks(
			{
				event: "UserPromptSubmit",
				...(run === undefined
					? {}
					: { task_id: run.taskId, run_id: run.runId }),
				fields: {
					prompt: inputText(content),
					mentioned_paths: content.flatMap((block) =>
						block.type === "mention" ? [block.path] : [],
					),
				},
			},
			scope,
		);
	}

	/**
	 * 排一条 steering 或 follow-up，马上返回它的编号。配了 `UserPromptSubmit` hooks 时先检查，按提交
	 * 的顺序逐条进行，通过后才用 `queue` 排进队列（`checked` 为真，带上 hooks 补充的信息）；被阻止的
	 * 不排队，`hooks.ran` 带着这个编号和原因，前端把它放回输入框。
	 */
	#queueInput(
		content: InputContent[],
		queue: (
			inputId: string,
			checked: boolean,
			context: string | undefined,
		) => void,
	): string {
		const inputId = newId();
		if (!this.#extensions.hasHooks("UserPromptSubmit")) {
			queue(inputId, false, undefined);
			return inputId;
		}
		this.#promptChecks = this.#promptChecks
			.then(async () => {
				if (this.#state !== "open") return;
				const outcome = await this.#promptHooks(content, {
					input_id: inputId,
				});
				if (outcome.blocked || this.#state !== "open") return;
				queue(inputId, true, outcome.additionalContext);
			})
			// 一条输入的检查出了错不拦住后面的输入
			.catch((error: unknown) => {
				this.#events.session({
					type: "error",
					message: `检查排队的输入时出错，这条输入没有排队：${(error as Error).message}`,
				});
			});
		return inputId;
	}

	/**
	 * 在 session 空闲时压缩上下文（`/compact`）：开始一个只做压缩的 task，有自己的 run 和预算，
	 * 返回 `task_id`。压缩成功时 runtime 上报 `context.compacted`，task 以 `completed` 结束；
	 * 压缩不了时以 `failed` 结束并说明原因。
	 */
	async compact(): Promise<string> {
		// task 刚结束时的扫描不算 session 在忙：用户看到的是 task 已经结束，等它做完再判断
		await this.#checking;
		this.#requireIdle("压缩上下文");
		const agent = await this.#readyAgent();
		this.#requireIdle("压缩上下文");
		return this.#startTask(agent, "user", [], "compact");
	}

	#input(input: string | UserInput[]): InputContent[] {
		return userInput(input, {
			put: (data) => this.#options.writer.putBlob(data),
			get: (sha256) => this.#options.store.blob(this.sessionId, sha256),
		});
	}

	/**
	 * task 运行时的输入，并入当前 task：在下一次模型请求之前插入。返回这条输入的编号。
	 * 取消时还没插入的 steering 立即交给模型，同一个 task 接着进行。
	 */
	steer(input: string | UserInput[]): string {
		if (this.#state !== "open" || this.#run === undefined) {
			throw new Error("没有进行中的 task：session 空闲时用 submit");
		}
		const content = this.#input(input);
		return this.#queueInput(content, (inputId, _checked, context) => {
			// 检查期间 task 结束了：和 task 结束时还没插入的 steering 一样交还前端
			if (this.#run === undefined) {
				this.#inputs.missed(inputId, content);
				return;
			}
			this.#inputs.steer(content, inputId, context);
			this.#inputs.userInput();
			this.#notifyInputAvailable();
		});
	}

	/**
	 * 排进 follow-up 列表，返回这条输入的编号：当前 task 以 `completed` 结束后，列表里的输入逐条作为
	 * 新的 task 开始。session 空闲时只有列表暂停着才能排，否则用 submit。
	 */
	followUp(input: string | UserInput[]): string {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#run === undefined && !this.#inputs.paused) {
			throw new Error("session 空闲、follow-up 列表没有暂停：用 submit");
		}
		const content = this.#input(input);
		return this.#queueInput(content, (inputId, checked, context) => {
			this.#inputs.followUp(content, inputId, context);
			// 检查期间 task 结束了：没有别的时机开始它
			const agent = this.#agent;
			if (
				checked &&
				this.#run === undefined &&
				!this.#inputs.paused &&
				agent !== undefined &&
				this.#restarting === undefined
			) {
				this.#startNext(agent);
			}
		});
	}

	/** 取回排队的 steering 和 follow-up：给了编号只取那一条，不给取回全部。 */
	dequeue(inputId?: string): QueuedInput[] {
		return this.#inputs.dequeue(inputId);
	}

	/** 当前排队的 steering 和 follow-up。 */
	inputQueue(): InputQueueSnapshot {
		return this.#inputs.snapshot();
	}

	/** 会话树的当前路径上已经记下的对外事件，按先后。 */
	history(): HostEvent[] {
		return pathHistory(
			this.#options.store,
			this.sessionId,
			this.#events.position,
		);
	}

	/** 这个 session 的检查点，按建立的先后。 */
	checkpoints(): CheckpointInfo[] {
		return listCheckpoints(this.#options.store, this.sessionId);
	}

	#requireSnapshots(): SessionSnapshots {
		if (this.#snapshots === undefined) {
			throw new SessionCommandError(
				"这个 session 没有做快照：找不到可用的 git，或者影子仓库打不开（见打开 session 时的警告）",
			);
		}
		return this.#snapshots;
	}

	/** 要还原代码的检查点在索引里的下标。没有这个检查点、它的快照已经清理时抛出 `SessionCommandError`。 */
	#restorable(checkpointId: string): number {
		const checkpoints = this.#options.store.checkpoints(this.sessionId);
		const index = checkpoints.findIndex(
			(checkpoint) => checkpoint.input_event_id === checkpointId,
		);
		const checkpoint = checkpoints[index];
		if (checkpoint === undefined) {
			throw new SessionCommandError(`没有这个检查点：${checkpointId}`);
		}
		if (checkpoint.cleaned) {
			throw new SessionCommandError(
				"这个检查点的快照已经清理：还可以回退对话，不能还原代码",
			);
		}
		return index;
	}

	/**
	 * 在 session 空闲时做一件要一会儿才做完的事（还原代码、回退）：做完之前新的输入等着，别的
	 * 只能在空闲时做的操作被拒绝。
	 */
	async #whileIdle<T>(action: string, work: () => Promise<T>): Promise<T> {
		// task 刚结束时的扫描不算 session 在忙：用户看到的是 task 已经结束，等它做完再判断
		await this.#checking;
		this.#requireIdle(action);
		const working = work();
		const gate = working.then(
			() => true,
			() => true,
		);
		this.#restarting = gate;
		try {
			return await working;
		} finally {
			// 中间重启过 agent 进程的（回退），重启结束时已经清掉了
			if (this.#restarting === gate) this.#restarting = undefined;
		}
	}

	/**
	 * 从某个检查点到现在 agent 的改动（`/diff`）；不给检查点时是这个 session 的全部改动。先对工作区
	 * 做一次快照，task 运行中也可以看。
	 */
	async diff(checkpointId?: string): Promise<ChangesDiff> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		const snapshots = this.#requireSnapshots();
		const start =
			checkpointId === undefined ? 0 : this.#restorable(checkpointId);
		// 还没有过输入：没有改动可看，也没有可以挂快照的检查点
		if (this.#options.store.checkpoints(this.sessionId).length === 0) {
			return { diff: "", unsnapshotted: [], failures: [] };
		}
		return snapshots.diff(start);
	}

	/** 把代码还原到检查点，并列出撤销不了的工作区外的改动。 */
	async #restoreCode(
		snapshots: SessionSnapshots,
		checkpointId: string,
		overwrite: boolean,
	): Promise<UndoResult> {
		const restored = await snapshots.restore(
			this.#restorable(checkpointId),
			overwrite,
		);
		return {
			...restored,
			outside: outsideEdits(
				this.#options.store,
				this.sessionId,
				checkpointId,
				this.#options.config.workspace,
			),
		};
	}

	/**
	 * 撤销改动（`/undo`）：把工作区还原到某个检查点，对话不动。只在 session 空闲时做，还在运行的
	 * 后台命令先结束。之后又被别处改过的文件是冲突，`overwrite` 为真时才还原。
	 */
	undo(checkpointId: string, overwrite: boolean): Promise<UndoResult> {
		return this.#whileIdle("撤销改动", async () => {
			const snapshots = this.#requireSnapshots();
			this.#restorable(checkpointId);
			// 它们可能接着改文件
			for (const { background_id } of this.#background.list()) {
				await this.#background.stop(background_id, "user");
			}
			const result = await this.#restoreCode(
				snapshots,
				checkpointId,
				overwrite,
			);
			// 模型的历史里这些改动还在：不告诉它，它会当文件还是改过的样子
			if (result.restored.length > 0) {
				this.#notice({
					background_id: null,
					text: [
						"The user restored these files in the workspace to an earlier checkpoint, undoing changes made since then. Read them again before relying on their contents.",
						...result.restored,
					].join("\n"),
					wake: false,
				});
			}
			return result;
		});
	}

	/** 回退的目标：要在当前的对话路径上。 */
	#rewindTarget(checkpointId: string): Checkpoint {
		const checkpoint = this.#options.store
			.checkpoints(this.sessionId)
			.find(({ input_event_id }) => input_event_id === checkpointId);
		if (checkpoint === undefined) {
			throw new SessionCommandError(`没有这个检查点：${checkpointId}`);
		}
		if (!checkpoint.on_path) {
			throw new SessionCommandError(
				"这个检查点不在当前的对话路径上，不能回退到它",
			);
		}
		return checkpoint;
	}

	/** 回退到这个检查点之后路径上最后一次模型请求用的模型和推理强度；那之前还没有回复时没有。 */
	modelBefore(checkpointId: string): RecordedModel | undefined {
		return pathModel(
			this.#options.store,
			this.sessionId,
			this.#rewindTarget(checkpointId).before,
		);
	}

	/**
	 * 回退会话（`/rewind`）：把当前位置移到某个检查点的输入之前，之后的输入接在那里，被放弃的那一段
	 * 留在记录里。只在 session 空闲时做；这个检查点之后启动的后台命令先结束，之前启动的保留。
	 * `code` 为真时同时把代码还原到这个检查点，返回还原的结果。agent 进程重启，按新的路径重建历史。
	 */
	rewind(
		checkpointId: string,
		options: { code: boolean; overwrite: boolean },
	): Promise<UndoResult | undefined> {
		return this.#whileIdle("回退会话", async () => {
			const checkpoint = this.#rewindTarget(checkpointId);
			const snapshots = options.code ? this.#requireSnapshots() : undefined;
			if (snapshots !== undefined) this.#restorable(checkpointId);
			await this.#stopOffPath(checkpoint.before);
			const restored =
				snapshots === undefined
					? undefined
					: await this.#restoreCode(snapshots, checkpointId, options.overwrite);
			await this.#moveTo("回退会话", checkpoint.before);
			return restored;
		});
	}

	/** 结束不在通往 `to` 的路径上启动的后台命令：接着运行会把输出送进不认识它们的对话。 */
	async #stopOffPath(to: Position | null): Promise<void> {
		const { store } = this.#options;
		const kept = new Set(
			to === null
				? []
				: hostEvents(
						store,
						this.sessionId,
						store
							.pathEvents(this.sessionId, to)
							.filter((event) => event.type === "background.started"),
					).flatMap((event) =>
						event.type === "background.started" ? [event.background_id] : [],
					),
		);
		for (const { background_id } of this.#background.list()) {
			if (!kept.has(background_id)) {
				await this.#background.stop(background_id, "user");
			}
		}
		this.#inputs.dropNotifications((id) => !kept.has(id));
	}

	/** 把当前位置移到 `to`：agent 进程重启，按新的路径重建历史。 */
	async #moveTo(action: string, to: Position | null): Promise<void> {
		const { store } = this.#options;
		// 后台命令结束时的快照记在原来的位置上，先等它们记完再移动当前位置
		await this.#snapshots?.idle();
		const restarted = await this.#restartAgent(action, {
			change: async () => {
				this.#events.moved(to);
				this.#lastRun = undefined;
				this.#idleRuns = true;
				this.#modelProxy.moved(pathModel(store, this.sessionId, to));
			},
		});
		if (!restarted) {
			throw new AgentStartError(
				`${action}时 agent 进程没能重新启动，session 已关闭`,
			);
		}
	}

	/** 被放弃的分支，按放弃的先后。 */
	branches(): BranchInfo[] {
		return listBranches(this.#options.store, this.sessionId);
	}

	/** 分支末端的位置。没有这个分支时抛出 `SessionCommandError`。 */
	#branchTip(id: string): Position {
		const tip = this.branches().some((branch) => branch.id === id)
			? this.#options.store
					.abandoned(this.sessionId)
					.find((position) => branchId(position) === id)
			: undefined;
		if (tip === undefined) {
			throw new SessionCommandError(`没有这个分支：${id}`);
		}
		return tip;
	}

	/** 切到这个分支之后路径上最后一次模型请求用的模型和推理强度。 */
	modelOn(branch: string): RecordedModel | undefined {
		return pathModel(
			this.#options.store,
			this.sessionId,
			this.#branchTip(branch),
		);
	}

	/**
	 * 切回一个被放弃的分支：把当前位置移到它的末端，现在这一段成为被放弃的分支。只在 session 空闲时
	 * 做；不在那个分支上启动的后台命令先结束。文件不动。agent 进程重启，按新的路径重建历史。
	 */
	switchBranch(branch: string): Promise<void> {
		return this.#whileIdle("切换分支", async () => {
			const tip = this.#branchTip(branch);
			await this.#stopOffPath(tip);
			await this.#moveTo("切换分支", tip);
		});
	}

	/** 让暂停的 follow-up 列表继续；session 空闲时马上开始列表的第一条。 */
	async resumeFollowUps(): Promise<void> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (!this.#inputs.paused) return;
		this.#inputs.userInput();
		this.#inputs.resume();
		if (this.#run === undefined) this.#startNext(await this.#readyAgent());
	}

	/**
	 * 开始一个 task：用户的输入、follow-up 和后台通知的唤醒都走这里。`kind` 为 `compact` 的是
	 * 用户发起的压缩，输入为空。`messageId` 是 `submit` 在运行 hooks 之前定下的、放这次输入的那条
	 * user 消息的编号。
	 */
	async #startTask(
		agent: RunningAgent,
		source: TaskSource,
		content: InputContent[],
		kind?: "compact",
		promptContext?: string,
		messageId?: string,
	): Promise<string> {
		const { config } = this.#options;
		const start = kind === undefined ? this.#startContext : undefined;
		// hooks 补充的信息只交给模型，不算用户的输入：`task.started` 里没有它，另记在 `hooks.ran` 里
		const hookBlocks =
			kind === undefined
				? [
						...(start === undefined
							? []
							: [hookContext("SessionStart", start.context)]),
						...(promptContext === undefined
							? []
							: [hookContext("UserPromptSubmit", promptContext)]),
					]
				: [];
		if (kind === undefined) this.#startContext = undefined;
		const run = new Run(config.budget);
		this.#run = run;
		this.#source = source;
		// 非交互运行没有人能追加额度：时间到了直接停止，不等下一次模型请求
		const { maxDurationMs } = config.budget;
		if (maxDurationMs !== null && config.approvalPolicy === "never") {
			run.deadline = setTimeout(
				() => this.#stopForBudget(run, "duration"),
				maxDurationMs,
			);
		}
		const before = this.#events.position;
		this.#events.runStarted(run);
		// 放这次输入的那条 user 消息由 runtime 生成，编号由 Host 定：同一份输入的两个副本靠它对上。
		// hooks 运行时定过的照用，它们的输出也在这条消息里
		const variant =
			kind === undefined
				? { message_id: messageId ?? start?.messageId ?? newId() }
				: { kind };
		if ("message_id" in variant) run.inputMessageId = variant.message_id;
		const inputEventId = this.#events.stored(run, {
			type: "task.started",
			source,
			input: content,
			...variant,
		});
		// 用户的每次输入一个检查点；后台通知唤醒的 task 和压缩不是用户的输入
		if (source !== "notification" && kind === undefined) {
			this.#checkpointCreated(run, inputEventId, "task", before);
		}
		if (source !== "notification") this.#inputs.userInput();
		// follow-up 列表暂停着时，用户的下一次输入就是让它继续；压缩不是输入，列表照旧暂停着
		if (source === "user" && kind === undefined) this.#inputs.resume();
		// 之前没有唤醒 session 而留下的通知，随这个 task 交给模型：先告诉 runtime 有输入要取，
		// 它在这个 task 的第一次模型请求之前就取走，排在这次输入之后
		if (this.#inputs.hasNotifications()) this.#notifyInputAvailable();
		// 上一个 task 之后确认、停用或删除过记忆（也可能是别的 Host 改的）：把新的索引交给 runtime，
		// 它在这个 task 开始时把差别告诉模型
		const memory = this.memory?.config();
		if (memory !== undefined && JSON.stringify(memory) !== this.#memorySent) {
			this.#memorySent = JSON.stringify(memory);
			await agent.process.channel.notify("config/update", { memory });
		}
		await agent.process.channel.notify("task/start", {
			input: [...content, ...hookBlocks],
			...variant,
		});
		return run.taskId;
	}

	/** session 空闲下来之后：先开始 follow-up 列表的第一条，没有的话为排队的后台通知开始一个 task。 */
	#startNext(agent: RunningAgent): void {
		if (this.#state !== "open" || this.#run !== undefined) return;
		const followUp = this.#inputs.nextFollowUp();
		const wake = followUp === undefined ? this.#inputs.wake() : undefined;
		let started: Promise<string>;
		// 事件记在新的 task 里：`#startTask` 在第一次等待之前已经记下 `task.started`
		if (followUp !== undefined) {
			started = this.#startTask(
				agent,
				"follow_up",
				followUp.input,
				undefined,
				followUp.hook_context,
			);
			this.#inputs.followUpStarted(followUp);
		} else if (wake !== undefined) {
			started = this.#startTask(agent, "notification", wake.input);
			this.#inputs.delivered(wake.notification_ids);
		} else {
			return;
		}
		started.catch((error: unknown) => {
			// agent 进程已经退出时，退出的处理会结束这个 task
			if (!(error instanceof ChannelClosedError)) throw error;
		});
	}

	/** 告诉 runtime 有 steering 或后台通知等待插入。 */
	#notifyInputAvailable(): void {
		this.#agent?.process.channel
			.notify("input/available", {})
			.catch((error: unknown) => {
				if (!(error instanceof ChannelClosedError)) throw error;
			});
	}

	/**
	 * 一条后台通知：排进队列并记下来。task 正在运行时告诉 runtime 来取，session 空闲时按唤醒的规则
	 * 开始一个 task。`quoted` 是文字里引用了原文的那条回复的编号（子 agent 的结果）。
	 */
	#notice(notice: Notice, quoted?: string): void {
		const notificationId = this.#inputs.notify(notice);
		this.#events.stored(this.#recordRun(), {
			type: "background.notification",
			notification_id: notificationId,
			background_id: notice.background_id,
			...(quoted === undefined ? {} : { message_id: quoted }),
			text: [notice.text, ...(notice.monitor?.lines ?? [])].join("\n"),
		});
		if (this.#state !== "open") return;
		if (this.#run !== undefined) {
			this.#notifyInputAvailable();
			return;
		}
		// 没有 agent 进程（异常退出之后）或正在重启时不唤醒：通知留到下一个 task 交给模型
		const agent = this.#agent;
		if (agent !== undefined && this.#restarting === undefined) {
			this.#startNext(agent);
		}
	}

	/**
	 * 等 session 空闲下来：没有进行中的 task，task 结束后的检查做完了，也没有接着开始 follow-up 或
	 * 后台通知的 task。只看 `task.ended` 判断不了：Linux 上它和下一个 task 之间隔着一次扫描。
	 */
	async whenIdle(): Promise<void> {
		for (;;) {
			const busy = this.#run?.ended.promise ?? this.#checking;
			if (busy === undefined) return;
			await busy;
		}
	}

	/** 运行中的后台命令，按开始的顺序。 */
	backgroundCommands(): BackgroundCommandInfo[] {
		return this.#background.list();
	}

	/**
	 * 用户停止一条后台命令，等它结束。没有这个编号或已经结束时返回 false。它产生的通知不唤醒 session，
	 * 等用户下一次开始 task 时交给模型。
	 */
	stopBackgroundCommand(backgroundId: string): Promise<boolean> {
		return this.#background.stop(backgroundId, "user");
	}

	/** 队列和后台命令的事件记在哪个 run 里：进行中的，session 空闲时是最近结束的。 */
	#recordRun(): Run {
		const run = this.#run ?? this.#lastRun;
		if (run !== undefined) return run;
		if (!this.#idleRuns) {
			throw new Error("还没有开始过 task，不该有队列和后台命令的事件");
		}
		const idle = new Run(this.#options.config.budget);
		this.#lastRun = idle;
		this.#events.runStarted(idle);
		return idle;
	}

	/** 唤醒开始的 task 里有调用被 `forbidden` 规则或 hook 阻止：到用户下一次输入之前不再唤醒。 */
	#observe(event: HostEvent): void {
		if (event.type === "tool_call.started" && event.name === "memory_propose") {
			this.memory?.proposeRegistered(event.run_id, event.event_id);
		}
		if (
			this.#source === "notification" &&
			event.type === "tool_call.completed" &&
			event.result.status === "denied" &&
			(event.result.reason === "forbidden_rule" ||
				event.result.reason === "hook")
		) {
			this.#inputs.blockWakeups();
		}
	}

	/**
	 * 回答一次询问：权限询问（`approval.requested`、`server_approval.requested`）用批准或拒绝，
	 * MCP server 的提问（`elicitation.requested`）用表单答复。询问已经有了结果时返回 false。
	 */
	respond(
		requestId: string,
		answer: ApprovalAnswer | ElicitationAnswer,
	): boolean {
		const answered = this.#extensions.respond(requestId, answer);
		if (answered !== undefined) return answered;
		// 表单答复只回答 MCP server 的提问：它已经有了结果
		if ("action" in answer) return false;
		return this.#approvals.respond(requestId, answer);
	}

	/** 这个 session 找到的扩展和它们的状态（`/extensions`）。 */
	extensions(): ExtensionInfo[] {
		return this.#extensions.items();
	}

	/** 这个 session 的 MCP server 和它们的状态（`/mcp`）。 */
	mcpServers(): McpServerState[] {
		return this.#extensions.servers();
	}

	/**
	 * 取消当前的 run：Host 先结束自己这边进行中的模型请求、命令和询问，再通知 runtime；它启动的
	 * 子 agent 同时取消，等它们都结束才返回。runtime 5 秒内没有报告 task 结束时，run 记 `cancelled`，
	 * 重启 agent 进程。
	 */
	async cancel(): Promise<void> {
		const run = this.#run;
		if (run === undefined || run.cancelled) return;
		const agent = this.#agent;
		if (agent === undefined) {
			throw new Error("有进行中的 run，却没有 agent 进程");
		}
		run.controller.abort();
		this.#cancelTimer = setTimeout(
			() => void this.#onCancelTimeout(run),
			cancelGraceMs,
		);
		const stopped = this.#subagents.stopAll(run);
		try {
			await agent.process.channel.request("run/cancel", {});
		} catch (error) {
			// agent 进程已经退出，退出的处理会结束这个 task
			if (!(error instanceof ChannelClosedError)) throw error;
		}
		await stopped;
	}

	/** 关闭 session：结束进行中的 task 和 agent 进程，最后发出 `session.ended`。 */
	close(): Promise<void> {
		return this.#shutdown("closed");
	}

	/** 按正常流程关闭 session：结束进行中的 task、agent 进程和沙盒，再保存事件、释放锁。 */
	async #shutdown(reason: SessionEndReason): Promise<void> {
		if (this.#state !== "open") return this.ended;
		this.#state = "closing";
		await this.#extractor?.cancel();
		const run = this.#run;
		if (run !== undefined) await this.#endRun(run, "cancelled");
		// 恢复时的询问还没有回答：不再等，中断的 task 不结束，下次恢复时再问
		this.#resuming?.controller.abort();
		// 后台命令属于 session：关闭时结束它们和它们的子孙进程
		await this.#background.stopAll("session_closed");
		// 父 run 已经带着它的子 agent 结束了；这里等它们的沙盒也停掉
		await this.#subagents.close();
		// 进行中的重启先做完：它启动的进程在下面一起结束
		await this.#restarting;
		await this.#stopAgent();
		// 已经发起的快照（后台命令结束时的）在沙盒停掉、记录关闭之前做完
		await this.#snapshots?.idle();
		// hooks 和本地 MCP server 在这个沙盒的辅助进程下面：先结束它们，再停沙盒
		await this.#extensions.runHooks({
			event: "SessionEnd",
			fields: { reason },
		});
		await this.#extensions.close();
		await this.#sandbox.stop();
		await Promise.all(this.#retired);
		// worker 的工作区只保留到 session 关闭：没有合并的改动随之丢弃
		rmSync(this.#directories.workers, { recursive: true, force: true });
		this.#state = "closed";
		this.#options.writer.close();
		this.#options.store.close();
		this.memory?.close();
		this.#options.lock.release();
		this.#events.session({ type: "session.ended", reason, usage: this.#usage });
		this.#resolveEnded();
	}

	/** 取消后 runtime 没有在时限内报告 task 结束：它已经不响应了，run 记 `cancelled`，重启 agent 进程。 */
	async #onCancelTimeout(run: Run): Promise<void> {
		if (this.#state !== "open") return;
		// run 在重启的过程里结束：`task.ended` 一发出就可能来新的输入，它要等新的进程
		await this.#restartAgent("取消后 runtime 5 秒内没有结束 task", {
			force: true,
			change: () => this.#endRun(run, "cancelled"),
		});
	}

	/**
	 * Host 自己结束一个 run（异常退出、取消超时、关闭 session）：按取消的方式收尾。Host 这边
	 * 进行中的模型请求和代为执行的工具调用中止后各自写下结果，等它们写完再结束 task，
	 * 这些结果和用量才记在 `task.ended` 之前。
	 */
	async #endRun(run: Run, outcome: TaskOutcome, error?: string): Promise<void> {
		run.controller.abort();
		await Promise.allSettled([...run.inFlight]);
		// `task.ended` 记在它启动的子 agent 都结束之后
		await this.#subagents.stopAll(run);
		// 等待期间 runtime 可能已经自己报告了结束
		if (this.#run !== run) return;
		this.#finishTask(run, outcome, error);
	}

	async initialize(params: InitializeParams): Promise<AgentConfig> {
		const agent = this.#agent;
		if (agent === undefined || agent.greeted) {
			throw new ProtocolError("initialize 只能在 agent 进程启动时发一次");
		}
		if (params.version !== runtimeVersion) {
			// 运行期间包可能在磁盘上被升级，每次启动 agent 进程都要核对
			const message = `agent 进程的 agent-runtime 是 ${params.version}，Host 依赖的是 ${runtimeVersion}，请重新启动`;
			agent.initialized.reject(new AgentStartError(message));
			throw new ProtocolError(message);
		}
		agent.greeted = true;
		agent.initialized.resolve();
		const { config } = this.#options;
		// 这个 session 已经有过 task：新进程从当前位置重建发给模型的历史
		const resume = this.#events.position;
		const memory = this.memory?.config();
		this.#memorySent = JSON.stringify(memory);
		const subagents = Object.entries(config.agents).map(
			([name, { description, isolated }]) => ({ name, description, isolated }),
		);
		return {
			...this.#agentConfig(config, this.#writableRoots),
			...(resume === null ? {} : { resume }),
			tools: [
				...config.tools,
				...memoryTools(config.memory),
				...this.#extensions.builtinTools(),
				...subagentTools(config),
			],
			...(memory === undefined ? {} : { memory }),
			...this.#extensions.agentConfig(),
			...(subagents.length === 0 ? {} : { subagents }),
		};
	}

	/** 交给 agent 进程的配置里主 agent 和子 agent 相同的部分。 */
	#agentConfig(
		config: SessionConfig,
		writableRoots: readonly string[],
	): Omit<AgentConfig, "tools"> {
		return {
			workspace: config.workspace,
			writable_roots: [...writableRoots],
			model: modelInfo(config),
			sandbox_mode: config.sandboxMode,
			approval_policy: config.approvalPolicy,
			user_instructions: readUserInstructions(this.#options.root),
			date: localDate(),
			os: `${process.platform} ${release()} (${arch()})`,
		};
	}

	async taskEnd(params: TaskEndParams): Promise<TaskEndResult> {
		const run = this.#run;
		if (run === undefined) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		// runtime 自己报告了结束：它在正常工作
		this.#exits = 0;
		// 还在经 hooks 检查的 steering 有了结果再判断：通过检查的要在这个 task 里交给模型。取消之后
		// 不等：runtime 要在时限内得到答复，没检查完的随后交还前端
		while (!run.cancelled) {
			const checks = this.#promptChecks;
			await checks;
			if (checks === this.#promptChecks) break;
		}
		if (this.#run !== run) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		const outcome = run.cancelled ? "cancelled" : params.outcome;
		// 还有没插入的 steering 时 task 不结束：runtime 取走后接着请求模型。用户取消之后也是这样，
		// 沿用同一个 task 和 run；超出上限而停止的不继续
		if (
			this.#state === "open" &&
			run.exceeded === undefined &&
			(outcome === "completed" || outcome === "cancelled") &&
			this.#inputs.hasSteering()
		) {
			clearTimeout(this.#cancelTimer);
			run.renew();
			return { continue: true };
		}
		// runtime 已经报告了结束，不再按取消超时处理；还没结束的子 agent 先停掉，`task.ended` 记在
		// 它们都结束之后
		clearTimeout(this.#cancelTimer);
		await this.#subagents.stopAll(run);
		if (this.#run !== run) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		this.#finishTask(run, outcome, params.error);
		const agent = this.#agent;
		if (agent !== undefined && this.#restarting === undefined) {
			if (this.#watch === undefined) this.#startNext(agent);
			else this.#checkProtected(this.#watch);
		}
		return { continue: false };
	}

	/** runtime 在插入时机取走待插入的 steering 和后台通知。 */
	async inputTake(): Promise<InputTakeResult> {
		this.#activeRun();
		return { inputs: this.#inputs.take() };
	}

	async modelRequest(
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
	): Promise<ModelRequestResult> {
		const run = this.#activeRun();
		return this.#track(run, this.#modelProxy.request(params, context, run));
	}

	async modelCountTokens(
		params: ModelCountTokensParams,
		context: HandlerContext<never>,
	): Promise<ModelCountTokensResult> {
		const run = this.#activeRun();
		return this.#track(
			run,
			this.#modelProxy.count(params, context.signal, run),
		);
	}

	async toolCallRun(
		params: ToolCallRunParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolCallRunResult> {
		const run = this.#activeRun();
		return this.#track(run, this.#toolCalls.run(params, context, run));
	}

	async toolCallRegister(
		params: ToolCallRegisterParams,
	): Promise<ToolCallRegisterResult> {
		const run = this.#activeRun();
		// 登记时要运行 hooks、可能要问用户：Host 自己结束 run 时等它写下结果
		return this.#track(run, this.#toolCalls.register(params, run));
	}

	async toolCallComplete(
		params: ToolCallCompleteParams,
	): Promise<ToolCallCompleteResult> {
		const run = this.#activeRun();
		// 先收下结果里的图片，不合规的在这里拒绝：结果记进 session 记录时图片按字节保存，
		// runtime 得到响应后，带着这个结果的模型请求里图片只带引用
		this.#images.remember(params.result.content);
		return this.#track(run, this.#toolCalls.complete(params));
	}

	/** `skill_load` 登记获准之后，runtime 来取 skill 的完整内容。 */
	async skillLoad(params: SkillLoadParams): Promise<SkillLoadResult> {
		return this.#extensions.loadSkill(params.name, this.#activeRun());
	}

	/** runtime 一侧才知道时机的两种 hooks：模型给出最终回复之后（`Stop`）和压缩上下文之前（`PreCompact`）。 */
	async hooksRun(params: HooksRunParams): Promise<HooksRunResult> {
		const run = this.#activeRun();
		const { event, message_id: messageId, ...fields } = params;
		const outcome = await this.#track(
			run,
			this.#extensions.runHooks(
				{
					event,
					task_id: run.taskId,
					run_id: run.runId,
					...(params.event === "PreCompact" ? { match: params.trigger } : {}),
					fields,
					signal: run.signal,
				},
				// runtime 只在这两种情况下生成那条消息：`Stop` 让模型接着做，`PreCompact` 没有阻止压缩
				({ blocked }) =>
					blocked === (event === "Stop") ? { message_id: messageId } : {},
			),
		);
		return {
			blocked: outcome.blocked,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
			...(outcome.additionalContext === undefined
				? {}
				: { additional_context: outcome.additionalContext }),
		};
	}

	/** runtime 自己的事件：属于当前的 run，同一个 run 里重复的 `event_id` 只记一次。 */
	recordAppend(params: RecordAppendParams): void {
		const run = this.#run;
		// 取走的输入已经在 runtime 的历史里：取消之后才到的插入报告也要记，不然它们会被当成没插入、
		// 放回输入框。系统指令也一样：runtime 只报告一次，丢了的话之后重启时没有它就重建不了历史。
		// 压缩同理：runtime 的历史已经换成了摘要，丢了的话重建出的历史和它之后发出的请求对不上
		const applied =
			params.event.type === "input.inserted" ||
			params.event.type === "instructions.recorded" ||
			params.event.type === "context.compacted";
		if (run === undefined || (run.cancelled && !applied)) {
			this.#events.session({
				type: "warning",
				message: `runtime 在没有进行中的 task 时上报了事件 ${params.event.type}，已丢弃`,
			});
			return;
		}
		if (run.runtimeEventIds.has(params.event_id)) return;
		run.runtimeEventIds.add(params.event_id);
		if (params.event.type === "input.inserted") {
			// 插入的位置由 Host 连同队列的快照一起记，不另记 runtime 的原始事件
			if (!this.#inputs.inserted(params.event.data)) {
				throw new ProtocolError("runtime 报告插入了它没有取走的输入");
			}
			return;
		}
		if (params.event.type === "context.compacted") {
			this.#events.compacted(run, params.event.data);
			return;
		}
		this.#events.runtime(run, params.event);
		const warnings = runtimeEventWarnings(params.event, this.#warnedRuleFiles);
		for (const message of warnings) {
			this.#events.session({ type: "warning", message });
		}
	}

	/** 读 session 记录不需要进行中的 task：重启后的 runtime 在第一个 task 之前用它重建历史。 */
	async recordRead(params: RecordReadParams): Promise<RecordReadResult> {
		const result = readRecord(
			this.#options.store,
			this.sessionId,
			params,
			this.#images,
		);
		// 恢复和分叉之后 runtime 按原来的编号放回这些消息：它们随请求再发来时不重复记
		this.#modelProxy.recorded(recordedMessageIds(result.events));
		return result;
	}

	/** 用户附带的图片按引用保存，runtime 在输入进入上下文时来取字节。 */
	async blobRead(params: BlobReadParams): Promise<BlobReadResult> {
		return readBlob(this.#options.store, this.sessionId, params);
	}

	/**
	 * runtime 在模型请求之前把 Host 没收到过的图片逐张交来。不要求有进行中的 task：取消之后才到的
	 * 只是多留一张图片。
	 */
	async imagePut(params: ImagePutParams): Promise<Empty> {
		this.#images.remember([params.image]);
		return {};
	}

	/** 重启后的 runtime 重建历史时，取回 `record/read` 里按引用给出的图片。 */
	async imageRead(params: ImageReadParams): Promise<ImageReadResult> {
		return { image: this.#images.image(params.sha256) };
	}

	/**
	 * 子 agent 的三个工具各自经通道请求 Host。编号是 runtime 给的：核对它是这个 run 里登记过、还在
	 * 等结果的那种调用，不是这样说明 runtime 有缺陷或被攻破。
	 */
	#subagentCall(
		run: Run,
		toolCallId: string,
		tool: "spawn_agent" | "send_message" | "interrupt_agent",
	): void {
		if (this.#toolCalls.pendingTool(toolCallId, run) !== tool) {
			throw new ProtocolError(
				`子 agent 的请求带的 tool_call_id 不是这个 run 里等待结果的 ${tool} 调用`,
			);
		}
	}

	async subagentStart(
		params: SubagentStartParams,
	): Promise<SubagentStartResult> {
		const run = this.#activeRun();
		this.#subagentCall(run, params.tool_call_id, "spawn_agent");
		// 启动要一会儿：Host 自己结束 run 时等它有了结果，再停掉启动好的子 agent
		return this.#track(run, this.#subagents.start(run, params));
	}

	async subagentSend(params: SubagentSendParams): Promise<SubagentSendResult> {
		const run = this.#activeRun();
		this.#subagentCall(run, params.tool_call_id, "send_message");
		return this.#subagents.send(run, params.agent_id, params.input);
	}

	async subagentStop(params: SubagentStopParams): Promise<SubagentStopResult> {
		const run = this.#activeRun();
		this.#subagentCall(run, params.tool_call_id, "interrupt_agent");
		return this.#track(run, this.#subagents.stop(run, params.agent_id));
	}

	/** 记忆库在 Host 一侧：没有启用长期记忆的 session 里 runtime 不该发来这些请求。 */
	#requireMemory(): SessionMemory {
		if (this.memory === undefined) {
			throw new ProtocolError("这个 session 没有启用长期记忆");
		}
		return this.memory;
	}

	/**
	 * 一次检索或读取属于哪次工具调用，记进 `memory.retrieved`。编号是 runtime 给的：核对它是这个 run
	 * 里登记过、还在等结果的那种调用，不是这样说明 runtime 有缺陷或被攻破。
	 */
	#memoryCall(
		run: Run,
		toolCallId: string,
		tool: "memory_search" | "memory_read",
	): { tool_call_id: string } {
		if (this.#toolCalls.pendingTool(toolCallId, run) !== tool) {
			throw new ProtocolError(
				`记忆的请求带的 tool_call_id 不是这个 run 里等待结果的 ${tool} 调用`,
			);
		}
		return { tool_call_id: toolCallId };
	}

	async memorySearch(params: MemorySearchParams): Promise<MemorySearchResult> {
		const run = this.#activeRun();
		const memory = this.#requireMemory();
		let link: { tool_call_id: string } | { message_id: string };
		if (params.tool_call_id !== undefined) {
			link = this.#memoryCall(run, params.tool_call_id, "memory_search");
		} else {
			// 没有工具调用的检索是 task 开始时按输入做的自动注入：查询就是输入，记上放输入的那条消息
			if (run.inputMessageId === undefined) {
				throw new ProtocolError(
					"memory/search 没有带 tool_call_id，这个 task 也没有输入",
				);
			}
			link = { message_id: run.inputMessageId };
		}
		const { result, retrieved } = memory.search(params);
		this.#events.stored(run, {
			type: "memory.retrieved",
			...retrieved,
			...link,
		});
		return result;
	}

	async memoryRead(params: MemoryReadParams): Promise<MemoryReadResult> {
		const run = this.#activeRun();
		const memory = this.#requireMemory();
		const link = this.#memoryCall(run, params.tool_call_id, "memory_read");
		const { result, retrieved } = memory.read(params);
		this.#events.stored(run, {
			type: "memory.retrieved",
			...retrieved,
			...link,
		});
		return result;
	}

	async memoryPropose(
		params: MemoryProposeParams,
	): Promise<MemoryProposeResult> {
		const run = this.#activeRun();
		const result = this.#requireMemory().propose(params, run.runId);
		if (result === undefined) {
			// runtime 先登记 `memory_propose` 的调用再提交内容，不是这样说明它有缺陷或被攻破
			throw new ProtocolError(
				"memory/propose 之前没有登记 memory_propose 的调用",
			);
		}
		return result;
	}

	/**
	 * 立即从一个已关闭的 session 的记录里提取记忆候选，不看后台提取的空闲时间条件：只给评测用。
	 * 没有启用长期记忆、那个 session 还开着或已经提取过时抛错。
	 */
	async extractMemory(sourceSessionId: string): Promise<MemoryExtractionEnded> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#extractor === undefined) {
			throw new Error("这个 session 没有启用长期记忆");
		}
		return this.#extractor.extractNow(sourceSessionId);
	}

	/** 记下 Host 正在为这个 run 处理的请求，Host 自己结束 run 时等它们收尾。 */
	async #track<Result>(run: Run, request: Promise<Result>): Promise<Result> {
		run.inFlight.add(request);
		try {
			return await request;
		} finally {
			run.inFlight.delete(request);
		}
	}

	/** 当前的 run。session 空闲或 run 已取消后，需要进行中 task 的请求以 `no_active_task` 拒绝。 */
	#activeRun(): Run {
		const run = this.#run;
		if (run === undefined || run.cancelled) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		return run;
	}

	/**
	 * 每次模型请求之前检查这个 run 的上限。超出时交互模式询问是否追加一份额度；拒绝了，或者是非交互
	 * 模式，就停止 run，task 以 `budget_exceeded` 结束。返回能不能发出这次请求。
	 */
	async #admit(run: Run): Promise<boolean> {
		// 子 agent 的请求计入启动它的 run：上限按整个 task 的用量检查，询问和停止也都落在父 run 上
		const owner = run.subagent?.parent ?? run;
		// 父 run 已经在停止（超出上限或被取消），子 agent 还没停下来：它的请求不发，也不再问一遍
		if (run.subagent !== undefined && owner.cancelled) return false;
		for (;;) {
			const exceeded = owner.budget.exceeded(owner.usage);
			if (exceeded === undefined) return true;
			if (this.#options.config.approvalPolicy !== "never") {
				// 父 run 和它的子 agent 同时超出时只问一次，追加的额度共用
				owner.extending ??= this.#approvals
					.ask(owner, { kind: "budget", ...exceeded })
					.then((answer) => {
						owner.extending = undefined;
						if (answer?.decision !== "approve") return false;
						owner.budget.extend();
						return true;
					});
				if (await owner.extending) continue;
			}
			this.#stopForBudget(owner, exceeded.limit);
			return false;
		}
	}

	/** 因为超出上限停止 run：和取消走同一条路，结束时记为 `budget_exceeded`。用户已经取消的不改。 */
	#stopForBudget(run: Run, limit: BudgetLimit): void {
		if (run.cancelled) return;
		run.exceeded = limit;
		void this.cancel();
	}

	#finishTask(run: Run, outcome: TaskOutcome, error?: string): void {
		clearTimeout(this.#cancelTimer);
		clearTimeout(run.deadline);
		this.#run = undefined;
		this.#lastRun = run;
		this.#toolCalls.settle(run);
		this.#usage = addUsage(this.#usage, run.usage);
		const { exceeded } = run;
		// 模型这个 task 里提议的、后台提取刚得到的候选，在 task 结束时一起列出
		const candidates = this.memory?.takeCandidates() ?? [];
		if (candidates.length > 0) {
			this.#events.stored(run, { type: "memory.candidates", candidates });
		}
		// 还没插入的 steering 交还前端、follow-up 列表的暂停，都记在 `task.ended` 之前
		this.#inputs.taskEnded(
			exceeded === undefined ? outcome : "budget_exceeded",
		);
		this.#events.stored(run, {
			type: "task.ended",
			outcome: exceeded === undefined ? outcome : "budget_exceeded",
			usage: run.usage,
			...(error === undefined || exceeded !== undefined ? {} : { error }),
			...(exceeded === undefined ? {} : { limit: exceeded }),
		});
		run.ended.resolve();
	}

	/**
	 * agent 进程不是 Host 结束的：握手之前退出算没能启动；之后退出是异常退出（崩溃、协议错误），
	 * run 记 `failed` 并带退出码或信号，session 保留，用户下一次输入时再启动新的进程。
	 * 连续 `maxConsecutiveExits` 次异常退出、中间没有正常结束的 task，就关闭 session。
	 */
	async #onAgentExit(agent: RunningAgent, exit: ProcessExit): Promise<void> {
		if (agent.stopping) return;
		const { failure } = agent;
		const diagnostics = agent.process.diagnostics();
		if (!agent.greeted) {
			agent.initialized.reject(
				new AgentStartError(
					`agent 进程在 initialize 之前退出了（${describeExit(exit)}）：${failure?.message ?? ""}\n${diagnostics}`,
				),
			);
			return;
		}
		if (this.#state !== "open") return;
		this.#agent = undefined;
		this.#exits += 1;
		const reason =
			failure?.message ?? `agent 进程意外退出（${describeExit(exit)}）`;
		const run = this.#run;
		if (run !== undefined) await this.#endRun(run, "failed", reason);
		await agent.gone;
		this.#events.session({
			type: run === undefined ? "warning" : "error",
			message: `${reason}\n${diagnostics}`,
		});
		if (this.#exits < maxConsecutiveExits) return;
		this.#events.session({
			type: "error",
			message: `agent 进程连续 ${maxConsecutiveExits} 次异常退出，中间没有正常结束的 task，session 已关闭`,
		});
		await this.#shutdown(failure === undefined ? "agent_exited" : "error");
	}
}
