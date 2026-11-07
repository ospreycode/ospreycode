import type { ProtocolName } from "../protocol/index.js";

/** 每百万 token 的价格（美元），四项和用量的口径相同。 */
export interface ModelPrice {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
}

/**
 * 模型清单的一个条目：模型用哪个协议、在哪个服务上、能力和价格。runtime 只发清单里的 ID，
 * 地址、协议和价格一律以清单为准。
 */
export interface ModelEntry {
	/** 清单里的 ID，runtime 的请求里写的就是它。 */
	id: string;
	protocol: ProtocolName;
	/** 模型服务名，也是这个服务的凭据的 ID。 */
	service: string;
	/** 服务的接口地址，如 `https://api.anthropic.com/v1`。 */
	base_url: string;
	/** 发给服务的模型名。 */
	model: string;
	context_window: number;
	max_output_tokens: number;
	/** 没有价格时不计费用。 */
	price?: ModelPrice;
}
