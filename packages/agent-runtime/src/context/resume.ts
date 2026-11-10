import type {
	AssistantMessage,
	Invalidation,
	Message,
} from "@ospreycode/api/protocol";
import type { RuntimeChannel } from "../channel/open.js";
import type {
	AgentConfig,
	RecordedEvent,
	RecordReadResult,
} from "../channel/protocol.js";
import type {
	RecordedInstructions,
	ToolCallCompleted,
	ToolCallStarted,
} from "../contracts/index.js";
import {
	cancelledMessage,
	type ResumedState,
	resultMessage,
} from "../loop/agent-loop.js";

/** 重建历史要读的事件。 */
const eventTypes = [
	"message.sent",
	"message.completed",
	"blocks.invalidated",
	"tool_call.started",
	"tool_call.completed",
	"instructions.recorded",
];

/**
 * 按会话树路径上的事件重建 loop 的状态，事件按路径上的先后给出。发给过模型的消息（`message.sent`）
 * 和模型的回复（`message.completed`）按原来的编号和顺序放回历史，所以重启后的请求和之前的前缀相同。
 * 路径上没有发给过模型的消息时返回空，loop 按新会话开始。
 */
export function rebuildState(
	events: readonly RecordedEvent[],
): ResumedState | undefined {
	const history: Message[] = [];
	const invalidated = new Map<string, Set<number>>();
	const started = new Map<string, ToolCallStarted>();
	const completed = new Map<string, ToolCallCompleted>();
	let instructions: RecordedInstructions | undefined;
	const invalidate = (messageId: string, index: number) => {
		const set = invalidated.get(messageId) ?? new Set<number>();
		set.add(index);
		invalidated.set(messageId, set);
	};
	const callKey = (messageId: string, callId: string) =>
		`${messageId}\n${callId}`;
	for (const event of events) {
		switch (event.type) {
			case "message.sent":
				history.push((event.data as { message: Message }).message);
				break;
			case "message.completed": {
				const { message } = event.data as { message: AssistantMessage };
				// 被取消的回复和出错时什么都没收到的回复，loop 没有留在历史里
				if (message.stop_reason === "cancelled") break;
				if (message.stop_reason === "error") {
					if (message.content.length === 0) break;
					// 流中途出错：已收到的部分留在历史里并整条作废，不等 loop 上报
					message.content.forEach((_, index) => {
						invalidate(message.message_id, index);
					});
				}
				history.push(message);
				break;
			}
			case "blocks.invalidated":
				for (const block of (event.data as Invalidation).blocks) {
					invalidate(block.message_id, block.index);
				}
				break;
			case "tool_call.started": {
				const call = event.data as ToolCallStarted;
				started.set(callKey(call.message_id, call.call_id), call);
				break;
			}
			case "tool_call.completed": {
				const call = event.data as ToolCallCompleted;
				completed.set(call.tool_call_id, call);
				break;
			}
			case "instructions.recorded":
				instructions = event.data as RecordedInstructions;
				break;
			default:
				throw new Error(`record/read 返回了没有要的事件：${event.type}`);
		}
	}
	if (history.length === 0) return undefined;
	if (instructions === undefined) {
		throw new Error(
			"session 记录里有发给模型的消息，却没有 instructions.recorded",
		);
	}
	// 最后一条回复的工具调用还没有把结果发给模型：上一个进程在这之前结束了。Host 那时已经给登记过的
	// 调用补上了结果，没来得及登记的记成取消，否则下一次模型请求格式不合法
	const last = history.at(-1);
	if (last?.role === "assistant" && last.stop_reason === "tool_use") {
		const dropped = invalidated.get(last.message_id);
		last.content.forEach((block, index) => {
			if (block.type !== "tool_call" || dropped?.has(index)) return;
			const call = started.get(callKey(last.message_id, block.call_id));
			if (call === undefined) {
				history.push(cancelledMessage(block, undefined));
				return;
			}
			const outcome = completed.get(call.tool_call_id);
			if (outcome === undefined) {
				throw new Error(
					`工具调用 ${call.tool_call_id} 在 session 记录里没有结果`,
				);
			}
			history.push(resultMessage(block, call.tool_call_id, outcome.result));
		});
	}
	return { history, invalidated, instructions };
}

/** 从 Host 读出 `resume` 之前这条路径上的事件，重建 loop 的状态。 */
export async function resumeState(
	channel: RuntimeChannel,
	until: NonNullable<AgentConfig["resume"]>,
): Promise<ResumedState | undefined> {
	const events: RecordedEvent[] = [];
	let offset: number | undefined = 0;
	while (offset !== undefined) {
		const page: RecordReadResult = await channel.request("record/read", {
			until,
			types: eventTypes,
			offset,
		});
		events.push(...page.events);
		offset = page.next_offset;
	}
	return rebuildState(events);
}
