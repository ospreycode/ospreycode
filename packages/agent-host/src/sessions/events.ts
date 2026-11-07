import type { RawPart } from "@ospreycode/api";
import type { Usage, UserContent } from "@ospreycode/api/protocol";
import type {
	ApprovalAnswer,
	NetworkRequest,
	PermissionRequest,
} from "@ospreycode/sandbox";
import type { BudgetLimit } from "./budget.js";

/** Host 写入 session 记录的 task、批准、进程和协议原文事件的格式版本，写进这些事件的 `version`。 */
export const recordFormatVersion = 1;

/** task 的来源：session 空闲时的用户输入、follow-up、后台命令的通知。 */
export type TaskSource = "user" | "follow_up" | "notification";

/**
 * task 结束的结果。`refused` 是模型拒绝回答；除 `completed` 外，follow-up 列表都暂停。
 */
export type TaskOutcome =
	| "completed"
	| "failed"
	| "budget_exceeded"
	| "cancelled"
	| "refused";

/** `task.started` 的内容。 */
export interface TaskStarted {
	source: TaskSource;
	/** 开始这个 task 的输入。 */
	input: UserContent[];
}

/** `task.ended` 的内容。 */
export interface TaskEnded {
	outcome: TaskOutcome;
	/** 这个 task 所有 run 的用量合计。 */
	usage: Usage;
	/** `failed` 时的原因。 */
	error?: string;
	/** `budget_exceeded` 时超出的是哪一项。 */
	limit?: BudgetLimit;
}

/**
 * `approval.requested` 的内容：交给前端回答的权限询问。`request_id` 是前端回答时引用的编号，
 * `reasons` 列出要问的原因。
 */
export type ApprovalRequested =
	| {
			request_id: string;
			kind: "tool_call";
			tool_call_id: string;
			request: PermissionRequest;
			reasons: string[];
	  }
	| {
			request_id: string;
			kind: "network";
			/** 正好一个工具调用在运行时才记到它名下。 */
			tool_call_id?: string;
			request: NetworkRequest;
			reasons: string[];
	  }
	| {
			request_id: string;
			/** 超出了这个 run 的上限：批准就追加一份和初始上限相同的额度，拒绝就结束 task。 */
			kind: "budget";
			limit: BudgetLimit;
			/** 当前的上限和已用的量：美元、次数或毫秒。 */
			max: number;
			used: number;
	  };

/**
 * `approval.decided` 的内容。`denied_by_policy` 是没有询问用户、按审批策略拒绝的，
 * 包括切换审批策略后不该再问的挂起询问。
 */
export interface ApprovalDecided {
	request_id: string;
	decision: "approved" | "denied" | "denied_by_policy";
	/** 用户的回答；按策略拒绝时为空。 */
	answer?: ApprovalAnswer;
}

/** Host 启动的进程的种类。 */
export type ProcessKind =
	| "agent"
	| "helper"
	| "command"
	| "escalated"
	| "apply_edits"
	| "hook"
	| "mcp_server";

/** `process.started` 的内容。 */
export interface ProcessStarted {
	kind: ProcessKind;
	pid: number;
}

/** `process.exited` 的内容。 */
export interface ProcessExited {
	kind: ProcessKind;
	pid: number;
	exit_code: number | null;
	signal: string | null;
}

/**
 * `protocol.raw` 的内容：一次请求的系统指令、工具声明或一条消息在目标协议里的原文，按片段保存
 * （每段是一个 JSON 值的原文）。同一协议、服务和 API 版本上继续对话时按它原样重放；存原文而不存
 * 解析后的对象，JSON 往返会改变键的顺序和数字的写法。不发给前端。
 */
export type ProtocolRaw = RawPart;
