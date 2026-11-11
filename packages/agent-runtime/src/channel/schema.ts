import type * as Api from "@ospreycode/api/protocol";
import Type, { type Static, type TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type * as Contracts from "../contracts/index.js";
import { ProtocolError } from "./errors.js";
import type { MessageValidator } from "./peer.js";
import type * as Protocol from "./protocol.js";

// 这里的 schema 和 api、contracts、protocol 里手写的类型逐个对应，下面的 sameType 在编译时核对两边一致。

const closed = { additionalProperties: false } as const;
const Count = Type.Integer({ minimum: 0 });
const Id = Type.String();

const ProtocolName = Type.Union([
	Type.Literal("openai.chat"),
	Type.Literal("openai.responses"),
	Type.Literal("anthropic.messages"),
]);

const ReasoningEffort = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const Origin = Type.Object(
	{ protocol: ProtocolName, service: Type.String(), model: Type.String() },
	closed,
);

const TextBlock = Type.Object(
	{
		type: Type.Literal("text"),
		text: Type.String(),
		phase: Type.Optional(Type.String()),
	},
	closed,
);

const ImageBlock = Type.Object(
	{
		type: Type.Literal("image"),
		media_type: Type.Union([
			Type.Literal("image/png"),
			Type.Literal("image/jpeg"),
			Type.Literal("image/gif"),
			Type.Literal("image/webp"),
		]),
		data: Type.String(),
	},
	closed,
);

const ToolCallBlock = Type.Object(
	{
		type: Type.Literal("tool_call"),
		call_id: Type.String(),
		name: Type.String(),
		arguments: Type.String(),
	},
	closed,
);

const ReasoningBlock = Type.Object(
	{
		type: Type.Literal("reasoning"),
		text: Type.String(),
		redacted: Type.Boolean(),
		opaque: Type.Optional(Type.String()),
		item_id: Type.Optional(Type.String()),
		origin: Origin,
	},
	closed,
);

const FallbackBlock = Type.Object(
	{
		type: Type.Literal("fallback"),
		from: Type.String(),
		to: Type.String(),
		origin: Origin,
	},
	closed,
);

const UserContent = Type.Union([TextBlock, ImageBlock]);

const InputContent = Type.Union([
	TextBlock,
	ImageBlock,
	Type.Object({ type: Type.Literal("mention"), path: Type.String() }, closed),
	Type.Object(
		{ type: Type.Literal("image_ref"), sha256: Type.String(), bytes: Count },
		closed,
	),
]);

const Usage = Type.Object(
	{
		input: Count,
		output: Count,
		cache_read: Count,
		cache_write: Count,
		reasoning: Count,
		cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
	},
	closed,
);

const StopReason = Type.Union([
	Type.Literal("end_turn"),
	Type.Literal("tool_use"),
	Type.Literal("max_tokens"),
	Type.Literal("context_window_exceeded"),
	Type.Literal("pause_turn"),
	Type.Literal("refusal"),
	Type.Literal("error"),
	Type.Literal("cancelled"),
]);

const RefusalDetails = Type.Object(
	{
		category: Type.String(),
		explanation: Type.Optional(Type.String()),
		recommended_model: Type.Optional(Type.String()),
	},
	closed,
);

const SystemMessage = Type.Object(
	{
		role: Type.Literal("system"),
		message_id: Id,
		content: Type.Array(TextBlock),
	},
	closed,
);

const UserMessage = Type.Object(
	{
		role: Type.Literal("user"),
		message_id: Id,
		content: Type.Array(UserContent),
	},
	closed,
);

const AssistantMessage = Type.Object(
	{
		role: Type.Literal("assistant"),
		message_id: Id,
		content: Type.Array(
			Type.Union([TextBlock, ReasoningBlock, ToolCallBlock, FallbackBlock]),
		),
		protocol: ProtocolName,
		service: Type.String(),
		requested_model: Type.String(),
		model: Type.String(),
		reasoning_effort: ReasoningEffort,
		reasoning_effort_sent: Type.Optional(Type.String()),
		stop_reason: StopReason,
		refusal: Type.Optional(RefusalDetails),
		usage: Usage,
	},
	closed,
);

const ToolResultMessage = Type.Object(
	{
		role: Type.Literal("tool_result"),
		message_id: Id,
		call_id: Type.String(),
		tool_call_id: Type.Optional(Id),
		content: Type.Array(UserContent),
		is_error: Type.Boolean(),
	},
	closed,
);

const Message = Type.Union([
	SystemMessage,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
]);

const RequestContent = Type.Array(
	Type.Union([
		TextBlock,
		Type.Object(
			{ type: Type.Literal("sent_image"), sha256: Type.String() },
			closed,
		),
	]),
);

const RequestMessage = Type.Union([
	SystemMessage,
	Type.Object(
		{ role: Type.Literal("user"), message_id: Id, content: RequestContent },
		closed,
	),
	AssistantMessage,
	Type.Object(
		{
			role: Type.Literal("tool_result"),
			message_id: Id,
			call_id: Type.String(),
			tool_call_id: Type.Optional(Id),
			content: RequestContent,
			is_error: Type.Boolean(),
		},
		closed,
	),
]);

const ToolDeclaration = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
		parameters: Type.Record(Type.String(), Type.Unknown()),
	},
	closed,
);

const ModelRequest = Type.Object(
	{
		model: Type.String(),
		reasoning_effort: ReasoningEffort,
		reasoning_budget: Type.Optional(Count),
		max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
		sampling: Type.Optional(
			Type.Object(
				{
					temperature: Type.Optional(Type.Number()),
					top_p: Type.Optional(Type.Number()),
					top_k: Type.Optional(Type.Integer()),
				},
				closed,
			),
		),
		tool_choice: Type.Union([Type.Literal("auto"), Type.Literal("none")]),
		cache_retention: Type.Union([
			Type.Literal("none"),
			Type.Literal("short"),
			Type.Literal("long"),
		]),
		messages: Type.Array(RequestMessage),
		tools: Type.Array(ToolDeclaration),
		metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	closed,
);

const SandboxSummary = Type.Object(
	{
		mode: Type.String(),
		writable_roots: Type.Array(Type.String()),
		network: Type.Union([
			Type.Literal("denied"),
			Type.Literal("proxy"),
			Type.Literal("unrestricted"),
		]),
	},
	closed,
);

const ShellOutcome = Type.Object(
	{
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		signal: Type.Union([Type.String(), Type.Null()]),
		output_path: Type.String(),
		output_bytes: Count,
		sandbox: SandboxSummary,
	},
	closed,
);

const Content = Type.Array(UserContent);

const ToolResult = Type.Union([
	Type.Object(
		{
			status: Type.Literal("succeeded"),
			content: Content,
			shell: Type.Optional(ShellOutcome),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("failed"),
			content: Content,
			reason: Type.Optional(Type.String()),
			shell: Type.Optional(ShellOutcome),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("running"),
			content: Content,
			background_id: Id,
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("timed_out"),
			content: Content,
			shell: Type.Optional(ShellOutcome),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("cancelled"), content: Content }, closed),
	Type.Object(
		{ status: Type.Literal("interrupted"), content: Content },
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("denied"),
			content: Content,
			reason: Type.Literal("policy"),
			categories: Type.Array(
				Type.Union([
					Type.Literal("dangerous_command"),
					Type.Literal("sandbox_approval"),
					Type.Literal("rules"),
					Type.Literal("request_permissions"),
					Type.Literal("skill_approval"),
					Type.Literal("mcp_elicitations"),
					Type.Literal("mcp_tools"),
					Type.Literal("network"),
				]),
			),
			message: Type.Optional(Type.String()),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("denied"),
			content: Content,
			reason: Type.Union([
				Type.Literal("user"),
				Type.Literal("hook"),
				Type.Literal("forbidden_rule"),
			]),
			message: Type.Optional(Type.String()),
		},
		closed,
	),
]);

const BlockRef = Type.Object({ message_id: Id, index: Count }, closed);

const Invalidation = Type.Object(
	{
		blocks: Type.Array(BlockRef),
		reason: Type.Union([
			Type.Literal("refusal"),
			Type.Literal("fallback"),
			Type.Literal("reasoning_prefix_mismatch"),
			Type.Literal("stream_error"),
		]),
	},
	closed,
);

const InstructionSection = Type.Object(
	{ name: Type.String(), text: Type.String() },
	closed,
);

const RecordedRuleFile = Type.Object(
	{
		path: Type.String(),
		source: Type.Union([Type.Literal("user"), Type.Literal("repository")]),
		sha256: Type.String(),
		bytes: Count,
		included: Type.Boolean(),
	},
	closed,
);

const RecordedInstructions = Type.Object(
	{
		sections: Type.Array(InstructionSection),
		rule_files: Type.Array(RecordedRuleFile),
		memory: Type.Optional(
			Type.Array(Type.Object({ id: Id, version: Count }, closed)),
		),
		skills: Type.Optional(
			Type.Array(
				Type.Object(
					{
						name: Type.String(),
						description: Type.String(),
						directory: Type.String(),
					},
					closed,
				),
			),
		),
	},
	closed,
);

const ContextCompacted = Type.Object(
	{
		trigger: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
		tokens_before: Count,
		summary: Type.String(),
		messages: Type.Array(
			Type.Object(
				{
					role: Type.Union([Type.Literal("system"), Type.Literal("user")]),
					message_id: Id,
					content: Type.Array(TextBlock),
				},
				closed,
			),
		),
		loaded_skills: Type.Optional(
			Type.Array(
				Type.Object({ name: Type.String(), content: Type.String() }, closed),
			),
		),
		instructions: RecordedInstructions,
	},
	closed,
);

const RuntimeEvent = Type.Union([
	Type.Object(
		{ type: Type.Literal("blocks.invalidated"), data: Invalidation },
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("instructions.recorded"),
			data: RecordedInstructions,
		},
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("input.inserted"),
			data: Type.Object(
				{
					input_ids: Type.Array(Id, { minItems: 1 }),
					message_id: Id,
					after_tool_call_id: Type.Union([Id, Type.Null()]),
				},
				closed,
			),
		},
		closed,
	),
	Type.Object(
		{ type: Type.Literal("context.compacted"), data: ContextCompacted },
		closed,
	),
]);

const ModelErrorInfo = Type.Object(
	{
		category: Type.Union([
			Type.Literal("authentication"),
			Type.Literal("permission"),
			Type.Literal("billing"),
			Type.Literal("rate_limit"),
			Type.Literal("overloaded"),
			Type.Literal("context_overflow"),
			Type.Literal("request_too_large"),
			Type.Literal("invalid_request"),
			Type.Literal("reasoning_prefix_mismatch"),
			Type.Literal("network"),
		]),
		message: Type.String(),
		retry_after_ms: Type.Optional(Count),
		block: Type.Optional(BlockRef),
	},
	closed,
);

const StreamDelta = Type.Union([
	Type.Object({ type: Type.Literal("start"), model: Type.String() }, closed),
	Type.Object(
		{ type: Type.Literal("text_delta"), index: Count, text: Type.String() },
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("reasoning_delta"),
			index: Count,
			text: Type.String(),
		},
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("tool_call_start"),
			index: Count,
			call_id: Type.String(),
			name: Type.String(),
		},
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("tool_call_delta"),
			index: Count,
			arguments: Type.String(),
		},
		closed,
	),
	Type.Object({ type: Type.Literal("tool_call_end"), index: Count }, closed),
	Type.Object({ type: Type.Literal("usage"), usage: Usage }, closed),
	Type.Object(
		{ type: Type.Literal("invalidate"), invalidation: Invalidation },
		closed,
	),
]);

const StreamEvent = Type.Union([
	...StreamDelta.anyOf,
	Type.Object(
		{
			type: Type.Literal("end"),
			message: AssistantMessage,
			error: Type.Optional(ModelErrorInfo),
		},
		closed,
	),
]);

const ToolCallStarted = Type.Object(
	{
		tool_call_id: Id,
		call_id: Type.String(),
		message_id: Id,
		name: Type.String(),
		arguments: Type.String(),
		executor: Type.Union([Type.Literal("runtime"), Type.Literal("host")]),
		edits: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String(),
						old_sha256: Type.Union([Type.String(), Type.Null()]),
						new_sha256: Type.String(),
					},
					closed,
				),
			),
		),
	},
	closed,
);

const ToolCallCompleted = Type.Object(
	{ tool_call_id: Id, result: ToolResult, duration_ms: Count },
	closed,
);

/**
 * 内部协议和工具调用格式的 schema，供组合别的 schema 使用：Host 的对外事件用它们，
 * 和通道上的检查是同一份。
 */
export const protocolSchemas = {
	textBlock: TextBlock,
	imageBlock: ImageBlock,
	userContent: UserContent,
	/** 用户输入的一段，含 `@` 提及的路径：Host 记进事件的是展开之前的输入。 */
	inputContent: InputContent,
	message: Message,
	assistantMessage: AssistantMessage,
	usage: Usage,
	modelErrorInfo: ModelErrorInfo,
	streamEvent: StreamEvent,
	/** `end` 以外的流式事件：只用于实时显示的增量。 */
	streamDelta: StreamDelta,
	toolResult: ToolResult,
	toolCallStarted: ToolCallStarted,
	toolCallCompleted: ToolCallCompleted,
};

const Empty = Type.Record(Type.String(), Type.Never());

const MemoryScope = Type.Union([Type.Literal("project"), Type.Literal("user")]);

const MemoryKind = Type.Union([
	Type.Literal("fact"),
	Type.Literal("preference"),
	Type.Literal("decision"),
	Type.Literal("lesson"),
]);

const ToolCallFields = {
	call_id: Type.String(),
	message_id: Id,
	name: Type.String(),
	arguments: Type.String(),
};

/** runtime 发给 Host 的请求的参数。 */
const requestParams = {
	initialize: Type.Object({ version: Type.String() }, closed),
	"task/end": Type.Object(
		{
			outcome: Type.Union([
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("cancelled"),
				Type.Literal("refused"),
				Type.Literal("budget_exceeded"),
			]),
			error: Type.Optional(Type.String()),
		},
		closed,
	),
	"model/request": Type.Object(
		{ message_id: Id, request: ModelRequest },
		closed,
	),
	"model/count_tokens": Type.Object({ request: ModelRequest }, closed),
	"tool_call/run": Type.Object(
		{
			...ToolCallFields,
			file_edits: Type.Optional(
				Type.Array(
					Type.Object(
						{
							op: Type.Union([Type.Literal("add"), Type.Literal("update")]),
							path: Type.String(),
							old_sha256: Type.Union([Type.String(), Type.Null()]),
							content: Type.String(),
						},
						closed,
					),
					{ minItems: 1 },
				),
			),
		},
		closed,
	),
	"tool_call/register": Type.Object(
		{
			...ToolCallFields,
			edit: Type.Optional(
				Type.Object(
					{
						path: Type.String(),
						old_sha256: Type.Union([Type.String(), Type.Null()]),
						new_sha256: Type.String(),
					},
					closed,
				),
			),
		},
		closed,
	),
	"tool_call/complete": Type.Object(
		{ tool_call_id: Id, result: ToolResult },
		closed,
	),
	"input/take": Empty,
	"record/read": Type.Object(
		{
			until: Type.Object({ run_id: Id, seq: Count }, closed),
			types: Type.Array(Type.String()),
			offset: Count,
		},
		closed,
	),
	"blob/read": Type.Object({ sha256: Type.String(), offset: Count }, closed),
	"image/put": Type.Object({ image: ImageBlock }, closed),
	"image/read": Type.Object({ sha256: Type.String() }, closed),
	"memory/search": Type.Object(
		{ query: Type.String(), tool_call_id: Type.Optional(Id) },
		closed,
	),
	"memory/read": Type.Object({ id: Id, tool_call_id: Id }, closed),
	"memory/propose": Type.Object(
		{
			scope: MemoryScope,
			kind: MemoryKind,
			title: Type.String(),
			body: Type.String(),
			replaces: Type.Optional(Id),
			files: Type.Array(
				Type.Object(
					{
						path: Type.String(),
						line: Type.Optional(Type.Integer({ minimum: 1 })),
						sha256: Type.String(),
					},
					closed,
				),
			),
		},
		closed,
	),
	"skill/load": Type.Object({ name: Type.String() }, closed),
	"hooks/run": Type.Union([
		Type.Object(
			{
				event: Type.Literal("Stop"),
				message_id: Id,
				last_assistant_message: Type.String(),
				continuation_count: Count,
			},
			closed,
		),
		Type.Object(
			{
				event: Type.Literal("PreCompact"),
				message_id: Id,
				trigger: Type.Union([Type.Literal("manual"), Type.Literal("auto")]),
			},
			closed,
		),
	]),
} satisfies Record<keyof Protocol.RuntimeRequests, TSchema>;

/** runtime 发给 Host 的通知的参数。 */
const notificationParams = {
	"record/append": Type.Object({ event_id: Id, event: RuntimeEvent }, closed),
} satisfies Record<keyof Protocol.RuntimeNotifications, TSchema>;

/** runtime 对 Host 请求的成功响应。 */
const results = {
	"run/cancel": Empty,
	status: Type.Object(
		{
			state: Type.Union([
				Type.Literal("idle"),
				Type.Literal("model"),
				Type.Literal("tools"),
			]),
			tool_call_ids: Type.Array(Id),
		},
		closed,
	),
} satisfies Record<keyof Protocol.HostRequests, TSchema>;

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

function sameType<A, B>(_same: Equal<A, B>): void {}

sameType<Static<typeof Message>, Api.Message>(true);
sameType<Static<typeof InputContent>, Protocol.InputContent>(true);
sameType<Static<typeof RequestMessage>, Protocol.RequestMessage>(true);
sameType<Static<typeof ToolResult>, Contracts.ToolResult>(true);
sameType<Static<typeof RuntimeEvent>, Contracts.RuntimeEvent>(true);
sameType<Static<typeof ModelErrorInfo>, Api.ModelErrorInfo>(true);
sameType<Static<typeof StreamEvent>, Api.StreamEvent>(true);
sameType<Static<typeof StreamDelta>, Exclude<Api.StreamEvent, { type: "end" }>>(
	true,
);
sameType<Static<typeof ToolCallStarted>, Contracts.ToolCallStarted>(true);
sameType<Static<typeof ToolCallCompleted>, Contracts.ToolCallCompleted>(true);
sameType<
	{ [M in keyof typeof requestParams]: Static<(typeof requestParams)[M]> },
	{
		[M in keyof Protocol.RuntimeRequests]: Protocol.RuntimeRequests[M]["params"];
	}
>(true);
sameType<
	{
		[M in keyof typeof notificationParams]: Static<
			(typeof notificationParams)[M]
		>;
	},
	Protocol.RuntimeNotifications
>(true);
sameType<
	{ [M in keyof typeof results]: Static<(typeof results)[M]> },
	{ [M in keyof Protocol.HostRequests]: Protocol.HostRequests[M]["result"] }
>(true);

function compileAll(schemas: Record<string, TSchema>): Map<string, Validator> {
	return new Map(
		Object.entries(schemas).map(([method, schema]) => [
			method,
			Compile(schema),
		]),
	);
}

function check(
	validators: Map<string, Validator>,
	kind: string,
	method: string,
	value: unknown,
): void {
	const validator = validators.get(method);
	if (validator === undefined) {
		throw new ProtocolError(`未知的${kind}：${method}`);
	}
	if (validator.Check(value)) return;
	// 只报位置和规则，不回显内容：消息里可能有从文件读到的密钥
	const [first] = validator.Errors(value);
	throw new ProtocolError(
		`${kind} ${method} 不符合 schema：${first?.instancePath || "/"} ${first?.message ?? ""}`,
	);
}

/** Host 一侧检查 runtime 发来的每条消息。 */
export function createRuntimeMessageValidator(): MessageValidator {
	const requests = compileAll(requestParams);
	const notifications = compileAll(notificationParams);
	const responses = compileAll(results);
	return {
		request: (method, params) => check(requests, "请求", method, params),
		notification: (method, params) =>
			check(notifications, "通知", method, params),
		result: (method, result) => check(responses, "响应", method, result),
	};
}
