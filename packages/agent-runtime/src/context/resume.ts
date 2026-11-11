import type {
	AssistantMessage,
	Invalidation,
	Message,
	ToolResultMessage,
	Usage,
} from "@ospreycode/api/protocol";
import type { RuntimeChannel } from "../channel/open.js";
import type {
	AgentConfig,
	RecordedEvent,
	RecordReadResult,
} from "../channel/protocol.js";
import type {
	ContextCompacted,
	RecordedInstructions,
	ToolCallCompleted,
	ToolCallStarted,
} from "../contracts/index.js";
import {
	cancelledMessage,
	type ResumedState,
	resultMessage,
} from "../loop/agent-loop.js";
import { loadedSkill } from "./compaction.js";

/** 重建历史要读的事件。 */
const eventTypes = [
	"message.sent",
	"message.completed",
	"blocks.invalidated",
	"tool_call.started",
	"tool_call.completed",
	"instructions.recorded",
	"context.compacted",
];

/**
 * 事件的内容是不是被 Host 按事件脱敏覆盖过。`redacted` 是 Host 定义的可选标记，带着它的事件保留
 * 原来的结构，内容换成了占位；runtime 信任 Host 给的事件，只读这个标记，不重新检查格式。
 */
function isRedacted(data: unknown): boolean {
	return (data as { redacted?: true }).redacted === true;
}

const noUsage: Usage = {
	input: 0,
	output: 0,
	cache_read: 0,
	cache_write: 0,
	reasoning: 0,
};

/**
 * 按会话树路径上的事件重建 loop 的状态，事件按路径上的先后给出。发给过模型的消息（`message.sent`）
 * 和模型的回复（`message.completed`）按原来的编号和顺序放回历史，所以重启后的请求和之前的前缀相同。
 * 路径上没有发给过模型的消息时返回空，loop 按新会话开始。路径上有压缩（`context.compacted`）时
 * 从最近的一次开始：历史换成它带的消息，只放回它之后的事件。
 *
 * 路径上有被脱敏覆盖的事件（见 `isRedacted`）时：
 * - 从它起，回复里的推理块都作废：它们是对着原来的历史生成的，模型服务核对不上。
 * - 被覆盖的压缩作废：它的摘要是从被覆盖的内容写出来的。历史不换成它带的消息，接着用到此为止
 *   累积的历史，要摘要的那条消息和摘要的回复去掉；它带的消息之后随请求记的副本照样跳过。它重新
 *   生成的系统指令也不取，之后记下的系统指令都建立在那一份上，同样不取：恢复后和压缩之前的记录
 *   比较，压缩之后追加过的补丁可能再追加一次，但不会漏掉。它之后的回复去掉用量，估算上下文时
 *   以压缩之前的回复为锚点，历史超过阈值时 loop 在下一次请求前照常重新压缩。
 */
export function rebuildState(
	events: readonly RecordedEvent[],
): ResumedState | undefined {
	const history: Message[] = [];
	const invalidated = new Map<string, Set<number>>();
	const started = new Map<string, ToolCallStarted>();
	const completed = new Map<string, ToolCallCompleted>();
	let instructions: RecordedInstructions | undefined;
	// 压缩带的消息和已加载的 skill：作废的压缩只留下它带的消息的编号
	let compacted = new Set<string>();
	let loadedSkills = new Map<string, string>();
	// 路径上出现过被脱敏覆盖的事件
	let redacted = false;
	// 最近一次压缩是作废的
	let voided = false;
	const invalidate = (messageId: string, index: number) => {
		const set = invalidated.get(messageId) ?? new Set<number>();
		set.add(index);
		invalidated.set(messageId, set);
	};
	const callKey = (messageId: string, callId: string) =>
		`${messageId}\n${callId}`;
	for (const event of events) {
		if (isRedacted(event.data)) redacted = true;
		switch (event.type) {
			case "message.sent": {
				const { message } = event.data as { message: Message };
				// 压缩事件带的消息已经在历史里（作废的压缩带的不要），之后随模型请求又记了一次
				if (!compacted.has(message.message_id)) history.push(message);
				break;
			}
			case "message.completed": {
				const { message } = event.data as { message: AssistantMessage };
				// 被取消的回复和出错时什么都没收到的回复，loop 没有留在历史里
				if (message.stop_reason === "cancelled") break;
				// 撞上上下文窗口被截断的回复也没有留下
				if (message.stop_reason === "context_window_exceeded") break;
				if (message.stop_reason === "error") {
					if (message.content.length === 0) break;
					// 流中途出错：已收到的部分留在历史里并整条作废，不等 loop 上报
					message.content.forEach((_, index) => {
						invalidate(message.message_id, index);
					});
				}
				if (redacted) {
					message.content.forEach((block, index) => {
						if (block.type === "reasoning") {
							invalidate(message.message_id, index);
						}
					});
				}
				// 作废的压缩之后的回复，报告的用量是对着压缩后的上下文数的；重建出的历史比那长，
				// 去掉用量，估算上下文时不拿它当锚点
				history.push(voided ? { ...message, usage: noUsage } : message);
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
				if (!voided) instructions = event.data as RecordedInstructions;
				break;
			case "context.compacted": {
				const compaction = event.data as ContextCompacted;
				if (isRedacted(compaction)) {
					// 要摘要的那条消息是这时历史里最后一条 user 消息，摘要的回复在它后面
					const request = history.findLastIndex(
						(message) => message.role === "user",
					);
					if (request === -1) {
						throw new Error("session 记录里的压缩之前没有要摘要的那条消息");
					}
					history.length = request;
					for (const message of compaction.messages) {
						compacted.add(message.message_id);
					}
					voided = true;
					break;
				}
				voided = false;
				history.splice(0, history.length, ...compaction.messages);
				invalidated.clear();
				started.clear();
				completed.clear();
				instructions = compaction.instructions;
				compacted = new Set(
					compaction.messages.map((message) => message.message_id),
				);
				loadedSkills = new Map(
					(compaction.loaded_skills ?? []).map((skill) => [
						skill.name,
						skill.content,
					]),
				);
				break;
			}
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
	// 最后一条回复的工具调用还没有把结果发给模型：上一个进程在这之前结束了
	const last = history.at(-1);
	let pending: ResumedState["pending"];
	if (last?.role === "assistant" && last.stop_reason === "tool_use") {
		const dropped = invalidated.get(last.message_id);
		const calls = last.content.flatMap((block, index) =>
			block.type === "tool_call" && !dropped?.has(index) ? [block] : [],
		);
		const results = new Map<string, ToolResultMessage>();
		let unfinished = false;
		for (const block of calls) {
			// 同一次调用登记过几次（上次恢复时重新执行过）时以最后一次为准
			const call = started.get(callKey(last.message_id, block.call_id));
			if (call === undefined) continue;
			const outcome = completed.get(call.tool_call_id);
			if (outcome === undefined) {
				unfinished = true;
			} else {
				results.set(
					block.call_id,
					resultMessage(block, call.tool_call_id, outcome.result),
				);
			}
		}
		if (unfinished) {
			// Host 被中断：登记过、没有结果的调用是 Host 恢复时留下来要重新执行的，下一个 task 开始时
			// 把这一轮做完
			pending = { message: last, results };
		} else {
			// agent 进程被结束：Host 那时已经给登记过的调用补上了结果，没来得及登记的记成取消，
			// 否则下一次模型请求格式不合法
			history.push(
				...calls.map(
					(block) =>
						results.get(block.call_id) ?? cancelledMessage(block, undefined),
				),
			);
		}
	}
	for (const call of started.values()) {
		const outcome = completed.get(call.tool_call_id);
		if (outcome === undefined) continue;
		// 被覆盖的调用，参数或结果已经是占位内容：读不出加载了哪个 skill、内容是什么
		if (isRedacted(call) || isRedacted(outcome)) continue;
		const skill = loadedSkill(call.name, call.arguments, outcome.result);
		if (skill !== undefined) loadedSkills.set(skill.name, skill.content);
	}
	return {
		history,
		invalidated,
		instructions,
		loadedSkills,
		...(pending === undefined ? {} : { pending }),
	};
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
