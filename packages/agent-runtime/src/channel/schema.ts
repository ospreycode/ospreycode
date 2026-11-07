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

const UserContent = Type.Union([TextBlock, ImageBlock]);

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
		content: Type.Array(Type.Union([TextBlock, ReasoningBlock, ToolCallBlock])),
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
		messages: Type.Array(Message),
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
			reason: Type.Union([
				Type.Literal("policy"),
				Type.Literal("user"),
				Type.Literal("hook"),
				Type.Literal("forbidden_rule"),
			]),
			message: Type.Optional(Type.String()),
		},
		closed,
	),
]);

const Invalidation = Type.Object(
	{
		blocks: Type.Array(Type.Object({ message_id: Id, index: Count }, closed)),
		reason: Type.Union([
			Type.Literal("refusal"),
			Type.Literal("fallback"),
			Type.Literal("reasoning_prefix_mismatch"),
			Type.Literal("stream_error"),
		]),
	},
	closed,
);

const RuntimeEvent = Type.Object(
	{ type: Type.Literal("blocks.invalidated"), data: Invalidation },
	closed,
);

const Empty = Type.Record(Type.String(), Type.Never());

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
	"tool_call/run": Type.Object(ToolCallFields, closed),
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
sameType<Static<typeof ModelRequest>, Api.ModelRequest>(true);
sameType<Static<typeof ToolResult>, Contracts.ToolResult>(true);
sameType<Static<typeof RuntimeEvent>, Contracts.RuntimeEvent>(true);
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
