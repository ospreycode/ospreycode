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
	},
	closed,
);

const CommandRule = Type.Object(
	{
		pattern: Type.Array(Type.Union([Type.String(), Type.Array(Type.String())])),
		decision: Type.Union([
			Type.Literal("allow"),
			Type.Literal("prompt"),
			Type.Literal("forbidden"),
		]),
		justification: Type.Optional(Type.String()),
		match: Type.Optional(Type.Array(Type.String())),
		not_match: Type.Optional(Type.Array(Type.String())),
		permissions: Type.Optional(AdditionalPermissions),
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
						op: Type.Union([Type.Literal("add"), Type.Literal("update")]),
						path: Type.String(),
						old_sha256: Type.Union([Type.String(), Type.Null()]),
						content: Type.String(),
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
	Type.Object(
		{
			kind: Type.Literal("stdin"),
			background_id: Type.String(),
			command: Type.String(),
			input: Type.String(),
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
			granted: Type.Optional(
				Type.Object(
					{
						file_system: Type.Optional(FileSystem),
						network: Type.Optional(Type.Array(Type.String())),
					},
					closed,
				),
			),
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
	input: Type.Array(p.inputContent),
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
		diff: Type.Optional(Type.String()),
		suggested_rule: Type.Optional(CommandRule),
	}),
	event({
		...base,
		...scope,
		...stored,
		type: Type.Literal("approval.requested"),
		request_id: Type.String(),
		kind: Type.Literal("network"),
		tool_call_id: Type.Optional(Type.String()),
		running_tool_calls: Type.Optional(Type.Array(Type.String())),
		running_background: Type.Optional(Type.Array(Type.String())),
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

const QueuedInput = Type.Object(
	{
		input_id: Type.String(),
		kind: Type.Union([Type.Literal("steering"), Type.Literal("follow_up")]),
		input: Type.Array(p.inputContent),
	},
	closed,
);

const InputQueue = Type.Object(
	{
		steering: Type.Array(QueuedInput),
		follow_up: Type.Array(QueuedInput),
		follow_up_paused: Type.Boolean(),
	},
	closed,
);

const InputQueued = event({
	...base,
	...scope,
	...stored,
	...QueuedInput.properties,
	type: Type.Literal("input.queued"),
	queue: InputQueue,
});

const InputInserted = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("input.inserted"),
	input_ids: Type.Array(Type.String()),
	message_id: Type.String(),
	after_tool_call_id: Type.Union([Type.String(), Type.Null()]),
	queue: InputQueue,
});

const InputDequeued = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("input.dequeued"),
	inputs: Type.Array(QueuedInput),
	reason: Type.Union([
		Type.Literal("returned"),
		Type.Literal("task_ended"),
		Type.Literal("follow_up_started"),
	]),
	queue: InputQueue,
});

const FollowUpPaused = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("input.follow_up_paused"),
	paused: Type.Boolean(),
	queue: InputQueue,
});

const ReasoningEffort = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const ModelChanged = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("model.changed"),
	model: Type.String(),
	previous_model: Type.String(),
});

const ReasoningEffortChanged = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("reasoning_effort.changed"),
	reasoning_effort: ReasoningEffort,
	previous_reasoning_effort: ReasoningEffort,
});

const BackgroundStarted = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("background.started"),
	background_id: Type.String(),
	tool_call_id: Type.String(),
	kind: Type.Union([Type.Literal("command"), Type.Literal("monitor")]),
	command: Type.String(),
	output_path: Type.String(),
	deadline: Type.Union([Type.String(), Type.Null()]),
});

const BackgroundEnded = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("background.ended"),
	background_id: Type.String(),
	reason: Type.Union([
		Type.Literal("exited"),
		Type.Literal("stopped"),
		Type.Literal("time_limit"),
		Type.Literal("output_limit"),
		Type.Literal("session_closed"),
	]),
	exit_code: Type.Union([Type.Integer(), Type.Null()]),
	signal: Type.Union([Type.String(), Type.Null()]),
	output_bytes: Type.Integer({ minimum: 0 }),
});

const BackgroundNotification = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("background.notification"),
	notification_id: Type.String(),
	background_id: Type.Union([Type.String(), Type.Null()]),
	text: Type.String(),
});

const BackgroundDelivered = event({
	...base,
	...scope,
	...stored,
	type: Type.Literal("background.delivered"),
	notification_ids: Type.Array(Type.String()),
});

const ProcessKind = Type.Union([
	Type.Literal("agent"),
	Type.Literal("helper"),
	Type.Literal("command"),
	Type.Literal("escalated"),
	Type.Literal("apply_edits"),
	Type.Literal("hook"),
	Type.Literal("mcp_server"),
]);

const ProcessStarted = event({
	...base,
	...stored,
	run_id: Type.String(),
	type: Type.Literal("process.started"),
	kind: ProcessKind,
	pid: Type.Integer(),
});

const ProcessExited = event({
	...base,
	...stored,
	run_id: Type.String(),
	type: Type.Literal("process.exited"),
	kind: ProcessKind,
	pid: Type.Integer(),
	exit_code: Type.Union([Type.Integer(), Type.Null()]),
	signal: Type.Union([Type.String(), Type.Null()]),
});

const SandboxModeChanged = event({
	...base,
	...stored,
	run_id: Type.String(),
	type: Type.Literal("sandbox_mode.changed"),
	from: Type.String(),
	to: Type.String(),
});

const ApprovalPolicy = Type.Union([
	Type.Literal("on-request"),
	Type.Literal("granular"),
	Type.Literal("never"),
]);

const ApprovalPolicyChanged = event({
	...base,
	...stored,
	run_id: Type.String(),
	type: Type.Literal("approval_policy.changed"),
	from: ApprovalPolicy,
	to: ApprovalPolicy,
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
	InputQueued,
	InputInserted,
	InputDequeued,
	FollowUpPaused,
	ModelChanged,
	ReasoningEffortChanged,
	BackgroundStarted,
	BackgroundEnded,
	BackgroundNotification,
	BackgroundDelivered,
	ProcessStarted,
	ProcessExited,
	SandboxModeChanged,
	ApprovalPolicyChanged,
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
