import type { BudgetLimit, TaskOutcome } from "@ospreycode/agent-host";
import type { CodingTrial, Denials } from "../traces/coding-trials.js";

/** 报告里的一道题：按它的仓库、语言和所属的部分分组。 */
export interface BenchmarkTask {
	id: string;
	repository: string;
	language: string;
	/** 开发题还是保留题。 */
	split: string;
}

/** 每个 run 的上限，运行评测的人显式给出全部三项。 */
export interface RunLimits {
	maxCostUsd: number | "none";
	maxRequests: number | "none";
	timeoutSec: number;
}

/** 实验条件：写进报告，结果只在这些条件下成立。 */
export interface BenchmarkConditions {
	/** benchmark 的名字。 */
	benchmark: string;
	/** 固定的数据版本：仓库和 commit、镜像怎么固定、抽样种子。 */
	dataset: string;
	/** 运行器和它的版本，以及任务环境（如 `Pier 0.3.1，docker`）。 */
	runner: string;
	model: string;
	/** 所用的模型协议。 */
	protocol: string;
	/** 提示和配置：题目说明之外加了什么，用户级配置里有什么。 */
	prompt: string;
	/** 被测的 commit。 */
	commit: string;
	/** 各包共用的版本号（含 `sandbox` 包）。 */
	version: string;
	sandboxMode: string;
	approvalPolicy: string;
	/** 权限规则文件的全文。 */
	rules: string;
	limits: RunLimits;
	/** 记忆快照；没有启用记忆时写明。 */
	memory: string;
	/** 任务环境的操作系统。 */
	os: string;
}

/** 通过的次数和有效的次数；有效的次数不含环境故障。 */
export interface Rate {
	passed: number;
	valid: number;
}

/** 一组题（同一种语言、同一个仓库或同一部分）的成功率。 */
export interface GroupRate extends Rate {
	name: string;
}

/** 一道题各次运行的结果。 */
export interface TaskRuns extends Rate {
	id: string;
	environmentFailures: number;
	/** 没有运行的次数。 */
	missing: number;
}

/**
 * 没通过的有效运行按 CLI 的结果分开：主任务以哪种结果结束。`killed` 是 CLI 被强制结束、没有结果；
 * `completed` 是 task 正常完成但测试没过。
 */
export type FailureCauses = Record<TaskOutcome | "killed", number>;

/** 编码 benchmark 的报告。 */
export interface BenchmarkReport {
	conditions: BenchmarkConditions;
	tasks: number;
	/** 每道题要运行的次数。 */
	runs: number;
	/** 全部运行合在一起的成功率。 */
	overall: Rate;
	/** 每次运行各自的成功率，按第几次运行排列：它们的范围就是结果的波动范围。 */
	perRun: Rate[];
	/** 每道题各次运行的结果，按 id 排序。 */
	perTask: TaskRuns[];
	/** 有效的运行里每次都通过、每次都不通过、有时通过的题数。 */
	stability: { always: number; never: number; mixed: number };
	bySplit: GroupRate[];
	byLanguage: GroupRate[];
	byRepository: GroupRate[];
	/** 环境故障的运行和原因。 */
	environmentFailures: { task: string; run: number; failure: string }[];
	/** 清单里有、结果里没有的运行。 */
	missing: { task: string; run: number }[];
	/** 超出预算的次数，按超出的是哪一项分开；通过了的运行也算。 */
	overBudget: Record<BudgetLimit, number>;
	failureCauses: FailureCauses;
	/** 有用量的运行的费用合计（不只是通过的）；有运行的模型没有价格时为空。 */
	costUsd: number | undefined;
	/** 有用量的运行的 token 合计。 */
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
	};
	/** 有用量的运行次数：agent 没有运行或 CLI 被强制结束的运行没有用量。 */
	measured: number;
	/** agent 运行时间的合计，和记下了时间的运行次数。 */
	durationMs: number;
	timed: number;
	denials: Denials;
}

function rate(trials: readonly CodingTrial[]): Rate {
	return {
		passed: trials.filter((trial) => trial.status === "passed").length,
		valid: trials.filter((trial) => trial.status !== "environment_failure")
			.length,
	};
}

/**
 * 汇总一批运行的结果。`tasks` 是要运行的题，`runs` 是每道题要运行的次数：结果里缺的运行
 * 列在 `missing` 里，不在清单里的题和重复的运行报错。
 */
export function benchmarkReport(
	conditions: BenchmarkConditions,
	tasks: readonly BenchmarkTask[],
	runs: number,
	trials: readonly CodingTrial[],
): BenchmarkReport {
	const byTask = new Map<string, CodingTrial[]>(
		tasks.map((task) => [task.id, []]),
	);
	for (const trial of trials) {
		const sameTask = byTask.get(trial.task);
		if (sameTask === undefined) {
			throw new Error(`结果里的 ${trial.task} 不在要运行的题里`);
		}
		if (!Number.isInteger(trial.run) || trial.run < 1 || trial.run > runs) {
			throw new Error(
				`${trial.task} 的第 ${trial.run} 次运行超出了 ${runs} 次`,
			);
		}
		if (sameTask.some((other) => other.run === trial.run)) {
			throw new Error(`${trial.task} 的第 ${trial.run} 次运行有两份结果`);
		}
		sameTask.push(trial);
	}

	const perTask = tasks
		.map((task) => {
			const own = byTask.get(task.id) as CodingTrial[];
			return {
				id: task.id,
				...rate(own),
				environmentFailures: own.filter(
					(trial) => trial.status === "environment_failure",
				).length,
				missing: runs - own.length,
			};
		})
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	const graded = perTask.filter((task) => task.valid > 0);

	const groups = (key: (task: BenchmarkTask) => string): GroupRate[] =>
		[...new Set(tasks.map(key))].sort().map((name) => ({
			name,
			...rate(
				tasks
					.filter((task) => key(task) === name)
					.flatMap((task) => byTask.get(task.id) as CodingTrial[]),
			),
		}));

	const usages = trials.flatMap((trial) =>
		trial.usage === undefined ? [] : [trial.usage],
	);
	const sum = (values: readonly number[]) =>
		values.reduce((total, value) => total + value, 0);
	const costs = usages.map((usage) => usage.cost_usd);
	const durations = trials.flatMap((trial) =>
		trial.durationMs === undefined ? [] : [trial.durationMs],
	);
	const denied = (key: keyof Denials) =>
		sum(trials.map((trial) => trial.denials[key]));
	const exceeded = (limit: BudgetLimit) =>
		trials.filter((trial) => trial.exceeded === limit).length;
	const failureCauses: FailureCauses = {
		completed: 0,
		failed: 0,
		budget_exceeded: 0,
		cancelled: 0,
		refused: 0,
		killed: 0,
	};
	for (const trial of trials) {
		if (trial.status === "failed")
			failureCauses[trial.outcome ?? "killed"] += 1;
	}

	return {
		conditions,
		tasks: tasks.length,
		runs,
		overall: rate(trials),
		perRun: Array.from({ length: runs }, (_, index) =>
			rate(trials.filter((trial) => trial.run === index + 1)),
		),
		perTask,
		stability: {
			always: graded.filter((task) => task.passed === task.valid).length,
			never: graded.filter((task) => task.passed === 0).length,
			mixed: graded.filter(
				(task) => task.passed > 0 && task.passed < task.valid,
			).length,
		},
		bySplit: groups((task) => task.split),
		byLanguage: groups((task) => task.language),
		byRepository: groups((task) => task.repository),
		environmentFailures: trials.flatMap((trial) =>
			trial.status === "environment_failure"
				? [{ task: trial.task, run: trial.run, failure: trial.failure }]
				: [],
		),
		missing: tasks.flatMap((task) => {
			const own = byTask.get(task.id) as CodingTrial[];
			return Array.from({ length: runs }, (_, index) => index + 1)
				.filter((run) => !own.some((trial) => trial.run === run))
				.map((run) => ({ task: task.id, run }));
		}),
		overBudget: {
			cost: exceeded("cost"),
			requests: exceeded("requests"),
			duration: exceeded("duration"),
		},
		failureCauses,
		costUsd: costs.every((cost) => cost !== undefined)
			? sum(costs as number[])
			: undefined,
		tokens: {
			input: sum(usages.map((usage) => usage.input)),
			output: sum(usages.map((usage) => usage.output)),
			cache_read: sum(usages.map((usage) => usage.cache_read)),
			cache_write: sum(usages.map((usage) => usage.cache_write)),
		},
		measured: usages.length,
		durationMs: sum(durations),
		timed: durations.length,
		denials: {
			forbidden: denied("forbidden"),
			sudo: denied("sudo"),
			dangerous: denied("dangerous"),
			prompt: denied("prompt"),
			escalation: denied("escalation"),
			mcp: denied("mcp"),
			other: denied("other"),
		},
	};
}

function limit(value: number | "none", unit: string): string {
	return value === "none" ? "不限" : `${value} ${unit}`;
}

/** 实验条件的各行，权限规则文件的全文在最后。对比实验的报告也用它。 */
export function conditionLines(conditions: BenchmarkConditions): string[] {
	return [
		`- 数据：${conditions.dataset}`,
		`- 运行器：${conditions.runner}；任务环境的操作系统：${conditions.os}`,
		`- 模型：${conditions.model}（${conditions.protocol}）`,
		`- 提示和配置：${conditions.prompt}`,
		`- 被测的 commit：${conditions.commit}，版本 ${conditions.version}`,
		`- 沙盒模式：${conditions.sandboxMode}；审批策略：${conditions.approvalPolicy}`,
		`- 每个 run 的上限：费用 ${limit(conditions.limits.maxCostUsd, "美元")}，模型请求 ${limit(conditions.limits.maxRequests, "次")}，时间 ${conditions.limits.timeoutSec} 秒`,
		`- 记忆：${conditions.memory}`,
		"- 权限规则文件：",
		"",
		"```toml",
		conditions.rules.trimEnd(),
		"```",
	];
}

/**
 * 一批运行的失败原因和开销各占一行：失败原因、超出预算、费用、token、时间和被拒的工具调用。
 * 对比实验的报告每组各用一次。
 */
export function costLines(
	report: Pick<
		BenchmarkReport,
		| "failureCauses"
		| "overBudget"
		| "costUsd"
		| "measured"
		| "tokens"
		| "durationMs"
		| "timed"
		| "denials"
	>,
): string[] {
	const { failureCauses, overBudget, denials, tokens } = report;
	const cost =
		report.costUsd === undefined
			? "未知（模型没有价格）"
			: `${report.costUsd.toFixed(4)} 美元，平均每次 ${(report.measured === 0 ? 0 : report.costUsd / report.measured).toFixed(4)} 美元`;
	const minutes = (milliseconds: number) => (milliseconds / 60000).toFixed(1);
	const failed = Object.values(failureCauses).reduce(
		(total, count) => total + count,
		0,
	);
	return [
		`- 没通过的有效运行 ${failed} 次：task 正常完成但测试没过 ${failureCauses.completed}，超出预算 ${failureCauses.budget_exceeded}，task 失败 ${failureCauses.failed}，模型拒绝 ${failureCauses.refused}，被取消 ${failureCauses.cancelled}，CLI 被强制结束 ${failureCauses.killed}`,
		`- 超出预算 ${overBudget.cost + overBudget.requests + overBudget.duration} 次：费用 ${overBudget.cost}，请求次数 ${overBudget.requests}，时间 ${overBudget.duration}`,
		`- 费用（${report.measured} 次有用量的运行，不只是通过的）：${cost}`,
		`- token：输入 ${tokens.input}，缓存读取 ${tokens.cache_read}，缓存写入 ${tokens.cache_write}，输出 ${tokens.output}`,
		`- agent 运行时间（${report.timed} 次）：共 ${minutes(report.durationMs)} 分钟，平均每次 ${report.timed === 0 ? "0.0" : minutes(report.durationMs / report.timed)} 分钟`,
		`- 被拒的工具调用：内置 forbidden ${denials.forbidden} 次（其中带 sudo 的 ${denials.sudo} 次），危险命令判断 ${denials.dangerous} 次，prompt 规则 ${denials.prompt} 次，越界申请 ${denials.escalation} 次，MCP ${denials.mcp} 次，其他 ${denials.other} 次`,
	];
}

/** 成功率写成百分数，后面带通过的次数和有效的次数。 */
export function percent({ passed, valid }: Rate): string {
	return valid === 0
		? "没有有效的运行"
		: `${((passed / valid) * 100).toFixed(1)}%（${passed}/${valid}）`;
}

/** 把报告写成给人看的文本。 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
	const { conditions, overall, stability } = report;
	const total = report.tasks * report.runs;
	const rates = report.perRun
		.filter((run) => run.valid > 0)
		.map((run) => run.passed / run.valid);
	const range =
		rates.length === 0
			? "没有有效的运行"
			: `${(Math.min(...rates) * 100).toFixed(1)}% 到 ${(Math.max(...rates) * 100).toFixed(1)}%`;
	const group = (title: string, rows: readonly GroupRate[]) => [
		`${title}：`,
		...rows.map((row) => `- ${row.name}：${percent(row)}`),
	];
	return [
		`# ${conditions.benchmark}`,
		"",
		"## 实验条件",
		"",
		...conditionLines(conditions),
		"",
		"## 结果",
		"",
		`- 成功率：${percent(overall)}，环境故障不计入`,
		`- ${report.tasks} 道题各运行 ${report.runs} 次，共 ${total} 次：环境故障 ${report.environmentFailures.length} 次，没有运行 ${report.missing.length} 次`,
		`- 各次运行的成功率：${report.perRun.map(percent).join("，")}；范围 ${range}`,
		`- 每次都通过 ${stability.always} 题，每次都不通过 ${stability.never} 题，有时通过 ${stability.mixed} 题`,
		...costLines(report),
		"",
		...group("按题目所属的部分", report.bySplit),
		"",
		...group("按语言", report.byLanguage),
		"",
		...group("按仓库", report.byRepository),
		"",
		"## 每道题",
		"",
		...report.perTask.map((task) => {
			const notes = [
				...(task.environmentFailures === 0
					? []
					: [`环境故障 ${task.environmentFailures} 次`]),
				...(task.missing === 0 ? [] : [`没有运行 ${task.missing} 次`]),
			];
			return `- ${task.id}：${task.passed}/${task.valid}${notes.length === 0 ? "" : `（${notes.join("，")}）`}`;
		}),
		...(report.environmentFailures.length === 0
			? []
			: [
					"",
					"## 环境故障",
					"",
					...report.environmentFailures.map(
						(entry) => `- ${entry.task} 第 ${entry.run} 次：${entry.failure}`,
					),
				]),
		...(report.missing.length === 0
			? []
			: [
					"",
					"## 没有运行",
					"",
					...report.missing.map(
						(entry) => `- ${entry.task} 第 ${entry.run} 次`,
					),
				]),
	].join("\n");
}
