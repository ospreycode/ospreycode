import type {
	ApprovalDecided,
	BackgroundEnded,
	ElicitationRequestedEvent,
	HookEvent,
	HostEvent,
	InputQueueSnapshot,
	ServerApprovalRequestedEvent,
	SessionConfig,
	SessionEndReason,
	SubagentEndedEvent,
	TaskEndedEvent,
	TaskSource,
} from "@ospreycode/agent-host";
import { OutputBuffer } from "../format/output.js";
import { elapsedBetween } from "../format/result.js";
import { type DetailLine, parseArguments } from "../format/text.js";
import { exploreTools } from "../format/tools.js";
import { beyondTaskFailure } from "../task-failure.js";
import { displayInput } from "./input.js";
import type { ApprovalEvent, ReasoningEffort, ToolResult } from "./types.js";

/** 用户的一条输入：开始 task 的输入，或者插进当前 task 的 steering。 */
export interface UserEntry {
	kind: "user";
	source: TaskSource | "steering";
	text: string;
}

/** 模型的一条回复，流式增量到达时逐步变长。 */
export interface AssistantEntry {
	kind: "assistant";
	text: string;
	reasoning: string;
}

/** 一次工具调用。 */
export interface ToolEntry {
	kind: "tool";
	name: string;
	/** 模型写出的参数原文。 */
	arguments: string;
	/** 流式输出的开头和末尾。 */
	output: OutputBuffer;
	result?: ToolResult;
	durationMs?: number;
}

/**
 * 连着的几次只读的查看（读文件、搜索、列目录）聚合成的一组：逐条显示的话，定位一段代码读的十几个
 * 文件会把模型的结论挤出屏幕。
 */
export interface ExploreEntry {
	kind: "explore";
	calls: ToolEntry[];
	/** 还可能有调用接着加进来：后面还没有别的条目，task 也没有结束。 */
	open: boolean;
}

/** 一次询问和它的结果。 */
export interface ApprovalEntry {
	kind: "approval";
	request: ApprovalEvent;
	/** 询问来自子 agent 时它的名字。 */
	subagent?: string;
	decided?: ApprovalDecided;
}

/**
 * 一个子 agent：它的回复和工具调用不逐条显示，只在这一项里更新进展；它的结果随后作为给模型的
 * 通知显示。
 */
export interface SubagentEntry {
	kind: "subagent";
	name: string;
	model: string;
	/** worker 自己的工作区；和主 agent 共用工作区的没有。 */
	workspace?: string;
	/** 主 agent 交给它的任务；恢复时补记的结束没有对应的启动调用，没有。 */
	prompt?: string;
	/** 它开始过的工具调用的个数。 */
	toolCalls: number;
	/** 最近开始的一次工具调用。 */
	last?: { name: string; arguments: string };
	ended?: SubagentEndedEvent;
}

/** 一行说明：设置的变化、后台命令、警告和错误。 */
export interface NoticeEntry {
	kind: "notice";
	level: "info" | "warning" | "error";
	text: string;
	/** 接在说明下面的带色调的行：`/diff` 的 unified diff。 */
	detail?: readonly DetailLine[];
}

/** task 的结果、用时、用量和费用。 */
export interface TaskEndedEntry {
	kind: "task_ended";
	event: TaskEndedEvent;
	/** 从 `task.started` 到 `task.ended` 的毫秒数，按两个事件记的时间算：按记录重画时也一样。 */
	durationMs: number;
}

/** 对话区的一项，按时间排列。 */
export type Entry =
	| UserEntry
	| AssistantEntry
	| ToolEntry
	| ExploreEntry
	| ApprovalEntry
	| SubagentEntry
	| NoticeEntry
	| TaskEndedEntry;

/** MCP server 等用户回答的问题：它的提问（elicitation），或者它要访问还没放行的域名。 */
export type ServerQuestion =
	| ElicitationRequestedEvent
	| ServerApprovalRequestedEvent;

/** hooks 拦下一个动作时在对话区里怎么说；没有列出的时机，原因在工具调用或任务的结果里看得到。 */
const blockedByHook: Partial<Record<HookEvent, string>> = {
	UserPromptSubmit: "hook 拦下了这条输入",
	PostToolUse: "hook 对工具结果的反馈",
	Stop: "hook 要求模型接着做",
};

/** 状态行上的内容。 */
export interface Status {
	model: string;
	reasoningEffort: ReasoningEffort;
	sandboxMode: string;
	approvalPolicy: string;
	workspace: string;
}

/** 推理内容只留末尾这么多字符：只用来找最近的一个标题。 */
const reasoningLimit = 4_000;

/** 推理内容里最近的一个标题：模型按 `**标题**` 的写法给每一段思考起的名字；没有时为空串。 */
function latestHeading(reasoning: string): string {
	const headings = [...reasoning.matchAll(/\*\*([^*\n]+)\*\*/g)];
	return headings.at(-1)?.[1]?.trim() ?? "";
}

function describeBackgroundEnd(ended: BackgroundEnded): string {
	switch (ended.reason) {
		case "exited":
			return ended.signal === null
				? `退出码 ${ended.exit_code}`
				: `被信号 ${ended.signal} 结束`;
		case "stopped":
			return "被停止";
		case "time_limit":
			return "到达时限";
		case "output_limit":
			return "输出超过上限";
		case "session_closed":
			return "session 关闭";
		case "lost":
			return "上次 session 中断时还在运行，已经不在了";
	}
}

/**
 * 交互界面的状态：Host 的事件进来，变成对话区的条目、排队的输入、挂起的询问和状态行的内容。
 * 不依赖终端和界面库，界面每次事件之后按它重画。
 */
export class InteractiveState {
	readonly entries: Entry[] = [];
	readonly status: Status;
	queue: InputQueueSnapshot = {
		steering: [],
		follow_up: [],
		follow_up_paused: false,
	};
	/** 等用户回答的询问，按到达的顺序。 */
	approvals: ApprovalEvent[] = [];
	/** MCP server 等用户回答的问题，按到达的顺序；它们不属于 task，排在 `approvals` 之后显示。 */
	serverQuestions: ServerQuestion[] = [];
	/** 进行中的 task；空闲时为空。 */
	taskId: string | undefined;
	/** 进行中的 task 开始的时间（`task.started` 记的）和它是不是只压缩上下文；空闲时为空。 */
	task: { startedAt: string; compact: boolean } | undefined;
	/**
	 * 模型正在思考时，推理内容里最近的一个标题（没有标题时是空串）；没有在思考时为空。不显示推理
	 * 内容时也记着：活动行靠它说明模型在想什么。
	 */
	thinking: string | undefined;
	/** 主 agent 还没有结果的工具调用，按开始的先后。 */
	readonly running: ToolEntry[] = [];
	/** session 已经关闭时的原因。 */
	ended: SessionEndReason | undefined;
	#showReasoning: boolean;
	readonly #changed = new Set<Entry>();
	readonly #replies = new Map<string, AssistantEntry>();
	readonly #tools = new Map<string, ToolEntry>();
	/** 聚合在一组里的查看调用各自属于哪一组。 */
	readonly #groups = new Map<ToolEntry, ExploreEntry>();
	/** 各个 task 开始的时间，结束时算用时。 */
	readonly #taskStarted = new Map<string, string>();
	/** 子 agent 是哪次 `spawn_agent` 调用启动的，按 `agent_id`。 */
	readonly #spawnedBy = new Map<string, string>();
	/** 这条回复到现在为止的推理内容的末尾。 */
	#reasoning = "";
	readonly #asked = new Map<string, ApprovalEntry>();
	/** 见过的子 agent，按 `agent_id`。 */
	readonly #subagents = new Map<string, SubagentEntry>();
	readonly #background = new Map<string, string>();
	#agentStarted = false;
	/** 最近结束的 task 失败的原因，已经显示在它结束的那一行里；下一个 task 开始时清掉。 */
	#failure: string | undefined;

	constructor(config: SessionConfig) {
		this.status = {
			model: config.model.id,
			reasoningEffort: config.reasoningEffort,
			sandboxMode: config.sandboxMode,
			approvalPolicy: config.approvalPolicy,
			workspace: config.workspace,
		};
		this.#showReasoning = config.ui.showReasoning;
	}

	/**
	 * 换上重新解析的配置：`/model`、`/effort` 成功之后马上更新状态行，不等 `model.changed`
	 * （它到下一次模型请求才发）；`/reload` 之后其余几项也可能变了。
	 */
	configured(config: SessionConfig): void {
		this.status.model = config.model.id;
		this.status.reasoningEffort = config.reasoningEffort;
		this.status.sandboxMode = config.sandboxMode;
		this.status.approvalPolicy = config.approvalPolicy;
		this.#showReasoning = config.ui.showReasoning;
	}

	/**
	 * 恢复、回退和分叉之后按记录重画对话：`events` 是 `Session.history()` 里在这之前记下的事件，
	 * 按先后；原来显示的对话先清掉。重画完换上现在的情况：记录里进行中的 task 和等着回答的询问现在
	 * 都没有（恢复时它们随上一次运行结束了，回退和分叉只在空闲、没有询问时做）；排队的输入按 Host
	 * 给出的队列，恢复时它取的是记录里最后一份，不看会话树的当前路径；状态行按 Host 给出的配置，
	 * 不按重画时经过的换模型的事件：启动参数指定了模型时用的是指定的那个。
	 */
	restore(
		events: readonly HostEvent[],
		now: { queue: InputQueueSnapshot; config: SessionConfig },
	): void {
		this.entries.length = 0;
		this.#changed.clear();
		this.#replies.clear();
		this.#tools.clear();
		this.#groups.clear();
		this.#taskStarted.clear();
		this.#spawnedBy.clear();
		this.running.length = 0;
		this.#asked.clear();
		this.#subagents.clear();
		// `#background` 留着：回退时结束的后台命令，结束的事件在重画之后才处理，说明里要写出是哪条命令
		for (const event of events) this.apply(event);
		this.taskId = undefined;
		this.#idle();
		this.approvals = [];
		this.#failure = undefined;
		this.queue = now.queue;
		this.configured(now.config);
	}

	/**
	 * 界面换到另一个 session（分叉）之后、按它的记录重画之前调用：原来那个 session 的 MCP server 的
	 * 问题和 agent 进程都随它关闭了。
	 */
	switched(): void {
		this.serverQuestions = [];
		this.ended = undefined;
		this.#agentStarted = false;
	}

	/** 在对话区加一行说明；`detail` 是接在它下面的带色调的行。 */
	notice(
		text: string,
		level: NoticeEntry["level"] = "info",
		detail?: readonly DetailLine[],
	): void {
		this.#add({
			kind: "notice",
			level,
			text,
			...(detail === undefined ? {} : { detail }),
		});
	}

	/** 上次调用以来内容变了的条目，界面据此只更新这些。 */
	takeChanged(): Entry[] {
		const changed = [...this.#changed];
		this.#changed.clear();
		return changed;
	}

	/** 一次工具调用的名字和参数原文，询问里要说明是哪条命令时用。 */
	toolCall(toolCallId: string): ToolEntry | undefined {
		return this.#tools.get(toolCallId);
	}

	/** 还在运行的后台命令的个数。 */
	get backgroundCount(): number {
		return this.#background.size;
	}

	/** 这个 `agent_id` 是子 agent 时它的名字；主 agent 没有。 */
	subagentName(agentId: string): string | undefined {
		return this.#subagents.get(agentId)?.name;
	}

	/**
	 * 子 agent 的 run 里只在它那一项上显示的事件：返回 true 时已经处理完。它的回复不显示（结果随后
	 * 作为通知到达），换模型和压缩是它自己的上下文的事，不动状态行。其余的事件（询问、hooks、后台
	 * 命令）和主 agent 的一样显示。
	 */
	#applySubagent(entry: SubagentEntry, event: HostEvent): boolean {
		switch (event.type) {
			case "tool_call.started":
				entry.toolCalls += 1;
				entry.last = { name: event.name, arguments: event.arguments };
				// 不进对话区，只留着给询问说明是哪条命令
				this.#tools.set(event.tool_call_id, {
					kind: "tool",
					name: event.name,
					arguments: event.arguments,
					output: new OutputBuffer(),
				});
				this.#changed.add(entry);
				return true;
			case "subagent.ended":
				entry.ended = event;
				this.#changed.add(entry);
				return true;
			case "model.delta":
			case "message.completed":
			case "tool_call.output":
			case "tool_call.completed":
			case "model.changed":
			case "reasoning_effort.changed":
			case "context.compacted":
				return true;
			default:
				return false;
		}
	}

	/** 按一个事件更新状态。 */
	apply(event: HostEvent): void {
		const subagent =
			"agent_id" in event ? this.#subagents.get(event.agent_id) : undefined;
		if (subagent !== undefined && this.#applySubagent(subagent, event)) return;
		switch (event.type) {
			case "session.started":
				this.status.model = event.model;
				this.status.sandboxMode = event.sandbox_mode;
				this.status.approvalPolicy = event.approval_policy;
				this.status.workspace = event.workspace;
				this.notice(
					`Osprey Code ${event.host_version} · 输入 / 查看命令，@ 提及文件，/quit 退出`,
				);
				break;
			case "session.ended":
				// Host 自己关闭 session 之前总有一条 `error` 说明原因，这里不再加一行
				this.ended = event.reason;
				break;
			case "task.started":
				this.taskId = event.task_id;
				this.task = {
					startedAt: event.time,
					compact: event.kind === "compact",
				};
				this.#taskStarted.set(event.task_id, event.time);
				this.#failure = undefined;
				if (event.kind === "compact") {
					this.notice("正在压缩上下文…");
					break;
				}
				this.#add({
					kind: "user",
					source: event.source,
					// 通知的内容在 `background.notification` 到的时候已经显示过
					text:
						event.source === "notification"
							? "模型开始处理上面的通知"
							: displayInput(event.input),
				});
				break;
			case "task.ended": {
				if (this.taskId === event.task_id) {
					this.taskId = undefined;
					this.#idle();
				}
				this.#failure = event.error;
				const startedAt = this.#taskStarted.get(event.task_id);
				this.#taskStarted.delete(event.task_id);
				this.#add({
					kind: "task_ended",
					event,
					// 每个 task 都以 `task.started` 开头：记录里没有它的开始时按没有用时算
					durationMs:
						startedAt === undefined ? 0 : elapsedBetween(startedAt, event.time),
				});
				break;
			}
			case "model.delta": {
				const delta = event.event;
				if (delta.type === "text_delta") {
					this.thinking = undefined;
					const reply = this.#reply(event.message_id);
					reply.text += delta.text;
					this.#changed.add(reply);
				} else if (delta.type === "reasoning_delta") {
					this.#reasoning = (this.#reasoning + delta.text).slice(
						-reasoningLimit,
					);
					this.thinking = latestHeading(this.#reasoning);
					if (!this.#showReasoning) break;
					const reply = this.#reply(event.message_id);
					reply.reasoning += delta.text;
					this.#changed.add(reply);
				}
				break;
			}
			case "message.completed": {
				const { message } = event;
				this.#reasoning = "";
				this.thinking = undefined;
				const text = message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("");
				const reasoning = this.#showReasoning
					? message.content
							.flatMap((block) =>
								block.type === "reasoning" ? [block.text] : [],
							)
							.join("\n")
					: "";
				const streamed = this.#replies.has(message.message_id);
				// 只有工具调用的回复不占一条
				if (text !== "" || reasoning !== "" || streamed) {
					const reply = this.#reply(message.message_id);
					reply.text = text;
					reply.reasoning = reasoning;
					this.#changed.add(reply);
					this.#replies.delete(message.message_id);
				}
				// 模型服务一侧执行的工具没有流式事件：回复结束时各列一行（搜索的关键词、打开的网址）
				for (const block of message.content) {
					if (block.type === "opaque" && block.summary !== undefined) {
						this.notice(block.summary);
					}
				}
				break;
			}
			case "tool_call.started": {
				const call: ToolEntry = {
					kind: "tool",
					name: event.name,
					arguments: event.arguments,
					output: new OutputBuffer(),
				};
				this.#tools.set(event.tool_call_id, call);
				this.running.push(call);
				if (exploreTools.has(event.name)) this.#explore(call);
				else this.#add(call);
				break;
			}
			case "tool_call.output": {
				const call = this.#tool(event.tool_call_id);
				call.output.append(event.text);
				this.#changed.add(this.#groups.get(call) ?? call);
				break;
			}
			case "tool_call.completed": {
				const call = this.#tool(event.tool_call_id);
				call.result = event.result;
				call.durationMs = event.duration_ms;
				const at = this.running.indexOf(call);
				if (at !== -1) this.running.splice(at, 1);
				this.#changed.add(this.#groups.get(call) ?? call);
				break;
			}
			case "approval.requested": {
				const asked: ApprovalEntry = {
					kind: "approval",
					request: event,
					...(subagent === undefined ? {} : { subagent: subagent.name }),
				};
				this.approvals.push(event);
				this.#asked.set(event.request_id, asked);
				this.#add(asked);
				break;
			}
			case "approval.decided": {
				this.approvals = this.approvals.filter(
					(request) => request.request_id !== event.request_id,
				);
				const asked = this.#asked.get(event.request_id);
				// 事件格式允许没有询问就按策略拒绝：那时没有对应的条目，结果在工具调用上看得到
				if (asked === undefined) break;
				asked.decided = event;
				this.#asked.delete(event.request_id);
				this.#changed.add(asked);
				break;
			}
			case "input.queued":
			case "input.dequeued":
			case "input.follow_up_paused":
				this.queue = event.queue;
				break;
			case "input.inserted": {
				// 事件只有编号：内容取自插入之前的队列
				const inserted = new Set(event.input_ids);
				for (const item of this.queue.steering) {
					if (!inserted.has(item.input_id)) continue;
					this.#add({
						kind: "user",
						source: "steering",
						text: displayInput(item.input),
					});
				}
				this.queue = event.queue;
				break;
			}
			case "context.compacted":
				this.notice(
					event.trigger === "manual"
						? `上下文已压缩（压缩前约 ${event.tokens_before} token）`
						: `上下文接近模型的上限，已自动压缩（压缩前约 ${event.tokens_before} token）`,
				);
				break;
			case "model.changed":
				this.status.model = event.model;
				this.notice(
					`从这次模型请求起使用 ${event.model}（之前是 ${event.previous_model}）`,
				);
				break;
			case "reasoning_effort.changed":
				this.status.reasoningEffort = event.reasoning_effort;
				this.notice(
					`从这次模型请求起推理强度是 ${event.reasoning_effort}（之前是 ${event.previous_reasoning_effort}）`,
				);
				break;
			case "sandbox_mode.changed":
				this.status.sandboxMode = event.to;
				this.notice(`沙盒模式：${event.from} → ${event.to}`);
				break;
			case "approval_policy.changed":
				this.status.approvalPolicy = event.to;
				this.notice(`审批策略：${event.from} → ${event.to}`);
				break;
			case "background.started":
				this.#background.set(event.background_id, event.command);
				this.notice(
					`${event.kind === "monitor" ? "监视" : "后台命令"} ${event.background_id} 开始运行：${event.command}`,
				);
				break;
			case "background.ended": {
				const command = this.#background.get(event.background_id);
				this.#background.delete(event.background_id);
				this.notice(
					`后台命令 ${event.background_id} 结束了（${describeBackgroundEnd(event)}）${command === undefined ? "" : `：${command}`}`,
				);
				break;
			}
			case "background.notification":
				// 不是哪条后台命令产生的：Host 自己要告诉模型的事（撤销之后文件还原了、归属不明的网络拒绝）
				this.notice(
					`${event.background_id === null ? "给模型的通知" : "后台通知"}：${event.text}`,
				);
				break;
			case "subagent.started": {
				const prompt = this.#spawnPrompt(event.agent_id);
				const started: SubagentEntry = {
					kind: "subagent",
					name: event.name,
					model: event.model,
					...(event.workspace === this.status.workspace
						? {}
						: { workspace: event.workspace }),
					...(prompt === undefined ? {} : { prompt }),
					toolCalls: 0,
				};
				this.#subagents.set(event.agent_id, started);
				this.#add(started);
				break;
			}
			case "process.started":
				if (event.kind !== "agent") break;
				if (this.#agentStarted) this.notice("agent 进程已重启");
				this.#agentStarted = true;
				break;
			case "warning":
				this.notice(event.message, "warning");
				break;
			case "error": {
				const text = beyondTaskFailure(event.message, this.#failure);
				if (text !== "") this.notice(text, "error");
				break;
			}
			case "hooks.ran": {
				for (const message of event.system_messages) {
					this.notice(`hook（${event.event}）：${message}`);
				}
				const blocked = blockedByHook[event.event];
				if (event.blocked && blocked !== undefined) {
					this.notice(
						`${blocked}${event.reason === undefined ? "" : `：${event.reason}`}`,
						"warning",
					);
				}
				break;
			}
			case "elicitation.requested":
			case "server_approval.requested":
				this.serverQuestions.push(event);
				break;
			case "elicitation.answered": {
				const { server } = this.#answered(event.request_id);
				this.notice(
					`MCP server ${server} 的提问：${{ accept: "已回答", decline: "已拒绝", cancel: "没有回答" }[event.action]}`,
				);
				break;
			}
			case "server_approval.decided": {
				const asked = this.#answered(event.request_id);
				if (asked.type !== "server_approval.requested") {
					throw new Error(`${event.request_id} 不是网络访问的询问`);
				}
				this.notice(
					`MCP server ${asked.server} 访问 ${asked.request.host}：${
						{
							approved:
								event.answer?.scope === "rule"
									? "已允许，并保存为规则"
									: event.answer?.scope === "task"
										? "已允许，这个 session 内有效"
										: "已允许这一次",
							denied: "已拒绝",
							denied_by_policy: "审批策略不再询问这一类，已拒绝",
						}[event.decision]
					}`,
				);
				break;
			}
			case "run.started":
				// 子 agent 的 run 带着启动它的那次调用：它那一项上写交给它的任务
				if (event.parent_tool_call_id !== undefined) {
					this.#spawnedBy.set(event.agent_id, event.parent_tool_call_id);
				}
				break;
			// 子 agent 的结束在它那一项上显示。到这里的只有恢复时补记的：它的开始在上一次运行里，另有通知说明
			case "subagent.ended":
			case "process.exited":
			case "background.delivered":
			// 候选由 `/memory` 那边列出；记忆的改动由做改动的命令说明，检索在工具调用上看得到
			case "memory.candidates":
			case "memory.updated":
			case "memory.retrieved":
			case "memory.extraction.started":
			case "memory.extraction.ended":
				break;
		}
	}

	/** MCP server 的一个问题有了结果：从等回答的问题里取出来。 */
	#answered(requestId: string): ServerQuestion {
		const asked = this.serverQuestions.find(
			(question) => question.request_id === requestId,
		);
		if (asked === undefined) {
			throw new Error(`没有见过的 MCP server 的问题有了结果：${requestId}`);
		}
		this.serverQuestions = this.serverQuestions.filter(
			(question) => question !== asked,
		);
		return asked;
	}

	#add(entry: Entry): void {
		this.#closeExplore();
		this.entries.push(entry);
		this.#changed.add(entry);
	}

	/** 一次查看的调用：接在前一项是还开着的那一组后面，否则另起一组。 */
	#explore(call: ToolEntry): void {
		const last = this.entries.at(-1);
		let group: ExploreEntry;
		if (last?.kind === "explore" && last.open) {
			group = last;
			group.calls.push(call);
			this.#changed.add(group);
		} else {
			group = { kind: "explore", calls: [call], open: true };
			this.#add(group);
		}
		this.#groups.set(call, group);
	}

	/** 最后一项是还开着的一组查看时把它合上：后面来了别的内容，或者 task 结束了。 */
	#closeExplore(): void {
		const last = this.entries.at(-1);
		if (last?.kind !== "explore" || !last.open) return;
		last.open = false;
		this.#changed.add(last);
	}

	/** 没有进行中的 task 了：活动行要的那几项都清掉。 */
	#idle(): void {
		this.task = undefined;
		this.thinking = undefined;
		this.#reasoning = "";
		// 一直没有结果的调用不再算进行中：标题跟着变
		for (const call of this.running) {
			this.#changed.add(this.#groups.get(call) ?? call);
		}
		this.running.length = 0;
		this.#closeExplore();
	}

	/** 启动这个子 agent 的那次 `spawn_agent` 调用里交给它的任务。 */
	#spawnPrompt(agentId: string): string | undefined {
		const toolCallId = this.#spawnedBy.get(agentId);
		const call =
			toolCallId === undefined ? undefined : this.#tools.get(toolCallId);
		const prompt =
			call === undefined ? undefined : parseArguments(call.arguments)?.prompt;
		return typeof prompt === "string" ? prompt : undefined;
	}

	#reply(messageId: string): AssistantEntry {
		let reply = this.#replies.get(messageId);
		if (reply === undefined) {
			reply = { kind: "assistant", text: "", reasoning: "" };
			this.#replies.set(messageId, reply);
			this.#add(reply);
		}
		return reply;
	}

	#tool(toolCallId: string): ToolEntry {
		const call = this.#tools.get(toolCallId);
		if (call === undefined) {
			throw new Error(`没有见过的工具调用有了输出或结果：${toolCallId}`);
		}
		return call;
	}
}
