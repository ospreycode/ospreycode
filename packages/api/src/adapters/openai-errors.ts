import type { ErrorCategory, ModelErrorInfo } from "../protocol/index.js";

type Json = Record<string, unknown>;

/** 429 里表示额度不足的错误码；其余 429（含 `slow_down`）是限流。 */
const billingCodes = new Set([
	"credit_balance_exhausted",
	"organization_spend_limit_exceeded",
	"project_spend_limit_exceeded",
	"organization_usage_limit_exceeded",
	"insufficient_quota",
]);

/** 流里的错误没有状态码，只按错误码归类。 */
export function openaiCodeCategory(code: unknown): ErrorCategory {
	switch (code) {
		case "rate_limit_exceeded":
		case "slow_down":
			return "rate_limit";
		case "context_length_exceeded":
			return "context_overflow";
		case "server_error":
		case "server_is_overloaded":
			return "overloaded";
		default:
			return billingCodes.has(String(code)) ? "billing" : "invalid_request";
	}
}

/** OpenAI 两种协议的 HTTP 错误：按状态码和 `error.code` 归类，不只看状态码。 */
export function classifyOpenAIError(
	status: number,
	body: string,
	retryAfter: string | null,
): ModelErrorInfo {
	let error: Json | undefined;
	try {
		error = (JSON.parse(body) as { error?: Json }).error;
	} catch {
		// 中转服务和网关可能返回 HTML 一类的错误页，这时只用状态码归类
		error = undefined;
	}
	const message =
		typeof error?.message === "string" ? error.message : body.slice(0, 500);
	const code = error?.code;
	let category: ErrorCategory;
	if (status === 401) category = "authentication";
	else if (status === 403 || status === 404) category = "permission";
	else if (status === 413) category = "request_too_large";
	else if (status === 429) {
		category =
			code !== "slow_down" &&
			(billingCodes.has(String(code)) || error?.type === "insufficient_quota")
				? "billing"
				: "rate_limit";
	} else if (status === 400 && code === "context_length_exceeded") {
		category = "context_overflow";
	} else if (status >= 500) category = "overloaded";
	else category = "invalid_request";
	const seconds = Number(retryAfter);
	return retryAfter !== null &&
		Number.isFinite(seconds) &&
		category === "rate_limit"
		? { category, message, retry_after_ms: seconds * 1000 }
		: { category, message };
}
