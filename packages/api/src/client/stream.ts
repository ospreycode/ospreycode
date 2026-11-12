import { streamAnthropicMessages } from "../adapters/anthropic-messages.js";
import { streamGoogleGenerateContent } from "../adapters/google-generate-content.js";
import { streamOpenAIChat } from "../adapters/openai-chat.js";
import { streamOpenAIResponses } from "../adapters/openai-responses.js";
import type { ModelEntry, ServerToolName } from "../models/entry.js";
import type { ModelRequest, StreamEvent } from "../protocol/index.js";
import type { RawStore } from "./raw.js";

/** 发出一次模型请求时，内部协议以外的部分：凭据、`fetch` 和取消都由调用方给出。 */
export interface StreamOptions {
	/** 这次回复的消息编号，由 runtime 生成。 */
	messageId: string;
	/**
	 * 服务的凭据：API key 或访问令牌，条目的 `auth` 是 `aws-sigv4` 时是 AWS `credential_process`
	 * 格式的 JSON。`api` 不读取凭据文件或环境变量。
	 */
	apiKey: string;
	/** 发请求用的 `fetch`，代理由它决定。 */
	fetch: typeof globalThis.fetch;
	/** 中止时以 `stop_reason: "cancelled"` 的 `end` 结束。 */
	signal: AbortSignal;
	/** 提示缓存的键（如 OpenAI 的 `prompt_cache_key`），由 Host 按通道填写 session 标识。 */
	cacheKey?: string;
	/** 调用方保存的原文：同一协议、服务和 API 版本上原样重放，新转换的部分和收到的回复交给它保存。 */
	raws?: RawStore;
	/**
	 * 这次请求启用的服务端工具，必须在条目的 `server_tools` 里。同一段对话里保持不变：
	 * 增减它们会让提示缓存和之前的推理内容失效。
	 */
	serverTools?: readonly ServerToolName[];
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

/** 按模型清单条目的协议发出请求。 */
export const streamModel: StreamModel = (entry, request, options) => {
	switch (entry.protocol) {
		case "anthropic.messages":
			return streamAnthropicMessages(entry, request, options);
		case "openai.responses":
			return streamOpenAIResponses(entry, request, options);
		case "openai.chat":
			return streamOpenAIChat(entry, request, options);
		case "google.generate-content":
			return streamGoogleGenerateContent(entry, request, options);
	}
};
