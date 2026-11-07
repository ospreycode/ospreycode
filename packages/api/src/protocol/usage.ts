/**
 * 一次模型请求的用量。`input`、`cache_read`、`cache_write` 三项互不包含，`reasoning` 算在
 * `output` 里、另列为子项；各家的口径由转换模块换成这个口径。
 */
export interface Usage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	/** 按模型清单的价格算出的费用（美元）；清单里没有这个模型的价格时为空。 */
	cost_usd?: number;
}
