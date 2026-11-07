import type {
	ToolCallCompleted,
	ToolCallStarted,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	StreamEvent,
	Usage,
	UserContent,
} from "@ospreycode/api/protocol";
import type {
	ApprovalDecided,
	ApprovalRequested,
	TaskOutcome,
	TaskSource,
} from "../sessions/events.js";

/** 对外事件格式的版本：删除、改名或改变含义时加一，新增事件类型或字段不改。 */
export const eventFormatVersion = 1;

/** 每个事件都带的字段。 */
export interface EventBase {
	session_id: string;
	/** ISO 8601 格式的 UTC 时间。 */
	time: string;
}

/** 属于某个 task 的事件另带的字段。 */
export interface TaskScope {
	task_id: string;
	run_id: string;
	agent_id: string;
}

/** 会存储的事件另带的字段，便于和 session 记录对照。 */
export interface Stored {
	event_id: string;
	/** run 内的序号。 */
	seq: number;
}

/** session 关闭的原因。 */
export type SessionEndReason = "closed" | "agent_exited" | "error";

/** `session.started`：第一条事件。 */
export interface SessionStartedEvent extends EventBase {
	type: "session.started";
	format_version: number;
	host_version: string;
	workspace: string;
	model: string;
	sandbox_mode: string;
	approval_policy: string;
}

/** `session.ended`：任何模式下关闭 session 时都发，带用量合计。 */
export interface SessionEndedEvent extends EventBase {
	type: "session.ended";
	reason: SessionEndReason;
	usage: Usage;
	/** 非交互模式下主任务的结果。 */
	outcome?: TaskOutcome;
	/** 非交互模式下 CLI 的退出码。 */
	exit_code?: number;
}

/** `task.started`。 */
export interface TaskStartedEvent extends EventBase, TaskScope, Stored {
	type: "task.started";
	source: TaskSource;
	input: UserContent[];
}

/** `run.started`：子 agent 的 run 另带父字段。 */
export interface RunStartedEvent extends EventBase, TaskScope, Stored {
	type: "run.started";
	parent_agent_id?: string;
	parent_tool_call_id?: string;
}

/** `task.ended`：每个 task 以它结束，带这个 task 的用量合计。 */
export interface TaskEndedEvent extends EventBase, TaskScope, Stored {
	type: "task.ended";
	outcome: TaskOutcome;
	usage: Usage;
	error?: string;
}

/** `message.completed`：模型的一条回复，带这条回复的用量和费用。 */
export interface MessageCompletedEvent extends EventBase, TaskScope, Stored {
	type: "message.completed";
	message: AssistantMessage;
}

/** `tool_call.started`。 */
export interface ToolCallStartedEvent
	extends EventBase,
		TaskScope,
		Stored,
		ToolCallStarted {
	type: "tool_call.started";
}

/** `tool_call.completed`。 */
export interface ToolCallCompletedEvent
	extends EventBase,
		TaskScope,
		Stored,
		ToolCallCompleted {
	type: "tool_call.completed";
}

/** `approval.requested`：需要前端用 `respond` 回答的请求。 */
export type ApprovalRequestedEvent = EventBase &
	TaskScope &
	Stored &
	ApprovalRequested & { type: "approval.requested" };

/** `approval.decided`。 */
export interface ApprovalDecidedEvent
	extends EventBase,
		TaskScope,
		Stored,
		ApprovalDecided {
	type: "approval.decided";
}

/** `warning`：不影响继续运行的问题。 */
export interface WarningEvent extends EventBase {
	type: "warning";
	message: string;
}

/** `error`：导致 task 或 session 失败的问题。 */
export interface ErrorEvent extends EventBase {
	type: "error";
	message: string;
}

/**
 * session 打开之前就失败（参数或配置错误、`initialize` 超时等）时唯一的一条事件：
 * 还没有 session，所以带 `format_version`、不带 `session_id`。
 */
export interface StartupErrorEvent {
	type: "error";
	format_version: number;
	time: string;
	message: string;
}

/** `model.delta`：模型回复的流式增量，只发给 SDK 的订阅方，不存储，也不写进 CLI 的 JSON 输出。 */
export interface ModelDeltaEvent extends EventBase, TaskScope {
	type: "model.delta";
	message_id: string;
	event: Exclude<StreamEvent, { type: "end" }>;
}

/** `tool_call.output`：Host 代为执行的工具的输出增量，和 `model.delta` 一样只发给 SDK 的订阅方。 */
export interface ToolCallOutputEvent extends EventBase, TaskScope {
	type: "tool_call.output";
	tool_call_id: string;
	text: string;
}

/** Host 发给前端的事件。 */
export type HostEvent =
	| SessionStartedEvent
	| SessionEndedEvent
	| TaskStartedEvent
	| RunStartedEvent
	| TaskEndedEvent
	| MessageCompletedEvent
	| ToolCallStartedEvent
	| ToolCallCompletedEvent
	| ApprovalRequestedEvent
	| ApprovalDecidedEvent
	| WarningEvent
	| ErrorEvent
	| ModelDeltaEvent
	| ToolCallOutputEvent;
