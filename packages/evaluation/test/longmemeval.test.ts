import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	formatRetrievalReport,
	loadLongMemEval,
	longMemEvalData,
	longMemEvalDocuments,
	type QuestionRanking,
	rankLongMemEval,
	retrievalMetrics,
	retrievalReport,
} from "../src/index.js";

/** 数据文件里的一个轮次。 */
interface RawTurn {
	role: string;
	content: string;
	has_answer?: boolean;
}

/** 按官方的格式写一道题，评测用不到的字段也照样带上。 */
function instance(
	id: string,
	type: string,
	question: string,
	sessions: Record<string, RawTurn[]>,
) {
	const ids = Object.keys(sessions);
	return {
		question_id: id,
		question_type: type,
		question,
		answer: "unused",
		question_date: "2023/05/30 (Tue) 23:40",
		haystack_session_ids: ids,
		haystack_dates: ids.map(() => "2023/05/20 (Sat) 02:21"),
		haystack_sessions: Object.values(sessions),
		answer_session_ids: ids.filter((session) => session.includes("answer")),
	};
}

const user = (content: string, hasAnswer?: boolean): RawTurn => ({
	role: "user",
	content,
	...(hasAnswer === undefined ? {} : { has_answer: hasAnswer }),
});
const assistant = (content: string, hasAnswer?: boolean): RawTurn => ({
	role: "assistant",
	content,
	...(hasAnswer === undefined ? {} : { has_answer: hasAnswer }),
});

/** 开头和结尾都有能匹配上的词，中间是匹配不上的填充：超过正文上限，要切成两条记忆。 */
const longTurn = `My telescope notes: ${"zzz ".repeat(600)}the Dobsonian is my favourite telescope.`;

const instances = [
	instance(
		"q-beagle",
		"single-session-user",
		"Which beagle shelter did Biscuit come from?",
		{
			sharegpt_k1_0: [
				user("Please explain how photosynthesis works in plants."),
				assistant("Plants convert light into chemical energy."),
			],
			answer_k2_1: [
				user("I am thinking about getting a dog soon.", false),
				// 助手一侧的轮次不参加检索，词再多也不会排进来
				assistant("A beagle from a shelter did come to mind: Biscuit!", false),
				user(
					"We adopted Biscuit, a beagle, from the Maple Street shelter.",
					true,
				),
			],
			ultrachat_k3_2: [user("Where does the word biscuit come from?")],
		},
	),
	instance("q-telescope", "multi-session", "What telescope is my favourite?", {
		answer_m1_0: [user(longTurn, true), assistant("Noted.", false)],
		sharegpt_m2_1: [user("What is the weather like in Lisbon?")],
	}),
	// 拒答题：没有该检索到的位置
	instance("q-unknown_abs", "single-session-user", "What is my cat called?", {
		answer_n1_0: [user("My dog is called Biscuit.", true)],
	}),
	// 证据在助手一侧
	instance(
		"q-recipe",
		"single-session-assistant",
		"Which flour did you suggest?",
		{
			answer_r1_0: [
				user("Which flour should I use for focaccia?", false),
				assistant("Use a strong bread flour.", true),
			],
		},
	),
];

describe("LongMemEval 的检索专项（按同一格式写的夹具）", () => {
	let base: string;
	let file: string;
	let sha256: string;

	const write = (name: string, data: unknown) => {
		const path = join(base, name);
		const content = JSON.stringify(data);
		writeFileSync(path, content);
		return { path, sha256: createHash("sha256").update(content).digest("hex") };
	};

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "osp-longmemeval-"));
		({ path: file, sha256 } = write("data.json", instances));
	});

	afterAll(() => {
		rmSync(base, { recursive: true, force: true });
	});

	test("固定的数据版本", () => {
		expect(longMemEvalData).toEqual({
			repository: "xiaowu0162/longmemeval-cleaned",
			revision: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
			file: "longmemeval_s_cleaned.json",
			bytes: 277383467,
			sha256:
				"d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
		});
	});

	test("读入：文件的 SHA-256 对不上时不读", () => {
		expect(() => loadLongMemEval(file, longMemEvalData.sha256)).toThrow(
			new RegExp(`SHA-256 是 ${sha256}，固定的是 ${longMemEvalData.sha256}`),
		);
		expect(loadLongMemEval(file, sha256)).toHaveLength(4);
	});

	test("读入：字段不对时报错，指出是哪道题的哪个位置", () => {
		const load = (changed: unknown) => {
			const { path, sha256: hash } = write("broken.json", [changed]);
			return () => loadLongMemEval(path, hash);
		};
		const [first] = instances as [(typeof instances)[number]];

		expect(load({ ...first, haystack_session_ids: ["only-one"] })).toThrow(
			/第 1 道题 有 1 个会话编号、3 个会话/,
		);
		expect(
			load({
				...first,
				haystack_sessions: [
					[{ role: "system", content: "x" }],
					...first.haystack_sessions.slice(1),
				],
			}),
		).toThrow(/haystack_sessions\[0\]\[0\]\.role 不能是 system/);
		// 有证据的会话里，用户一侧的轮次都要标明有没有证据
		expect(
			load({
				...first,
				haystack_sessions: [
					first.haystack_sessions[0],
					[user("no label")],
					first.haystack_sessions[2],
				],
			}),
		).toThrow(/haystack_sessions\[1\]\[0\]\.has_answer 要是 true 或 false/);
		expect(load({ ...first, question: 42 })).toThrow(/question 要是字符串/);
		const { path, sha256: hash } = write("not-array.json", { questions: [] });
		expect(() => loadLongMemEval(path, hash)).toThrow(/要是数组/);
	});

	test("检索对象只有用户一侧的轮次，编号照官方的写法", () => {
		const [beagle] = loadLongMemEval(file, sha256);
		if (beagle === undefined) throw new Error("没有读到题目");

		expect(longMemEvalDocuments(beagle).map((document) => document.id)).toEqual(
			[
				"sharegpt_k1_0_1",
				// 有证据的会话里没有证据的轮次
				"noans_k2_1_1",
				"answer_k2_1_3",
				"ultrachat_k3_2_1",
			],
		);
	});

	test("每道题用问题检索自己的历史：证据轮次排在前面，没命中的不返回，长轮次切开后只算一次", () => {
		const directory = join(base, "stores");
		mkdirSync(directory);

		const run = rankLongMemEval(loadLongMemEval(file, sha256), directory);

		expect(run.rankings).toEqual([
			{
				id: "q-beagle",
				type: "single-session-user",
				ranking: ["answer_k2_1_3", "ultrachat_k3_2_1"],
				evidence: ["answer_k2_1_3"],
				documents: 4,
				records: 4,
			},
			{
				id: "q-telescope",
				type: "multi-session",
				ranking: ["answer_m1_0_1", "sharegpt_m2_1_1"],
				evidence: ["answer_m1_0_1"],
				documents: 2,
				records: 3,
			},
		]);
		expect(run.skipped).toEqual({
			abstention: ["q-unknown_abs"],
			noEvidence: ["q-recipe"],
		});
		// 每道题的记忆库用完就删
		expect(readdirSync(directory)).toEqual([]);

		const report = retrievalReport(
			{ data: "夹具", commit: "0000000", version: "0.1.0" },
			run,
		);
		expect(report).toMatchObject({
			questions: 2,
			skipped: { abstention: 1, noEvidence: 1 },
			documents: 3,
			records: 3.5,
		});
		for (const level of [report.overall.turn, report.overall.session]) {
			expect(level).toEqual({
				1: { recallAny: 1, recallAll: 1, ndcgAny: 1 },
				3: { recallAny: 1, recallAll: 1, ndcgAny: 1 },
				5: { recallAny: 1, recallAll: 1, ndcgAny: 1 },
				10: { recallAny: 1, recallAll: 1, ndcgAny: 1 },
			});
		}
	});

	test("同分的轮次后写入的排在前面，不随写入的快慢变化", () => {
		// 每个轮次都只命中同一个词
		const names = Array.from({ length: 40 }, (_, index) =>
			index === 7 ? "answer_t7_7" : `sharegpt_t${index}_${index}`,
		);
		const { path, sha256: hash } = write("ties.json", [
			instance(
				"q-kayak",
				"single-session-user",
				"kayak",
				Object.fromEntries(
					names.map((name, index) => [
						name,
						[user(`Entry ${index}: the kayak trip.`, index === 7 || undefined)],
					]),
				),
			),
		]);
		const directory = join(base, "tie-stores");
		mkdirSync(directory);

		const run = rankLongMemEval(loadLongMemEval(path, hash), directory);

		expect(run.rankings.map((question) => question.ranking)).toEqual([
			names.map((name) => `${name}_1`).reverse(),
		]);
	});
});

describe("检索指标（照官方的定义）", () => {
	const question = (
		id: string,
		type: string,
		ranking: string[],
		evidence: string[],
		documents: number,
	): QuestionRanking => ({
		id,
		type,
		ranking,
		evidence,
		documents,
		records: documents,
	});
	/** 两个证据轮次，排在第 1 和第 4。 */
	const spread = question(
		"spread",
		"multi-session",
		["answer_s1_1", "x_1", "noans_s1_3", "answer_s2_5", "y_2"],
		["answer_s1_1", "answer_s2_5"],
		8,
	);
	/** 一个证据轮次排在第 4，前三名都是同一个会话的轮次。 */
	const crowded = question(
		"crowded",
		"multi-session",
		["s1_1", "s1_2", "s1_3", "answer_s2_1", "s3_1"],
		["answer_s2_1"],
		5,
	);
	const missed = question("missed", "knowledge-update", [], ["answer_s9_1"], 3);
	const zero = { recallAny: 0, recallAll: 0, ndcgAny: 0 };

	test("按轮次：前 k 名里有任何一个、有全部证据，NDCG 按名次折扣", () => {
		expect(retrievalMetrics(spread).turn).toEqual({
			1: { recallAny: 1, recallAll: 0, ndcgAny: 1 },
			// 实际 1，理想 1 + 1/log2(2) = 2
			3: { recallAny: 1, recallAll: 0, ndcgAny: 0.5 },
			// 实际 1 + 1/log2(4) = 1.5
			5: { recallAny: 1, recallAll: 1, ndcgAny: 0.75 },
			10: { recallAny: 1, recallAll: 1, ndcgAny: 0.75 },
		});
		expect(retrievalMetrics(crowded).turn).toEqual({
			1: zero,
			3: zero,
			5: { recallAny: 1, recallAll: 1, ndcgAny: 0.5 },
			10: { recallAny: 1, recallAll: 1, ndcgAny: 0.5 },
		});
	});

	test("按会话：k 放宽到出现 k 个不同的会话，没证据的轮次不算进有证据的会话", () => {
		expect(retrievalMetrics(spread).session).toEqual({
			1: { recallAny: 1, recallAll: 0, ndcgAny: 1 },
			// noans_s1 和 answer_s1 算两个会话
			3: { recallAny: 1, recallAll: 0, ndcgAny: 0.5 },
			5: { recallAny: 1, recallAll: 1, ndcgAny: 0.75 },
			// 排名里不够 10 个会话：取整个排名
			10: { recallAny: 1, recallAll: 1, ndcgAny: 0.75 },
		});
		expect(retrievalMetrics(crowded).session).toEqual({
			1: zero,
			// 前三名只有一个会话，放宽到第 5 名才有三个
			3: { recallAny: 1, recallAll: 1, ndcgAny: 0.5 },
			5: { recallAny: 1, recallAll: 1, ndcgAny: 0.5 },
			10: { recallAny: 1, recallAll: 1, ndcgAny: 0.5 },
		});
	});

	test("什么都没检索到时全是 0", () => {
		const metrics = retrievalMetrics(missed);
		for (const level of [metrics.turn, metrics.session]) {
			expect(level).toEqual({ 1: zero, 3: zero, 5: zero, 10: zero });
		}
	});

	test("报告：全部题和每种题型各取平均", () => {
		const report = retrievalReport(
			{
				data: "longmemeval_s_cleaned.json（revision 98d7416）",
				commit: "0000000",
				version: "0.1.0",
			},
			{
				rankings: [spread, crowded, missed],
				skipped: { abstention: ["a_abs", "b_abs"], noEvidence: ["c"] },
			},
		);

		expect(report).toMatchObject({
			questions: 3,
			skipped: { abstention: 2, noEvidence: 1 },
		});
		expect(report.documents).toBeCloseTo(16 / 3, 10);
		expect(report.overall.turn[5]).toEqual({
			recallAny: expect.closeTo(2 / 3, 10),
			recallAll: expect.closeTo(2 / 3, 10),
			ndcgAny: expect.closeTo(1.25 / 3, 10),
		});
		expect(report.overall.session[3]).toEqual({
			recallAny: expect.closeTo(2 / 3, 10),
			recallAll: expect.closeTo(1 / 3, 10),
			ndcgAny: expect.closeTo(1 / 3, 10),
		});
		expect(report.byType.map((entry) => [entry.type, entry.questions])).toEqual(
			[
				["knowledge-update", 1],
				["multi-session", 2],
			],
		);
		expect(report.byType[1]?.turn[3]).toEqual({
			recallAny: 0.5,
			recallAll: 0,
			ndcgAny: 0.25,
		});

		const formatted = formatRetrievalReport(report);
		expect(formatted).toContain(
			"- 数据：longmemeval_s_cleaned.json（revision 98d7416）",
		);
		expect(formatted).toContain(
			"- 计入 3 道题：跳过拒答题 2 道，用户一侧没有证据轮次的 1 道",
		);
		expect(formatted).toContain("- 平均每道题 5.3 个轮次，写成 5.3 条记忆");
		expect(formatted).toContain(
			"按轮次：\n- k=1：recall_any 0.3333，recall_all 0.0000，ndcg_any 0.3333",
		);
		expect(formatted).toContain(
			"- k=5：recall_any 0.6667，recall_all 0.6667，ndcg_any 0.4167",
		);
		expect(formatted).toContain(
			"## 按题型（k=5）\n\n- knowledge-update（1 道）\n  - 按轮次：recall_any 0.0000，recall_all 0.0000，ndcg_any 0.0000",
		);
		expect(formatted).toContain(
			"- multi-session（2 道）\n  - 按轮次：recall_any 1.0000，recall_all 1.0000，ndcg_any 0.6250\n  - 按会话：recall_any 1.0000，recall_all 1.0000，ndcg_any 0.6250",
		);
	});

	test("没有计入的题时报错", () => {
		expect(() =>
			retrievalReport(
				{ data: "夹具", commit: "0000000", version: "0.1.0" },
				{ rankings: [], skipped: { abstention: ["a_abs"], noEvidence: [] } },
			),
		).toThrow(/没有计入的题/);
	});
});
