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
	ToolDeclaration,
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

/** 记忆引用的一个文件和写入时的内容哈希；路径是绝对路径，runtime 在 agent 沙盒里核对。 */
export interface MemoryReference {
	path: string;
	sha256: string;
}

/** 记忆索引里的一条。 */
export interface MemoryIndexEntry {
	id: string;
	/** 记忆的版本号：内容或状态变了就变。 */
	version: number;
	/** 给模型看的一行：编号、范围、类型、标题和来源。 */
	line: string;
	references: MemoryReference[];
}

/** 生效记忆的索引：自动放进上下文的只有它，正文由模型按需读取。 */
export interface MemoryIndex {
	entries: MemoryIndexEntry[];
	/** 超出长度上限、没有列出的条数。 */
	omitted: number;
}

/**
 * 长期记忆的配置。`write` 和 `retrieval` 是评测用的选项，只能由 Host SDK 的调用方在创建 session
 * 时给出：写入策略是只记用户明确要求的（`explicit`）、加上模型提议（`propose`）还是再加上后台提取
 * （`extract`）；记忆注入方式是只给索引、只给检索工具、两者都给，还是每个 task 开始时自动注入
 * 检索到的前几条正文（`auto`）。
 */
export interface MemoryConfig {
	write: "explicit" | "propose" | "extract";
	retrieval: "index" | "tools" | "both" | "auto";
	/** 生效记忆的索引；注入方式不给索引时没有。 */
	index?: MemoryIndex;
}

/** 启用的一个 skill：模型按名字用 `skill_load` 加载它的完整内容。 */
export interface SkillInfo {
	name: string;
	description: string;
	/** skill 目录的绝对路径，agent 沙盒里可读：附带的脚本和文件相对它。 */
	directory: string;
}

/**
 * Host 交来的一个 MCP 工具：名字带 Host 分配的标签前缀（`<标签>__<工具名>`），经 `tool_call/run`
 * 由 Host 执行。只读、可重复、可并发三项由 Host 决定，不采信 server 的标注。
 */
export interface McpToolInfo {
	declaration: ToolDeclaration;
	read_only: boolean;
	idempotent: boolean;
	concurrent: boolean;
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
	/** 长期记忆；这个 session 不用记忆时没有。 */
	memory?: MemoryConfig;
	/** 启用的 skills；有它们时 `tools` 里有 `skill_load`。 */
	skills?: SkillInfo[];
	/** 启用的 MCP 工具，接在 `tools` 之后。 */
	mcp_tools?: McpToolInfo[];
	/** 这个 session 配了"任务结束时"的 hooks：模型给出最终回复后先经 `hooks/run` 运行它们。 */
	stop_hooks?: boolean;
	/** 这个 session 配了"上下文压缩前"的 hooks：压缩之前先经 `hooks/run` 运行它们。 */
	pre_compact_hooks?: boolean;
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
	/** 记忆变了之后的配置，带新的索引：和已经告诉模型的比较，差别在下一个 task 开始时追加。 */
	memory?: MemoryConfig;
	/** 启用的 skills 变了之后的完整列表：和已经告诉模型的比较，有差别时追加一条替换说明。 */
	skills?: SkillInfo[];
	/** MCP 工具变了之后的完整列表：从下一次模型请求起生效。 */
	mcp_tools?: McpToolInfo[];
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
	/**
	 * Host 给放这次输入的那条 user 消息分配的编号，runtime 照用：Host 把它记在 `task.started` 里，
	 * 按事件脱敏靠它找到输入在消息里的那一份。压缩的 task 没有输入，不带。
	 */
	message_id?: string;
	/** `compact` 是用户发起的压缩：输入为空，runtime 只压缩上下文，压缩完报告 task 结束。 */
	kind?: "compact";
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

/**
 * `model/count_tokens` 的参数：要数的请求，和 `model/request` 的 `request` 相同，Host 用和真实请求
 * 相同的原文调用模型服务的计数接口。
 */
export interface ModelCountTokensParams {
	request: ModelRequestParams["request"];
}

/** `model/count_tokens` 的响应：这次请求的输入 token 数；计数接口出错时是错误，类别和模型请求的相同。 */
export type ModelCountTokensResult =
	| { input_tokens: number }
	| { error: ModelErrorInfo };

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

/**
 * `tool_call/complete` 的响应。Host 保存结果时运行工具调用前后的 hooks；它们补充了信息时带上
 * 补充之后的结果，交给模型的是这一份，不是 runtime 提交的那一份。
 */
export interface ToolCallCompleteResult {
	result?: ToolResult;
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
 *
 * 内容里可以带 `redacted: true`：Host 定义的可选标记，表示这个事件被按事件脱敏覆盖过，结构不变，
 * 内容换成了占位。重建历史时据此作废之后的推理块和被覆盖的压缩（见 `rebuildState`）。
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

/** `memory/search` 的参数。 */
export interface MemorySearchParams {
	query: string;
	/**
	 * 发起检索的那次 `memory_search` 调用。Host 记进 `memory.retrieved`：按事件脱敏时查询随调用的
	 * 参数一起覆盖。task 开始时自动注入的检索没有工具调用，不带。
	 */
	tool_call_id?: string;
}

/** 检索或读取返回的一条生效的记忆。 */
export interface MemoryEntry {
	id: string;
	scope: "project" | "user";
	kind: "fact" | "preference" | "decision" | "lesson";
	title: string;
	body: string;
	/** 来源的说明：内容来自谁，引用了哪些文件。 */
	source: string;
	references: MemoryReference[];
}

/** `memory/search` 的响应：命中的记忆，最相关的在前。 */
export interface MemorySearchResult {
	memories: MemoryEntry[];
}

/** `memory/read` 的参数。 */
export interface MemoryReadParams {
	id: string;
	/** 发起读取的那次 `memory_read` 调用，Host 记进 `memory.retrieved`。 */
	tool_call_id: string;
}

/** `memory/read` 的响应：没有这条记忆，或者它不是生效的，为空。 */
export interface MemoryReadResult {
	memory: MemoryEntry | null;
}

/** `memory/propose` 的参数：一条候选，用户确认后才生效。 */
export interface MemoryProposeParams {
	scope: "project" | "user";
	kind: "fact" | "preference" | "decision" | "lesson";
	title: string;
	body: string;
	/** 这条候选要取代的现有记忆：确认后成为它的新版本。 */
	replaces?: string;
	/** 引用的文件：绝对路径，和 runtime 在 agent 沙盒里算出的内容哈希。 */
	files: { path: string; line?: number; sha256: string }[];
}

/** `memory/propose` 的响应：记下的候选的编号，或者没有记下的原因（交给模型）。 */
export type MemoryProposeResult =
	| { recorded: true; id: string }
	| { recorded: false; reason: string };

/** `skill/load` 的参数：`skill_load` 登记获准之后取这个 skill 的完整内容。 */
export interface SkillLoadParams {
	/** skill 的名字，和启用的 skills 列表里的一致。 */
	name: string;
}

/**
 * `skill/load` 的响应：Host 核对过内容哈希的 skill 正文，已经包上名字和目录；没有这个 skill，
 * 或者内容和确认过的不一致时是交给模型的原因。
 */
export type SkillLoadResult =
	| { loaded: true; content: string }
	| { loaded: false; reason: string };

/**
 * `hooks/run` 的参数：runtime 一侧才知道时机的两种 hooks。`Stop` 在模型给出最终回复、task 结束
 * 之前；`PreCompact` 在压缩上下文之前。`message_id` 是 hooks 的输出交给模型时 runtime 放它的那条
 * user 消息的编号（`Stop` 是让模型接着做的那条，`PreCompact` 是要模型写摘要的那条），运行之前就
 * 定下：Host 把它记进 `hooks.ran`，按事件脱敏靠它对上两份内容。hooks 没有要交给模型的内容时
 * 不会有这条消息。
 */
export type HooksRunParams =
	| {
			event: "Stop";
			message_id: string;
			/** 模型最后一条回复的文字。 */
			last_assistant_message: string;
			/** 这个 task 里 `Stop` hooks 已经让模型接着做了几轮。 */
			continuation_count: number;
	  }
	| { event: "PreCompact"; message_id: string; trigger: "manual" | "auto" };

/**
 * `hooks/run` 的响应。`blocked` 为真时：`Stop` 表示再跑一轮，`reason` 作为提示交给模型；
 * `PreCompact` 表示这次不压缩。`additional_context` 是 hooks 补充给模型的信息。
 */
export interface HooksRunResult {
	blocked: boolean;
	reason?: string;
	additional_context?: string;
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
	"model/count_tokens": {
		params: ModelCountTokensParams;
		result: ModelCountTokensResult;
		stream: never;
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
		result: ToolCallCompleteResult;
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
	"memory/search": {
		params: MemorySearchParams;
		result: MemorySearchResult;
		stream: never;
	};
	"memory/read": {
		params: MemoryReadParams;
		result: MemoryReadResult;
		stream: never;
	};
	"memory/propose": {
		params: MemoryProposeParams;
		result: MemoryProposeResult;
		stream: never;
	};
	"skill/load": {
		params: SkillLoadParams;
		result: SkillLoadResult;
		stream: never;
	};
	"hooks/run": {
		params: HooksRunParams;
		result: HooksRunResult;
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
