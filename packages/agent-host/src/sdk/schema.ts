import { protocolSchemas as p } from "@ospreycode/agent-runtime";
import type * as Sandbox from "@ospreycode/sandbox";
import Type, { type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type * as Events from "./events.js";

// 对外事件的 schema：内部协议的消息、流式事件和工具调用事件取 agent-runtime 的同一份 schema，
// 下面的 sameShape 在编译时核对它和 events.ts 里手写的类型一致。

const closed = { additionalProperties: false } as const;
const Paths = Type.Array(Type.String());

const base = { session_id: Type.String(), time: Type.String() };
const scope = {
	task_id: Type.String(),
	run_id: Type.String(),
	agent_id: Type.String(),
};
const stored = { event_id: Type.String(), seq: Type.Integer({ minimum: 1 }) };

const TaskOutcome = Type.Union([
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("budget_exceeded"),
	Type.Literal("cancelled"),
	Type.Literal("refused"),
]);

const FileSystem = Type.Object(
	{ read: Type.Optional(Paths), write: Type.Optional(Paths) },
	closed,
);

const AdditionalPermissions = Type.Object(
	{
		file_system: Type.Optional(FileSystem),
		unix_sockets: Type.Optional(Paths),
		local_binding: Type.Optional(Type.Boolean()),
	},
	closed,
);

const CommandRequest = Type.Object(
	{
		kind: Type.Literal("command"),
		command: Type.String(),
		workdir: Type.String(),
		sandbox_permissions: Type.Union([
			Type.Literal("use_default"),
			Type.Literal("with_additional_permissions"),
			Type.Literal("require_escalated"),
		]),
		additional_permissions: Type.Optional(AdditionalPermissions),
		justification: Type.Optional(Type.String()),
		prefix_rule: Type.Optional(Type.Array(Type.String())),
	},
	closed,
);

const BudgetLimit = Type.Union([
	Type.Literal("cost"),
	Type.Literal("requests"),
	Type.Literal("duration"),
]);

const NetworkRequest = Type.Object(
	{
		kind: Type.Literal("network"),
		host: Type.String(),
		port: Type.Integer(),
		protocol: Type.Union([
			Type.Literal("http"),
			Type.Literal("https"),
			Type.Literal("socks5"),
		]),
	},
	closed,
);

const PermissionRequest = Type.Union([
	CommandRequest,
	Type.Object(
		{
			kind: Type.Literal("file_edits"),
			edits: Type.Array(
				Type.Object(
					{
						op: Type.Union([
							Type.Literal("add"),
							Type.Literal("update"),
							Type.Literal("delete"),
						]),
						path: Type.String(),
						old_sha256: Type.Union([Type.String(), Type.Null()]),
						content: Type.Union([Type.String(), Type.Null()]),
					},
					closed,
				),
			),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("permissions"),
			file_system: Type.Optional(FileSystem),
			network: Type.Optional(Type.Array(Type.String())),
			justification: Type.Optional(Type.String()),
		},
		closed,
	),
	NetworkRequest,
	Type.Object(
		{
			kind: Type.Literal("mcp_tool"),
			server: Type.String(),
			tool: Type.String(),
			arguments: Type.String(),
		},
		closed,
	),
]);

const ApprovalAnswer = Type.Union([
	Type.Object(
		{
			decision: Type.Literal("approve"),
			scope: Type.Union([
				Type.Literal("once"),
				Type.Literal("task"),
				Type.Literal("rule"),
			]),
		},
		closed,
	),
	Type.Object(
		{
			decision: Type.Literal("deny"),
			scope: Type.Union([Type.Literal("once"), Type.Literal("rule")]),
			message: Type.Optional(Type.String()),
		},
		closed,
	),
]);

const event = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, closed);

const SessionStarted = event({
	...base,
	type: Type.Literal("session.started"),
	format_version: Type.Integer(),
	host_version: Type.String(),
	user_id: Type.String(),
	project_id: Type.String(),
	workspace: Type.String(),
	model: Type.String(),
	sandbox_mode: Type.String(),
	approval_policy: Type.String(),
});

const SessionEnded = event({
	...base,
	type: Type.Literal("session.ended"),
	reason: Type.Union([
		Type.Literal("closed"),
		Type.Literal("agent_exited"),
		Type.Literal("error"),
	]),
	usage: p.usage,
	outcome: Type.Optional(TaskOutcome),
	exit_code: Type.Optional(Type.Integer()),
});

const TaskStarted = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("task.started"),
	source: Type.Union([
		Type.Literal("user"),
		Type.Literal("follow_up"),
		Type.Literal("notification"),
	]),
	input: Type.Array(p.userContent),
});

const RunStarted = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("run.started"),
	parent_agent_id: Type.Optional(Type.String()),
	parent_tool_call_id: Type.Optional(Type.String()),
});

const TaskEnded = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("task.ended"),
	outcome: TaskOutcome,
	usage: p.usage,
	error: Type.Optional(Type.String()),
	limit: Type.Optional(BudgetLimit),
});

const MessageCompleted = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("message.completed"),
	message: p.assistantMessage,
});

const ToolCallStarted = event({
	...base,
	...scope,
	...stored,
	...p.toolCallStarted.properties,
	type: Type.Literal("tool_call.started"),
});

const ToolCallCompleted = event({
	...base,
	...scope,
	...stored,
	...p.toolCallCompleted.properties,
	type: Type.Literal("tool_call.completed"),
});

const ApprovalRequested = Type.Union([
	event({
		...base,
		...scope,
		...stored,
		type: Type.Literal("approval.requested"),
		request_id: Type.String(),
		kind: Type.Literal("tool_call"),
		tool_call_id: Type.String(),
		request: PermissionRequest,
		reasons: Type.Array(Type.String()),
	}),
	event({
		...base,
		...scope,
		...stored,
		type: Type.Literal("approval.requested"),
		request_id: Type.String(),
		kind: Type.Literal("network"),
		tool_call_id: Type.Optional(Type.String()),
		request: NetworkRequest,
		reasons: Type.Array(Type.String()),
	}),
	event({
		...base,
		...scope,
		...stored,
		type: Type.Literal("approval.requested"),
		request_id: Type.String(),
		kind: Type.Literal("budget"),
		limit: BudgetLimit,
		max: Type.Number({ minimum: 0 }),
		used: Type.Number({ minimum: 0 }),
	}),
]);

const ApprovalDecided = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("approval.decided"),
	request_id: Type.String(),
	decision: Type.Union([
		Type.Literal("approved"),
		Type.Literal("denied"),
		Type.Literal("denied_by_policy"),
	]),
	answer: Type.Optional(ApprovalAnswer),
});

const Warning = event({
	...base,
	type: Type.Literal("warning"),
	message: Type.String(),
});

const ErrorEvent = event({
	...base,
	type: Type.Literal("error"),
	message: Type.String(),
});

const ModelDelta = event({
	...base,
	...scope,
	type: Type.Literal("model.delta"),
	message_id: Type.String(),
	event: p.streamDelta,
});

const ToolCallOutput = event({
	...base,
	...scope,
	type: Type.Literal("tool_call.output"),
	tool_call_id: Type.String(),
	text: Type.String(),
});

/**
 * Host 发给前端的事件（格式版本 `eventFormatVersion`）的 JSON Schema。它描述当前版本，
 * Host 的测试按它检查发出的每个事件；消费方仍应忽略不认识的事件类型和字段。
 */
export const hostEventSchema = Type.Union([
	SessionStarted,
	SessionEnded,
	TaskStarted,
	RunStarted,
	TaskEnded,
	MessageCompleted,
	ToolCallStarted,
	ToolCallCompleted,
	...ApprovalRequested.anyOf,
	ApprovalDecided,
	Warning,
	ErrorEvent,
	ModelDelta,
	ToolCallOutput,
]);

/** session 打开之前就失败时那条事件的 JSON Schema。 */
export const startupErrorEventSchema = Type.Object(
	{
		type: Type.Literal("error"),
		format_version: Type.Integer(),
		time: Type.String(),
		message: Type.String(),
	},
	closed,
);

// 两边互相可以赋值：对象的交叉类型和展开后的对象写法不同，用不了逐字相同的比较
type SameShape<A, B> = [A] extends [B]
	? [B] extends [A]
		? true
		: false
	: false;
function sameShape<A, B>(_same: SameShape<A, B>): void {}

sameShape<Static<typeof PermissionRequest>, Sandbox.PermissionRequest>(true);
sameShape<Static<typeof ApprovalAnswer>, Sandbox.ApprovalAnswer>(true);
sameShape<Static<typeof hostEventSchema>, Events.HostEvent>(true);
sameShape<Static<typeof startupErrorEventSchema>, Events.StartupErrorEvent>(
	true,
);

const hostEventValidator = Compile(hostEventSchema);

/** 一个值是不是符合当前版本格式的 Host 事件。 */
export function isHostEvent(value: unknown): value is Events.HostEvent {
	return hostEventValidator.Check(value);
}
