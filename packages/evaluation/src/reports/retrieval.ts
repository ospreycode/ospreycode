import { searchLimit } from "@ospreycode/memory";
import type { QuestionRanking, RetrievalRun } from "../runners/retrieval.js";

/** 取前几名来算指标。`memory_search` 一次最多返回 5 条，10 只用来和官方公布的数字对照。 */
export const retrievalCutoffs = [1, 3, 5, 10] as const;

/** 取前几名。 */
export type RetrievalCutoff = (typeof retrievalCutoffs)[number];

/** 一组检索指标，定义照 LongMemEval 官方的检索评测。一道题的值在 0 到 1 之间，汇总时取平均。 */
export interface RetrievalMetrics {
	/** 前 k 名里有任何一个该检索到的。 */
	recallAny: number;
	/** 前 k 名里有全部该检索到的。 */
	recallAll: number;
	/** 前 k 名的 NDCG：该检索到的记 1，其余记 0。 */
	ndcgAny: number;
}

/** 各个 k 的指标。 */
export type MetricsByCutoff = Record<RetrievalCutoff, RetrievalMetrics>;

/** 按轮次和按会话各一组指标。 */
export interface RetrievalLevels {
	/** 按轮次：该检索到的是有证据的轮次。 */
	turn: MetricsByCutoff;
	/** 按会话：轮次的名次折算到会话，前 k 名指前 k 个不同的会话。 */
	session: MetricsByCutoff;
}

function dcg(relevances: readonly number[]): number {
	return relevances.reduce(
		(total, relevance, index) =>
			total + (index === 0 ? relevance : relevance / Math.log2(index + 1)),
		0,
	);
}

function evaluate(
	ranking: readonly string[],
	relevant: ReadonlySet<string>,
	relevantDocuments: number,
	k: number,
): RetrievalMetrics {
	const top = ranking.slice(0, k);
	const recalled = new Set(top);
	const found = [...relevant].filter((id) => recalled.has(id)).length;
	return {
		recallAny: found > 0 ? 1 : 0,
		recallAll: found === relevant.size ? 1 : 0,
		ndcgAny:
			dcg(top.map((id) => (relevant.has(id) ? 1 : 0))) /
			dcg(Array.from({ length: Math.min(k, relevantDocuments) }, () => 1)),
	};
}

/** 轮次的编号去掉最后的序号，得到它所在的会话。 */
function sessionOf(id: string): string {
	return id.slice(0, id.lastIndexOf("_"));
}

/**
 * 一道题的指标。按会话的一组照官方的折算方法：轮次的排名不变，编号换成会话的，k 放宽到排名里
 * 出现了 k 个不同的会话为止（不够 k 个时取整个排名）。
 */
export function retrievalMetrics(question: QuestionRanking): RetrievalLevels {
	const { ranking, evidence } = question;
	const turns = new Set(evidence);
	const sessions = ranking.map(sessionOf);
	const relevantSessions = new Set(evidence.map(sessionOf));
	const widened = (k: number) => {
		const seen = new Set<string>();
		for (const [index, session] of sessions.entries()) {
			seen.add(session);
			if (seen.size === k) return index + 1;
		}
		return question.documents + 1;
	};
	const each = (
		metrics: (k: RetrievalCutoff) => RetrievalMetrics,
	): MetricsByCutoff => ({
		1: metrics(1),
		3: metrics(3),
		5: metrics(5),
		10: metrics(10),
	});
	return {
		turn: each((k) => evaluate(ranking, turns, evidence.length, k)),
		session: each((k) =>
			evaluate(sessions, relevantSessions, evidence.length, widened(k)),
		),
	};
}

/** 实验条件：写进报告，结果只在这些条件下成立。 */
export interface RetrievalConditions {
	/** 数据文件和它固定的版本。 */
	data: string;
	/** 被测的 commit。 */
	commit: string;
	/** 各包共用的版本号（含 `memory` 包）。 */
	version: string;
}

/** 一种题型的结果。 */
export interface RetrievalTypeResult extends RetrievalLevels {
	type: string;
	questions: number;
}

/** 检索专项的报告。 */
export interface RetrievalReport {
	conditions: RetrievalConditions;
	/** 计入的题数。 */
	questions: number;
	/** 跳过的题数：拒答题，和用户一侧没有证据轮次的题。 */
	skipped: { abstention: number; noEvidence: number };
	/** 平均每道题可以检索的轮次数，和写进记忆库的记忆条数。 */
	documents: number;
	records: number;
	/** 全部计入的题的平均。 */
	overall: RetrievalLevels;
	/** 按题型分开，按题型的名字排序。 */
	byType: RetrievalTypeResult[];
}

function average(levels: readonly RetrievalLevels[]): RetrievalLevels {
	const mean = (pick: (entry: RetrievalLevels) => number) =>
		levels.reduce((total, entry) => total + pick(entry), 0) / levels.length;
	const level = (name: keyof RetrievalLevels): MetricsByCutoff => {
		const at = (k: RetrievalCutoff): RetrievalMetrics => ({
			recallAny: mean((entry) => entry[name][k].recallAny),
			recallAll: mean((entry) => entry[name][k].recallAll),
			ndcgAny: mean((entry) => entry[name][k].ndcgAny),
		});
		return { 1: at(1), 3: at(3), 5: at(5), 10: at(10) };
	};
	return { turn: level("turn"), session: level("session") };
}

/** 汇总一次检索评测：每道题算出指标，再对全部题和每种题型取平均。 */
export function retrievalReport(
	conditions: RetrievalConditions,
	run: RetrievalRun,
): RetrievalReport {
	const { rankings } = run;
	if (rankings.length === 0) throw new Error("没有计入的题");
	const scored = rankings.map((question) => ({
		type: question.type,
		metrics: retrievalMetrics(question),
	}));
	const mean = (pick: (question: QuestionRanking) => number) =>
		rankings.reduce((total, question) => total + pick(question), 0) /
		rankings.length;
	return {
		conditions,
		questions: rankings.length,
		skipped: {
			abstention: run.skipped.abstention.length,
			noEvidence: run.skipped.noEvidence.length,
		},
		documents: mean((question) => question.documents),
		records: mean((question) => question.records),
		overall: average(scored.map((entry) => entry.metrics)),
		byType: [...new Set(scored.map((entry) => entry.type))]
			.sort()
			.map((type) => {
				const own = scored.filter((entry) => entry.type === type);
				return {
					type,
					questions: own.length,
					...average(own.map((entry) => entry.metrics)),
				};
			}),
	};
}

function formatMetrics(metrics: RetrievalMetrics): string {
	return `recall_any ${metrics.recallAny.toFixed(4)}，recall_all ${metrics.recallAll.toFixed(4)}，ndcg_any ${metrics.ndcgAny.toFixed(4)}`;
}

/** 把报告写成给人看的文本。 */
export function formatRetrievalReport(report: RetrievalReport): string {
	const { conditions, skipped } = report;
	const level = (title: string, metrics: MetricsByCutoff) => [
		`${title}：`,
		...retrievalCutoffs.map((k) => `- k=${k}：${formatMetrics(metrics[k])}`),
	];
	return [
		"# LongMemEval 检索专项",
		"",
		"## 实验条件",
		"",
		`- 数据：${conditions.data}`,
		`- 被测的 commit：${conditions.commit}，版本 ${conditions.version}`,
		"- 做法：只用用户一侧的轮次，每个轮次写成一条记忆（超过正文上限的切成几条），用问题作查询经 MemoryStore.search 排序；不调用模型",
		`- 计入 ${report.questions} 道题：跳过拒答题 ${skipped.abstention} 道，用户一侧没有证据轮次的 ${skipped.noEvidence} 道`,
		`- 平均每道题 ${report.documents.toFixed(1)} 个轮次，写成 ${report.records.toFixed(1)} 条记忆`,
		"",
		"## 结果",
		"",
		...level("按轮次", report.overall.turn),
		"",
		...level("按会话", report.overall.session),
		"",
		`## 按题型（k=${searchLimit}）`,
		"",
		...report.byType.flatMap((entry) => [
			`- ${entry.type}（${entry.questions} 道）`,
			`  - 按轮次：${formatMetrics(entry.turn[searchLimit])}`,
			`  - 按会话：${formatMetrics(entry.session[searchLimit])}`,
		]),
	].join("\n");
}
