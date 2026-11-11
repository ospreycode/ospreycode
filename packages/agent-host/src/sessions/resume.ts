import {
	memoryToolRegistry,
	protocolSchemas,
	type RecordedEdit,
	skillLoadTool,
	toolRegistry,
} from "@ospreycode/agent-runtime";
import type { Usage } from "@ospreycode/api/protocol";
import type {
	Position,
	SessionStore,
	StoredEvent,
} from "@ospreycode/session-store";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { inputQueueSchema } from "../sdk/schema.js";
import type { InputQueueSnapshot } from "./inputs.js";
import { addUsage, emptyUsage } from "./run.js";

/** 中断的 task 里一次只有开始、没有结果，也确定不了有没有执行的工具调用。 */
export interface UncertainCall {
	toolCallId: string;
	name: string;
	/** 模型写出的参数原文。 */
	arguments: string;
}

/** 上次没有正常结束的 task：有 `task.started`，没有 `task.ended`。 */
export interface InterruptedTask {
	taskId: string;
	runId: string;
	/** 这个 run 里最后一个事件的序号：收尾的事件接着它编。 */
	seq: number;
	/** 中断之前这个 task 已经记下的用量。 */
	usage: Usage;
	/** 登记过文件改动、没有结果的调用：恢复时按文件现在的哈希确定结果。 */
	edits: { toolCallId: string; edits: RecordedEdit[] }[];
	/** 要问用户重新执行还是跳过的调用，按登记的顺序。 */
	uncertain: UncertainCall[];
}

/** 上次还在运行的一条后台命令：进程已经在恢复时清理掉了。 */
export interface LostBackground {
	backgroundId: string;
	command: string;
	outputPath: string;
}

/** 恢复一个 session 时从记录里读出的状态。 */
export interface ResumeState {
	/** 上次的 agent 标识；还没有开始过 task 的 session 没有。 */
	agentId: string | undefined;
	/** 会话树上的当前位置。 */
	position: Position | null;
	interrupted: InterruptedTask | undefined;
	/** 最后一份队列的快照；队列没有变化过的 session 没有。 */
	queue: InputQueueSnapshot | undefined;
	lostBackground: LostBackground[];
}

const toolCallStarted = Compile(
	Type.Object(
		{
			...protocolSchemas.toolCallStarted.properties,
			// 按事件脱敏覆盖过参数的调用带它
			redacted: Type.Optional(Type.Literal(true)),
		},
		{ additionalProperties: false },
	),
);
const toolCallRef = Compile(Type.Object({ tool_call_id: Type.String() }));
const approvalRequested = Compile(
	Type.Object({
		request_id: Type.String(),
		kind: Type.String(),
		tool_call_id: Type.Optional(Type.String()),
	}),
);
const approvalDecided = Compile(Type.Object({ request_id: Type.String() }));
const queueChanged = Compile(Type.Object({ queue: inputQueueSchema }));
const backgroundStarted = Compile(
	Type.Object({
		background_id: Type.String(),
		command: Type.String(),
		output_path: Type.String(),
	}),
);
const backgroundEnded = Compile(Type.Object({ background_id: Type.String() }));
const messageCompleted = Compile(
	Type.Object({ message: Type.Object({ usage: protocolSchemas.usage }) }),
);

/** 带队列快照的事件。 */
const queueEvents = new Set([
	"input.queued",
	"input.inserted",
	"input.dequeued",
	"input.follow_up_paused",
]);

/** 重复执行没有副作用的工具：只有开始、没有结果的调用不用问用户，下一个 task 开始时直接重新执行。 */
function idempotent(name: string): boolean {
	const spec =
		toolRegistry.get(name) ??
		memoryToolRegistry.get(name) ??
		(name === skillLoadTool.declaration.name ? skillLoadTool : undefined);
	// 不认识的工具（如 MCP server 的）按有副作用处理
	return spec?.idempotent === true;
}

/** 从磁盘读回的事件内容，用之前按要用到的字段检查。 */
function checked<T>(
	event: StoredEvent,
	schema: { Check(value: unknown): value is T },
): T {
	if (!schema.Check(event.data)) {
		throw new Error(
			`session 记录里的 ${event.type} 格式不对：${event.run_id} 的第 ${event.seq} 个事件`,
		);
	}
	return event.data;
}

/** 中断的 task 里没有结果的调用各自怎么处理。 */
function danglingCalls(
	events: readonly StoredEvent[],
): Pick<InterruptedTask, "edits" | "uncertain"> {
	const started = new Map<
		string,
		{ name: string; arguments: string; edits?: RecordedEdit[] }
	>();
	const asked = new Map<string, string[]>();
	const decided = new Set<string>();
	for (const event of events) {
		if (event.type === "tool_call.started") {
			const call = checked(event, toolCallStarted);
			started.set(call.tool_call_id, call);
		} else if (event.type === "tool_call.completed") {
			started.delete(checked(event, toolCallRef).tool_call_id);
		} else if (event.type === "approval.requested") {
			const request = checked(event, approvalRequested);
			if (request.kind === "tool_call" && request.tool_call_id !== undefined) {
				asked.set(request.tool_call_id, [
					...(asked.get(request.tool_call_id) ?? []),
					request.request_id,
				]);
			}
		} else if (event.type === "approval.decided") {
			decided.add(checked(event, approvalDecided).request_id);
		}
	}
	const edits: InterruptedTask["edits"] = [];
	const uncertain: UncertainCall[] = [];
	for (const [toolCallId, call] of started) {
		// 还在等批准的调用没有执行过，下一个 task 开始时重新登记、重新询问
		const waiting = (asked.get(toolCallId) ?? []).some(
			(requestId) => !decided.has(requestId),
		);
		if (waiting) continue;
		if (call.edits !== undefined) {
			edits.push({ toolCallId, edits: call.edits });
		} else if (!idempotent(call.name)) {
			uncertain.push({
				toolCallId,
				name: call.name,
				arguments: call.arguments,
			});
		}
	}
	return { edits, uncertain };
}

/**
 * 读出恢复一个 session 要用的状态。只看这个 session 自己的事件：分叉沿用的父 session 那一段里
 * 没有它自己中断的 task、队列和后台命令。
 */
export function readResumeState(
	store: SessionStore,
	sessionId: string,
): ResumeState {
	const events = store.events(sessionId);
	// 子 agent 的 run 不算：恢复的是主 agent 的 task
	const runs = store
		.runs(sessionId)
		.filter((run) => run.task_id !== null && run.parent_agent_id === undefined);
	const last = runs.at(-1);
	let interrupted: InterruptedTask | undefined;
	if (last !== undefined && last.task_id !== null) {
		const own = events.filter((event) => event.run_id === last.run_id);
		const has = (type: string) => own.some((event) => event.type === type);
		// 空闲时记事件用的 run 没有 `task.started`
		if (has("task.started") && !has("task.ended")) {
			interrupted = {
				taskId: last.task_id,
				runId: last.run_id,
				seq: Math.max(...own.map((event) => event.seq)),
				usage: own
					.filter((event) => event.type === "message.completed")
					.reduce(
						(total, event) =>
							addUsage(total, checked(event, messageCompleted).message.usage),
						emptyUsage(),
					),
				...danglingCalls(own),
			};
		}
	}
	let queue: InputQueueSnapshot | undefined;
	const background = new Map<string, LostBackground>();
	for (const event of events) {
		if (queueEvents.has(event.type)) {
			queue = checked(event, queueChanged).queue;
		} else if (event.type === "background.started") {
			const started = checked(event, backgroundStarted);
			background.set(started.background_id, {
				backgroundId: started.background_id,
				command: started.command,
				outputPath: started.output_path,
			});
		} else if (event.type === "background.ended") {
			background.delete(checked(event, backgroundEnded).background_id);
		}
	}
	return {
		agentId: last?.agent_id ?? undefined,
		position: store.position(sessionId),
		interrupted,
		queue,
		lostBackground: [...background.values()],
	};
}
