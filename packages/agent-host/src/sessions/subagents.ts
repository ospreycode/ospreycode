import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type AgentConfig,
	ChannelClosedError,
	ChannelRequestError,
	type PendingInput,
	ProtocolError,
	ReceivedImages,
	version as runtimeVersion,
	type SubagentSendResult,
	type SubagentStartParams,
	type SubagentStartResult,
	type SubagentStopResult,
} from "@ospreycode/agent-runtime";
import type { CountTokens, StreamModel } from "@ospreycode/api";
import type { AssistantMessage } from "@ospreycode/api/protocol";
import type { PolicyContext } from "@ospreycode/sandbox";
import type { Approvals } from "../actions/approvals.js";
import { NetworkApprovals } from "../actions/network-approvals.js";
import type { SessionRules } from "../actions/session-rules.js";
import type { ToolCalls } from "../actions/tool-calls.js";
import { type ChannelHandlers, serveChannel } from "../channel/serve.js";
import type { SessionConfig } from "../config/session-config.js";
import {
	CredentialError,
	type LoadedCredential,
} from "../credentials/sources.js";
import type { GitResult } from "../extensions/plugins.js";
import type { SessionExtensions } from "../extensions/session-extensions.js";
import { ModelProxy } from "../model-proxy/proxy.js";
import {
	type AgentProcess,
	type ProcessExit,
	startAgentProcess,
} from "../processes/agent-process.js";
import type { BackgroundCommands } from "../processes/background.js";
import type { ProcessTracker } from "../processes/registry.js";
import type { SessionSandbox } from "../processes/sandboxed.js";
import type { SessionDirectories } from "../project/workspace.js";
import type { ToolSnapshots } from "../workspace/session-snapshots.js";
import type { EventSink } from "./emitter.js";
import type { SubagentOutcome } from "./events.js";
import { newId } from "./ids.js";
import { notificationPrefix } from "./inputs.js";
import { Run } from "./run.js";

/** 同一个父 run 同时运行的子 agent 的上限。 */
export const maxSubagents = 6;

/** 等子 agent 的进程发来 `initialize` 的时间。 */
const initializeTimeoutMs = 30_000;

/** 停止子 agent 时等它的 runtime 报告结束的时间。 */
const stopGraceMs = 5_000;

/** 一个 agent（主 agent 或子 agent）的沙盒和工具调用的处理。 */
export interface PreparedAgent {
	sandbox: SessionSandbox;
	toolCalls: ToolCalls;
	/** agent 沙盒的可写根，含 `TMPDIR`。 */
	writableRoots: readonly string[];
	/** 沙盒里的进程的环境变量。 */
	env: Record<string, string>;
	policy: PolicyContext;
}

/** 准备沙盒和工具调用的处理时，主 agent 和子 agent 不同的部分。 */
export interface AgentScope {
	/** 这个 agent 自己的网络审批：本任务内批准的域名不在 agent 之间共用。 */
	network: NetworkApprovals;
	/** 启用的工具。 */
	tools: readonly string[];
	/** 能不能调用 MCP 工具。 */
	mcp: boolean;
	/** 启用的插件的版本目录。 */
	pluginDirectories: readonly string[];
	/** 这个 agent 的工具调用前后怎么做快照。 */
	snapshots: ToolSnapshots;
	/** 这是子 agent 的沙盒：和主 agent 的沙盒同时存在，它的辅助进程不记进程事件。 */
	subagent: boolean;
}

/** session 现在的设置里启动子 agent 要用的部分。 */
export interface SubagentSettings {
	config: SessionConfig;
	denied: { read: readonly string[]; write: readonly string[] };
	rules: SessionRules;
	/** session 当前模型的凭据。 */
	credential: LoadedCredential;
	directories: SessionDirectories;
}

/** 管理子 agent 用到的依赖。 */
export interface SubagentsOptions {
	events: EventSink;
	approvals: Approvals;
	background: BackgroundCommands;
	extensions: SessionExtensions;
	tracker: ProcessTracker;
	fetch: typeof globalThis.fetch;
	streamModel: StreamModel;
	countTokens: CountTokens;
	scrub: (text: string) => string;
	onSecret: (value: string) => void;
	/** session 现在的设置：每次启动子 agent 时取。 */
	settings: () => SubagentSettings;
	/** 一份配置选用的模型的凭据；来自文件时带上文件的真实路径。 */
	credentialFor: (
		config: SessionConfig,
	) => Promise<{ credential: LoadedCredential; file?: string }>;
	/** 在沙盒里把项目仓库克隆到 `directory` 下的 `repo/`。 */
	cloneRepository: (
		projectRoot: string,
		directory: string,
	) => Promise<GitResult>;
	/** 按子 agent 的配置准备它的沙盒和工具调用的处理。 */
	prepare: (
		settings: Pick<SubagentSettings, "config" | "denied" | "rules">,
		scope: AgentScope,
	) => Promise<PreparedAgent>;
	/** 交给 agent 进程的配置里主 agent 和子 agent 相同的部分。 */
	agentConfig: (
		config: SessionConfig,
		writableRoots: readonly string[],
	) => Omit<AgentConfig, "tools">;
	/** 每次模型请求之前检查所属 task 的上限。 */
	admit: (run: Run) => Promise<boolean>;
	/** 这个 session 的快照：和主 agent 共用工作区的子 agent 的改动照常做快照。 */
	snapshots: ToolSnapshots;
	/**
	 * 子 agent 自己结束了（不是被停止的）：把结果交给启动它的 agent。`quoted` 是文字里引用了原文的
	 * 那条回复的编号，没有引用回复时（失败、拒绝、没有文字）没有。
	 */
	onEnded: (
		parent: Run,
		agentId: string,
		text: string,
		quoted: string | undefined,
	) => void;
}

/** 一个运行中的子 agent。 */
interface Subagent {
	readonly agentId: string;
	/** 定义的名字。 */
	readonly name: string;
	readonly run: Run;
	/** 启动它的 run。 */
	readonly parent: Run;
	readonly process: AgentProcess;
	readonly sandbox: SessionSandbox;
	readonly toolCalls: ToolCalls;
	readonly network: NetworkApprovals;
	readonly proxy: ModelProxy;
	/** 它的 runtime 交来过的图片。 */
	readonly images: ReceivedImages;
	/** 握手时交给它的配置。 */
	readonly config: AgentConfig;
	/** 它的沙盒模式和审批策略；审批策略会话中会换。 */
	policy: PolicyContext;
	/** worker 自己的工作区；和主 agent 共用工作区的没有。 */
	readonly workspace: string | undefined;
	/** 握手有了结果时兑现：成功为空，没能启动时是原因。 */
	readonly initialized: PromiseWithResolvers<string | undefined>;
	/** 进程退出、从进程登记表里删掉之后兑现。 */
	readonly gone: Promise<void>;
	greeted: boolean;
	/** 通道因协议错误失效的原因。 */
	failure: Error | undefined;
	/** 排着等它取走的输入：父 agent 发来的消息，和归属不明的网络拒绝。 */
	pending: PendingInput[];
	/** 它取走、还没报告插入位置的输入。 */
	readonly taken: Set<string>;
	/** 它最近一次模型回复的编号和里面的文字：结束时文字作为结果交给父 agent。 */
	reply: { messageId: string; text: string } | undefined;
	/** `subagent.ended` 已经记下。 */
	finished: boolean;
	/** Host 正在停止它：之后它的结束不通知父 agent。 */
	stopping: Promise<void> | undefined;
	/** 进程和沙盒的收尾，只做一次。 */
	closing: Promise<void> | undefined;
}

const noSnapshots: ToolSnapshots = {
	before: async () => {},
	after: async () => {},
};

function describeExit(exit: ProcessExit): string {
	return exit.signal === null
		? `exit code ${exit.code}`
		: `signal ${exit.signal}`;
}

function replyText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/** 记下 Host 正在为这个 run 处理的请求，Host 自己结束 run 时等它们收尾。 */
async function track<Result>(
	run: Run,
	request: Promise<Result>,
): Promise<Result> {
	run.inFlight.add(request);
	try {
		return await request;
	} finally {
		run.inFlight.delete(request);
	}
}

/**
 * 一个 session 的子 agent：按 `[agents.<名字>]` 的定义各起一个 agent 进程，有自己的通道、沙盒和
 * 模型代理，在自己的 run 里做一个任务。子 run 和启动它的 run 属于同一个 task、共用一份额度；
 * 它自己结束时结果作为通知交给父 agent，父 run 取消或结束时跟着停止。
 */
export class Subagents {
	#options: SubagentsOptions;
	/** 握手完成、收尾还没做完的子 agent。 */
	#agents = new Map<string, Subagent>();
	/** 每个父 run 正在启动、还没握手完成的子 agent 的个数：也占上限。 */
	#starting = new Map<Run, number>();
	/** 停了进程、等后台命令结束后再停沙盒的子 agent；停完的从这里去掉。 */
	#retired = new Set<Promise<void>>();

	constructor(options: SubagentsOptions) {
		this.#options = options;
	}

	/**
	 * 启动一个子 agent（`subagent/start`）：握手完成、任务交出去之后就返回，不等它做完。握手之前
	 * 没能启动时什么也不记，返回交给模型的原因。
	 */
	async start(
		parent: Run,
		params: SubagentStartParams,
	): Promise<SubagentStartResult> {
		const { config } = this.#options.settings();
		const name = params.agent;
		if (!Object.hasOwn(config.agents, name)) {
			return {
				started: false,
				reason: `There is no subagent named ${name}. The subagents are: ${Object.keys(config.agents).join(", ")}.`,
			};
		}
		const starting = this.#starting.get(parent) ?? 0;
		const running = [...this.#agents.values()].filter(
			(agent) => agent.parent === parent && !agent.finished,
		).length;
		if (running + starting >= maxSubagents) {
			return {
				started: false,
				reason: `${maxSubagents} subagents are already running, which is the limit. Wait for one of them to end or stop one with interrupt_agent, then try again.`,
			};
		}
		this.#starting.set(parent, starting + 1);
		try {
			return await this.#start(parent, params);
		} finally {
			const left = (this.#starting.get(parent) ?? 1) - 1;
			if (left === 0) this.#starting.delete(parent);
			else this.#starting.set(parent, left);
		}
	}

	async #start(
		parent: Run,
		params: SubagentStartParams,
	): Promise<SubagentStartResult> {
		const { events, scrub } = this.#options;
		const { config, denied, rules, credential, directories } =
			this.#options.settings();
		const name = params.agent;
		const definition = config.agents[name];
		if (definition === undefined) {
			throw new Error(`没有子 agent 的定义：${name}`);
		}
		// 用户取消之后同一个 run 可能接着进行：取消之前发起的启动仍然作废
		const cancelled = parent.signal;
		const agentId = newId();
		const refuse = (reason: string): SubagentStartResult => {
			const scrubbed = scrub(reason);
			events.session({
				type: "warning",
				message: `子 agent ${name} 没能启动：${scrubbed}`,
			});
			return { started: false, reason: scrubbed };
		};
		let model = { credential, file: undefined as string | undefined };
		if (
			definition.model !== undefined &&
			definition.model.service !== config.model.service
		) {
			try {
				const loaded = await this.#options.credentialFor({
					...config,
					model: definition.model,
				});
				model = { credential: loaded.credential, file: loaded.file };
			} catch (error) {
				if (!(error instanceof CredentialError)) throw error;
				return refuse(
					`There is no usable credential for its model ${definition.model.id}: ${error.message}`,
				);
			}
			this.#options.onSecret(model.credential.value);
		}
		// 只取标识的前 12 个字符：worker 的工作区在 Host 根目录下面已经很深，项目里的工具在工作区里
		// 建 Unix socket 时路径有长度上限
		const directory = definition.isolated
			? join(directories.workers, agentId.slice(0, 12))
			: undefined;
		const cleanup = () => {
			if (directory !== undefined) {
				rmSync(directory, { recursive: true, force: true });
			}
		};
		let workspace: string | undefined;
		if (directory !== undefined) {
			const cloned = await this.#clone(config, directory);
			if ("reason" in cloned) {
				cleanup();
				return refuse(cloned.reason);
			}
			workspace = cloned.workspace;
		}
		// 定义只能收紧：命名权限配置下保留它禁止读写的路径和域名，只去掉它放开写入的路径
		const tightened =
			definition.readOnly && config.baseSandboxMode !== "read-only";
		const { permissionProfile: profile, ...rest } = config;
		const childConfig: SessionConfig = {
			...rest,
			model: definition.model ?? config.model,
			reasoningEffort: definition.reasoningEffort ?? config.reasoningEffort,
			...(workspace === undefined || directory === undefined
				? {}
				: { workspace, projectRoot: join(directory, "repo") }),
			...(tightened
				? { sandboxMode: "read-only", baseSandboxMode: "read-only" }
				: {}),
			...(profile === undefined
				? {}
				: {
						permissionProfile: tightened
							? { ...profile, mode: "read-only", write: [] }
							: profile,
					}),
		};
		// 定义里列了工具的只有这些；没列的和主 agent 相同，只是没有记忆和子 agent 的工具
		const full = definition.tools === undefined;
		const tools = definition.tools ?? [
			...config.tools,
			...this.#options.extensions.builtinTools(),
		];
		// 网络审批回答沙盒的询问时这个子 agent 可能还没建好
		let agent: Subagent | undefined;
		const network = new NetworkApprovals({
			events,
			approvals: this.#options.approvals,
			currentRun: () =>
				agent === undefined || agent.finished ? undefined : agent.run,
			onDenied: (message) => {
				events.session({ type: "warning", message });
				if (agent !== undefined && !agent.finished) {
					this.#queue(
						agent,
						"notification",
						`${notificationPrefix} ${message}`,
					);
				}
			},
			pauseTimeout: (toolCallId) =>
				this.#options.background.pauseTimeout(toolCallId),
			backgroundRunning: () =>
				this.#options.background.list().map((command) => command.background_id),
		});
		let prepared: PreparedAgent;
		try {
			prepared = await this.#options.prepare(
				{
					config: childConfig,
					denied: {
						read: [
							...denied.read,
							...(model.file === undefined ? [] : [model.file]),
						],
						write: denied.write,
					},
					rules,
				},
				{
					network,
					tools,
					mcp: full,
					pluginDirectories: this.#options.extensions.pluginDirectories(),
					// worker 的工作区不做快照：撤销还原的是用户的工作区
					snapshots:
						workspace === undefined ? this.#options.snapshots : noSnapshots,
					subagent: true,
				},
			);
		} catch (error) {
			// 沙盒建不起来是约定中的失败：原因交给模型，session 不受影响
			cleanup();
			return refuse(
				`Its sandbox could not be set up: ${(error as Error).message}`,
			);
		}
		network.configure({ policy: prepared.policy, rules });
		const run = new Run(config.budget, undefined, {
			agentId,
			parent,
			toolCallId: params.tool_call_id,
		});
		const images = new ReceivedImages();
		const child = startAgentProcess({
			argv: prepared.sandbox.agentArgv,
			reaper: prepared.sandbox.agentReaper,
			env: prepared.env,
			cwd: childConfig.workspace,
			onChannelFailure: (error) => {
				started.failure = error;
				child.kill();
			},
		});
		const { tracker } = this.#options;
		const tracked = tracker.add(child.pid, "agent");
		const started: Subagent = {
			agentId,
			name,
			run,
			parent,
			process: child,
			sandbox: prepared.sandbox,
			toolCalls: prepared.toolCalls,
			network,
			proxy: new ModelProxy({
				// 提示缓存按 agent 分开：子 agent 的对话和主 agent 的没有共同的前缀
				sessionId: agentId,
				entry: childConfig.model,
				credential: model.credential,
				fetch: this.#options.fetch,
				streamModel: this.#options.streamModel,
				countTokens: this.#options.countTokens,
				events,
				images,
				scrub,
				onSecret: this.#options.onSecret,
				admit: this.#options.admit,
				serverTools: config.serverTools,
			}),
			images,
			config: {
				...this.#options.agentConfig(childConfig, prepared.writableRoots),
				tools: [...tools],
				...(full
					? {
							skills: this.#options.extensions.agentConfig().skills,
							mcp_tools: this.#options.extensions.mcpTools(),
						}
					: {}),
				subagent: {
					name,
					...(definition.instructions === undefined
						? {}
						: { instructions: definition.instructions }),
				},
			},
			policy: prepared.policy,
			workspace,
			initialized: Promise.withResolvers(),
			gone: child.exited.then(async () => {
				await tracked;
				await tracker.remove(child.pid);
			}),
			greeted: false,
			failure: undefined,
			pending: [],
			taken: new Set(),
			reply: undefined,
			finished: false,
			stopping: undefined,
			closing: undefined,
		};
		agent = started;
		serveChannel(child.channel, this.#handlers(started));
		void child.exited.then((exit) => this.#onExit(started, exit));
		const timer = setTimeout(
			() =>
				started.initialized.resolve(
					`its process did not send initialize within ${initializeTimeoutMs / 1000} seconds\n${child.diagnostics()}`,
				),
			initializeTimeoutMs,
		);
		await tracked;
		const failure = await started.initialized.promise;
		clearTimeout(timer);
		if (failure !== undefined || cancelled.aborted) {
			started.finished = true;
			await this.#close(started);
			cleanup();
			return failure === undefined
				? { started: false, reason: "The task was cancelled." }
				: refuse(`Its process did not start: ${failure}`);
		}
		this.#agents.set(agentId, started);
		events.runStarted(run);
		events.stored(run, {
			type: "subagent.started",
			name,
			model: childConfig.model.id,
			sandbox_mode: childConfig.sandboxMode,
			workspace: childConfig.workspace,
		});
		try {
			await child.channel.notify("task/start", {
				input: [{ type: "text", text: params.prompt }],
				message_id: newId(),
			});
		} catch (error) {
			// 进程刚握手完就退出了：退出的处理会把它记成失败，结果照常作为通知交给父 agent
			if (!(error instanceof ChannelClosedError)) throw error;
		}
		return {
			started: true,
			agent_id: agentId,
			...(workspace === undefined ? {} : { workspace }),
		};
	}

	/**
	 * 给 worker 建工作区：在沙盒里把项目仓库克隆到 `directory` 下，工作区是克隆里和 session 的工作区
	 * 相同的相对路径。克隆不出来（不是 git 仓库、还没有提交、那个路径不在 `HEAD` 里）时返回原因。
	 */
	async #clone(
		config: SessionConfig,
		directory: string,
	): Promise<{ workspace: string } | { reason: string }> {
		mkdirSync(directory, { mode: 0o700 });
		let cloned: GitResult;
		try {
			cloned = await this.#options.cloneRepository(
				config.projectRoot,
				directory,
			);
		} catch (error) {
			return {
				reason: `Its copy of the repository could not be made: ${(error as Error).message}`,
			};
		}
		if (cloned.exitCode !== 0) {
			return {
				reason: `Its copy of the repository could not be made: git clone failed.\n${cloned.stderr.trim()}`,
			};
		}
		const workspace = join(
			directory,
			"repo",
			relative(config.projectRoot, config.workspace),
		);
		let real: string | undefined;
		try {
			real = realpathSync(workspace);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		// 不是它本身（经过了符号链接）时，工作区会落到克隆之外
		if (real !== workspace) {
			return {
				reason:
					"Its copy of the repository does not contain the workspace directory: the directory is not in the HEAD commit, or the repository has no commits yet.",
			};
		}
		return { workspace };
	}

	/** 排一条等这个子 agent 取走的输入，并告诉它的 runtime。 */
	#queue(agent: Subagent, kind: PendingInput["kind"], text: string): void {
		agent.pending.push({
			input_id: newId(),
			kind,
			content: [{ type: "text", text }],
		});
		agent.process.channel
			.notify("input/available", {})
			.catch((error: unknown) => {
				if (!(error instanceof ChannelClosedError)) throw error;
			});
	}

	/** 这个父 run 启动的、还在运行的那个子 agent。 */
	#find(parent: Run, agentId: string): Subagent | undefined {
		const agent = this.#agents.get(agentId);
		return agent === undefined ||
			agent.parent !== parent ||
			agent.finished ||
			agent.stopping !== undefined
			? undefined
			: agent;
	}

	/** 给运行中的子 agent 发一条消息（`subagent/send`）：在它下一次模型请求之前插入。 */
	send(parent: Run, agentId: string, input: string): SubagentSendResult {
		const agent = this.#find(parent, agentId);
		if (agent === undefined) {
			return {
				sent: false,
				reason: `No running subagent has the id ${agentId}: it has already ended, or the id is wrong.`,
			};
		}
		this.#queue(agent, "steering", input);
		return { sent: true };
	}

	/** 停止一个运行中的子 agent（`subagent/stop`），等它结束；它的结果不再通知父 agent。 */
	async stop(parent: Run, agentId: string): Promise<SubagentStopResult> {
		const agent = this.#find(parent, agentId);
		if (agent === undefined) {
			return {
				stopped: false,
				reason: `No running subagent has the id ${agentId}: it has already ended, or the id is wrong.`,
			};
		}
		await this.#stop(agent);
		return { stopped: true };
	}

	/** 父 run 取消或结束：停止它启动的全部子 agent，等它们结束。 */
	async stopAll(parent: Run): Promise<void> {
		await Promise.all(
			[...this.#agents.values()]
				.filter((agent) => agent.parent === parent)
				.map((agent) => this.#stop(agent)),
		);
	}

	/** 会话中切换了审批策略：运行中的子 agent 一起换，沙盒模式各自不变。 */
	setApprovalPolicy(policy: PolicyContext, rules: SessionRules): void {
		for (const agent of this.#agents.values()) {
			agent.policy = { ...policy, sandboxMode: agent.policy.sandboxMode };
			agent.toolCalls.setPolicy(agent.policy);
			agent.network.configure({ policy: agent.policy, rules });
		}
	}

	/** MCP 工具集变了：能用 MCP 工具的子 agent 也拿到新的列表。 */
	mcpToolsChanged(): void {
		for (const agent of this.#agents.values()) {
			if (agent.config.mcp_tools === undefined || agent.finished) continue;
			agent.process.channel
				.notify("config/update", {
					mcp_tools: this.#options.extensions.mcpTools(),
				})
				.catch((error: unknown) => {
					if (!(error instanceof ChannelClosedError)) throw error;
				});
		}
	}

	/** 关闭 session：停止全部子 agent；后台命令已经结束，等着它们的沙盒也都停掉。 */
	async close(): Promise<void> {
		await Promise.all(
			[...this.#agents.values()].map((agent) => this.#stop(agent)),
		);
		await Promise.all(this.#retired);
	}

	/**
	 * Host 停止一个子 agent：中止 Host 这边进行中的模型请求、命令和询问，通知它的 runtime；时限内
	 * 没有报告结束就由 Host 记下结束。之后结束它的进程。
	 */
	#stop(agent: Subagent): Promise<void> {
		agent.stopping ??= (async () => {
			if (!agent.finished) {
				agent.run.controller.abort();
				agent.process.channel
					.request("run/cancel", {})
					.catch((error: unknown) => {
						if (!(error instanceof ChannelClosedError)) throw error;
					});
				const ended = await Promise.race([
					agent.run.ended.promise.then(() => true),
					sleep(stopGraceMs, false, { ref: false }),
				]);
				if (!ended) {
					await Promise.allSettled([...agent.run.inFlight]);
					this.#finish(agent, "cancelled");
				}
			}
			await this.#close(agent);
		})();
		return agent.stopping;
	}

	/**
	 * 子 agent 的 run 结束：还没有结果的工具调用和询问收尾，记下 `subagent.ended`。它自己结束的
	 * （不是 Host 停止的）把结果交给父 agent。
	 */
	#finish(agent: Subagent, outcome: SubagentOutcome, error?: string): void {
		if (agent.finished) return;
		agent.finished = true;
		const { run } = agent;
		agent.toolCalls.settle(run);
		this.#options.events.stored(run, {
			type: "subagent.ended",
			outcome,
			usage: run.usage,
			...(error === undefined ? {} : { error }),
		});
		run.ended.resolve();
		if (agent.stopping !== undefined) return;
		const head = `Subagent ${agent.name} (${agent.agentId})`;
		const reply =
			agent.reply === undefined || agent.reply.text === ""
				? undefined
				: agent.reply;
		const result = {
			completed: `${head} finished. Its final reply:\n${reply?.text ?? "(It ended without a final reply.)"}`,
			failed: `${head} failed: ${error ?? "no reason was given"}`,
			refused: `${head} ended because its model refused the request.`,
			cancelled: `${head} was cancelled.`,
		}[outcome];
		this.#options.onEnded(
			agent.parent,
			agent.agentId,
			this.#options.scrub(
				agent.workspace === undefined
					? result
					: `${result}\nIts changes are in ${agent.workspace}. They are not in your workspace until you merge them.`,
			),
			outcome === "completed" ? reply?.messageId : undefined,
		);
	}

	/**
	 * 结束子 agent 的进程，再停它的沙盒。它启动的后台命令属于 session，用的是这个沙盒的命令辅助
	 * 进程：还有后台命令在运行时沙盒先留着，等它们都结束再停。
	 */
	#close(agent: Subagent): Promise<void> {
		agent.closing ??= (async () => {
			await agent.process.stop();
			await agent.gone;
			if (agent.process.reaperExitedEarly()) {
				this.#options.events.session({
					type: "warning",
					message: `子 agent ${agent.name} 的沙盒的收尾进程提前退出了，不能确认这个沙盒里的进程都已结束`,
				});
			}
			this.#agents.delete(agent.agentId);
			const { background } = this.#options;
			if (background.list().length === 0) {
				await agent.sandbox.stop();
				return;
			}
			const stopped = background.whenIdle().then(() => agent.sandbox.stop());
			this.#retired.add(stopped);
			void stopped.then(() => this.#retired.delete(stopped));
		})();
		return agent.closing;
	}

	/**
	 * 子 agent 的进程退出了。握手之前退出算没能启动；Host 没有让它结束的是异常退出，记 `failed`，
	 * 不重启：它没有可以接着做的记录位置。
	 */
	async #onExit(agent: Subagent, exit: ProcessExit): Promise<void> {
		const reason =
			agent.failure?.message ??
			`its agent process exited unexpectedly (${describeExit(exit)})`;
		if (!agent.greeted) {
			agent.initialized.resolve(`${reason}\n${agent.process.diagnostics()}`);
			return;
		}
		if (agent.finished) return;
		agent.run.controller.abort();
		await Promise.allSettled([...agent.run.inFlight]);
		if (agent.stopping === undefined) {
			this.#options.events.session({
				type: "warning",
				message: `子 agent ${agent.name} 异常退出：${reason}\n${agent.process.diagnostics()}`,
			});
			this.#finish(agent, "failed", reason);
		} else {
			this.#finish(agent, "cancelled");
		}
		await this.#close(agent);
	}

	/** 这个子 agent 进行中的 run；已经结束或取消之后，需要进行中 task 的请求以 `no_active_task` 拒绝。 */
	#active(agent: Subagent): Run {
		if (agent.finished || agent.run.cancelled) {
			throw new ChannelRequestError("no_active_task", "没有进行中的 task");
		}
		return agent.run;
	}

	/**
	 * 子 agent 的通道上的操作。请求来自哪个 agent 由通道决定。子 agent 用不到的操作（嵌套的子
	 * agent、记忆、读 session 记录、`Stop` 和 `PreCompact` hooks）按协议错误处理。
	 */
	#handlers(agent: Subagent): ChannelHandlers {
		const { events, extensions } = this.#options;
		const unsupported = (operation: string) => async (): Promise<never> => {
			throw new ProtocolError(`子 agent 不能使用 ${operation}`);
		};
		return {
			initialize: async (params) => {
				if (agent.greeted) {
					throw new ProtocolError("initialize 只能在 agent 进程启动时发一次");
				}
				if (params.version !== runtimeVersion) {
					const message = `its agent-runtime is ${params.version}, the Host depends on ${runtimeVersion}`;
					agent.initialized.resolve(message);
					throw new ProtocolError(message);
				}
				agent.greeted = true;
				agent.initialized.resolve(undefined);
				return agent.config;
			},
			taskEnd: async (params) => {
				if (agent.finished) {
					throw new ChannelRequestError("no_active_task", "没有进行中的 task");
				}
				// 超出上限时停止的是整个 task，子 agent 是随它取消的
				const outcome =
					agent.run.cancelled || params.outcome === "budget_exceeded"
						? "cancelled"
						: params.outcome;
				// 父 agent 发来的消息还没取走：runtime 取走后接着请求模型
				if (outcome === "completed" && agent.pending.length > 0) {
					return { continue: true };
				}
				this.#finish(agent, outcome, params.error);
				// 等这次响应写出去再关通道
				setImmediate(() => void this.#close(agent));
				return { continue: false };
			},
			inputTake: async () => {
				this.#active(agent);
				const inputs = agent.pending;
				agent.pending = [];
				for (const { input_id } of inputs) agent.taken.add(input_id);
				return { inputs };
			},
			modelRequest: async (params, context) => {
				const run = this.#active(agent);
				const result = await track(
					run,
					agent.proxy.request(params, context, run),
				);
				agent.reply = {
					messageId: result.message.message_id,
					text: replyText(result.message),
				};
				return result;
			},
			modelCountTokens: async (params, context) => {
				const run = this.#active(agent);
				return track(run, agent.proxy.count(params, context.signal, run));
			},
			toolCallRun: async (params, context) => {
				const run = this.#active(agent);
				return track(run, agent.toolCalls.run(params, context, run));
			},
			toolCallRegister: async (params) => {
				const run = this.#active(agent);
				return track(run, agent.toolCalls.register(params, run));
			},
			toolCallComplete: async (params) => {
				const run = this.#active(agent);
				agent.images.remember(params.result.content);
				return track(run, agent.toolCalls.complete(params));
			},
			recordAppend: (params) => {
				const { run } = agent;
				// 和主 agent 一样：取消之后才到的插入报告、系统指令和压缩也要记
				const applied =
					params.event.type === "input.inserted" ||
					params.event.type === "instructions.recorded" ||
					params.event.type === "context.compacted";
				if (agent.finished || (run.cancelled && !applied)) {
					events.session({
						type: "warning",
						message: `子 agent ${agent.name} 的 runtime 在没有进行中的 task 时上报了事件 ${params.event.type}，已丢弃`,
					});
					return;
				}
				if (run.runtimeEventIds.has(params.event_id)) return;
				run.runtimeEventIds.add(params.event_id);
				if (params.event.type === "input.inserted") {
					// 插入的消息随下一次模型请求记成 `message.sent`，不另记
					if (
						!params.event.data.input_ids.every((id) => agent.taken.delete(id))
					) {
						throw new ProtocolError("runtime 报告插入了它没有取走的输入");
					}
					return;
				}
				if (params.event.type === "context.compacted") {
					events.compacted(run, params.event.data);
					return;
				}
				events.runtime(run, params.event);
			},
			imagePut: async (params) => {
				agent.images.remember([params.image]);
				return {};
			},
			skillLoad: async (params) => {
				const run = this.#active(agent);
				if (!agent.config.tools.includes("skill_load")) {
					throw new ProtocolError("这个子 agent 没有启用 skill_load");
				}
				return extensions.loadSkill(params.name, run);
			},
			recordRead: unsupported("record/read"),
			blobRead: unsupported("blob/read"),
			imageRead: unsupported("image/read"),
			memorySearch: unsupported("memory/search"),
			memoryRead: unsupported("memory/read"),
			memoryPropose: unsupported("memory/propose"),
			hooksRun: unsupported("hooks/run"),
			subagentStart: unsupported("subagent/start"),
			subagentSend: unsupported("subagent/send"),
			subagentStop: unsupported("subagent/stop"),
		};
	}
}
