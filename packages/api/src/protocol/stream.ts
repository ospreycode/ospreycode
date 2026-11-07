import type { ModelErrorInfo } from "./errors.js";
import type { AssistantMessage } from "./messages.js";
import type { Usage } from "./usage.js";

/**
 * 回复停止的原因。`pause_turn` 是服务端工具暂停（Anthropic 的同名停止原因）：
 * 把这条回复原样追加后再次请求。
 */
export type StopReason =
	| "end_turn"
	| "tool_use"
	| "max_tokens"
	| "context_window_exceeded"
	| "pause_turn"
	| "refusal"
	| "error"
	| "cancelled";

/** 会话里的一个内容块：所在消息和它在 `content` 里的下标。 */
export interface BlockRef {
	message_id: string;
	index: number;
}

/** 作废的原因：拒绝回答、服务端回退、推理内容前缀不符、流中途出错。 */
export type InvalidationReason =
	| "refusal"
	| "fallback"
	| "reasoning_prefix_mismatch"
	| "stream_error";

/** 作废：这些块原样留在会话里供显示和审计，组装之后的请求时跳过，已发出的前缀不变。 */
export interface Invalidation {
	blocks: BlockRef[];
	reason: InvalidationReason;
}

/**
 * 一次模型请求的流式事件，`index` 是块在回复 `content` 里的下标。流以唯一的 `end` 结束：
 * 出错和取消时 `message` 是已收到的部分，`stop_reason` 为 `error` 或 `cancelled`。
 */
export type StreamEvent =
	| {
			type: "start";
			/** 服务报告的模型，流的开头就回退时和请求的不同。 */
			model: string;
	  }
	| { type: "text_delta"; index: number; text: string }
	| { type: "reasoning_delta"; index: number; text: string }
	| { type: "tool_call_start"; index: number; call_id: string; name: string }
	| { type: "tool_call_delta"; index: number; arguments: string }
	| { type: "tool_call_end"; index: number }
	| { type: "usage"; usage: Usage }
	| { type: "invalidate"; invalidation: Invalidation }
	| {
			type: "end";
			message: AssistantMessage;
			/** `stop_reason` 为 `error` 时的错误。 */
			error?: ModelErrorInfo;
	  };
