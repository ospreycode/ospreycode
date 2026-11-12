import type { ArmTrials } from "../runners/coding-benchmark.js";
import {
	type BenchmarkConditions,
	type BenchmarkReport,
	type BenchmarkTask,
	benchmarkReport,
	conditionLines,
	costLines,
	percent,
} from "./benchmark.js";
import {
	formatDifference,
	minimumRuns,
	type PairedDifference,
	pairedDifference,
} from "./memory.js";

/** 一组和基线组相比的结果。 */
export interface BaselineComparison {
	/** 每道题的通过率减去基线组的；没有可以配对的题时没有。 */
	difference?: PairedDifference;
	/** 通过率比基线组高的题，按 id 排序。 */
	improved: string[];
	/** 通过率比基线组低的题，按 id 排序。 */
	regressed: string[];
}

/** 对比实验里的一组。 */
export interface ArmReport {
	name: string;
	description: string;
	/** 这一组自己的汇总，和 `benchmarkReport` 给出的相同。 */
	results: Omit<BenchmarkReport, "conditions">;
	/** 和基线组相比；基线组自己没有。 */
	comparison?: BaselineComparison;
}

/** 对比实验的报告。 */
export interface ComparisonReport {
	/** 各组共同的实验条件；各组不同的那一项写基线组的，差别见各组的 `description`。 */
	conditions: BenchmarkConditions;
	tasks: number;
	/** 每道题在每组里要运行的次数。 */
	runs: number;
	/** 各组，第一组是基线。 */
	arms: ArmReport[];
	/** 不参加配对的题：有一组里没有有效的运行。按 id 排序。 */
	excluded: string[];
}

/**
 * 汇总一次对比实验：每组的成功率和开销，以及其余各组和基线组（第一组）的配对差。
 *
 * 配对差以题为单位：每道题在这一组的通过率减去基线组的，bootstrap 求 95% 置信区间。环境故障的
 * 运行不计入通过率；有一组里没有有效运行的题在哪一组都不参加配对，各组比的才是同一批题。
 */
export function comparisonReport(
	conditions: BenchmarkConditions,
	tasks: readonly BenchmarkTask[],
	runs: number,
	arms: readonly ArmTrials[],
): ComparisonReport {
	if (arms.length < 2) throw new Error("对比实验至少要有两组");
	const names = arms.map((arm) => arm.name);
	if (new Set(names).size !== names.length) throw new Error("组的名字有重复");

	const reports = arms.map((arm) => {
		const { conditions: _, ...results } = benchmarkReport(
			conditions,
			tasks,
			runs,
			arm.trials,
		);
		return results;
	});
	const ids = tasks.map((task) => task.id).sort();
	const rateOf = (report: (typeof reports)[number], id: string) => {
		const task = report.perTask.find((entry) => entry.id === id);
		if (task === undefined) throw new Error(`报告里没有题目 ${id}`);
		return task.valid === 0 ? undefined : task.passed / task.valid;
	};
	const excluded = ids.filter((id) =>
		reports.some((report) => rateOf(report, id) === undefined),
	);
	const paired = ids.filter((id) => !excluded.includes(id));
	const [baseline] = reports as [(typeof reports)[number]];

	return {
		conditions,
		tasks: tasks.length,
		runs,
		arms: arms.map((arm, index): ArmReport => {
			const results = reports[index] as (typeof reports)[number];
			const shared = { name: arm.name, description: arm.description, results };
			if (index === 0) return shared;
			const differences = paired.map((id) => ({
				id,
				value:
					(rateOf(results, id) as number) - (rateOf(baseline, id) as number),
			}));
			return {
				...shared,
				comparison: {
					...(differences.length === 0
						? {}
						: {
								difference: pairedDifference(
									differences.map((difference) => difference.value),
								),
							}),
					improved: differences
						.filter((difference) => difference.value > 0)
						.map((difference) => difference.id),
					regressed: differences
						.filter((difference) => difference.value < 0)
						.map((difference) => difference.id),
				},
			};
		}),
		excluded,
	};
}

/** 把对比实验的报告写成给人看的文本。 */
export function formatComparisonReport(report: ComparisonReport): string {
	const { conditions, arms } = report;
	const [baseline, ...others] = arms as [ArmReport, ...ArmReport[]];
	const names = (ids: readonly string[]) =>
		ids.length === 0 ? "没有" : ids.join("，");
	return [
		`# ${conditions.benchmark}：对比实验`,
		"",
		"## 实验条件",
		"",
		`- ${report.tasks} 道题在每组里各运行 ${report.runs} 次；各组之间只差下面写的一项，其余相同`,
		...(report.runs < minimumRuns
			? [
					`- 每组不足 ${minimumRuns} 次：下面的数字只说明流程走通了，不能据此下结论`,
				]
			: []),
		`- 基线组 ${baseline.name}：${baseline.description}`,
		...others.map((arm) => `- ${arm.name}：${arm.description}`),
		...conditionLines(conditions),
		"",
		"## 结果",
		"",
		`- ${baseline.name}（基线）：成功率 ${percent(baseline.results.overall)}`,
		...others.map((arm) => {
			const { difference } = arm.comparison as BaselineComparison;
			return `- ${arm.name}：成功率 ${percent(arm.results.overall)}；和基线相比 ${difference === undefined ? "没有可以配对的题" : formatDifference(difference)}`;
		}),
		"- 成功率不计入环境故障；配对差以题为单位 bootstrap",
		...(report.excluded.length === 0
			? []
			: [
					`- 不参加配对的题（有一组里没有有效的运行）：${names(report.excluded)}`,
				]),
		"",
		"## 相对基线变好和变差的题",
		"",
		...others.map((arm) => {
			const { improved, regressed } = arm.comparison as BaselineComparison;
			return `- ${arm.name}：变好 ${improved.length} 题（${names(improved)}）；变差 ${regressed.length} 题（${names(regressed)}）`;
		}),
		...arms.flatMap((arm) => [
			"",
			`## ${arm.name} 的失败原因和开销`,
			"",
			`- 环境故障 ${arm.results.environmentFailures.length} 次，没有运行 ${arm.results.missing.length} 次`,
			...costLines(arm.results),
			...arm.results.environmentFailures.map(
				(entry) =>
					`- 环境故障：${entry.task} 第 ${entry.run} 次：${entry.failure}`,
			),
			...arm.results.missing.map(
				(entry) => `- 没有运行：${entry.task} 第 ${entry.run} 次`,
			),
		]),
		"",
		"## 每道题",
		"",
		...baseline.results.perTask.map(
			(task, index) =>
				`- ${task.id}：${arms
					.map((arm) => {
						const own = arm.results.perTask[index] as typeof task;
						return `${arm.name} ${own.passed}/${own.valid}`;
					})
					.join("，")}`,
		),
	].join("\n");
}
