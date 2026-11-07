import { streamAnthropicMessages } from "../adapters/anthropic-messages.js";
import type { ModelEntry } from "../models/entry.js";
import type {
	ModelRequest,
	ProtocolName,
	StreamEvent,
} from "../protocol/index.js";

/** 发出一次模型请求时，内部协议以外的部分：凭据、`fetch` 和取消都由调用方给出。 */
export interface StreamOptions {
	/** 这次回复的消息编号，由 runtime 生成。 */
	messageId: string;
	/** 服务的 API key。`api` 不读取凭据文件或环境变量。 */
	apiKey: string;
	/** 发请求用的 `fetch`，代理由它决定。 */
	fetch: typeof globalThis.fetch;
	/** 中止时以 `stop_reason: "cancelled"` 的 `end` 结束。 */
	signal: AbortSignal;
}

/**
 * 发出一次模型请求，产出内部协议的流式事件，以唯一的 `end` 结束；服务报错、网络中断和取消
 * 都体现在 `end` 里，不抛出。`api` 不重试。
 */
export type StreamModel = (
	entry: ModelEntry,
	request: ModelRequest,
	options: StreamOptions,
) => AsyncIterable<StreamEvent>;

/** 已经有转换模块的协议。 */
export const supportedProtocols: readonly ProtocolName[] = [
	"anthropic.messages",
];

/** 按模型清单条目的协议发出请求。 */
export const streamModel: StreamModel = (entry, request, options) => {
	switch (entry.protocol) {
		case "anthropic.messages":
			return streamAnthropicMessages(entry, request, options);
		default:
			throw new Error(`还不支持 ${entry.protocol} 协议`);
	}
};
