import { arch, release } from "node:os";
import {
	type AgentConfig,
	ChannelClosedError,
	ChannelRequestError,
	type Empty,
	type HandlerContext,
	type InitializeParams,
	type ModelRequestParams,
	type ModelRequestResult,
	ProtocolError,
	type RuntimeRequests,
	version as runtimeVersion,
	type TaskEndParams,
	type TaskEndResult,
	type ToolCallCompleteParams,
	type ToolCallParams,
	type ToolCallRegisterResult,
	type ToolCallRunResult,
} from "@ospreycode/agent-runtime";
import type { StreamModel } from "@ospreycode/api";
import type { UserContent } from "@ospreycode/api/protocol";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
import { Approvals } from "../actions/approvals.js";
import { ToolCalls } from "../actions/tool-calls.js";
import { type ChannelHandlers, serveChannel } from "../channel/serve.js";
import type { SessionConfig } from "../config/session-config.js";
import type { LoadedCredential } from "../credentials/sources.js";
import type { DiagnosticLog } from "../diagnostics/log.js";
import { ModelProxy } from "../model-proxy/proxy.js";
import {
	type AgentProcess,
	type ProcessExit,
	startAgentProcess,
} from "../processes/agent-process.js";
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
import { EventSink } from "./emitter.js";
import type { TaskOutcome } from "./events.js";
import { newId } from "./ids.js";
import { addUsage, emptyUsage, Run } from "./run.js";

/** 等 agent 进程发来 `initialize` 的时间。 */
const initializeTimeoutMs = 30_000;

/** 取消后等 runtime 报告 task 结束的时间。 */
const cancelGraceMs = 5_000;

/** agent 进程没能启动：`initialize` 超时、版本不一致或提前退出（CLI 的退出码 1）。 */
export class AgentStartError extends Error {
	override name = "AgentStartError";
}

/** 打开 session 用到的依赖，都已检查过。 */
export interface HostSessionOptions {
	sessionId: string;
	root: string;
	config: SessionConfig;
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
	/** 按沙盒模式准备 agent 进程的启动命令和命令沙盒。 */
	createSandbox: (context: SandboxContext) => Promise<SessionSandbox>;
	/** 这个 session 启动的进程记进进程登记表。 */
	tracker: ProcessTracker;
	/** 已经取得的工作区锁，session 结束时释放。 */
	lock: WorkspaceLock;
	userId: string;
	projectId: string;
	onEvent: (event: HostEvent) => void;
}

/** 准备沙盒时已经确定的东西。 */
export interface SandboxContext {
	bash: string;
	/** 沙盒里的进程的环境变量。 */
	env: Record<string, string>;
	directories: SessionDirectories;
	tracker: ProcessTracker;
}

function describeExit(exit: ProcessExit): string {
	return exit.signal === null ? `退出码 ${exit.code}` : `信号 ${exit.signal}`;
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
	#modelProxy: ModelProxy;
	#toolCalls!: ToolCalls;
	#agent!: AgentProcess;
	#sandbox!: SessionSandbox;
	#tmpdir = "";
	#run: Run | undefined;
	#usage = emptyUsage();
	#state: "starting" | "open" | "closing" | "closed" = "starting";
	#initialized = Promise.withResolvers<void>();
	#failure: Error | undefined;
	#cancelTimer: NodeJS.Timeout | undefined;
	/** agent 进程退出、从进程登记表里删掉之后兑现。 */
	#agentGone!: Promise<void>;
	#resolveEnded!: () => void;

	private constructor(options: HostSessionOptions) {
		this.sessionId = options.sessionId;
		this.#options = options;
		this.#events = new EventSink({
			sessionId: this.sessionId,
			agentId: this.agentId,
			listener: options.onEvent,
			scrub: options.scrub,
			log: options.log,
		});
		this.#approvals = new Approvals(this.#events);
		this.#modelProxy = new ModelProxy({
			entry: options.config.model,
			credential: options.credential,
			fetch: options.fetch,
			streamModel: options.streamModel,
			events: this.#events,
			scrub: options.scrub,
			onSecret: options.onSecret,
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
		const { config, root, hostEnv, tracker } = this.#options;
		const { workspace } = config;
		const directories = createSessionDirectories(root, this.sessionId);
		this.#tmpdir = directories.tmp;
		const bash = findBash(hostEnv.PATH);
		const env = sandboxEnvironment(hostEnv, {
			tmpdir: directories.tmp,
			workspace,
			bash,
			extra: config.environment,
		});
		this.#sandbox = await this.#options.createSandbox({
			bash,
			env,
			directories,
			tracker,
		});
		this.#toolCalls = new ToolCalls({
			events: this.#events,
			approvals: this.#approvals,
			launcher: this.#sandbox.commands,
			policy: {
				sandboxMode: config.sandboxMode,
				approvalPolicy: config.approvalPolicy,
				...(config.granular === undefined ? {} : { granular: config.granular }),
			},
			workspace,
			outputDir: directories.output,
			env,
			tools: ["shell"],
			tracker,
		});
		const agent = startAgentProcess({
			argv: this.#sandbox.agentArgv,
			env,
			cwd: workspace,
			onChannelFailure: (error) => this.#onChannelFailure(error),
		});
		this.#agent = agent;
		serveChannel(agent.channel, this);
		void agent.exited.then((exit) => this.#onAgentExit(exit));
		const timer = setTimeout(
			() =>
				this.#initialized.reject(
					new AgentStartError(
						`agent 进程 ${initializeTimeoutMs / 1000} 秒内没有发来 initialize\n${agent.diagnostics()}`,
					),
				),
			initializeTimeoutMs,
		);
		try {
			await tracker.add(agent.pid, "agent");
			this.#agentGone = agent.exited.then(() => tracker.remove(agent.pid));
			await this.#initialized.promise;
		} catch (error) {
			this.#state = "closed";
			agent.kill();
			await agent.exited;
			await tracker.remove(agent.pid);
			await this.#sandbox.stop();
			throw error;
		} finally {
			clearTimeout(timer);
		}
		this.#state = "open";
		this.#events.session({
			type: "session.started",
			format_version: eventFormatVersion,
			host_version: hostVersion,
			user_id: this.#options.userId,
			project_id: this.#options.projectId,
			workspace,
			model: config.model.id,
			sandbox_mode: config.sandboxMode,
			approval_policy: config.approvalPolicy,
		});
		for (const message of config.warnings) {
			this.#events.session({ type: "warning", message });
		}
	}

	/** 在 session 空闲时开始一个 task，返回 `task_id`。 */
	async submit(input: string): Promise<string> {
		if (this.#state !== "open") throw new Error("session 已关闭");
		if (this.#run !== undefined) {
			throw new Error(
				"task 运行时的输入（steering 和 follow-up）要到 P1 才支持",
			);
		}
		const run = new Run();
		this.#run = run;
		const content: UserContent[] = [{ type: "text", text: input }];
		this.#events.stored(run, {
			type: "task.started",
			source: "user",
			input: content,
		});
		this.#events.stored(run, { type: "run.started" });
		await this.#agent.channel.notify("task/start", { input: content });
		return run.taskId;
	}

	/** 回答一次询问；询问已经有了结果时返回 false。 */
	respond(requestId: string, answer: ApprovalAnswer): boolean {
		return this.#approvals.respond(requestId, answer);
	}

	/**
	 * 取消当前的 run：Host 先结束自己这边进行中的模型请求、命令和询问，再通知 runtime。
	 * runtime 5 秒内没有报告 task 结束时，结束 agent 进程。
	 */
	async cancel(): Promise<void> {
		const run = this.#run;
		if (run === undefined || run.cancelled) return;
		run.controller.abort();
		this.#cancelTimer = setTimeout(() => {
			// P1 起改为重启 agent 进程；P0 没有重启，结束这个 session
			this.#finishTask(run, "cancelled");
			this.#failure = new Error("取消后 runtime 5 秒内没有结束 task");
			this.#agent.kill();
		}, cancelGraceMs);
		try {
			await this.#agent.channel.request("run/cancel", {});
		} catch (error) {
			// agent 进程已经退出，退出的处理会结束这个 task
			if (!(error instanceof ChannelClosedError)) throw error;
		}
	}

	/** 关闭 session：结束进行中的 task 和 agent 进程，最后发出 `session.ended`。 */
	async close(): Promise<void> {
		if (this.#state !== "open") return this.ended;
		this.#state = "closing";
		const run = this.#run;
		if (run !== undefined) {
			run.controller.abort();
			this.#finishTask(run, "cancelled");
		}
		await this.#agent.stop();
		await this.#sandbox.stop();
		this.#state = "closed";
		await this.#end("closed");
	}

	async initialize(params: InitializeParams): Promise<AgentConfig> {
		if (this.#state !== "starting") {
			throw new ProtocolError("initialize 只能在启动时发一次");
		}
		if (params.version !== runtimeVersion) {
			// 运行期间包可能在磁盘上被升级，每次启动 agent 进程都要核对
			const message = `agent 进程的 agent-runtime 是 ${params.version}，Host 依赖的是 ${runtimeVersion}，请重新启动`;
			this.#initialized.reject(new AgentStartError(message));
			throw new ProtocolError(message);
		}
		this.#initialized.resolve();
		const { config } = this.#options;
		const { workspace, budget } = config;
		const writableRoots = {
			"read-only": [this.#tmpdir],
			"workspace-write": [workspace, this.#tmpdir],
			"danger-full-access": ["/"],
		}[config.sandboxMode];
		return {
			workspace,
			writable_roots: writableRoots,
			model: {
				id: config.model.id,
				reasoning_effort: config.reasoningEffort,
				context_window: config.model.context_window,
				max_output_tokens: config.model.max_output_tokens,
			},
			sandbox_mode: config.sandboxMode,
			approval_policy: config.approvalPolicy,
			tools: ["shell"],
			user_instructions: null,
			date: localDate(),
			os: `${process.platform} ${release()} (${arch()})`,
			budget: {
				max_cost_usd: budget.maxCostUsd,
				max_requests: budget.maxRequests,
				max_duration_ms: budget.maxDurationMs,
			},
		};
	}

	async taskEnd(params: TaskEndParams): Promise<TaskEndResult> {
		const run = this.#run;
		if (run === undefined) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		this.#finishTask(
			run,
			run.cancelled ? "cancelled" : params.outcome,
			params.error,
		);
		return { continue: false };
	}

	async modelRequest(
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
	): Promise<ModelRequestResult> {
		return this.#modelProxy.request(params, context, this.#activeRun());
	}

	async toolCallRun(
		params: ToolCallParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolCallRunResult> {
		return this.#toolCalls.run(params, context, this.#activeRun());
	}

	async toolCallRegister(
		params: ToolCallParams,
	): Promise<ToolCallRegisterResult> {
		return this.#toolCalls.register(params, this.#activeRun());
	}

	async toolCallComplete(params: ToolCallCompleteParams): Promise<Empty> {
		this.#activeRun();
		return this.#toolCalls.complete(params);
	}

	recordAppend(): void {
		// runtime 自己的事件从 P1 起交给 session-store 保存；P0 还没有 session 记录
	}

	/** 当前的 run。session 空闲或 run 已取消后，需要进行中 task 的请求以 `no_active_task` 拒绝。 */
	#activeRun(): Run {
		const run = this.#run;
		if (run === undefined || run.cancelled) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		return run;
	}

	#finishTask(run: Run, outcome: TaskOutcome, error?: string): void {
		clearTimeout(this.#cancelTimer);
		this.#run = undefined;
		this.#usage = addUsage(this.#usage, run.usage);
		this.#events.stored(run, {
			type: "task.ended",
			outcome,
			usage: run.usage,
			...(error === undefined ? {} : { error }),
		});
	}

	#onChannelFailure(error: Error): void {
		this.#failure = error;
		this.#agent.kill();
	}

	#onAgentExit(exit: ProcessExit): void {
		if (this.#state === "starting") {
			this.#initialized.reject(
				new AgentStartError(
					`agent 进程在 initialize 之前退出了（${describeExit(exit)}）：${this.#failure?.message ?? ""}\n${this.#agent.diagnostics()}`,
				),
			);
			return;
		}
		if (this.#state !== "open") return;
		this.#state = "closed";
		const reason =
			this.#failure?.message ?? `agent 进程意外退出（${describeExit(exit)}）`;
		const run = this.#run;
		if (run !== undefined) {
			run.controller.abort();
			this.#finishTask(run, "failed", reason);
		}
		this.#events.session({
			type: "error",
			message: `${reason}\n${this.#agent.diagnostics()}`,
		});
		const ended = this.#failure === undefined ? "agent_exited" : "error";
		void this.#sandbox.stop().then(() => this.#end(ended));
	}

	/** 全部进程结束之后：删掉 agent 进程的登记，释放工作区锁，发出 `session.ended`。 */
	async #end(reason: SessionEndReason): Promise<void> {
		await this.#agentGone;
		this.#options.lock.release();
		this.#events.session({ type: "session.ended", reason, usage: this.#usage });
		this.#resolveEnded();
	}
}
