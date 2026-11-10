import { appendFileSync } from "node:fs";
import { expect, inject } from "vitest";
import { ledgerTotal } from "./model-keys.js";

/** 一次运行全部模型测试的费用上限（美元），超过后其余模型测试失败。 */
export const runCostLimitUsd = 1;

/** 每个模型测试的 run 显式给出的上限：0.05 美元、20 次模型请求、5 分钟。 */
export const testRunLimits = {
	maxCostUsd: 0.05,
	maxRequests: 20,
	maxDurationMs: 5 * 60_000,
} as const;

/**
 * 只重跑一次的失败的开头：模型服务的限流、服务过载、网络中断和超时。vitest.config.ts 里 `model` 标签的
 * `retry.condition` 按它识别，断言失败不重跑。
 */
export const transientPrefix = "模型服务暂时不可用";

const transientCategories = new Set(["rate_limit", "overloaded", "network"]);

function transient(category: string, message: string): Error {
	return new Error(`${transientPrefix}（${category}）：${message}`);
}

/** 模型请求的错误：临时故障抛出可以重跑的错误，其余的按断言失败报告。 */
export function expectNoModelError(
	error: { category: string; message: string } | undefined,
): void {
	if (error !== undefined && transientCategories.has(error.category)) {
		throw transient(error.category, error.message);
	}
	expect(error).toBeUndefined();
}

/** task 因为模型服务的临时故障失败时抛出可以重跑的错误；runtime 把错误写成 `类别: 信息`。 */
export function throwIfTransient(task: {
	outcome: string;
	error?: string;
}): void {
	if (task.outcome !== "failed" || task.error === undefined) return;
	const separator = task.error.indexOf(": ");
	if (separator === -1) return;
	const category = task.error.slice(0, separator);
	if (transientCategories.has(category)) {
		throw transient(category, task.error.slice(separator + 2));
	}
}

/** 每个模型测试开始前检查：这次运行的合计超过上限后，其余模型测试失败。 */
export function checkLedger(): void {
	const spent = ledgerTotal(inject("modelLedger"));
	if (spent > runCostLimitUsd) {
		throw new Error(
			`这次运行的模型测试已经花了 ${spent.toFixed(4)} 美元，超过上限 ${runCostLimitUsd} 美元`,
		);
	}
}

/**
 * 把一次模型请求或一个 task 的费用记进这次运行的账本，在断言之前调用：失败的和重跑的也要算。
 * 测试用的模型都有价格，用了 token 却没有费用时报错，账本不能漏记。
 */
export function charge(usage: {
	input: number;
	output: number;
	cost_usd?: number;
}): void {
	if (usage.cost_usd === undefined && usage.input + usage.output > 0) {
		throw new Error("这次用量没有费用：模型测试用的模型要有价格，账本才能记");
	}
	appendFileSync(inject("modelLedger"), `${usage.cost_usd ?? 0}\n`);
}
