import { countAnthropicMessages } from "../adapters/anthropic-messages.js";
import { countOpenAIResponses } from "../adapters/openai-responses.js";
import type { ModelEntry } from "../models/entry.js";
import type { ModelErrorInfo, ModelRequest } from "../protocol/index.js";
import type { RawStore } from "./raw.js";

/** 数一次请求的输入 token 时，内部协议以外的部分：凭据、`fetch` 和取消都由调用方给出。 */
export interface CountOptions {
	/** 服务的 API key。`api` 不读取凭据文件或环境变量。 */
	apiKey: string;
	/** 发请求用的 `fetch`，代理由它决定。 */
	fetch: typeof globalThis.fetch;
	/** 中止时结果是 `{cancelled: true}`。 */
	signal: AbortSignal;
	/** 和模型请求用同一份保存的原文：计数的内容和真正发出的逐字节相同。 */
	raws?: RawStore;
}

/**
 * 计数的结果：这次请求的输入 token 数。服务报错、网络中断和超时是 `error`，类别和模型请求的相同；
 * 被取消时是 `cancelled`。
 */
export type TokenCount =
	| { input_tokens: number }
	| { error: ModelErrorInfo }
	| { cancelled: true };

/**
 * 用模型服务的计数接口数一次请求的输入 token，请求体和真正发出的相同，只去掉计数接口不接受的字段。
 * 约定中的失败不抛出。`api` 不重试。
 */
export type CountTokens = (
	entry: ModelEntry,
	request: ModelRequest,
	options: CountOptions,
) => Promise<TokenCount>;

/** 按模型清单条目的协议调用计数接口。`openai.chat` 没有计数接口，对它调用会抛出。 */
export const countTokens: CountTokens = async (entry, request, options) => {
	switch (entry.protocol) {
		case "anthropic.messages":
			return countAnthropicMessages(entry, request, options);
		case "openai.responses":
			return countOpenAIResponses(entry, request, options);
		case "openai.chat":
			throw new Error(`${entry.id} 用的 openai.chat 没有 token 计数接口`);
	}
};
