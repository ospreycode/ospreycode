import type { Usage } from "../protocol/index.js";
import type { ModelPrice, ModelPriceRates } from "./entry.js";

function minutes(clock: string): number {
	const [hours = 0, mins = 0] = clock.split(":").map(Number);
	return hours * 60 + mins;
}

/** 服务端工具的费用（美元）：计费的次数乘以每一千次的价格。清单里没有价格的工具是清单的缺陷。 */
export function serverToolsCost(price: ModelPrice, usage: Usage): number {
	let cost = 0;
	for (const [name, calls] of Object.entries(usage.server_tools ?? {})) {
		const rate = (price.server_tools as Record<string, number> | undefined)?.[
			name
		];
		if (rate === undefined) {
			throw new Error(`模型清单的价格里没有服务端工具 ${name}`);
		}
		cost += (calls * rate) / 1000;
	}
	return cost;
}

/**
 * 一次请求的费用（美元）：照 pi，按总输入（输入加缓存读写）选价格档，整次请求按这一档计费；
 * 请求结束时落在某个时段里，再乘以那个时段的倍数；已经到期的调价逐个乘上。服务端工具按次另计。
 */
export function computeCost(price: ModelPrice, usage: Usage, at: Date): number {
	const totalInput = usage.input + usage.cache_read + usage.cache_write;
	const tier = [...(price.tiers ?? [])]
		.sort((a, b) => b.above_input_tokens - a.above_input_tokens)
		.find((candidate) => totalInput > candidate.above_input_tokens);
	const rates: ModelPriceRates = tier ?? price;
	const now = at.getUTCHours() * 60 + at.getUTCMinutes();
	const period = (price.periods ?? []).find(
		(candidate) =>
			candidate.days.includes(at.getUTCDay()) &&
			now >= minutes(candidate.from) &&
			now < minutes(candidate.to),
	);
	const day = at.toISOString().slice(0, 10);
	const changed = (price.changes ?? [])
		.filter((change) => day >= change.from)
		.reduce((factor, change) => factor * change.factor, 1);
	return (
		((usage.input * rates.input +
			usage.output * rates.output +
			usage.cache_read * rates.cache_read +
			usage.cache_write * rates.cache_write) /
			1_000_000) *
			(period?.factor ?? 1) *
			changed +
		serverToolsCost(price, usage)
	);
}
