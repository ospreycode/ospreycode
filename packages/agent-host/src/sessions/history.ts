import type { ReasoningEffort } from "@ospreycode/api/protocol";
import type {
	Position,
	SessionStore,
	StoredEvent,
} from "@ospreycode/session-store";
import Type from "typebox";
import { Compile } from "typebox/compile";
import type { HostEvent } from "../sdk/events.js";
import { isHostEvent } from "../sdk/schema.js";
import { loadContent, storedContentSchema } from "./stored-images.js";

/** session 记录里按原样就是对外事件内容的事件类型。 */
const direct = new Set([
	"task.started",
	"task.ended",
	"message.completed",
	"tool_call.started",
	"approval.requested",
	"approval.decided",
	"input.queued",
	"input.inserted",
	"input.dequeued",
	"input.follow_up_paused",
	"model.changed",
	"reasoning_effort.changed",
	"background.started",
	"background.ended",
	"background.notification",
	"background.delivered",
	"memory.candidates",
	"memory.retrieved",
]);

const storedCompleted = Compile(
	Type.Object({ result: Type.Object({ content: storedContentSchema }) }),
);
const storedCompacted = Compile(
	Type.Object({
		trigger: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
		tokens_before: Type.Number(),
		summary: Type.String(),
		redacted: Type.Optional(Type.Literal(true)),
	}),
);

/**
 * 把 session 记录里的事件换回当时发给前端的样子。只有会存储的对外事件，流式增量没有存，别的事件
 * 略过。记录是从磁盘读回的，换回之后按对外事件的格式检查一次。
 */
export function hostEvents(
	store: SessionStore,
	sessionId: string,
	events: readonly StoredEvent[],
): HostEvent[] {
	const blob = (sha256: string) => store.blob(sessionId, sha256);
	return events.flatMap((stored): HostEvent[] => {
		const { type, run_id, seq, data } = stored;
		const malformed = () =>
			new Error(
				`session 记录里的 ${type} 格式不对：${run_id} 的第 ${seq} 个事件`,
			);
		let content: object;
		if (type === "run.started") {
			content = {};
		} else if (type === "tool_call.completed") {
			if (!storedCompleted.Check(data)) throw malformed();
			content = {
				...data,
				result: {
					...data.result,
					content: loadContent(data.result.content, blob),
				},
			};
		} else if (type === "context.compacted") {
			// 记录里另带压缩后的整份上下文，前端收到的只有这三项，和按事件脱敏的标记
			if (!storedCompacted.Check(data)) throw malformed();
			content = {
				trigger: data.trigger,
				tokens_before: data.tokens_before,
				summary: data.summary,
				...(data.redacted === undefined ? {} : { redacted: data.redacted }),
			};
		} else if (direct.has(type)) {
			content = data as object;
		} else {
			return [];
		}
		const event = {
			session_id: stored.session_id,
			time: stored.time,
			task_id: stored.task_id,
			run_id,
			agent_id: stored.agent_id,
			event_id: stored.event_id,
			seq,
			type,
			...content,
		};
		if (!isHostEvent(event)) throw malformed();
		return [event];
	});
}

/** 子 agent 的 run：`run.started` 带父 agent。 */
const subagentRun = Compile(Type.Object({ parent_agent_id: Type.String() }));

/** 路径上最后一次模型请求用的模型和推理强度。 */
export interface RecordedModel {
	model: string;
	reasoningEffort: ReasoningEffort;
}

/**
 * 从会话树的根到 `until` 这条路径上，主 agent 最后一条回复用的模型和推理强度：恢复、回退和分叉之后
 * 接着用它。路径上还没有回复时没有。
 */
export function pathModel(
	store: SessionStore,
	sessionId: string,
	until: Position | null,
): RecordedModel | undefined {
	if (until === null) return undefined;
	const path = store.pathEvents(sessionId, until);
	// 子 agent 可以用别的模型：它们的 run 不算
	const subagents = new Set(
		path
			.filter(
				({ type, data }) => type === "run.started" && subagentRun.Check(data),
			)
			.map(({ run_id }) => run_id),
	);
	const last = hostEvents(
		store,
		sessionId,
		path.filter(
			({ type, run_id }) =>
				type === "message.completed" && !subagents.has(run_id),
		),
	).at(-1);
	if (last?.type !== "message.completed") return undefined;
	return {
		model: last.message.requested_model,
		reasoningEffort: last.message.reasoning_effort,
	};
}

/**
 * 从会话树的根到 `until` 这条路径上的事件，换回当时发给前端的样子：前端恢复、回退或分叉之后按它
 * 重画对话。
 */
export function pathHistory(
	store: SessionStore,
	sessionId: string,
	until: Position | null,
): HostEvent[] {
	if (until === null) return [];
	return hostEvents(store, sessionId, store.pathEvents(sessionId, until));
}
