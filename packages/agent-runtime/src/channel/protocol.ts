import type {
	AssistantMessage,
	ModelErrorInfo,
	ModelRequest,
	ReasoningEffort,
	StreamEvent,
	UserContent,
} from "@ospreycode/api/protocol";
import type { RuntimeEvent, ToolResult } from "../contracts/index.js";

/** 审批策略。runtime 只用它写系统指令、提示模型，权限由 Host 执行。 */
export type ApprovalPolicyName = "on-request" | "never" | "granular";

/** runtime 写系统指令和控制长度用到的模型信息，以 Host 的模型清单为准。 */
export interface ModelInfo {
	/** 模型清单里的 ID。 */
	id: string;
	reasoning_effort: ReasoningEffort;
	context_window: number;
	max_output_tokens: number;
}

/** 每个 run 的上限，为空表示不设。loop 自己按它们控制，最终的上限由 Host 执行。 */
export interface RunBudget {
	max_cost_usd: number | null;
	max_requests: number | null;
	max_duration_ms: number | null;
}

/** `initialize` 的参数：agent 进程报告 `agent-runtime` 的包版本，和 Host 依赖的版本不同就停止。 */
export interface InitializeParams {
	version: string;
}

/** `initialize` 的响应：runtime 需要的启动配置。runtime 在沙盒里读不到用户级配置。 */
export interface AgentConfig {
	/** 工作区的真实路径。 */
	workspace: string;
	/** 当前的可写根，含 `TMPDIR`。 */
	writable_roots: string[];
	/** 从哪个位置重建发给模型的历史；新 session 没有。 */
	resume?: { run_id: string; seq: number };
	model: ModelInfo;
	sandbox_mode: string;
	approval_policy: ApprovalPolicyName;
	/** 启用的工具。 */
	tools: string[];
	/** 用户级规则文件的内容；没有时为空。 */
	user_instructions: string | null;
	/** 当前日期，`YYYY-MM-DD`。 */
	date: string;
	/** 操作系统的说明，如 `macOS 26.1 (arm64)`。 */
	os: string;
	budget: RunBudget;
}

/** `config/update` 的参数：只带变化的部分。 */
export interface ConfigUpdate {
	model?: ModelInfo;
	approval_policy?: ApprovalPolicyName;
	tools?: string[];
}

/** `task/start` 的参数：开始新的 task。 */
export interface TaskStartParams {
	input: UserContent[];
}

/** runtime 报告的 task 结果。 */
export type TaskEndOutcome =
	| "completed"
	| "failed"
	| "cancelled"
	| "refused"
	| "budget_exceeded";

/** `task/end` 的参数。 */
export interface TaskEndParams {
	outcome: TaskEndOutcome;
	/** `failed` 时的原因。 */
	error?: string;
}

/** `task/end` 的响应：Host 还有待插入的输入时 `continue` 为真，runtime 取出后接着请求模型。 */
export interface TaskEndResult {
	continue: boolean;
}

/** `status` 的响应：runtime 当前在做什么。 */
export interface StatusResult {
	state: "idle" | "model" | "tools";
	/** 正在执行的工具调用。 */
	tool_call_ids: string[];
}

/** `model/request` 的参数。 */
export interface ModelRequestParams {
	/** runtime 为这次回复生成的消息编号。 */
	message_id: string;
	request: ModelRequest;
}

/** `model/request` 的最终响应：模型出错时 `message` 是已收到的部分，`stop_reason` 为 `error`。 */
export interface ModelRequestResult {
	message: AssistantMessage;
	error?: ModelErrorInfo;
}

/** `model/event`：`model/request` 的流式事件（`end` 以外的事件，`end` 就是最终响应）。 */
export interface ModelEventParams {
	request_id: number;
	event: Exclude<StreamEvent, { type: "end" }>;
}

/** 模型发起的一次工具调用。 */
export interface ToolCallParams {
	/** 模型返回的调用编号。 */
	call_id: string;
	/** 发起调用的 assistant 消息。 */
	message_id: string;
	name: string;
	/** 模型写出的参数原文。 */
	arguments: string;
}

/** `tool_call/started`：`tool_call/run` 的第一条通知，带 Host 分配的编号。 */
export interface ToolCallStartedParams {
	request_id: number;
	tool_call_id: string;
}

/** `tool_call/output`：Host 代为执行的工具产生的输出，只流回上限以内的部分。 */
export interface ToolCallOutputParams {
	request_id: number;
	text: string;
}

/** `tool_call/run` 的最终响应。 */
export interface ToolCallRunResult {
	result: ToolResult;
}

/** `tool_call/register` 的参数：登记 runtime 一侧执行的工具调用。 */
export interface ToolCallRegisterParams extends ToolCallParams {
	/** 编辑工具要改的文件和改动前后的哈希，Host 据此做快照；文件不存在时 `old_sha256` 为空。 */
	edit?: { path: string; old_sha256: string | null; new_sha256: string };
}

/** `tool_call/register` 的响应：分配的编号和决定，被拒绝时带上交给模型的结果。 */
export type ToolCallRegisterResult =
	| { tool_call_id: string; allowed: true }
	| { tool_call_id: string; allowed: false; result: ToolResult };

/** `tool_call/complete` 的参数：提交登记过的调用的结果。 */
export interface ToolCallCompleteParams {
	tool_call_id: string;
	result: ToolResult;
}

/** `record/append` 的参数：上报 runtime 自己的事件。 */
export interface RecordAppendParams {
	/** runtime 生成的事件编号。 */
	event_id: string;
	event: RuntimeEvent;
}

/** `cancel` 的参数：取消自己发出、对方还在处理的请求。 */
export interface CancelParams {
	request_id: number;
}

/** 没有参数或内容的请求和响应。 */
export type Empty = Record<string, never>;

/** 一条带 `request_id` 的流式通知。 */
export interface StreamNotification {
	method: string;
	params: { request_id: number };
}

/** 一种请求：参数、最终响应和它的流式通知。 */
export interface RequestSpec {
	params: object;
	result: unknown;
	stream: StreamNotification;
}

/** runtime 发给 Host 的请求。 */
export interface RuntimeRequests {
	initialize: { params: InitializeParams; result: AgentConfig; stream: never };
	"task/end": { params: TaskEndParams; result: TaskEndResult; stream: never };
	"model/request": {
		params: ModelRequestParams;
		result: ModelRequestResult;
		stream: { method: "model/event"; params: ModelEventParams };
	};
	"tool_call/run": {
		params: ToolCallParams;
		result: ToolCallRunResult;
		stream:
			| { method: "tool_call/started"; params: ToolCallStartedParams }
			| { method: "tool_call/output"; params: ToolCallOutputParams };
	};
	"tool_call/register": {
		params: ToolCallRegisterParams;
		result: ToolCallRegisterResult;
		stream: never;
	};
	"tool_call/complete": {
		params: ToolCallCompleteParams;
		result: Empty;
		stream: never;
	};
}

/** Host 发给 runtime 的请求。 */
export interface HostRequests {
	"run/cancel": { params: Empty; result: Empty; stream: never };
	status: { params: Empty; result: StatusResult; stream: never };
}

/** runtime 发给 Host 的通知（`cancel` 除外）。 */
export interface RuntimeNotifications {
	"record/append": RecordAppendParams;
}

/** Host 发给 runtime 的通知（`cancel` 和流式通知除外）。 */
export interface HostNotifications {
	"config/update": ConfigUpdate;
	"task/start": TaskStartParams;
}

/** Host 发给 runtime 的流式通知的方法名。 */
export const hostStreamMethods = [
	"model/event",
	"tool_call/started",
	"tool_call/output",
] as const;
