import type { HostEvent, RunLimits } from "@ospreycode/agent-host";
import type { Usage } from "@ospreycode/api/protocol";
import {
	type MaintenanceSession,
	type MemoryGroup,
	type MemorySession,
	type MemoryTrial,
	memoryExperimentPermissions,
	memoryGroups,
	type ProbeCounters,
} from "../runners/memory-experiment.js";
import {
	type MemoryFailure,
	memoryFailures,
	toolCalls,
} from "../traces/memory-trials.js";

/** bootstrap 重抽样的次数。 */
export const bootstrapResamples = 10_000;

/** bootstrap 用的固定种子：同一批结果每次算出同样的区间。 */
export const bootstrapSeed = 20261111;

/** 每组至少运行这么多次才能下结论。 */
export const minimumRuns = 3;

/** 实验条件：写进报告，结果只在这些条件下成立。每个模型一份报告。 */
export interface MemoryConditions {
	model: string;
	/** 所用的模型协议。 */
	protocol: string;
	reasoningEffort: string;
	/** 被测的 commit。 */
	commit: string;
	/** 各包共用的版本号。 */
	version: string;
	os: string;
	/** 权限规则文件的全文。 */
	rules: string;
	/** 每个 run 的上限。 */
	budget: RunLimits;
	/** 每个会话的时间上限。 */
	timeoutMs: number;
}

/**
 * 和无记忆组的配对差：每道题的通过率减去无记忆组的，各题取平均；`low` 和 `high` 是以题为单位
 * bootstrap 得到的 95% 置信区间。
 */
export interface PairedDifference {
	tasks: number;
	mean: number;
	low: number;
	high: number;
}

/** 一批 session 的开销合计。 */
export interface SessionCost {
	sessions: number;
	/** 有 session 的模型没有价格时为空。 */
	costUsd: number | undefined;
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
	};
	durationMs: number;
}

/** 一种状态（没有记忆或已有记忆）下各个会话的开销合计。 */
export interface PhaseCost extends SessionCost {
	toolCalls: number;
	/** 以 `budget_exceeded` 结束的会话。 */
	overBudget: number;
	/** 到时间上限被取消的会话。 */
	timedOut: number;
}

/** 一个组的结果。 */
export interface GroupResult {
	group: MemoryGroup;
	passed: number;
	trials: number;
	/** 和无记忆组的配对差；无记忆组自己没有。 */
	difference?: PairedDifference;
	/** 检验会话里的计数合计。 */
	counters: ProbeCounters;
	/** 学习会话：没有记忆的状态。 */
	cold: PhaseCost;
	/** 检验会话：已有记忆的状态。 */
	warm: PhaseCost;
	/** 会话之间整理记忆的 session：提取记忆的开销在这里。 */
	maintenance: SessionCost;
}

/** 按无记忆时的通过次数分出的一层。 */
export interface Stratum {
	/** 无记忆时从不通过、有时通过、每次通过。 */
	name: "never" | "sometimes" | "always";
	tasks: number;
	/** 这一层里各组和无记忆组的配对差。 */
	differences: (PairedDifference & { group: MemoryGroup })[];
}

/** 完整 memory 组自己的数字。 */
export interface MemoryGroupDetail {
	/** 这一组做 task 的会话数（学习会话和检验会话）。 */
	sessions: number;
	extraction: {
		/** 提取的次数。 */
		runs: number;
		requests: number;
		tokens: { input: number; output: number };
		/** 有提取的模型没有价格时为空。 */
		costUsd: number | undefined;
		/** 提取记下的候选。 */
		candidates: number;
		/** 模型写出、没有记下的条数。 */
		dropped: number;
	};
	/** task 结束时列出的候选（模型用 `memory_propose` 提议的）。 */
	proposed: number;
	confirmations: number;
	/** 各个会话的索引 token 合计。 */
	indexTokens: number;
	/** 没通过的运行归到五类的次数。 */
	failures: Record<MemoryFailure, number>;
}

/** memory 对比实验的报告。 */
export interface MemoryReport {
	conditions: MemoryConditions;
	tasks: number;
	/** 每道题在每个组里运行的次数。 */
	runs: number;
	groups: GroupResult[];
	strata: Stratum[];
	/** 每道题各组通过的次数，按题目名字排序。 */
	perTask: { task: string; passed: Record<MemoryGroup, number> }[];
	memory: MemoryGroupDetail;
}

/** mulberry32：种子固定时给出固定的 [0, 1) 序列。 */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const sum = (values: readonly number[]) =>
	values.reduce((total, value) => total + value, 0);

const mean = (values: readonly number[]) => sum(values) / values.length;

/**
 * 以题为单位做 bootstrap：`differences` 是每道题的通过率之差，有放回地抽同样多的题、取平均，
 * 重复 `bootstrapResamples` 次，取 2.5% 和 97.5% 分位。
 */
export function pairedDifference(
	differences: readonly number[],
): PairedDifference {
	if (differences.length === 0) throw new Error("没有可以比较的题");
	const next = random(bootstrapSeed);
	const means = Array.from({ length: bootstrapResamples }, () =>
		mean(
			differences.map(
				() => differences[Math.floor(next() * differences.length)] as number,
			),
		),
	).sort((a, b) => a - b);
	return {
		tasks: differences.length,
		mean: mean(differences),
		low: means[Math.floor(bootstrapResamples * 0.025)] as number,
		high: means[Math.ceil(bootstrapResamples * 0.975) - 1] as number,
	};
}

function eventsOf<T extends HostEvent["type"]>(
	sessions: readonly MaintenanceSession[],
	type: T,
): Extract<HostEvent, { type: T }>[] {
	return sessions.flatMap((session) =>
		session.events.filter(
			(event): event is Extract<HostEvent, { type: T }> => event.type === type,
		),
	);
}

function totalCost(usages: readonly Usage[]): number | undefined {
	const costs = usages.map((usage) => usage.cost_usd);
	return costs.every((cost) => cost !== undefined)
		? sum(costs as number[])
		: undefined;
}

function sessionCost(sessions: readonly MaintenanceSession[]): SessionCost {
	const usages = sessions.map((session) => session.usage);
	return {
		sessions: sessions.length,
		costUsd: totalCost(usages),
		tokens: {
			input: sum(usages.map((usage) => usage.input)),
			output: sum(usages.map((usage) => usage.output)),
			cache_read: sum(usages.map((usage) => usage.cache_read)),
			cache_write: sum(usages.map((usage) => usage.cache_write)),
		},
		durationMs: sum(sessions.map((session) => session.durationMs)),
	};
}

function phaseCost(sessions: readonly MemorySession[]): PhaseCost {
	return {
		...sessionCost(sessions),
		toolCalls: sum(sessions.map((session) => toolCalls(session.events).length)),
		overBudget: sessions.filter(
			(session) => session.outcome === "budget_exceeded",
		).length,
		timedOut: sessions.filter((session) => session.outcome === undefined)
			.length,
	};
}

/**
 * 汇总一次对比实验的结果。每道题在每个组里的运行次数要相同，否则报错：配对比较要求各组的题和
 * 次数一一对应。
 */
export function memoryReport(
	conditions: MemoryConditions,
	trials: readonly MemoryTrial[],
): MemoryReport {
	const tasks = [...new Set(trials.map((trial) => trial.task))].sort();
	const runs = Math.max(...trials.map((trial) => trial.run));
	const of = (task: string, group: MemoryGroup) =>
		trials.filter((trial) => trial.task === task && trial.group === group);
	for (const task of tasks) {
		for (const group of memoryGroups) {
			const count = of(task, group).length;
			if (count !== runs) {
				throw new Error(
					`${task} 在 ${group} 组里有 ${count} 次运行，应当是 ${runs} 次`,
				);
			}
		}
	}
	const rate = (task: string, group: MemoryGroup) =>
		of(task, group).filter((trial) => trial.passed).length / runs;
	const difference = (group: MemoryGroup, among: readonly string[]) =>
		pairedDifference(
			among.map((task) => rate(task, group) - rate(task, "none")),
		);
	const compared = memoryGroups.filter((group) => group !== "none");

	const groups = memoryGroups.map((group): GroupResult => {
		const own = trials.filter((trial) => trial.group === group);
		const counter = (key: keyof ProbeCounters) =>
			sum(own.map((trial) => trial.counters[key]));
		return {
			group,
			passed: own.filter((trial) => trial.passed).length,
			trials: own.length,
			...(group === "none" ? {} : { difference: difference(group, tasks) }),
			counters: {
				repeatedCalls: counter("repeatedCalls"),
				repeatedReads: counter("repeatedReads"),
				repeatedFailures: counter("repeatedFailures"),
				staleUses: counter("staleUses"),
			},
			cold: phaseCost(own.flatMap((trial) => trial.learn)),
			warm: phaseCost(own.map((trial) => trial.probe)),
			maintenance: sessionCost(own.flatMap((trial) => trial.maintenance)),
		};
	});

	const stratumOf = (task: string): Stratum["name"] => {
		const passed = of(task, "none").filter((trial) => trial.passed).length;
		return passed === 0 ? "never" : passed === runs ? "always" : "sometimes";
	};
	const strata = (["never", "sometimes", "always"] as const).flatMap(
		(name): Stratum[] => {
			const among = tasks.filter((task) => stratumOf(task) === name);
			if (among.length === 0) return [];
			return [
				{
					name,
					tasks: among.length,
					differences: compared.map((group) => ({
						group,
						...difference(group, among),
					})),
				},
			];
		},
	);

	const full = trials.filter((trial) => trial.group === "memory");
	const sessions = full.flatMap((trial) => [...trial.learn, trial.probe]);
	const all = [...sessions, ...full.flatMap((trial) => trial.maintenance)];
	const extractions = eventsOf(all, "memory.extraction.ended");
	return {
		conditions,
		tasks: tasks.length,
		runs,
		groups,
		strata,
		perTask: tasks.map((task) => ({
			task,
			passed: Object.fromEntries(
				memoryGroups.map((group) => [
					group,
					of(task, group).filter((trial) => trial.passed).length,
				]),
			) as Record<MemoryGroup, number>,
		})),
		memory: {
			sessions: sessions.length,
			extraction: {
				runs: extractions.length,
				requests: sum(extractions.map((event) => event.requests)),
				tokens: {
					input: sum(extractions.map((event) => event.usage.input)),
					output: sum(extractions.map((event) => event.usage.output)),
				},
				costUsd: totalCost(extractions.map((event) => event.usage)),
				candidates: sum(extractions.map((event) => event.candidate_ids.length)),
				dropped: sum(extractions.map((event) => event.dropped)),
			},
			proposed: sum(
				eventsOf(sessions, "memory.candidates").map(
					(event) => event.candidates.length,
				),
			),
			confirmations: eventsOf(all, "memory.updated").filter(
				(event) => event.change === "confirmed",
			).length,
			indexTokens: sum(sessions.map((session) => session.indexTokens)),
			failures: Object.fromEntries(
				memoryFailures.map((failure) => [
					failure,
					full.filter((trial) => trial.failure === failure).length,
				]),
			) as Record<MemoryFailure, number>,
		},
	};
}

const groupNames: Record<MemoryGroup, string> = {
	none: "无记忆",
	history: "直接提供历史",
	retrieval: "只检索",
	memory: "完整 memory",
	irrelevant: "等长无关记忆",
};

const failureNames: Record<MemoryFailure, string> = {
	stale_misuse: "误用过期记忆",
	not_written: "没写入",
	not_confirmed: "没确认",
	not_retrieved: "没检索到",
	retrieved_not_used: "检索到但没用",
};

const stratumNames: Record<Stratum["name"], string> = {
	never: "无记忆时从不通过",
	sometimes: "无记忆时有时通过",
	always: "无记忆时每次通过",
};

function percent(passed: number, total: number): string {
	return `${((passed / total) * 100).toFixed(1)}%（${passed}/${total}）`;
}

function points(value: number): string {
	return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
}

function formatDifference(difference: PairedDifference): string {
	return `${points(difference.mean)} 个百分点，95% 置信区间 ${points(difference.low)} 到 ${points(difference.high)}（${difference.tasks} 道题）`;
}

function limit(value: number | null, unit: string): string {
	return value === null ? "不限" : `${value} ${unit}`;
}

function formatCost(cost: SessionCost): string {
	if (cost.sessions === 0) return "没有";
	const usd =
		cost.costUsd === undefined
			? "费用未知（模型没有价格）"
			: `${cost.costUsd.toFixed(4)} 美元，平均每个 ${(cost.costUsd / cost.sessions).toFixed(4)} 美元`;
	const { tokens } = cost;
	return `${cost.sessions} 个 session，${usd}；token 输入 ${tokens.input}，缓存读取 ${tokens.cache_read}，缓存写入 ${tokens.cache_write}，输出 ${tokens.output}；共 ${(cost.durationMs / 1000).toFixed(1)} 秒`;
}

function formatPhase(phase: PhaseCost): string {
	if (phase.sessions === 0) return "没有";
	return `${formatCost(phase)}；工具调用 ${phase.toolCalls} 次；超出预算 ${phase.overBudget} 个，超时 ${phase.timedOut} 个`;
}

/** 把报告写成给人看的文本。 */
export function formatMemoryReport(report: MemoryReport): string {
	const { conditions, memory } = report;
	const { budget } = conditions;
	const { extraction } = memory;
	const perSession = (value: number) =>
		memory.sessions === 0 ? "0.0" : (value / memory.sessions).toFixed(1);
	return [
		"# Memory 对比实验",
		"",
		"## 实验条件",
		"",
		`- 模型：${conditions.model}（${conditions.protocol}），推理强度 ${conditions.reasoningEffort}`,
		`- 被测的 commit：${conditions.commit}，版本 ${conditions.version}；操作系统：${conditions.os}`,
		`- 沙盒模式：${memoryExperimentPermissions.sandboxMode}；审批策略：${memoryExperimentPermissions.approvalPolicy}`,
		`- 每个 run 的上限：费用 ${limit(budget.maxCostUsd, "美元")}，模型请求 ${limit(budget.maxRequests, "次")}，时间 ${limit(budget.maxDurationMs, "毫秒")}；每个会话最多 ${conditions.timeoutMs} 毫秒`,
		`- ${report.tasks} 道题，每道题在每个组里运行 ${report.runs} 次`,
		...(report.runs < minimumRuns
			? [
					`- 每组不足 ${minimumRuns} 次：下面的数字只说明流程走通了，不能据此下结论`,
				]
			: []),
		"- 权限规则文件：",
		"",
		"```toml",
		conditions.rules.trimEnd(),
		"```",
		"",
		"## 成功率",
		"",
		...report.groups.map(
			(group) =>
				`- ${groupNames[group.group]}：${percent(group.passed, group.trials)}${group.difference === undefined ? "" : `；和无记忆组的配对差 ${formatDifference(group.difference)}`}`,
		),
		"",
		"## 按无记忆时的通过次数分层",
		"",
		...report.strata.flatMap((stratum) => [
			`${stratumNames[stratum.name]}（${stratum.tasks} 道题）：`,
			...stratum.differences.map(
				(difference) =>
					`- ${groupNames[difference.group]}：${formatDifference(difference)}`,
			),
		]),
		"",
		"## 检验会话里的重复劳动",
		"",
		...report.groups.map(
			({ group, counters }) =>
				`- ${groupNames[group]}：重复的工具调用 ${counters.repeatedCalls} 次，重复读文件 ${counters.repeatedReads} 次，重复的失败尝试 ${counters.repeatedFailures} 次，误用过期记忆 ${counters.staleUses} 次`,
		),
		"",
		"## 开销（全部运行，不只是通过的）",
		"",
		...report.groups.flatMap((group) => [
			`${groupNames[group.group]}：`,
			`- 没有记忆的状态（学习会话）：${formatPhase(group.cold)}`,
			`- 已有记忆的状态（检验会话）：${formatPhase(group.warm)}`,
			`- 会话之间整理记忆：${formatCost(group.maintenance)}`,
		]),
		"",
		"## 完整 memory 组",
		"",
		`- 提取 ${extraction.runs} 次，模型请求 ${extraction.requests} 次，token 输入 ${extraction.tokens.input}、输出 ${extraction.tokens.output}，${extraction.costUsd === undefined ? "费用未知（模型没有价格）" : `${extraction.costUsd.toFixed(4)} 美元`}（已计入上面整理记忆的开销）；记下候选 ${extraction.candidates} 条，丢弃 ${extraction.dropped} 条`,
		`- 模型提议的候选 ${memory.proposed} 条，平均每个 task ${perSession(memory.proposed + extraction.candidates)} 条候选（含提取的）；确认 ${memory.confirmations} 次`,
		`- 索引平均每个会话 ${perSession(memory.indexTokens)} token`,
		`- 没通过的运行：${memoryFailures.map((failure) => `${failureNames[failure]} ${memory.failures[failure]} 次`).join("，")}`,
		"",
		"## 每道题通过的次数",
		"",
		...report.perTask.map(
			({ task, passed }) =>
				`- ${task}：${memoryGroups.map((group) => `${groupNames[group]} ${passed[group]}/${report.runs}`).join("，")}`,
		),
	].join("\n");
}
