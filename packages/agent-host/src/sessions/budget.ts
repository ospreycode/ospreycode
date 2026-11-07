import type { Usage } from "@ospreycode/api/protocol";
import type { RunLimits } from "../config/session-config.js";

/** 超出的是哪一项上限：费用、模型请求次数、时间。 */
export type BudgetLimit = "cost" | "requests" | "duration";

/** 超出的那一项、当前的上限和已用的量（美元、次数、毫秒）。 */
export interface BudgetExceeded {
	limit: BudgetLimit;
	max: number;
	used: number;
}

/**
 * 一个 run 的额度。steering 共用所在 run 的额度，follow-up 和后台通知开始的 task 各有一份；
 * 超出时可以追加一份和初始上限相同的额度。
 */
export class RunBudget {
	#limits: RunLimits;
	#shares = 1;
	#requests = 0;
	readonly #startedAt = Date.now();

	constructor(limits: RunLimits) {
		this.#limits = limits;
	}

	/** 发出一次模型请求：重试和 401 后的重发都算。 */
	count(): void {
		this.#requests += 1;
	}

	/** 追加一份和初始上限相同的额度。 */
	extend(): void {
		this.#shares += 1;
	}

	/** 下一次请求之前已经用完的那一项；都没用完时为空。 */
	exceeded(usage: Usage): BudgetExceeded | undefined {
		const { maxCostUsd, maxRequests, maxDurationMs } = this.#limits;
		const checks: [BudgetLimit, number | null, number][] = [
			["requests", maxRequests, this.#requests],
			["cost", maxCostUsd, usage.cost_usd ?? 0],
			["duration", maxDurationMs, Date.now() - this.#startedAt],
		];
		for (const [limit, initial, used] of checks) {
			if (initial !== null && used >= initial * this.#shares) {
				return { limit, max: initial * this.#shares, used };
			}
		}
		return undefined;
	}
}
