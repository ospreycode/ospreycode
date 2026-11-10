import type {
	AssistantMessage,
	ImageBlock,
	ModelErrorInfo,
	ModelRequest,
	ProtocolName,
	ReasoningEffort,
	StreamEvent,
	SystemMessage,
	TextBlock,
	UserContent,
} from "@ospreycode/api/protocol";
import type { FileEditOp } from "../apply-edits/apply.js";
import type { RuntimeEvent, ToolResult } from "../contracts/index.js";

/** 审批策略。runtime 只用它写系统指令、提示模型，权限由 Host 执行。 */
export type ApprovalPolicyName = "on-request" | "never" | "granular";

/** runtime 写系统指令和控制长度用到的模型信息，以 Host 的模型清单为准。 */
export interface ModelInfo {
	/** 模型清单里的 ID。 */
	id: string;
	/** 模型用的协议：估算图片的 token 和上下文超长的阈值按它定。 */
	protocol: ProtocolName;
	reasoning_effort: ReasoningEffort;
	context_window: number;
	/** 输入的上限；比 `context_window` 小时另外限制输入。 */
	max_input_tokens?: number;
	max_output_tokens: number;
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
	/** 用户级规则文件：Host 读到的路径和内容；没有时为空。 */
	user_instructions: { path: string; content: string } | null;
	/** 当前日期，`YYYY-MM-DD`。 */
	date: string;
	/** 操作系统的说明，如 `macOS 26.1 (arm64)`。 */
	os: string;
}

/** `config/update` 的参数：只带变化的部分。 */
export interface ConfigUpdate {
	model?: ModelInfo;
	approval_policy?: ApprovalPolicyName;
	tools?: string[];
}

/** 用户输入里 `@` 提及的路径，照用户写的原样；相对路径按工作区根解析。 */
export interface MentionBlock {
	type: "mention";
	path: string;
}

/**
 * 用户输入里附带的图片：原始字节由 Host 按引用保存，这里只有它的 SHA-256 和字节数。runtime 在这条
 * 输入进入上下文时用 `blob/read` 取来，在沙盒里解码和缩放。
 */
export interface ImageReference {
	type: "image_ref";
	sha256: string;
	bytes: number;
}

/**
 * 通道上的用户输入：提及的路径和附带的图片由 runtime 在这条输入进入上下文时读取
 * （见 `context/mentions.ts`），Host 不读取仓库里的文件，也不解码图片。
 */
export type InputContent = UserContent | MentionBlock | ImageReference;

/** `task/start` 的参数：开始新的 task。 */
export interface TaskStartParams {
	input: InputContent[];
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

/** Host 交给 runtime、要插进当前 task 的一条输入。 */
export interface PendingInput {
	/** Host 分配的编号，runtime 报告插入位置时带回。 */
	input_id: string;
	/** `steering` 是用户的话；`notification` 是后台命令的通知，Host 已经写好前缀，不是用户的输入。 */
	kind: "steering" | "notification";
	content: InputContent[];
}

/** `input/take` 的响应：待插入的输入，steering 在前、通知在后，各按到达的顺序；取出后 Host 不再保留。 */
export interface InputTakeResult {
	inputs: PendingInput[];
}

/** `status` 的响应：runtime 当前在做什么。 */
export interface StatusResult {
	state: "idle" | "model" | "tools";
	/** 正在执行的工具调用。 */
	tool_call_ids: string[];
}

/**
 * 消息里的一张图片：只带图片字节（base64 解码后）的 SHA-256，图片本身另外单独过通道（`image/put`、
 * `image/read`，或者在工具结果里），每张只过一次。图片留在消息里的话，一条消息带几张大图，或者每次
 * 请求都带上历史里的全部图片，都会超过单条消息的上限。
 */
export interface SentImage {
	type: "sent_image";
	sha256: string;
}

/** 通道上的 user 消息：图片都是引用。 */
export interface RequestUserMessage {
	role: "user";
	message_id: string;
	content: (TextBlock | SentImage)[];
}

/** 通道上的工具结果消息：图片都是引用。 */
export interface RequestToolResultMessage {
	role: "tool_result";
	message_id: string;
	call_id: string;
	tool_call_id?: string;
	content: (TextBlock | SentImage)[];
	is_error: boolean;
}

/**
 * `model/request` 和 `record/read` 读回的 `message.sent` 里的一条消息：内部协议的消息，其中的图片
 * 都换成了引用。
 */
export type RequestMessage =
	| SystemMessage
	| RequestUserMessage
	| AssistantMessage
	| RequestToolResultMessage;

/** `model/request` 的参数。 */
export interface ModelRequestParams {
	/** runtime 为这次回复生成的消息编号。 */
	message_id: string;
	/** 内部协议的模型请求，消息里的图片都是引用：runtime 先用 `image/put` 把 Host 没收到过的交过去。 */
	request: {
		[Key in keyof ModelRequest]: Key extends "messages"
			? RequestMessage[]
			: ModelRequest[Key];
	};
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

/**
 * `tool_call/run` 的参数。编辑工具的目标在可写范围之外时带上 `file_edits`：runtime 组装好的
 * 文件改动申请，Host 询问用户后交给 apply-edits 执行。
 */
export interface ToolCallRunParams extends ToolCallParams {
	file_edits?: FileEditOp[];
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

/** `record/read` 的参数：读会话树上从根到 `until` 这条路径上的事件，一次一页。 */
export interface RecordReadParams {
	until: { run_id: string; seq: number };
	/** 只要这些类型的事件。 */
	types: string[];
	/** 从筛选后的第几个事件开始，第一页为 0。 */
	offset: number;
}

/**
 * session 记录里的一个事件：类型、在会话树上的位置和内容。`message.sent` 的内容是
 * `{message: RequestMessage}`，图片是引用，runtime 用 `image/read` 逐张取回。
 */
export interface RecordedEvent {
	type: string;
	run_id: string;
	seq: number;
	data: unknown;
}

/** `record/read` 的响应：一页事件；后面还有时 `next_offset` 是下一页的起点。 */
export interface RecordReadResult {
	events: RecordedEvent[];
	next_offset?: number;
}

/** `blob/read` 的参数：按 SHA-256 读这个 session 引用过的大内容，一次一页。 */
export interface BlobReadParams {
	sha256: string;
	/** 从第几个字节开始，第一页为 0。 */
	offset: number;
}

/** `blob/read` 的响应：一页内容的 base64；后面还有时 `next_offset` 是下一页的起点。 */
export interface BlobReadResult {
	data: string;
	next_offset?: number;
}

/** `image/put` 的参数：一张 Host 还没有收到过的图片，之后的消息里按它的 SHA-256 引用。 */
export interface ImagePutParams {
	image: ImageBlock;
}

/** `image/read` 的参数：按图片字节的 SHA-256 取一张 Host 收到过的图片。 */
export interface ImageReadParams {
	sha256: string;
}

/** `image/read` 的响应。 */
export interface ImageReadResult {
	image: ImageBlock;
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
		params: ToolCallRunParams;
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
	"input/take": { params: Empty; result: InputTakeResult; stream: never };
	"record/read": {
		params: RecordReadParams;
		result: RecordReadResult;
		stream: never;
	};
	"blob/read": {
		params: BlobReadParams;
		result: BlobReadResult;
		stream: never;
	};
	"image/put": { params: ImagePutParams; result: Empty; stream: never };
	"image/read": {
		params: ImageReadParams;
		result: ImageReadResult;
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
	/** 有 steering 或后台命令的通知等待插入：runtime 在下一次模型请求之前用 `input/take` 取出。 */
	"input/available": Empty;
}

/** Host 发给 runtime 的流式通知的方法名。 */
export const hostStreamMethods = [
	"model/event",
	"tool_call/started",
	"tool_call/output",
] as const;
