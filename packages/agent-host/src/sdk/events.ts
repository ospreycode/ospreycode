import type {
	InputContent,
	ToolCallCompleted,
	ToolCallStarted,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	StreamEvent,
	Usage,
} from "@ospreycode/api/protocol";
import type { BudgetLimit } from "../sessions/budget.js";
import type {
	ApprovalDecided,
	ApprovalPolicyChanged,
	ApprovalRequested,
	BackgroundEnded,
	BackgroundNotified,
	BackgroundStarted,
	ModelChanged,
	ProcessExited,
	ProcessStarted,
	ReasoningEffortChanged,
	SandboxModeChanged,
	TaskOutcome,
	TaskSource,
} from "../sessions/events.js";
import type {
	BackgroundDelivered,
	FollowUpPaused,
	InputDequeued,
	InputInsertedRecord,
	InputQueued,
} from "../sessions/inputs.js";

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
	user_id: string;
	project_id: string;
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
	input: InputContent[];
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
	/** `budget_exceeded` 时超出的是哪一项。 */
	limit?: BudgetLimit;
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

/** `input.queued`：一条 steering 或 follow-up 排进了队列，带变化后的完整队列。 */
export interface InputQueuedEvent
	extends EventBase,
		TaskScope,
		Stored,
		InputQueued {
	type: "input.queued";
}

/** `input.inserted`：steering 插进了这个 task，跟在 `after_tool_call_id` 的结果后面。 */
export interface InputInsertedEvent
	extends EventBase,
		TaskScope,
		Stored,
		InputInsertedRecord {
	type: "input.inserted";
}

/**
 * `input.dequeued`：输入没有交给模型就离开了队列。`reason` 为 `task_ended` 时是 task 结束时还没
 * 插入的 steering，前端把它放回输入框。
 */
export interface InputDequeuedEvent
	extends EventBase,
		TaskScope,
		Stored,
		InputDequeued {
	type: "input.dequeued";
}

/** `input.follow_up_paused`：follow-up 列表暂停或继续。 */
export interface FollowUpPausedEvent
	extends EventBase,
		TaskScope,
		Stored,
		FollowUpPaused {
	type: "input.follow_up_paused";
}

/** `model.changed`：从这个 task 的下一次模型请求起换了模型。 */
export interface ModelChangedEvent
	extends EventBase,
		TaskScope,
		Stored,
		ModelChanged {
	type: "model.changed";
}

/** `reasoning_effort.changed`：从这个 task 的下一次模型请求起换了推理强度。 */
export interface ReasoningEffortChangedEvent
	extends EventBase,
		TaskScope,
		Stored,
		ReasoningEffortChanged {
	type: "reasoning_effort.changed";
}

/** `background.started`：一条命令转入后台或监视开始。`task_id` 是启动它的 task。 */
export interface BackgroundStartedEvent
	extends EventBase,
		TaskScope,
		Stored,
		BackgroundStarted {
	type: "background.started";
}

/** `background.ended`：后台命令结束。`task_id` 是当时进行中的 task，session 空闲时是最近的一个。 */
export interface BackgroundEndedEvent
	extends EventBase,
		TaskScope,
		Stored,
		BackgroundEnded {
	type: "background.ended";
}

/** `background.notification`：后台命令产生了一条通知。`task_id` 的含义同 `background.ended`。 */
export interface BackgroundNotificationEvent
	extends EventBase,
		TaskScope,
		Stored,
		BackgroundNotified {
	type: "background.notification";
}

/** `background.delivered`：这些通知交给了这个 task 的模型（插进进行中的 task，或者开始了唤醒的 task）。 */
export interface BackgroundDeliveredEvent
	extends EventBase,
		TaskScope,
		Stored,
		BackgroundDelivered {
	type: "background.delivered";
}

/**
 * `process.started`：Host 启动了一个随 session 存在的进程，按 `kind` 区分：agent 进程（`agent`，
 * 重启时进程更替只记它）和沙盒的两个辅助进程（`helper`）。不属于任何 task，只带 `run_id`。
 */
export interface ProcessStartedEvent extends EventBase, Stored, ProcessStarted {
	type: "process.started";
	run_id: string;
}

/** `process.exited`：Host 启动的进程退出了，带退出码或信号。 */
export interface ProcessExitedEvent extends EventBase, Stored, ProcessExited {
	type: "process.exited";
	run_id: string;
}

/** `sandbox_mode.changed`：沙盒模式换了，agent 进程已经按新模式重启。不属于任何 task。 */
export interface SandboxModeChangedEvent
	extends EventBase,
		Stored,
		SandboxModeChanged {
	type: "sandbox_mode.changed";
	run_id: string;
}

/**
 * `approval_policy.changed`：用户在会话中切换了审批策略，之后的判断按新的策略；挂起的询问在新策略下
 * 不该再问的已经答为 `denied_by_policy`。不属于任何 task。
 */
export interface ApprovalPolicyChangedEvent
	extends EventBase,
		Stored,
		ApprovalPolicyChanged {
	type: "approval_policy.changed";
	run_id: string;
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
	| InputQueuedEvent
	| InputInsertedEvent
	| InputDequeuedEvent
	| FollowUpPausedEvent
	| ModelChangedEvent
	| ReasoningEffortChangedEvent
	| BackgroundStartedEvent
	| BackgroundEndedEvent
	| BackgroundNotificationEvent
	| BackgroundDeliveredEvent
	| ProcessStartedEvent
	| ProcessExitedEvent
	| SandboxModeChangedEvent
	| ApprovalPolicyChangedEvent
	| WarningEvent
	| ErrorEvent
	| ModelDeltaEvent
	| ToolCallOutputEvent;
