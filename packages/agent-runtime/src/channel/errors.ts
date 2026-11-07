/**
 * 对端发来的消息不合规：超长、不是合法的 UTF-8 或 JSON、形状不对、方法未知、`id` 重复或不符合 schema。
 * 两端出自同一次发布，出现它只能是缺陷或 agent 被攻破，连接随即关闭。
 */
export class ProtocolError extends Error {
	override name = "ProtocolError";
}

/** 通道在请求得到最终响应之前关闭了。 */
export class ChannelClosedError extends Error {
	override name = "ChannelClosedError";
}

/**
 * 请求以错误结束：
 *
 * - `cancelled`：请求被取消，`data` 附上已产生的用量
 * - `no_active_task`：session 空闲或 run 已取消后，仍发来需要进行中 task 的请求
 */
export type ChannelErrorCode = "cancelled" | "no_active_task";

/** 错误响应的内容。 */
export interface ChannelErrorBody {
	code: ChannelErrorCode;
	message: string;
	data?: unknown;
}

/** 请求以错误响应结束；处理请求的一方抛出它来回复错误。 */
export class ChannelRequestError extends Error {
	override name = "ChannelRequestError";
	readonly code: ChannelErrorCode;
	readonly data: unknown;

	constructor(code: ChannelErrorCode, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}

	/** 错误响应里的 `error` 字段。 */
	toBody(): ChannelErrorBody {
		return this.data === undefined
			? { code: this.code, message: this.message }
			: { code: this.code, message: this.message, data: this.data };
	}
}
