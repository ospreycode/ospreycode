import type { StreamModel } from "../client/stream.js";
import type {
	AssistantContent,
	AssistantMessage,
	ModelErrorInfo,
	ModelRequest,
	RefusalDetails,
	StopReason,
	StreamEvent,
	Usage,
} from "../protocol/index.js";

/** 脚本模型的一次回复。 */
export interface ScriptedTurn {
	content: AssistantContent[];
	/** 不写时有工具调用为 `tool_use`，否则为 `end_turn`。 */
	stop_reason?: StopReason;
	/** `stop_reason` 为 `refusal` 时的详情。 */
	refusal?: RefusalDetails;
	usage?: Partial<Usage>;
	/** 以这个错误结束，`content` 是出错前已经收到的部分。 */
	error?: ModelErrorInfo;
	/** 产出 `content` 之后一直等到请求被取消，用来测试在指定时刻取消。 */
	hang?: boolean;
}

/** 按收到的请求和这是第几次请求（从 0 开始）给出回复。 */
export type Script = (request: ModelRequest, call: number) => ScriptedTurn;

function deltas(index: number, block: AssistantContent): StreamEvent[] {
	switch (block.type) {
		case "text":
			return [{ type: "text_delta", index, text: block.text }];
		case "reasoning":
			return [{ type: "reasoning_delta", index, text: block.text }];
		case "tool_call":
			return [
				{
					type: "tool_call_start",
					index,
					call_id: block.call_id,
					name: block.name,
				},
				{ type: "tool_call_delta", index, arguments: block.arguments },
				{ type: "tool_call_end", index },
			];
		case "fallback":
			return [];
	}
}

/** 和转换模块相同的作废规则：拒绝作废全部输出，回退作废最后一个分界之前的推理内容和工具调用。 */
function invalidation(
	messageId: string,
	turn: ScriptedTurn,
	stopReason: StopReason,
): StreamEvent | undefined {
	const boundary = turn.content.findLastIndex(
		(block) => block.type === "fallback",
	);
	const indices =
		stopReason === "refusal"
			? turn.content.map((_, index) => index)
			: turn.content.flatMap((block, index) =>
					index < boundary &&
					(block.type === "reasoning" || block.type === "tool_call")
						? [index]
						: [],
				);
	if (indices.length === 0) return undefined;
	return {
		type: "invalidate",
		invalidation: {
			blocks: indices.map((index) => ({ message_id: messageId, index })),
			reason: stopReason === "refusal" ? "refusal" : "fallback",
		},
	};
}

/**
 * 按脚本返回结果的模型，和真实的 `streamModel` 用法相同。只用于真实模型难以稳定触发的情况：
 * 模型服务报错、超时、在指定时刻取消、中途拒绝和服务端回退。
 */
export function scriptedModel(script: Script): StreamModel {
	let calls = 0;
	return async function* (entry, request, options) {
		const turn = script(request, calls++);
		const usage: Usage = {
			input: 0,
			output: 0,
			cache_read: 0,
			cache_write: 0,
			reasoning: 0,
			...turn.usage,
		};
		const fallback = turn.content.findLast(
			(block) => block.type === "fallback",
		);
		const message = (stopReason: StopReason): AssistantMessage => ({
			role: "assistant",
			message_id: options.messageId,
			content: turn.content,
			protocol: entry.protocol,
			service: entry.service,
			requested_model: entry.id,
			model: fallback?.to ?? entry.model,
			reasoning_effort: request.reasoning_effort,
			stop_reason: stopReason,
			...(turn.refusal === undefined ? {} : { refusal: turn.refusal }),
			usage,
		});
		yield { type: "start", model: entry.model };
		for (const [index, block] of turn.content.entries()) {
			yield* deltas(index, block);
		}
		yield { type: "usage", usage };
		if (turn.hang === true && !options.signal.aborted) {
			await new Promise((resolve) =>
				options.signal.addEventListener("abort", resolve, { once: true }),
			);
		}
		if (options.signal.aborted) {
			yield { type: "end", message: message("cancelled") };
		} else if (turn.error !== undefined) {
			yield { type: "end", message: message("error"), error: turn.error };
		} else {
			const toolUse = turn.content.some((block) => block.type === "tool_call");
			const stopReason =
				turn.stop_reason ?? (toolUse ? "tool_use" : "end_turn");
			const invalidate = invalidation(options.messageId, turn, stopReason);
			if (invalidate !== undefined) yield invalidate;
			yield { type: "end", message: message(stopReason) };
		}
	};
}
