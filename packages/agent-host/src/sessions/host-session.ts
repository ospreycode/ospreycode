import { arch, release } from "node:os";
import {
	type AgentConfig,
	type BlobReadParams,
	type BlobReadResult,
	ChannelClosedError,
	ChannelRequestError,
	type Empty,
	type HandlerContext,
	type ImagePutParams,
	type ImageReadParams,
	type ImageReadResult,
	type InitializeParams,
	type InputContent,
	type InputTakeResult,
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
	type TaskEndParams,
	type TaskEndResult,
	type ToolCallCompleteParams,
	type ToolCallRegisterParams,
	type ToolCallRegisterResult,
	type ToolCallRunParams,
	type ToolCallRunResult,
} from "@ospreycode/agent-runtime";
import type { StreamModel } from "@ospreycode/api";
import type {
	ApprovalAnswer,
	ApprovalPolicy,
	GranularApproval,
	PolicyContext,
} from "@ospreycode/sandbox";
import type { NetworkAnswer } from "@ospreycode/sandbox/backends";
import type { SessionStore, SessionWriter } from "@ospreycode/session-store";
import { Approvals } from "../actions/approvals.js";
import { NetworkApprovals } from "../actions/network-approvals.js";
import type { SessionRules } from "../actions/session-rules.js";
import { ToolCalls } from "../actions/tool-calls.js";
import { type ChannelHandlers, serveChannel } from "../channel/serve.js";
import { ConfigError } from "../config/errors.js";
import { profileDomainRules } from "../config/sandbox-mode.js";
import type { SessionConfig } from "../config/session-config.js";
import { readUserInstructions } from "../config/user-instructions.js";
import type { LoadedCredential } from "../credentials/sources.js";
import type { DiagnosticLog } from "../diagnostics/log.js";
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
import type { ProcessTracker } from "../processes/registry.js";
import type { SessionSandbox } from "../processes/sandboxed.js";
import type { WorkspaceLock } from "../project/locks.js";
import {
	createSessionDirectories,
	type SessionDirectories,
} from "../project/workspace.js";
import {
	eventFormatVersion,
	type HostEvent,
	type SessionEndReason,
} from "../sdk/events.js";
import { version as hostVersion } from "../version.js";
import { readBlob } from "./blob-read.js";
import type { BudgetLimit } from "./budget.js";
import { EventSink } from "./emitter.js";
import type { ProcessEvent, TaskOutcome, TaskSource } from "./events.js";
import { newId } from "./ids.js";
import {
	type InputQueueSnapshot,
	InputQueues,
	type Notice,
	type QueuedInput,
} from "./inputs.js";
import { ProtectedWatch } from "./protected-watch.js";
import { readRecord } from "./record-read.js";
import { addUsage, emptyUsage, Run } from "./run.js";
import { runtimeEventWarnings } from "./runtime-events.js";
import { coversPrevious } from "./sandbox-change.js";
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
	/** 按沙盒模式准备 agent 进程的启动命令和命令沙盒：打开 session、切换沙盒模式和重新加载配置时各调用一次。 */
	createSandbox: (context: SandboxContext) => Promise<SessionSandbox>;
	/** 这个 session 启动的进程记进进程登记表。 */
	tracker: ProcessTracker;
	/** 已经取得的工作区锁，session 结束时释放。 */
	lock: WorkspaceLock;
	/** 这个项目的 session 记录，session 结束时关闭。 */
	store: SessionStore;
	/** 这个 session 的写入者，持有写锁。 */
	writer: SessionWriter;
	userId: string;
	projectId: string;
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
interface Prepared {
	sandbox: SessionSandbox;
	/** Linux 上工作区可写时：准备沙盒那时工作区里受保护的路径。 */
	watch: ProtectedWatch | undefined;
	toolCalls: ToolCalls;
	writableRoots: readonly string[];
	env: Record<string, string>;
	policy: PolicyContext;
	rules: SessionRules;
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
	readonly agentId = newId();
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
	#inputs = new InputQueues((event) =>
		this.#events.stored(this.#recordRun(), event),
	);
	/** 最近结束的 run：session 空闲时队列和后台命令的事件记在它里面。 */
	#lastRun: Run | undefined;
	/** 后台命令：属于 session，跨 task 保留，换沙盒和重启 agent 进程时不换。 */
	#background = new BackgroundCommands(defaultBackgroundLimits, {
		started: (run, started) =>
			this.#events.stored(run, { type: "background.started", ...started }),
		ended: (ended) =>
			this.#events.stored(this.#recordRun(), {
				type: "background.ended",
				...ended,
			}),
		notify: (notice) => this.#notice(notice),
		// 结束了的 task 批准的域名只放行到它启动的后台命令都结束
		idle: () => this.#network.backgroundEnded(),
	});
	/** 换下来的沙盒，等后台命令都结束后停掉；停完的从这里去掉。 */
	#retired = new Set<Promise<void>>();
	/** 当前 task 的来源。 */
	#source: TaskSource = "user";
	#resolveEnded!: () => void;

	private constructor(options: HostSessionOptions) {
		this.sessionId = options.sessionId;
		this.#options = options;
		this.#events = new EventSink({
			sessionId: this.sessionId,
			agentId: this.agentId,
			listener: (event) => {
				this.#observe(event);
				options.onEvent(event);
			},
			record: (event) => options.writer.append(event),
			putBlob: (data) => options.writer.putBlob(data),
			scrub: options.scrub,
			log: options.log,
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
		this.#modelProxy = new ModelProxy({
			sessionId: this.sessionId,
			entry: options.config.model,
			credential: options.credential,
			fetch: options.fetch,
			streamModel: options.streamModel,
			events: this.#events,
			images: this.#images,
			scrub: options.scrub,
			onSecret: options.onSecret,
			admit: (run) => this.#admit(run),
		});
		this.ended = new Promise((resolve) => {
			this.#resolveEnded = resolve;
		});
	}

	/** 启动 agent 进程、完成握手后返回；之后发出 `session.started`。 */
	static async open(options: HostSessionOptions): Promise<HostSession> {
		const session = new HostSession(options);
		await session.#start();
		return session;
	}

	async #start(): Promise<void> {
		const { config, root } = this.#options;
		this.#directories = createSessionDirectories(
			root,
			this.sessionId,
			this.#options.projectId,
		);
		this.#use(await this.#prepare(this.#options));
		let agent: RunningAgent;
		try {
			agent = await this.#launchAgent();
		} catch (error) {
			this.#state = "closed";
			await this.#sandbox.stop();
			throw error;
		}
		this.#state = "open";
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
		// 辅助进程在 agent 进程之前启动，进程事件也按这个顺序
		for (const event of this.#earlyProcesses ?? []) this.#events.process(event);
		this.#earlyProcesses = undefined;
		this.#recordStart(agent);
	}

	/** 按一份配置准备沙盒和工具调用的处理；换上它们用 `#use`。 */
	async #prepare(
		settings: Pick<HostSessionOptions, "config" | "denied" | "rules">,
	): Promise<Prepared> {
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
		// Linux 上沙盒的保护停在包装的时刻。在准备沙盒之前记下：两者之间出现的仓库多重启一次，不会漏掉
		const watch =
			process.platform === "linux" &&
			config.baseSandboxMode === "workspace-write"
				? await ProtectedWatch.start(workspace)
				: undefined;
		const sandbox = await this.#options.createSandbox({
			config,
			denied,
			rules,
			bash,
			env,
			directories,
			tracker,
			askNetwork: (request, toolCallId) =>
				this.#network.ask(request, toolCallId),
			onWarning: (message) =>
				this.#events.session({ type: "warning", message }),
			onProcess: (event) => {
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
				hostAllowed: [directories.tmp, directories.cache, directories.output],
				// Host 根目录另按子目录判断，不算在凭据位置里；`~/.ssh` 这些常见密钥位置可以经批准读取，由沙盒拦
				credentialPaths: denied.read.filter((path) => path !== root),
				agentWritable: [
					workspace,
					directories.tmp,
					directories.cache,
					...(profile?.write ?? []),
				],
			},
			network: this.#network,
			background: this.#background,
			denied,
			...(profile === undefined ? {} : { profile }),
			workspace,
			writableRoots,
			outputDir: directories.output,
			env,
			tools: config.tools,
			tracker,
		});
		return {
			sandbox,
			watch,
			toolCalls,
			writableRoots,
			env,
			policy,
			rules,
		};
	}

	#use(prepared: Prepared): void {
		this.#sandbox = prepared.sandbox;
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
					this.#use(await this.#prepare(this.#options));
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
				this.#options = { ...this.#options, ...settings };
				this.#use(prepared);
				this.#modelProxy.setModel(settings.config.model, settings.credential);
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
		this.#approvals.reevaluate(this.#policy);
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
		this.#options.writer.setTitle(inputText(content).split("\n", 1)[0] ?? "");
		return this.#startTask(agent, "user", content);
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
		const inputId = this.#inputs.steer(this.#input(input));
		this.#inputs.userInput();
		this.#notifyInputAvailable();
		return inputId;
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
		return this.#inputs.followUp(this.#input(input));
	}

	/** 取回排队的 steering 和 follow-up：给了编号只取那一条，不给取回全部。 */
	dequeue(inputId?: string): QueuedInput[] {
		return this.#inputs.dequeue(inputId);
	}

	/** 当前排队的 steering 和 follow-up。 */
	inputQueue(): InputQueueSnapshot {
		return this.#inputs.snapshot();
	}

	/** 让暂停的 follow-up 列表继续；session 空闲时马上开始列表的第一条。 */
	async resumeFollowUps(): Promise<void> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (!this.#inputs.paused) return;
		this.#inputs.userInput();
		this.#inputs.resume();
		if (this.#run === undefined) this.#startNext(await this.#readyAgent());
	}

	/** 开始一个 task：用户的输入、follow-up 和后台通知的唤醒都走这里。 */
	async #startTask(
		agent: RunningAgent,
		source: TaskSource,
		content: InputContent[],
	): Promise<string> {
		const { config } = this.#options;
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
		this.#events.runStarted(run);
		this.#events.stored(run, { type: "task.started", source, input: content });
		if (source !== "notification") this.#inputs.userInput();
		// follow-up 列表暂停着时，用户的下一次输入就是让它继续
		if (source === "user") this.#inputs.resume();
		// 之前没有唤醒 session 而留下的通知，随这个 task 交给模型：先告诉 runtime 有输入要取，
		// 它在这个 task 的第一次模型请求之前就取走，排在这次输入之后
		if (this.#inputs.hasNotifications()) this.#notifyInputAvailable();
		await agent.process.channel.notify("task/start", { input: content });
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
			started = this.#startTask(agent, "follow_up", followUp.input);
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
	 * 开始一个 task。
	 */
	#notice(notice: Notice): void {
		const notificationId = this.#inputs.notify(notice);
		this.#events.stored(this.#recordRun(), {
			type: "background.notification",
			notification_id: notificationId,
			background_id: notice.background_id,
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
		if (run === undefined) {
			throw new Error("还没有开始过 task，不该有队列和后台命令的事件");
		}
		return run;
	}

	/** 唤醒开始的 task 里有调用被 `forbidden` 规则或 hook 阻止：到用户下一次输入之前不再唤醒。 */
	#observe(event: HostEvent): void {
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

	/** 回答一次询问；询问已经有了结果时返回 false。 */
	respond(requestId: string, answer: ApprovalAnswer): boolean {
		return this.#approvals.respond(requestId, answer);
	}

	/**
	 * 取消当前的 run：Host 先结束自己这边进行中的模型请求、命令和询问，再通知 runtime。
	 * runtime 5 秒内没有报告 task 结束时，run 记 `cancelled`，重启 agent 进程。
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
		try {
			await agent.process.channel.request("run/cancel", {});
		} catch (error) {
			// agent 进程已经退出，退出的处理会结束这个 task
			if (!(error instanceof ChannelClosedError)) throw error;
		}
	}

	/** 关闭 session：结束进行中的 task 和 agent 进程，最后发出 `session.ended`。 */
	close(): Promise<void> {
		return this.#shutdown("closed");
	}

	/** 按正常流程关闭 session：结束进行中的 task、agent 进程和沙盒，再保存事件、释放锁。 */
	async #shutdown(reason: SessionEndReason): Promise<void> {
		if (this.#state !== "open") return this.ended;
		this.#state = "closing";
		const run = this.#run;
		if (run !== undefined) await this.#endRun(run, "cancelled");
		// 后台命令属于 session：关闭时结束它们和它们的子孙进程
		await this.#background.stopAll("session_closed");
		// 进行中的重启先做完：它启动的进程在下面一起结束
		await this.#restarting;
		await this.#stopAgent();
		await this.#sandbox.stop();
		await Promise.all(this.#retired);
		this.#state = "closed";
		this.#options.writer.close();
		this.#options.store.close();
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
		return {
			workspace: config.workspace,
			writable_roots: [...this.#writableRoots],
			...(resume === null ? {} : { resume }),
			model: modelInfo(config),
			sandbox_mode: config.sandboxMode,
			approval_policy: config.approvalPolicy,
			tools: [...config.tools],
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
		return this.#toolCalls.register(params, this.#activeRun());
	}

	async toolCallComplete(params: ToolCallCompleteParams): Promise<Empty> {
		this.#activeRun();
		// 先收下结果里的图片，不合规的在这里拒绝：结果记进 session 记录时图片按字节保存，
		// runtime 得到响应后，带着这个结果的模型请求里图片只带引用
		this.#images.remember(params.result.content);
		return this.#toolCalls.complete(params);
	}

	/** runtime 自己的事件：属于当前的 run，同一个 run 里重复的 `event_id` 只记一次。 */
	recordAppend(params: RecordAppendParams): void {
		const run = this.#run;
		// 取走的输入已经在 runtime 的历史里：取消之后才到的插入报告也要记，不然它们会被当成没插入、
		// 放回输入框。系统指令也一样：runtime 只报告一次，丢了的话之后重启时没有它就重建不了历史
		const applied =
			params.event.type === "input.inserted" ||
			params.event.type === "instructions.recorded";
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
		this.#events.runtime(run, params.event);
		const warnings = runtimeEventWarnings(params.event, this.#warnedRuleFiles);
		for (const message of warnings) {
			this.#events.session({ type: "warning", message });
		}
	}

	/** 读 session 记录不需要进行中的 task：重启后的 runtime 在第一个 task 之前用它重建历史。 */
	async recordRead(params: RecordReadParams): Promise<RecordReadResult> {
		return readRecord(
			this.#options.store,
			this.sessionId,
			params,
			this.#images,
		);
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
		for (;;) {
			const exceeded = run.budget.exceeded(run.usage);
			if (exceeded === undefined) return true;
			if (this.#options.config.approvalPolicy !== "never") {
				const answer = await this.#approvals.ask(run, {
					kind: "budget",
					...exceeded,
				});
				if (answer?.decision === "approve") {
					run.budget.extend();
					continue;
				}
			}
			this.#stopForBudget(run, exceeded.limit);
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
