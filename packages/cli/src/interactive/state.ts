import type {
	ApprovalDecided,
	BackgroundEnded,
	HostEvent,
	InputQueueSnapshot,
	SessionConfig,
	SessionEndReason,
	TaskEndedEvent,
	TaskSource,
} from "@ospreycode/agent-host";
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
	/** 流式输出的末尾一段。 */
	output: string;
	result?: ToolResult;
	durationMs?: number;
}

/** 一次询问和它的结果。 */
export interface ApprovalEntry {
	kind: "approval";
	request: ApprovalEvent;
	decided?: ApprovalDecided;
}

/** 一行说明：设置的变化、后台命令、警告和错误。 */
export interface NoticeEntry {
	kind: "notice";
	level: "info" | "warning" | "error";
	text: string;
}

/** task 的结果、用量和费用。 */
export interface TaskEndedEntry {
	kind: "task_ended";
	event: TaskEndedEvent;
}

/** 对话区的一项，按时间排列。 */
export type Entry =
	| UserEntry
	| AssistantEntry
	| ToolEntry
	| ApprovalEntry
	| NoticeEntry
	| TaskEndedEntry;

/** 状态行上的内容。 */
export interface Status {
	model: string;
	reasoningEffort: ReasoningEffort;
	sandboxMode: string;
	approvalPolicy: string;
	workspace: string;
}

/** 流式输出只留末尾这么多字符：界面只显示最后几行。 */
const outputLimit = 16_000;

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
	/** 进行中的 task；空闲时为空。 */
	taskId: string | undefined;
	/** session 已经关闭时的原因。 */
	ended: SessionEndReason | undefined;
	#showReasoning: boolean;
	readonly #changed = new Set<Entry>();
	readonly #replies = new Map<string, AssistantEntry>();
	readonly #tools = new Map<string, ToolEntry>();
	readonly #asked = new Map<string, ApprovalEntry>();
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

	/** 在对话区加一行说明。 */
	notice(text: string, level: NoticeEntry["level"] = "info"): void {
		this.#add({ kind: "notice", level, text });
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

	/** 按一个事件更新状态。 */
	apply(event: HostEvent): void {
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
				this.#failure = undefined;
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
			case "task.ended":
				if (this.taskId === event.task_id) this.taskId = undefined;
				this.#failure = event.error;
				this.#add({ kind: "task_ended", event });
				break;
			case "model.delta": {
				const delta = event.event;
				if (delta.type === "text_delta") {
					const reply = this.#reply(event.message_id);
					reply.text += delta.text;
					this.#changed.add(reply);
				} else if (delta.type === "reasoning_delta" && this.#showReasoning) {
					const reply = this.#reply(event.message_id);
					reply.reasoning += delta.text;
					this.#changed.add(reply);
				}
				break;
			}
			case "message.completed": {
				const { message } = event;
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
				if (text === "" && reasoning === "" && !streamed) break;
				const reply = this.#reply(message.message_id);
				reply.text = text;
				reply.reasoning = reasoning;
				this.#changed.add(reply);
				this.#replies.delete(message.message_id);
				break;
			}
			case "tool_call.started": {
				const call: ToolEntry = {
					kind: "tool",
					name: event.name,
					arguments: event.arguments,
					output: "",
				};
				this.#tools.set(event.tool_call_id, call);
				this.#add(call);
				break;
			}
			case "tool_call.output": {
				const call = this.#tool(event.tool_call_id);
				call.output = (call.output + event.text).slice(-outputLimit);
				this.#changed.add(call);
				break;
			}
			case "tool_call.completed": {
				const call = this.#tool(event.tool_call_id);
				call.result = event.result;
				call.durationMs = event.duration_ms;
				this.#changed.add(call);
				break;
			}
			case "approval.requested": {
				const asked: ApprovalEntry = { kind: "approval", request: event };
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
				this.notice(`后台通知：${event.text}`);
				break;
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
			case "run.started":
			case "process.exited":
			case "background.delivered":
				break;
		}
	}

	#add(entry: Entry): void {
		this.entries.push(entry);
		this.#changed.add(entry);
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
