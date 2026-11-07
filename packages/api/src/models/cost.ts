import type { Usage } from "../protocol/index.js";
import type { ModelPrice, ModelPriceRates } from "./entry.js";

function minutes(clock: string): number {
	const [hours = 0, mins = 0] = clock.split(":").map(Number);
	return hours * 60 + mins;
}

/**
 * 一次请求的费用（美元）：照 pi，按总输入（输入加缓存读写）选价格档，整次请求按这一档计费；
 * 请求结束时落在某个时段里，再乘以那个时段的倍数。
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
	return (
		((usage.input * rates.input +
			usage.output * rates.output +
			usage.cache_read * rates.cache_read +
			usage.cache_write * rates.cache_write) /
			1_000_000) *
		(period?.factor ?? 1)
	);
}
