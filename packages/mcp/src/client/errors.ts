import {
	InsufficientScopeError,
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { McpError } from "../protocol/errors.js";

/** 转换错误时要知道的事。 */
export interface ErrorContext {
	/** 当时在做什么，写在错误消息的开头，如"连接 MCP server"。 */
	action: string;
	/** 调用方给的中止信号。 */
	signal?: AbortSignal | undefined;
	/** 连接还没建立。 */
	connecting?: boolean;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 在包的边界把 SDK 抛出的错误换成 `McpError`，原始错误放在 `cause` 里。
 * 授权类的错误只用固定的消息：SDK 的消息里可能带着授权服务器发来的内容。
 */
export function toMcpError(error: unknown, context: ErrorContext): McpError {
	if (error instanceof McpError) return error;
	const { action, signal } = context;
	// SDK 把中止和超时报成同一个错误码，传输被中止时还会报成别的错误：只要信号已经中止就算取消
	if (signal?.aborted) {
		return new McpError("cancelled", `${action}：已取消`, { cause: error });
	}
	if (error instanceof InsufficientScopeError) {
		return new McpError(
			"insufficient_scope",
			`${action}：令牌的权限不够，要重新登录提升权限`,
			{ cause: error, requiredScope: error.requiredScope },
		);
	}
	if (
		error instanceof UnauthorizedError ||
		(error instanceof SdkHttpError && error.status === 401)
	) {
		return new McpError(
			"unauthorized",
			`${action}：没有有效的令牌，要（重新）登录`,
			{ cause: error },
		);
	}
	if (error instanceof ProtocolError) {
		return new McpError(
			"protocol",
			`${action}：server 返回错误 ${error.code}：${error.message}`,
			{ cause: error, code: error.code },
		);
	}
	if (error instanceof SdkError) {
		if (error.code === SdkErrorCode.RequestTimeout) {
			return new McpError("timeout", `${action}：超时`, { cause: error });
		}
		// 握手完成前 server 退出算连接失败，不算"连接已经断了"
		if (
			!context.connecting &&
			(error.code === SdkErrorCode.ConnectionClosed ||
				error.code === SdkErrorCode.NotConnected)
		) {
			return new McpError("closed", `${action}：连接已经断了`, {
				cause: error,
			});
		}
	}
	return new McpError("transport", `${action}：${messageOf(error)}`, {
		cause: error,
	});
}
