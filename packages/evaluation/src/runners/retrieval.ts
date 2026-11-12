import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	bodyLimit,
	MemoryStore,
	noSources,
	sanitizeBody,
	titleLimit,
} from "@ospreycode/memory";
import {
	evidenceIds,
	type LongMemEvalQuestion,
	longMemEvalDocuments,
} from "../benchmarks/longmemeval.js";

/** 一道题的检索结果。 */
export interface QuestionRanking {
	/** 题目的编号。 */
	id: string;
	/** 题型。 */
	type: string;
	/** 检索到的轮次的编号，按名次排列；一个查询词也没命中的轮次不在里面。 */
	ranking: string[];
	/** 该检索到的轮次的编号。 */
	evidence: string[];
	/** 这道题有多少个可以检索的轮次。 */
	documents: number;
	/** 写进记忆库的记忆条数：超过正文上限的轮次切成了几条。 */
	records: number;
}

/** 一次检索评测的结果。 */
export interface RetrievalRun {
	/** 计入的题，按数据里的顺序。 */
	rankings: QuestionRanking[];
	/** 跳过的题的编号：它们没有该检索到的轮次。 */
	skipped: {
		/** 拒答题。 */
		abstention: string[];
		/** 证据都在助手一侧的题。 */
		noEvidence: string[];
	};
}

/**
 * 把一个轮次切成能写进记忆库的几段。切开的地方成了新的行首，行首的角色标签入库时会被加上一对
 * 引号，所以每段比正文上限少留两个字符，切完再处理一遍。
 */
function pieces(content: string): string[] {
	const chars = [...sanitizeBody(content)];
	const size = bodyLimit - 2;
	const parts: string[] = [];
	for (let start = 0; start < chars.length; start += size) {
		const part = sanitizeBody(chars.slice(start, start + size).join(""));
		if (part !== "") parts.push(part);
	}
	return parts;
}

/**
 * 等到时钟过了这个时刻。同分的记忆按确认时间从新到旧排，时间只精确到毫秒：同一毫秒里写入的几条
 * 反而按写入的先后排，名次就随写入的快慢变化。每条都等过了上一条的时间再写，结果才能重现。
 */
function waitPast(time: string): void {
	while (new Date().toISOString() <= time) {
		// 最多等一毫秒
	}
}

/**
 * LongMemEval 的检索专项：每道题把用户一侧的轮次写进一个临时的记忆库，用问题作查询经
 * `MemoryStore.search` 排序。不调用模型，不联网。
 *
 * 每个轮次是一条记忆，超过正文上限的切成几条，标题取这一条开头的一段：检索看的是标题和正文，
 * 标题里不另加能匹配上的文字。轮次按数据里的顺序写入，每条的确认时间都比上一条晚，所以同分的
 * 记忆后写入的排在前面。拒答题和用户一侧没有证据轮次的题跳过。`directory` 要已经存在，每道题
 * 的库用完就删。
 */
export function rankLongMemEval(
	questions: readonly LongMemEvalQuestion[],
	directory: string,
): RetrievalRun {
	const run: RetrievalRun = {
		rankings: [],
		skipped: { abstention: [], noEvidence: [] },
	};
	for (const [index, question] of questions.entries()) {
		if (question.id.includes("_abs")) {
			run.skipped.abstention.push(question.id);
			continue;
		}
		const documents = longMemEvalDocuments(question);
		const evidence = evidenceIds(documents);
		if (evidence.length === 0) {
			run.skipped.noEvidence.push(question.id);
			continue;
		}

		const home = join(directory, String(index));
		mkdirSync(home);
		const store = MemoryStore.open({
			path: join(home, "memory.sqlite"),
			scope: "user",
			// 数据是公开的聊天记录：按疑似密钥丢掉轮次，量到的就不是检索了
			containsSecret: () => false,
		});
		try {
			const documentOf = new Map<string, string>();
			for (const document of documents) {
				for (const body of pieces(document.content)) {
					const record = store.add({
						kind: "fact",
						title: [...body].slice(0, titleLimit).join(""),
						body,
						sources: noSources(),
					});
					documentOf.set(record.id, document.id);
					// 直接添加的记忆，创建时间就是确认时间
					waitPast(record.created_at);
				}
			}
			const ranking = new Set(
				store
					.search(question.question, documentOf.size)
					.map((record) => documentOf.get(record.id) as string),
			);
			run.rankings.push({
				id: question.id,
				type: question.type,
				ranking: [...ranking],
				evidence,
				documents: documents.length,
				records: documentOf.size,
			});
		} finally {
			store.close();
			rmSync(home, { recursive: true });
		}
	}
	return run;
}
