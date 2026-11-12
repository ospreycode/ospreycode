import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "@ospreycode/api";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import {
	type EvaluationEnvironment,
	formatMemoryReport,
	type MemoryTask,
	type MemoryTrial,
	memoryGroups,
	memoryReport,
	runMemoryExperiment,
} from "@ospreycode/evaluation";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fakeMem0, fakeUsage } from "./mem0-harness.js";

/** 脚本模型用的清单条目，地址不会被访问。 */
const model: ModelEntry = {
	id: "scripted",
	protocol: "anthropic.messages",
	service: "test",
	base_url: "https://scripted.invalid/v1",
	model: "scripted",
	context_window: 200_000,
	max_output_tokens: 8_000,
};

let secrets: string;
/** 脚本模型收到的每次请求。 */
let requests: ModelRequest[];

beforeEach(() => {
	secrets = mkdtempSync("/tmp/osp-eval-test-");
	writeFileSync(join(secrets, "test"), "test-key\n", { mode: 0o600 });
	requests = [];
});

afterEach(() => {
	rmSync(secrets, { recursive: true, force: true });
});

function environment(
	script: (request: ModelRequest) => ScriptedTurn,
): EvaluationEnvironment {
	return {
		model,
		reasoningEffort: "off",
		credential: { file: join(secrets, "test") },
		budget: { maxCostUsd: null, maxRequests: 10, maxDurationMs: null },
		denyRead: [],
		env: { PATH: process.env.PATH },
		streamModel: scriptedModel((request) => {
			requests.push(request);
			return script(request);
		}),
	};
}

const say = (text: string): ScriptedTurn => ({
	content: [{ type: "text", text }],
});

function call(name: string, args: Record<string, unknown>): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: `call_${requests.length}`,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

const isExtraction = (request: ModelRequest) =>
	JSON.stringify(request.messages[0]).includes(
		"You review the transcript of a finished coding session",
	);

/** 系统指令和模型自己的回复之外的全部内容：上下文、用户的输入和工具结果。 */
function received(request: ModelRequest): string {
	return JSON.stringify(
		request.messages.filter(
			(message) => message.role !== "system" && message.role !== "assistant",
		),
	);
}

/** 这次请求是所在 task 里的第几次，从 0 开始。 */
function turn(request: ModelRequest): number {
	return request.messages.filter((message) => message.role === "assistant")
		.length;
}

function toolNames(request: ModelRequest): string[] {
	return request.tools.map((tool) => tool.name);
}

function by(
	trials: readonly MemoryTrial[],
	group: MemoryTrial["group"],
): MemoryTrial {
	const trial = trials.find((item) => item.group === group);
	if (trial === undefined) throw new Error(`没有 ${group} 组的运行`);
	return trial;
}

function eventsOf(trial: MemoryTrial, type: string) {
	return [...trial.learn, ...trial.maintenance, trial.probe].flatMap(
		(session) => session.events.filter((event) => event.type === type),
	);
}

const learnInput = "The deploy code is K-42. Remember it.";
const probeInput = "Write the deploy code into code.txt.";

const deployCode: MemoryTask = {
	name: "部署口令",
	setup: (workspace) =>
		writeFileSync(join(workspace, "notes.txt"), "nothing here\n"),
	learn: [learnInput],
	probe: probeInput,
	check: (probe, workspace) => [
		...(probe.outcome === "completed" ? [] : ["task 没有完成"]),
		...(existsSync(join(workspace, "code.txt")) &&
		readFileSync(join(workspace, "code.txt"), "utf8") === "K-42"
			? []
			: ["code.txt 里没有口令"]),
	],
	evidence: (text) => text.includes("K-42"),
	facts: "The deploy code is K-42.",
};

/**
 * 一个只会照着眼前的内容做事的模型：学习会话里读一遍 notes.txt，有 memory_propose 就提议记下口令；
 * 检验会话里有索引就先读第一条记忆，眼前有口令就写进文件，没有就再读一遍 notes.txt 然后放弃。
 */
function deployScript(request: ModelRequest): ScriptedTurn {
	if (isExtraction(request)) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						candidates: [
							{
								action: "add",
								scope: "project",
								kind: "fact",
								title: "Notes are kept in notes.txt",
								body: "The session read notes.txt in the workspace root.",
							},
						],
					}),
				},
			],
			usage: { input: 1000, output: 100 },
		};
	}
	const seen = received(request);
	const step = turn(request);
	if (!seen.includes(probeInput)) {
		if (step === 0) return call("read", { path: "notes.txt" });
		if (step === 1 && toolNames(request).includes("memory_propose")) {
			return call("memory_propose", {
				scope: "project",
				kind: "fact",
				title: "Deploy code is K-42",
				body: "The user said the deploy code is K-42.",
			});
		}
		return say("OK");
	}
	// 索引里的各行：有写着口令的就读它，没有就读第一条
	const listed = [
		...seen.matchAll(/\[([pu]-[^\]]+)\] (?:project|user) \w+: ([^(]*)/gu),
	];
	const target = listed.find((line) => line[2]?.includes("K-42")) ?? listed[0];
	if (step === 0 && target !== undefined) {
		return call("memory_read", { id: target[1] });
	}
	const said = JSON.stringify(
		request.messages.filter((message) => message.role === "assistant"),
	);
	if (said.includes("printf K-42")) return say("done");
	if (seen.includes("K-42")) {
		return call("shell", { command: "printf K-42 > code.txt" });
	}
	return said.includes("notes.txt")
		? say("I do not know the deploy code.")
		: call("read", { path: "notes.txt" });
}

test("五个组各运行一遍：只有拿得到之前会话内容的组通过，等长无关记忆组的记忆和完整 memory 组一样长", async () => {
	const trials = await runMemoryExperiment(
		[deployCode],
		environment(deployScript),
		{ runs: 1, timeoutMs: 30_000, diagnostic: false },
	);

	expect(trials.map((trial) => trial.group)).toEqual([...memoryGroups]);
	expect(
		Object.fromEntries(trials.map((trial) => [trial.group, trial.passed])),
	).toEqual({
		none: false,
		history: true,
		retrieval: true,
		memory: true,
		irrelevant: false,
	});
	for (const trial of trials) {
		expect(trial).toMatchObject({ task: "部署口令", run: 1 });
		expect(trial.learn).toHaveLength(1);
		expect(trial.learn[0]?.outcome).toBe("completed");
		expect(trial.probe.outcome).toBe("completed");
		expect(trial.probe.sessionId).not.toBe(trial.learn[0]?.sessionId);
	}

	// 无记忆：没有记忆工具，检验会话把学习会话读过的文件又读了一遍
	const none = by(trials, "none");
	expect(none.problems).toEqual(["code.txt 里没有口令"]);
	expect(none.counters).toEqual({
		repeatedCalls: 1,
		repeatedReads: 1,
		repeatedFailures: 0,
		staleUses: 0,
	});
	expect(none.memories).toEqual([]);
	expect(none.failure).toBeUndefined();
	expect(eventsOf(none, "memory.candidates")).toEqual([]);

	// 直接提供历史：整份文字记录在检验会话的输入前面
	const input = (trial: MemoryTrial) =>
		trial.probe.events.flatMap((event) =>
			event.type === "task.started"
				? event.input.flatMap((block) =>
						block.type === "text" ? [block.text] : [],
					)
				: [],
		)[0];
	const history = input(by(trials, "history"));
	expect(history).toContain("<earlier_sessions>");
	expect(history).toContain(`[session 1] user: ${learnInput}`);
	expect(history).toContain(
		'[session 1] tool: read {"path":"notes.txt"}\nsucceeded: ',
	);
	expect(history).toContain("[session 1] assistant: OK");
	expect(history?.endsWith(`</earlier_sessions>\n\n${probeInput}`)).toBe(true);
	expect(by(trials, "history").counters.repeatedReads).toBe(0);

	// 只检索：只有和输入有词相同的记录，命中多的在前
	const retrieval = input(by(trials, "retrieval"));
	expect(retrieval).toContain(`[session 1] user: ${learnInput}`);
	expect(retrieval).not.toContain("assistant: OK");
	expect(retrieval?.indexOf("user: The deploy code")).toBeLessThan(
		retrieval?.indexOf("tool: read") ?? -1,
	);

	// 完整 memory：模型提议的和提取的候选都由脚本确认；提取在两个会话之间单独的 session 里做
	const memory = by(trials, "memory");
	const byTitle = (memories: MemoryTrial["memories"]) =>
		memories.toSorted((a, b) => a.title.localeCompare(b.title));
	expect(
		byTitle(memory.memories).map(({ status, title }) => ({ status, title })),
	).toEqual([
		{ status: "active", title: "Deploy code is K-42" },
		{ status: "active", title: "Notes are kept in notes.txt" },
	]);
	expect(memory.learn[0]?.indexTokens).toBe(0);
	expect(memory.probe.indexTokens).toBeGreaterThan(0);
	expect(memory.maintenance).toHaveLength(1);
	expect(memory.maintenance[0]?.usage.input).toBe(1000);
	expect(
		eventsOf(memory, "memory.extraction.ended").map(
			(event) => event.session_id,
		),
	).toEqual([memory.maintenance[0]?.sessionId]);
	// 检验会话开头的索引里两条都有，不是会话中途的"记忆更新"
	expect(
		requests.some((request) => received(request).includes("<memory_update>")),
	).toBe(false);
	expect(memory.counters).toEqual({
		repeatedCalls: 0,
		repeatedReads: 0,
		repeatedFailures: 0,
		staleUses: 0,
	});
	expect(
		memory.probe.events.flatMap((event) =>
			event.type === "memory.retrieved" ? event.memory_ids : [],
		),
	).toEqual([byTitle(memory.memories)[0]?.id]);

	// 等长无关记忆：学习会话没有记忆，检验会话里是同样条数、同样长度的无关内容
	const irrelevant = by(trials, "irrelevant");
	const shape = (memories: MemoryTrial["memories"]) =>
		memories
			.map(({ status, scope, kind, title, body }) => ({
				status,
				scope,
				kind,
				title: title.length,
				body: body.length,
			}))
			.sort((a, b) => a.title - b.title);
	expect(shape(irrelevant.memories)).toEqual(shape(memory.memories));
	for (const filler of irrelevant.memories) {
		expect(`${filler.title}\n${filler.body}`).not.toMatch(/K-42|notes\.txt/);
	}
	// 索引的每一行除了标题还有一段来源说明，用户添加的和模型写的这一段差两个字符
	expect(irrelevant.probe.indexTokens).toBeGreaterThan(0);
	expect(
		Math.abs(irrelevant.probe.indexTokens - memory.probe.indexTokens),
	).toBeLessThanOrEqual(2 * irrelevant.memories.length);
	expect(irrelevant.maintenance).toHaveLength(1);
	expect(irrelevant.failure).toBeUndefined();
	expect(eventsOf(irrelevant, "memory.extraction.ended")).toEqual([]);
	for (const group of ["none", "history", "retrieval"] as const) {
		expect(by(trials, group).maintenance).toEqual([]);
	}

	// 关掉长期记忆的会话里模型没有记忆工具
	const withMemoryTools = requests
		.filter((request) => toolNames(request).includes("memory_propose"))
		.map((request) => received(request).includes(probeInput));
	// 完整 memory 组的两个会话各 3 次请求，等长无关记忆组的检验会话 3 次
	expect(withMemoryTools.filter((probe) => !probe)).toHaveLength(3);
	expect(withMemoryTools.filter((probe) => probe)).toHaveLength(6);

	const report = memoryReport(
		{
			suite: "部署口令",
			model: "scripted",
			protocol: model.protocol,
			reasoningEffort: "off",
			commit: "0000000",
			version: "0.0.0",
			os: "test",
			rules: "",
			budget: { maxCostUsd: null, maxRequests: 10, maxDurationMs: null },
			timeoutMs: 30_000,
		},
		trials,
	);
	expect(
		report.groups.map((group) => [group.group, group.maintenance.sessions]),
	).toEqual([
		["none", 0],
		["history", 0],
		["retrieval", 0],
		["memory", 1],
		["irrelevant", 1],
	]);
	expect(report.groups[3]?.maintenance.tokens).toMatchObject({
		input: 1000,
		output: 100,
	});
	expect(report.memory).toMatchObject({
		sessions: 2,
		extraction: {
			runs: 1,
			requests: 1,
			tokens: { input: 1000, output: 100 },
			candidates: 1,
			dropped: 0,
		},
		proposed: 1,
		confirmations: 2,
		indexTokens: memory.probe.indexTokens,
	});
}, 120_000);

test("没有学习会话的题：完整 memory 组没通过时归到没写入；task 到时间上限被取消算没通过", async () => {
	const task: MemoryTask = {
		name: "没有可学的",
		setup: () => {},
		learn: [],
		probe: "What is the deploy code?",
		check: () => ["答不出来"],
		evidence: (text) => text.includes("K-42"),
		facts: "The deploy code is K-42.",
	};
	const answered = await runMemoryExperiment(
		[task],
		environment(() => say("I do not know.")),
		{ runs: 1, timeoutMs: 30_000, diagnostic: false },
	);
	expect(answered.map((trial) => trial.passed)).toEqual(
		memoryGroups.map(() => false),
	);
	expect(answered.map((trial) => trial.failure)).toEqual([
		undefined,
		undefined,
		undefined,
		"not_written",
		undefined,
	]);
	// 没有之前的会话：输入前面什么都不加
	expect(
		requests.every((request) => !received(request).includes("<earlier_")),
	).toBe(true);

	const hung = await runMemoryExperiment(
		[{ ...task, check: () => [] }],
		environment(() => ({ ...say("thinking"), hang: true })),
		{ runs: 1, timeoutMs: 300, diagnostic: false },
	);
	for (const trial of hung) {
		expect(trial.probe.outcome).toBeUndefined();
		expect(trial.problems).toEqual(["超过时间上限 300 毫秒"]);
		expect(trial.passed).toBe(false);
	}
}, 120_000);

/** 检验会话的输入里第一个文本块。 */
function probeText(trial: MemoryTrial): string {
	const [text] = trial.probe.events.flatMap((event) =>
		event.type === "task.started"
			? event.input.flatMap((block) =>
					block.type === "text" ? [block.text] : [],
				)
			: [],
	);
	if (text === undefined) throw new Error("检验会话没有输入");
	return text;
}

test("诊断组和 Mem0 对照组排在五组之后：诊断组拿到题目写的正确证据，Mem0 组拿到 Mem0 从学习会话提炼和检索的记忆", async () => {
	const mem0 = await fakeMem0(secrets);
	const trials = await runMemoryExperiment(
		[deployCode],
		environment(deployScript),
		{ runs: 1, timeoutMs: 30_000, diagnostic: true, mem0: mem0.options },
	).finally(() => mem0.close());

	expect(trials.map((trial) => trial.group)).toEqual([
		...memoryGroups,
		"diagnostic",
		"mem0",
	]);

	// 诊断组：关掉长期记忆，输入前面只有证据
	const diagnostic = by(trials, "diagnostic");
	expect(diagnostic.passed).toBe(true);
	expect(probeText(diagnostic)).toBe(
		`<known_facts>\nFacts established in earlier sessions. They are correct and current.\n\nThe deploy code is K-42.\n</known_facts>\n\n${probeInput}`,
	);
	expect(diagnostic.memories).toEqual([]);
	expect(diagnostic.maintenance).toEqual([]);
	expect(diagnostic.external).toBeUndefined();

	// Mem0 组：学习会话的文字记录一批交给 Mem0，工具调用写成 assistant 的文字
	const external = by(trials, "mem0");
	expect(external.passed).toBe(true);
	const extraction = mem0.requests.filter(
		(request) => request.path === "/v1/chat/completions",
	);
	expect(extraction).toHaveLength(1);
	expect(extraction[0]?.body.messages).toEqual([
		{ role: "user", content: learnInput },
		{
			role: "assistant",
			content: expect.stringMatching(
				/^tool: read \{"path":"notes\.txt"\}\nsucceeded: /,
			),
		},
		{ role: "assistant", content: "OK" },
	]);
	// 检验会话之前用它的输入检索，结果放在输入前面
	expect(probeText(external)).toBe(
		`<earlier_sessions>\nMemories from earlier sessions in this project that match this request. They may be out of date.\n\n- ${learnInput}\n</earlier_sessions>\n\n${probeInput}`,
	);
	expect(external.memories).toEqual([]);
	expect(external.external).toEqual({
		llmRequests: 1,
		embeddingRequests: 2,
		tokens: {
			input: fakeUsage.chat.prompt_tokens,
			output: fakeUsage.chat.completion_tokens,
			embedding: 2 * fakeUsage.embedding.prompt_tokens,
		},
		costUsd: (100 * 2 + 20 * 10 + 16 * 1) / 1_000_000,
	});
	// 这两组的会话里模型都没有记忆工具
	for (const trial of [diagnostic, external]) {
		expect(eventsOf(trial, "memory.candidates")).toEqual([]);
		expect(trial.probe.indexTokens).toBe(0);
	}

	const report = memoryReport(
		{
			suite: "部署口令",
			model: "scripted",
			protocol: model.protocol,
			reasoningEffort: "off",
			commit: "0000000",
			version: "0.0.0",
			os: "test",
			rules: "",
			budget: { maxCostUsd: null, maxRequests: 10, maxDurationMs: null },
			timeoutMs: 30_000,
		},
		trials,
	);
	expect(report.groups.map((group) => group.group)).toEqual([...memoryGroups]);
	expect(
		report.extra.map(({ group, passed, trials: total, difference }) => ({
			group,
			passed,
			total,
			mean: difference?.mean,
		})),
	).toEqual([
		{ group: "diagnostic", passed: 1, total: 1, mean: 1 },
		{ group: "mem0", passed: 1, total: 1, mean: 1 },
	]);
	expect(report.extra[1]?.external).toEqual(external.external);
	expect(report.diagnosis).toEqual({ writeOrRetrieve: 0, use: 0 });
	expect(report.perTask[0]?.passed).toMatchObject({ diagnostic: 1, mem0: 1 });
	expect(formatMemoryReport(report)).toContain("## 单独报告的组");
}, 120_000);

test("Mem0 中途出错：这次实验失败，错误里有桥接进程退出的原因", async () => {
	const mem0 = await fakeMem0(secrets, { FAKE_MEM0_CRASH: "add" });
	await expect(
		runMemoryExperiment([deployCode], environment(deployScript), {
			runs: 1,
			timeoutMs: 30_000,
			diagnostic: false,
			mem0: mem0.options,
		}).finally(() => mem0.close()),
	).rejects.toThrow("Mem0 的桥接进程退出了（退出码 3）");
}, 120_000);

test("检验会话换到另一个项目：同一个 HOME 下的另一个工作区，只有 user 范围的记忆跟过去", async () => {
	const preference = "Scripts always start with the line # owner: quill-53.";
	const probe = "Write hello.sh the way I like scripts.";
	const task: MemoryTask = {
		name: "另一个项目里的个人偏好",
		setup: (workspace) =>
			writeFileSync(join(workspace, "first-project.txt"), "first\n"),
		learn: [`${preference} Remember it for all my projects.`],
		probeProject: (workspace) =>
			writeFileSync(join(workspace, "second-project.txt"), "second\n"),
		probe,
		check: (_session, workspace) => [
			...(existsSync(join(workspace, "second-project.txt")) &&
			!existsSync(join(workspace, "first-project.txt"))
				? []
				: ["检查拿到的不是检验会话的工作区"]),
			...(existsSync(join(workspace, "hello.sh")) ? [] : ["没有写 hello.sh"]),
		],
		evidence: (text) => text.includes("quill-53"),
		facts: preference,
	};
	// 学习会话里各提议一条 project 记忆和一条 user 记忆；检验会话里看得到 quill-53 才写文件
	const trials = await runMemoryExperiment(
		[task],
		environment((request) => {
			const seen = received(request);
			const step = turn(request);
			if (!seen.includes(probe)) {
				if (step < 2 && toolNames(request).includes("memory_propose")) {
					return call("memory_propose", {
						scope: step === 0 ? "project" : "user",
						kind: "preference",
						title:
							step === 0
								? "first-project keeps notes in first-project.txt"
								: "Scripts start with # owner: quill-53",
						body: "The user said so.",
					});
				}
				return say("OK");
			}
			if (step === 0 && seen.includes("quill-53")) {
				return call("shell", { command: "printf hi > hello.sh" });
			}
			return say("done");
		}),
		{ runs: 1, timeoutMs: 30_000, diagnostic: true },
	);

	expect(
		Object.fromEntries(trials.map((trial) => [trial.group, trial.passed])),
	).toEqual({
		none: false,
		history: true,
		retrieval: true,
		memory: true,
		irrelevant: false,
		diagnostic: true,
	});
	// 另一个项目里只有 user 范围的那条
	expect(
		by(trials, "memory").memories.map(({ scope, title }) => ({ scope, title })),
	).toEqual([{ scope: "user", title: "Scripts start with # owner: quill-53" }]);
	// 等长无关记忆也加在检验会话所在的项目里
	expect(by(trials, "irrelevant").memories.map(({ scope }) => scope)).toEqual([
		"user",
	]);
}, 120_000);
