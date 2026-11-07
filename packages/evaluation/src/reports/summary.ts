import type { ScenarioResult } from "../runners/scenario.js";

/** 一组场景的汇总：通过的个数、全部场景（不只是通过的）的费用和耗时。 */
export interface Summary {
	passed: number;
	total: number;
	/** 有场景的模型没有价格时为空。 */
	costUsd: number | undefined;
	durationMs: number;
	results: ScenarioResult[];
}

/** 汇总一组场景的结果。 */
export function summarize(results: ScenarioResult[]): Summary {
	const costs = results.map((result) => result.usage.cost_usd);
	return {
		passed: results.filter((result) => result.passed).length,
		total: results.length,
		costUsd: costs.every((cost) => cost !== undefined)
			? costs.reduce((sum, cost) => sum + cost, 0)
			: undefined,
		durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
		results,
	};
}

/** 把汇总写成给人看的文本，每个场景一行，不通过的列出原因。 */
export function formatSummary(summary: Summary): string {
	const lines = summary.results.map((result) => {
		const status = result.passed ? "通过" : "不通过";
		const detail =
			result.problems.length === 0 ? "" : `：${result.problems.join("；")}`;
		const { input, cache_read, cache_write, output } = result.usage;
		const tokens = input + cache_read + cache_write + output;
		return `- ${status} ${result.scenario}（${result.outcome ?? "未结束"}，${result.durationMs} 毫秒，${tokens} token）${detail}`;
	});
	const cost =
		summary.costUsd === undefined
			? "未知"
			: `${summary.costUsd.toFixed(4)} 美元`;
	return [
		`${summary.passed}/${summary.total} 个场景通过，共 ${summary.durationMs} 毫秒，费用 ${cost}`,
		...lines,
	].join("\n");
}
