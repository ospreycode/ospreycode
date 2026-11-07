/**
 * 模型请求失败的类别，loop 据此决定能不能重试，不需要认识各家的错误格式。
 *
 * - `authentication`：认证失败
 * - `permission`：无权限或模型不存在
 * - `billing`：额度或账单不足
 * - `rate_limit`：限流
 * - `overloaded`：服务过载
 * - `context_overflow`：上下文超长
 * - `request_too_large`：请求过大
 * - `invalid_request`：请求格式错误
 * - `reasoning_prefix_mismatch`：推理内容前缀不符，原样重试必然再次失败
 * - `network`：网络中断和超时
 */
export type ErrorCategory =
	| "authentication"
	| "permission"
	| "billing"
	| "rate_limit"
	| "overloaded"
	| "context_overflow"
	| "request_too_large"
	| "invalid_request"
	| "reasoning_prefix_mismatch"
	| "network";

/** 一次失败的模型请求。 */
export interface ModelErrorInfo {
	category: ErrorCategory;
	/** 服务返回的错误信息，或网络错误的说明。 */
	message: string;
	/** 限流时服务建议的等待时间。 */
	retry_after_ms?: number;
}
