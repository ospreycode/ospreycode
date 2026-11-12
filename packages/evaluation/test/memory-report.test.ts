import type { HostEvent } from "@ospreycode/agent-host";
import type { Usage } from "@ospreycode/api/protocol";
import {
	classifyFailure,
	formatMemoryReport,
	historyBlock,
	historyChars,
	type MaintenanceSession,
	type MemoryConditions,
	type MemoryGroup,
	type MemorySession,
	type MemorySnapshot,
	type MemoryTrial,
	memoryGroups,
	memoryReport,
	pairedDifference,
	repeatCounters,
	retrievedBlock,
	type TranscriptEntry,
	transcriptEntries,
	transcriptEntryChars,
} from "@ospreycode/evaluation";
import { describe, expect, test } from "vitest";

const conditions: MemoryConditions = {
	suite: "测试用的题",
	model: "claude-haiku-5-5",
	protocol: "anthropic.messages",
	reasoningEffort: "off",
	commit: "abc1234",
	version: "0.1.0",
	os: "darwin 25.6.0",
	rules: '[[rules]]\npattern = ["rm"]\ndecision = "allow"\n',
	budget: { maxCostUsd: 1, maxRequests: 30, maxDurationMs: null },
	timeoutMs: 120_000,
};

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 10,
		cache_read: 0,
		cache_write: 0,
		reasoning: 0,
		cost_usd: cost,
	};
}

/** 测试只填报告用到的字段；事件的其余字段由 Host 的测试覆盖。 */
function event(fields: Record<string, unknown>): HostEvent {
	return fields as unknown as HostEvent;
}

function session(fields: Partial<MemorySession> = {}): MemorySession {
	return {
		sessionId: "s",
		outcome: "completed",
		events: [],
		usage: usage(100, 0.01),
		durationMs: 1000,
		indexTokens: 0,
		...fields,
	};
}

function trial(
	task: string,
	group: MemoryTrial["group"],
	run: number,
	passed: boolean,
	fields: Partial<MemoryTrial> = {},
): MemoryTrial {
	return {
		task,
		group,
		run,
		passed,
		problems: passed ? [] : ["没通过"],
		learn: [session()],
		probe: session(),
		maintenance: [],
		counters: {
			repeatedCalls: 0,
			repeatedReads: 0,
			repeatedFailures: 0,
			staleUses: 0,
		},
		memories: [],
		...fields,
	};
}

/** 每道题每个组 3 次运行，`passes[group]` 是通过的次数。 */
function trialsOf(
	task: string,
	passes: Record<MemoryGroup, number>,
): MemoryTrial[] {
	return memoryGroups.flatMap((group) =>
		[1, 2, 3].map((run) => trial(task, group, run, run <= passes[group])),
	);
}

const trials = [
	...trialsOf("t1", {
		none: 0,
		history: 3,
		retrieval: 2,
		memory: 3,
		irrelevant: 0,
	}),
	...trialsOf("t2", {
		none: 1,
		history: 2,
		retrieval: 1,
		memory: 2,
		irrelevant: 1,
	}),
	...trialsOf("t3", {
		none: 3,
		history: 3,
		retrieval: 3,
		memory: 2,
		irrelevant: 2,
	}),
	...trialsOf("t4", {
		none: 0,
		history: 3,
		retrieval: 0,
		memory: 3,
		irrelevant: 0,
	}),
];

describe("统计", () => {
	test("同一道题配对比较：每道题的通过率减去无记忆组的，以题为单位 bootstrap 求置信区间", () => {
		const report = memoryReport(conditions, trials);
		expect(report).toMatchObject({ tasks: 4, runs: 3 });
		expect(
			report.groups.map(({ group, passed, trials: total }) => [
				group,
				passed,
				total,
			]),
		).toEqual([
			["none", 4, 12],
			["history", 11, 12],
			["retrieval", 6, 12],
			["memory", 10, 12],
			["irrelevant", 3, 12],
		]);
		expect(report.groups[0]?.difference).toBeUndefined();

		// 四道题的差是 1、1/3、-1/3、1
		const memory = report.groups[3]?.difference;
		expect(memory?.tasks).toBe(4);
		expect(memory?.mean).toBeCloseTo(0.5);
		expect(memory?.low).toBeGreaterThanOrEqual(-1 / 3);
		expect(memory?.low).toBeLessThan(0.5);
		expect(memory?.high).toBeGreaterThan(0.5);
		expect(memory?.high).toBeLessThanOrEqual(1);
		// 等长无关记忆组：0、0、-1/3、0，区间不会越过 0
		const irrelevant = report.groups[4]?.difference;
		expect(irrelevant?.mean).toBeCloseTo(-1 / 12);
		expect(irrelevant?.high).toBeLessThanOrEqual(0);

		// 固定种子：同一批结果每次算出同样的区间
		expect(memoryReport(conditions, trials)).toEqual(report);
		expect(memoryReport(conditions, trials.toReversed())).toEqual(report);
	});

	test("每道题的差都一样时区间收成一个点；没有题时报错", () => {
		expect(pairedDifference([0.5, 0.5, 0.5])).toEqual({
			tasks: 3,
			mean: 0.5,
			low: 0.5,
			high: 0.5,
		});
		expect(() => pairedDifference([])).toThrow("没有可以比较的题");
	});

	test("按无记忆时的通过次数分层：已经稳定通过的题上，记忆的害处不被平均掉", () => {
		const { strata } = memoryReport(conditions, trials);
		expect(strata.map(({ name, tasks }) => [name, tasks])).toEqual([
			["never", 2],
			["sometimes", 1],
			["always", 1],
		]);
		const memoryIn = (name: string) =>
			strata
				.find((stratum) => stratum.name === name)
				?.differences.find((difference) => difference.group === "memory");
		expect(memoryIn("never")).toMatchObject({ mean: 1, low: 1, high: 1 });
		expect(memoryIn("sometimes")?.mean).toBeCloseTo(1 / 3);
		expect(memoryIn("always")?.mean).toBeCloseTo(-1 / 3);
		// 没有题的层不出现
		const stable = memoryReport(
			conditions,
			trials.filter((item) => item.task === "t3"),
		);
		expect(stable.strata.map((stratum) => stratum.name)).toEqual(["always"]);
	});

	test("各组的题和次数对不上时报错", () => {
		expect(() => memoryReport(conditions, trials.slice(0, -1))).toThrow(
			"t4 在 irrelevant 组里有 2 次运行，应当是 3 次",
		);
	});
});

describe("报告内容", () => {
	const extraction = event({
		type: "memory.extraction.ended",
		requests: 2,
		usage: usage(1000, 0.002),
		candidate_ids: ["p-1", "p-2"],
		dropped: 1,
	});
	const maintenance: MaintenanceSession = {
		sessionId: "m",
		events: [
			extraction,
			event({ type: "memory.updated", change: "confirmed" }),
			event({ type: "memory.updated", change: "confirmed" }),
		],
		usage: usage(1000, 0.002),
		durationMs: 500,
	};
	const detailed = [
		trial("t1", "none", 1, false, {
			counters: {
				repeatedCalls: 3,
				repeatedReads: 2,
				repeatedFailures: 1,
				staleUses: 0,
			},
			probe: session({ outcome: "budget_exceeded" }),
		}),
		trial("t1", "history", 1, true, {
			probe: session({ usage: usage(5000, 0.05) }),
		}),
		trial("t1", "retrieval", 1, true),
		trial("t1", "memory", 1, false, {
			failure: "stale_misuse",
			counters: {
				repeatedCalls: 0,
				repeatedReads: 0,
				repeatedFailures: 0,
				staleUses: 2,
			},
			learn: [
				session({
					events: [
						event({ type: "memory.candidates", candidates: [{}, {}, {}] }),
						event({ type: "memory.updated", change: "confirmed" }),
						event({ type: "memory.updated", change: "rejected" }),
						event({
							type: "tool_call.started",
							tool_call_id: "c1",
							name: "shell",
							arguments: "{}",
						}),
					],
				}),
			],
			maintenance: [maintenance],
			probe: session({ indexTokens: 120, outcome: undefined }),
		}),
		trial("t1", "irrelevant", 1, false, {
			probe: session({ indexTokens: 120 }),
		}),
	];

	test("没有记忆和已有记忆两种状态分开；提取的开销计入完整 memory 组", () => {
		const report = memoryReport(conditions, detailed);
		const [none, history, , memory] = report.groups;
		expect(none?.counters).toEqual({
			repeatedCalls: 3,
			repeatedReads: 2,
			repeatedFailures: 1,
			staleUses: 0,
		});
		expect(none?.warm).toMatchObject({
			sessions: 1,
			overBudget: 1,
			timedOut: 0,
		});
		expect(history?.cold.costUsd).toBeCloseTo(0.01);
		expect(history?.warm.costUsd).toBeCloseTo(0.05);
		expect(history?.warm.tokens.input).toBe(5000);
		expect(memory?.cold.toolCalls).toBe(1);
		expect(memory?.warm.timedOut).toBe(1);
		expect(memory?.maintenance).toMatchObject({
			sessions: 1,
			tokens: { input: 1000 },
			durationMs: 500,
		});
		expect(memory?.maintenance.costUsd).toBeCloseTo(0.002);
		expect(none?.maintenance).toMatchObject({ sessions: 0, costUsd: 0 });

		expect(report.memory).toEqual({
			sessions: 2,
			extraction: {
				runs: 1,
				requests: 2,
				tokens: { input: 1000, output: 10 },
				costUsd: 0.002,
				candidates: 2,
				dropped: 1,
			},
			proposed: 3,
			confirmations: 3,
			indexTokens: 120,
			failures: {
				stale_misuse: 1,
				not_written: 0,
				not_confirmed: 0,
				not_retrieved: 0,
				retrieved_not_used: 0,
			},
		});
		expect(report.perTask).toEqual([
			{
				task: "t1",
				passed: { none: 0, history: 1, retrieval: 1, memory: 0, irrelevant: 0 },
			},
		]);
	});

	test("模型没有价格时费用为空，不当成 0", () => {
		const { cost_usd: _, ...unpriced } = usage(100, 0);
		const report = memoryReport(
			conditions,
			detailed.map((item) =>
				item.group === "none"
					? { ...item, probe: session({ usage: unpriced }) }
					: item,
			),
		);
		expect(report.groups[0]?.warm.costUsd).toBeUndefined();
		expect(formatMemoryReport(report)).toContain("费用未知（模型没有价格）");
	});

	test("写成文本：实验条件、各组的成功率和配对差、分层、重复劳动、开销、完整 memory 组的数字和每道题", () => {
		const text = formatMemoryReport(memoryReport(conditions, trials));
		expect(text).toContain("- 模型：claude-haiku-5-5（anthropic.messages）");
		expect(text).toContain("- 沙盒模式：danger-full-access；审批策略：never");
		expect(text).toContain(
			"费用 1 美元，模型请求 30 次，时间 不限；每个会话最多 120000 毫秒",
		);
		expect(text).toContain('pattern = ["rm"]');
		expect(text).toContain("- 4 道题，每道题在每个组里运行 3 次");
		expect(text).not.toContain("不能据此下结论");
		expect(text).toContain("- 无记忆：33.3%（4/12）\n");
		expect(text).toMatch(
			/- 完整 memory：83\.3%（10\/12）；和无记忆组的配对差 \+50\.0 个百分点，95% 置信区间 [+-]\d+\.\d 到 \+\d+\.\d（4 道题）/,
		);
		expect(text).toContain("无记忆时每次通过（1 道题）：");
		expect(text).toContain(
			"- 完整 memory：-33.3 个百分点，95% 置信区间 -33.3 到 -33.3（1 道题）",
		);
		expect(text).toContain(
			"- 无记忆：重复的工具调用 0 次，重复读文件 0 次，重复的失败尝试 0 次，误用过期记忆 0 次",
		);
		expect(text).toContain("- 没有记忆的状态（学习会话）：12 个 session");
		expect(text).toContain("- 会话之间整理记忆：没有");
		expect(text).toContain(
			"- 没通过的运行：误用过期记忆 0 次，没写入 0 次，没确认 0 次，没检索到 0 次，检索到但没用 0 次",
		);
		expect(text).toContain(
			"- t3：无记忆 3/3，直接提供历史 3/3，只检索 3/3，完整 memory 2/3，等长无关记忆 2/3",
		);
	});

	test("每组不足 3 次时注明不能下结论", () => {
		const text = formatMemoryReport(memoryReport(conditions, detailed));
		expect(text).toContain(
			"- 每组不足 3 次：下面的数字只说明流程走通了，不能据此下结论",
		);
		expect(text).toContain(
			"- 提取 1 次，模型请求 2 次，token 输入 1000、输出 10，0.0020 美元（已计入上面整理记忆的开销）；记下候选 2 条，丢弃 1 条",
		);
		expect(text).toContain(
			"- 模型提议的候选 3 条，平均每个 task 2.5 条候选（含提取的）；确认 3 次",
		);
		expect(text).toContain("- 索引平均每个会话 60.0 token");
		expect(text).toContain("- 没通过的运行：误用过期记忆 1 次");
	});
});

describe("文字记录", () => {
	const started = (id: string, name: string, args: unknown) =>
		event({
			type: "tool_call.started",
			tool_call_id: id,
			name,
			arguments: typeof args === "string" ? args : JSON.stringify(args),
		});
	const completed = (id: string, status: string, text: string) =>
		event({
			type: "tool_call.completed",
			tool_call_id: id,
			result: { status, content: [{ type: "text", text }] },
		});
	const input = (text: string) =>
		event({
			type: "task.started",
			input: [
				{ type: "text", text },
				{ type: "image", media_type: "image/png", data: "AAAA" },
			],
		});
	const reply = (...content: unknown[]) =>
		event({ type: "message.completed", message: { content } });

	const first = [
		input("How do I run the tests?"),
		reply({
			type: "tool_call",
			call_id: "x",
			name: "read",
			arguments: "{}",
		}),
		started("c1", "read", { path: "package.json" }),
		completed("c1", "succeeded", '{"scripts":{"test":"vitest run"}}'),
		reply(
			{ type: "reasoning", text: "thinking" },
			{ type: "text", text: "Run npm test." },
		),
		event({ type: "task.ended", outcome: "completed" }),
	];
	const second = [
		input("Deploy it."),
		started("c2", "shell", { command: "make deploy" }),
		completed("c2", "failed", "x".repeat(transcriptEntryChars + 500)),
	];

	test("用户的输入、模型的回复、工具调用和结果各一条，按发生的顺序；过长的截断", () => {
		const entries = transcriptEntries([first, second]);
		expect(entries.slice(0, 3)).toEqual([
			{ session: 1, role: "user", text: "user: How do I run the tests?" },
			{
				session: 1,
				role: "tool",
				text: 'tool: read {"path":"package.json"}\nsucceeded: {"scripts":{"test":"vitest run"}}',
			},
			{ session: 1, role: "assistant", text: "assistant: Run npm test." },
		]);
		expect(entries[3]).toEqual({
			session: 2,
			role: "user",
			text: "user: Deploy it.",
		});
		expect(entries[4]?.text).toHaveLength(
			transcriptEntryChars + " [truncated]".length,
		);
		expect(entries[4]?.text.endsWith("x [truncated]")).toBe(true);
		expect(entries).toHaveLength(5);
	});

	test("直接提供历史：整份记录；超过上限时留末尾并注明开头被截掉", () => {
		const entries = transcriptEntries([first, second]);
		const whole = historyBlock(entries);
		expect(whole?.startsWith("<earlier_sessions>\n")).toBe(true);
		expect(whole?.endsWith("\n</earlier_sessions>")).toBe(true);
		expect(whole).toContain("[session 1] user: How do I run the tests?");
		expect(whole).toContain("[session 2] user: Deploy it.");
		expect(whole).not.toContain("cut off");
		expect(historyBlock([])).toBeUndefined();

		const long: TranscriptEntry[] = Array.from({ length: 40 }, (_, index) => ({
			session: 1,
			role: "user",
			text: `entry ${index} ${"y".repeat(transcriptEntryChars - 20)}`,
		}));
		const tail = historyBlock(long);
		expect(tail?.length).toBeLessThanOrEqual(historyChars + 500);
		expect(tail).toContain("(the beginning is cut off)");
		expect(tail).toContain("entry 39 ");
		expect(tail).not.toContain("entry 0 ");
	});

	test("只检索：按和查询相同的词数取前 5 条，同分的取靠后的，一条也没命中时为空", () => {
		const entries: TranscriptEntry[] = [
			{
				session: 1,
				role: "user",
				text: "user: the staging deploy uses make ship",
			},
			{ session: 1, role: "assistant", text: "assistant: noted" },
			{ session: 1, role: "user", text: "user: deploy" },
			{ session: 2, role: "user", text: "user: deploy again" },
			{ session: 2, role: "user", text: "user: deploy once more" },
			{ session: 2, role: "user", text: "user: deploy a third time" },
			{ session: 3, role: "user", text: "user: deploy to staging" },
		];
		const block = retrievedBlock(entries, "How do I deploy to staging?");
		const listed = (block ?? "")
			.split("\n\n")
			.slice(1)
			.map((text) => text.replace("\n</earlier_sessions>", ""));
		expect(listed).toEqual([
			"[session 3] user: deploy to staging",
			"[session 1] user: the staging deploy uses make ship",
			"[session 2] user: deploy a third time",
			"[session 2] user: deploy once more",
			"[session 2] user: deploy again",
		]);
		expect(retrievedBlock(entries, "unrelated question")).toBeUndefined();
		// 中文按相邻两字匹配，和 memory_search 一样
		expect(
			retrievedBlock(
				[{ session: 1, role: "user", text: "user: 部署脚本在 scripts 目录" }],
				"怎么部署",
			),
		).toContain("部署脚本");
	});

	test("重复劳动：和之前相同的调用、学习会话读过的文件、重复的失败尝试；记忆工具不算", () => {
		const learn = [
			[
				started("a1", "read", { path: "src/a.ts", limit: 10 }),
				completed("a1", "succeeded", "…"),
				started("a2", "shell", { command: "make test" }),
				completed("a2", "failed", "boom"),
				started("a3", "memory_read", { id: "p-1" }),
				completed("a3", "succeeded", "…"),
				started("a4", "shell", { command: "ls" }),
				completed("a4", "succeeded", "…"),
			],
		];
		const probe = [
			// 键的顺序不同也算同一次调用；同时是读过的文件
			started("b1", "read", { limit: 10, path: "src/a.ts" }),
			completed("b1", "succeeded", "…"),
			// 绝对路径读同一个文件：重复读文件，但参数不同，不算重复的调用
			started("b2", "read", { path: "/work/src/a.ts" }),
			completed("b2", "succeeded", "…"),
			// 和学习会话里失败的命令相同，又失败了
			started("b3", "shell", { command: "make test" }),
			completed("b3", "failed", "boom"),
			// 检验会话里新的失败，再来一次才算重复
			started("b4", "shell", { command: "make check" }),
			completed("b4", "timed_out", "…"),
			started("b5", "shell", { command: "make check" }),
			completed("b5", "denied", "…"),
			// 之前成功、这次失败：是重复的调用，不是重复的失败尝试
			started("b6", "shell", { command: "ls" }),
			completed("b6", "failed", "…"),
			started("b7", "memory_read", { id: "p-1" }),
			completed("b7", "succeeded", "…"),
			// 参数不是合法的 JSON：按原文比较
			started("b8", "read", "{path"),
			started("b9", "read", "{path"),
		];
		expect(repeatCounters(learn, probe, "/work")).toEqual({
			repeatedCalls: 5,
			repeatedReads: 2,
			repeatedFailures: 2,
		});
		expect(repeatCounters([], [], "/work")).toEqual({
			repeatedCalls: 0,
			repeatedReads: 0,
			repeatedFailures: 0,
		});
	});
});

describe("失败归类", () => {
	const memory = (
		id: string,
		status: MemorySnapshot["status"],
		title: string,
	): MemorySnapshot => ({
		id,
		scope: "project",
		kind: "fact",
		status,
		title,
		body: "body",
	});
	const evidence = (text: string) => text.includes("K-42");
	const useful = memory("p-1", "active", "Deploy code is K-42");
	const other = memory("p-2", "active", "Tests run with vitest");

	test("按顺序判断：误用过期记忆、没写入、没确认、没检索到、检索到但没用", () => {
		expect(
			classifyFailure({
				staleUses: 1,
				memories: [useful],
				retrieved: ["p-1"],
				evidence,
			}),
		).toBe("stale_misuse");
		expect(
			classifyFailure({
				staleUses: 0,
				memories: [other],
				retrieved: ["p-2"],
				evidence,
			}),
		).toBe("not_written");
		expect(
			classifyFailure({
				staleUses: 0,
				memories: [
					memory("p-3", "pending", "Deploy code is K-42"),
					memory("p-4", "expired", "K-42 was the deploy code"),
					other,
				],
				retrieved: [],
				evidence,
			}),
		).toBe("not_confirmed");
		expect(
			classifyFailure({
				staleUses: 0,
				memories: [useful, other],
				retrieved: ["p-2"],
				evidence,
			}),
		).toBe("not_retrieved");
		expect(
			classifyFailure({
				staleUses: 0,
				memories: [useful, other],
				retrieved: ["p-2", "p-1"],
				evidence,
			}),
		).toBe("retrieved_not_used");
	});

	test("解题要用的信息在正文里也算", () => {
		expect(
			classifyFailure({
				staleUses: 0,
				memories: [{ ...other, body: "The deploy code is K-42." }],
				retrieved: [],
				evidence,
			}),
		).toBe("not_retrieved");
	});
});

describe("单独报告的组", () => {
	const mem0Usage = {
		llmRequests: 2,
		embeddingRequests: 3,
		tokens: { input: 400, output: 60, embedding: 30 },
		costUsd: 0.002,
	};
	/** t1 的完整 memory 组第 3 次没通过，t3 的第 2、3 次没通过。 */
	const base = [
		...trialsOf("t1", {
			none: 0,
			history: 3,
			retrieval: 2,
			memory: 2,
			irrelevant: 0,
		}),
		...trialsOf("t3", {
			none: 3,
			history: 3,
			retrieval: 3,
			memory: 1,
			irrelevant: 2,
		}),
	];
	const extra = (
		group: "diagnostic" | "mem0",
		passes: Record<string, number>,
	) =>
		Object.entries(passes).flatMap(([task, passed]) =>
			[1, 2, 3].map((run) =>
				trial(
					task,
					group,
					run,
					run <= passed,
					group === "mem0" ? { external: mem0Usage } : {},
				),
			),
		);

	test("诊断组和 Mem0 组各给出成功率、和无记忆组的配对差和开销，不进五组的结果和分层", () => {
		const report = memoryReport(conditions, [
			...base,
			...extra("diagnostic", { t1: 3, t3: 2 }),
			...extra("mem0", { t1: 1, t3: 3 }),
		]);
		expect(report.groups.map((group) => group.group)).toEqual([
			...memoryGroups,
		]);
		expect(
			report.extra.map(({ group, passed, trials: total, difference }) => ({
				group,
				passed,
				total,
				mean: difference?.mean,
			})),
		).toEqual([
			// t1：3/3 − 0/3，t3：2/3 − 3/3
			{
				group: "diagnostic",
				passed: 5,
				total: 6,
				mean: expect.closeTo(1 / 3, 10),
			},
			// t1：1/3 − 0/3，t3：3/3 − 3/3
			{ group: "mem0", passed: 4, total: 6, mean: expect.closeTo(1 / 6, 10) },
		]);
		expect(report.extra[0]?.external).toBeUndefined();
		expect(report.extra[1]?.external).toEqual({
			llmRequests: 12,
			embeddingRequests: 18,
			tokens: { input: 2400, output: 360, embedding: 180 },
			costUsd: expect.closeTo(0.012, 10),
		});
		expect(report.extra[1]?.warm.costUsd).toBeCloseTo(0.06, 10);
		expect(report.perTask).toEqual([
			{
				task: "t1",
				passed: {
					none: 0,
					history: 3,
					retrieval: 2,
					memory: 2,
					irrelevant: 0,
					diagnostic: 3,
					mem0: 1,
				},
			},
			{
				task: "t3",
				passed: {
					none: 3,
					history: 3,
					retrieval: 3,
					memory: 1,
					irrelevant: 2,
					diagnostic: 2,
					mem0: 3,
				},
			},
		]);
		for (const stratum of report.strata) {
			expect(stratum.differences.map((entry) => entry.group)).toEqual([
				"history",
				"retrieval",
				"memory",
				"irrelevant",
			]);
		}

		const text = formatMemoryReport(report);
		expect(text).toContain("## 单独报告的组");
		expect(text).toContain("诊断组（直接给出正确证据）：");
		expect(text).toContain("Mem0 对照组：");
		expect(text).toContain(
			"- Mem0 自己的用量（不在上面两项里）：模型请求 12 次，token 输入 2400、输出 360；嵌入请求 18 次，180 token；0.0120 美元",
		);
		expect(text).toContain("诊断组（直接给出正确证据） 3/3，Mem0 对照组 1/3");
	});

	test("完整 memory 组没通过的运行按同一次运行的诊断组分开：诊断组通过的是写入或检索的问题", () => {
		// 完整 memory 组没通过的：t1 第 3 次，t3 第 2、3 次；诊断组 t1 三次都通过，t3 只有前两次通过
		const report = memoryReport(conditions, [
			...base,
			...extra("diagnostic", { t1: 3, t3: 2 }),
		]);
		expect(report.diagnosis).toEqual({ writeOrRetrieve: 2, use: 1 });
		expect(report.extra.map((group) => group.group)).toEqual(["diagnostic"]);
		expect(formatMemoryReport(report)).toContain(
			"- 完整 memory 组没通过的运行里，诊断组通过的 2 次（问题在写入或检索），诊断组也没通过的 1 次（问题在使用，或者题目太难）",
		);
	});

	test("没有运行这两组时报告里没有这一节；运行了的组每道题的次数也要齐", () => {
		const report = memoryReport(conditions, base);
		expect(report.extra).toEqual([]);
		expect(report.diagnosis).toBeUndefined();
		expect(formatMemoryReport(report)).not.toContain("单独报告的组");

		expect(() =>
			memoryReport(conditions, [...base, ...extra("mem0", { t1: 3 })]),
		).toThrow();
	});
});
