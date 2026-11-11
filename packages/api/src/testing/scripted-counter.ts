import type { CountTokens } from "../client/count.js";
import type { ModelErrorInfo, ModelRequest } from "../protocol/index.js";

/** 按收到的请求和这是第几次计数（从 0 开始）给出输入的 token 数，或者计数接口报的错误。 */
export type CountScript = (
	request: ModelRequest,
	call: number,
) => number | ModelErrorInfo;

/**
 * 按脚本返回结果的计数接口，和真实的 `countTokens` 用法相同。只用于真实服务难以稳定触发的情况：
 * 上下文刚好在临界区间、计数接口报错。
 */
export function scriptedCounter(script: CountScript): CountTokens {
	let calls = 0;
	return async (_entry, request, options) => {
		const result = script(request, calls++);
		if (options.signal.aborted) return { cancelled: true };
		return typeof result === "number"
			? { input_tokens: result }
			: { error: result };
	};
}
