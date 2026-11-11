import type { MemoryRecord } from "../core/record.js";

/** 中日韩文字：没有空格分词，按相邻两字拆。 */
const cjk =
	"\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";

/** 一个词里连续的一段中日韩文字，或者连续的一段其他文字。 */
const segments = new RegExp(`[${cjk}]+|[^${cjk}]+`, "gu");
const cjkSegment = new RegExp(`^[${cjk}]`, "u");

/** 每次检索最多返回这么多条。 */
export const searchLimit = 5;

/**
 * 把查询拆成词：按空白和标点分开，全部小写；中日韩文字的连续一段按相邻两字拆（单独一个字就是它
 * 自己），其他文字不足两个字符的词去掉。
 */
export function queryTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const word of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
		for (const [segment] of word.matchAll(segments)) {
			const chars = [...segment];
			if (!cjkSegment.test(segment)) {
				if (chars.length >= 2) terms.add(segment);
				continue;
			}
			if (chars.length === 1) terms.add(segment);
			for (let i = 0; i + 1 < chars.length; i += 1) {
				terms.add(`${chars[i]}${chars[i + 1]}`);
			}
		}
	}
	return [...terms];
}

/**
 * 在给出的记忆里检索：把查询拆成词，逐条在标题和正文里做不区分大小写的子串匹配，按命中的词数
 * 排序，整句都命中的排在最前，同分的按确认时间从新到旧。一个词也没命中的不返回。不建索引：
 * 记忆经过确认才生效，数量不大。
 */
export function searchRecords(
	records: readonly MemoryRecord[],
	query: string,
	limit: number,
): MemoryRecord[] {
	const terms = queryTerms(query);
	const whole = query.trim().toLowerCase();
	const scored = records.flatMap((record) => {
		const text = `${record.title}\n${record.body}`.toLowerCase();
		const hits = terms.filter((term) => text.includes(term)).length;
		const phrase = whole.length >= 2 && text.includes(whole);
		if (hits === 0 && !phrase) return [];
		return [{ record, score: hits + (phrase ? terms.length + 1 : 0) }];
	});
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			(b.record.confirmed_at ?? "").localeCompare(a.record.confirmed_at ?? ""),
	);
	return scored.slice(0, limit).map(({ record }) => record);
}
