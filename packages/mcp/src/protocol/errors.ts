/** `McpError` 的分类，调用方按它决定怎么处理。 */
export type McpErrorKind =
	/** 没有有效的令牌，要用户（重新）登录。 */
	| "unauthorized"
	/** 403 insufficient_scope，要用户重新登录提升权限。 */
	| "insufficient_scope"
	| "timeout"
	| "cancelled"
	/** 连接已经断了。 */
	| "closed"
	/** server 返回了 JSON-RPC 错误，`code` 里是错误码。 */
	| "protocol"
	/** 启动、连接、HTTP 或版本协商失败。 */
	| "transport";

/** `McpError` 除分类和消息以外的内容。 */
export interface McpErrorDetails {
	/** 原始错误。 */
	cause?: unknown;
	/** `kind` 为 `protocol` 时的 JSON-RPC 错误码。 */
	code?: number;
	/** `kind` 为 `insufficient_scope` 时 server 要求的 scope。 */
	requiredScope?: string;
}

/**
 * 这个包抛出的错误。SDK 的错误在包的边界转换成它，原始错误保留在 `cause` 里。
 *
 * 授权和登录失败的消息是这个包自己写的固定文字，不含令牌、授权码和授权服务器或回调发来的内容。
 * `protocol` 和 `transport` 的消息带着 server 或 SDK 给的错误说明（JSON-RPC 错误的 message、
 * HTTP 错误响应的正文），那是 server 能控制的内容，只能当数据显示。`cause` 是 SDK 的原始错误，
 * 同样可能带着对方发来的内容，不要整个写进日志或交给模型。
 */
export class McpError extends Error {
	override name = "McpError";
	readonly kind: McpErrorKind;
	/** `kind` 为 `protocol` 时的 JSON-RPC 错误码。 */
	readonly code?: number;
	/** `kind` 为 `insufficient_scope` 时 server 要求的 scope。 */
	readonly requiredScope?: string;

	constructor(
		kind: McpErrorKind,
		message: string,
		details: McpErrorDetails = {},
	) {
		super(
			message,
			details.cause === undefined ? undefined : { cause: details.cause },
		);
		this.kind = kind;
		this.code = details.code;
		this.requiredScope = details.requiredScope;
	}
}
