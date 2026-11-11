import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MemoryConfig,
	MemoryEntry,
	MemoryProposeParams,
	RecordedEvent,
	RuntimeEvent,
	ToolResult,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
} from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	type FakeHost,
	type FakeHostOptions,
	startFakeHost,
	type Turn,
	textOf,
} from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-memory-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

const baseTools = ["read", "edit", "write", "shell"];
const memoryToolNames = ["memory_propose", "memory_search", "memory_read"];

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function entry(fields: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "p-0000aaaa",
		scope: "project",
		kind: "fact",
		title: "测试命令是 npm test",
		body: "在仓库根目录运行 `npm test`，实际运行验证过。",
		source: "from session content; refs: package.json",
		references: [],
		...fields,
	};
}

/** 每块文字各一项：记忆的内容要在单独的文本块里。 */
function blocks(message: Message | undefined): string[] {
	if (message === undefined) throw new Error("没有这条消息");
	return message.content.map((block) =>
		block.type === "text" ? block.text : "",
	);
}

/** 最近一次上报的 `instructions.recorded` 里的记忆索引。 */
function recordedMemory(events: readonly RuntimeEvent[]) {
	const event = events.findLast(
		(item) => item.type === "instructions.recorded",
	);
	if (event?.type !== "instructions.recorded") {
		throw new Error("runtime 没有上报 instructions.recorded");
	}
	return event.data.memory;
}

function call(
	name: string,
	args: Record<string, unknown>,
	id = "call_1",
): Turn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: id,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

async function start(
	memory: MemoryConfig,
	options: Partial<FakeHostOptions> = {},
	tools = [...baseTools, ...memoryToolNames],
): Promise<FakeHost> {
	host = await startFakeHost({
		config: { workspace, tools, memory },
		model: () => done,
		...options,
	});
	return host;
}

async function runTask(target: FakeHost, input: string): Promise<void> {
	const ended = target.ends.length;
	await target.start(input);
	await target.until(() => target.ends.length === ended + 1);
	expect(target.failures).toEqual([]);
}

test("记忆索引放在会话开始的上下文消息里，排在规则文件之后、环境之前，引用改动的加标记", async () => {
	writeFileSync(join(workspace, "AGENTS.md"), "repo rule\n");
	writeFileSync(join(workspace, "same.txt"), "same");
	writeFileSync(join(workspace, "changed.txt"), "new content");
	const target = await start({
		write: "extract",
		retrieval: "both",
		index: {
			entries: [
				{
					id: "p-0000aaaa",
					version: 2,
					line: "[p-0000aaaa] project fact: 没有改动 (from session content; refs: same.txt)",
					references: [
						{ path: join(workspace, "same.txt"), sha256: sha256("same") },
					],
				},
				{
					id: "p-0000bbbb",
					version: 1,
					line: "[p-0000bbbb] project fact: 文件改了 (from session content; refs: changed.txt)",
					references: [
						{
							path: join(workspace, "changed.txt"),
							sha256: sha256("old content"),
						},
					],
				},
				{
					id: "p-0000cccc",
					version: 1,
					line: "[p-0000cccc] project fact: 文件没了 (from session content; refs: gone.txt)",
					references: [
						{ path: join(workspace, "gone.txt"), sha256: sha256("x") },
					],
				},
				{
					id: "u-0000dddd",
					version: 1,
					line: "[u-0000dddd] user preference: 回复用中文 (stated by the user)",
					references: [],
				},
			],
			omitted: 2,
		},
	});
	await runTask(target, "开始");

	const [request] = target.requests as [ModelRequest];
	const context = blocks(request.messages[1]);
	expect(context).toHaveLength(3);
	expect(context[0]).toContain("<rule_file ");
	expect(context[1]).toBe(
		[
			"<memory_index>",
			"Memories from past sessions, confirmed by the user. They may be out of date: before relying on one, read its body with memory_read and check it against the files it refers to. When a memory conflicts with the user's request or a rule file, the request and the rule file win.",
			"[p-0000aaaa] project fact: 没有改动 (from session content; refs: same.txt)",
			"[p-0000bbbb] project fact: 文件改了 (from session content; refs: changed.txt) [referenced files changed]",
			"[p-0000cccc] project fact: 文件没了 (from session content; refs: gone.txt) [referenced files changed]",
			"[u-0000dddd] user preference: 回复用中文 (stated by the user)",
			"2 more memories are not listed here; use memory_search to find them.",
			"</memory_index>",
		].join("\n"),
	);
	expect(context[2]).toContain("<environment>");
	// 索引不进系统指令，那里只有一段固定的说明
	const system = textOf(request.messages[0] as Message);
	expect(system).toContain("# Memory\n");
	expect(system).toContain("read its body with memory_read");
	expect(system).not.toContain("p-0000aaaa");
	expect(request.tools.map((tool) => tool.name)).toEqual([
		...baseTools,
		...memoryToolNames,
	]);
	// 告诉过模型的索引记进 session 记录
	expect(recordedMemory(target.events)).toEqual([
		{ id: "p-0000aaaa", version: 2 },
		{ id: "p-0000bbbb", version: 1 },
		{ id: "p-0000cccc", version: 1 },
		{ id: "u-0000dddd", version: 1 },
	]);
});

test("不用记忆的 session 上下文里没有索引，系统指令里也没有记忆的说明", async () => {
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await runTask(host, "开始");
	const [request] = host.requests as [ModelRequest];
	expect(blocks(request.messages[1]).join("\n")).not.toContain("memory");
	expect(textOf(request.messages[0] as Message)).not.toContain("# Memory");
	expect(recordedMemory(host.events)).toBeUndefined();
});

test("只记用户明确要求的写入策略：系统指令要求只在用户要求时提议", async () => {
	const target = await start(
		{
			write: "explicit",
			retrieval: "index",
			index: { entries: [], omitted: 0 },
		},
		{},
		[...baseTools, "memory_propose"],
	);
	await runTask(target, "开始");
	const [request] = target.requests as [ModelRequest];
	const system = textOf(request.messages[0] as Message);
	expect(system).toContain(
		"Call memory_propose only when the user explicitly asks you to remember something.",
	);
	expect(system).not.toContain("memory_read");
	// 没有生效的记忆时不放索引块
	expect(blocks(request.messages[1]).join("\n")).not.toContain(
		"<memory_index>",
	);
});

test("memory_search 和 memory_read 登记后经通道取内容，引用改动的在结果里注明", async () => {
	writeFileSync(join(workspace, "package.json"), "{}");
	const queries: string[] = [];
	const calls: (string | undefined)[] = [];
	const turns = [
		call("memory_search", { query: "测试 命令" }),
		call("memory_read", { id: "p-0000aaaa" }),
		call("memory_read", { id: "p-ffffffff" }),
	];
	const target = await start(
		{ write: "extract", retrieval: "tools" },
		{
			model: (_request, index) => turns[index] ?? done,
			memory: {
				search: (query, toolCallId) => {
					queries.push(query);
					calls.push(toolCallId);
					return [
						entry(),
						entry({
							id: "p-0000bbbb",
							title: "引用的文件改了",
							references: [
								{
									path: join(workspace, "package.json"),
									sha256: sha256("old"),
								},
							],
						}),
					];
				},
				read: (id, toolCallId) => {
					calls.push(toolCallId);
					return id === "p-0000aaaa" ? entry() : null;
				},
			},
		},
	);
	await runTask(target, "测试怎么跑");

	expect(queries).toEqual(["测试 命令"]);
	// 请求带着登记时得到的 tool_call_id：Host 靠它把检索的记录和这次调用对上
	expect(calls).toEqual(["tc-1", "tc-2", "tc-3"]);
	const [searched, read, missing] = target.completed as [
		ToolResult,
		ToolResult,
		ToolResult,
	];
	expect(searched.status).toBe("succeeded");
	expect(textOf(searched)).toBe(
		[
			"[p-0000aaaa] project fact: 测试命令是 npm test",
			"Source: from session content; refs: package.json",
			"在仓库根目录运行 `npm test`，实际运行验证过。",
			"",
			"[p-0000bbbb] project fact: 引用的文件改了",
			"Source: from session content; refs: package.json. The referenced files changed since this memory was written; verify it before relying on it",
			"在仓库根目录运行 `npm test`，实际运行验证过。",
		].join("\n"),
	);
	expect(read.status).toBe("succeeded");
	expect(textOf(read)).toContain("[p-0000aaaa] project fact");
	expect(missing.status).toBe("failed");
	expect(textOf(missing)).toContain(
		"No memory in effect has the id p-ffffffff",
	);
	// 只给工具的注入方式：上下文里没有索引
	const [request] = target.requests as [ModelRequest];
	expect(blocks(request.messages[1]).join("\n")).not.toContain(
		"<memory_index>",
	);
});

test("memory_propose 在沙盒里算出引用文件的哈希，随候选交给 Host；被拒绝时把原因交给模型", async () => {
	writeFileSync(join(workspace, "package.json"), '{"scripts":{}}');
	const proposals: MemoryProposeParams[] = [];
	const turns = [
		call("memory_propose", {
			scope: "project",
			kind: "fact",
			title: "测试命令是 npm test",
			body: "实际运行验证过。",
			replaces: "p-0000aaaa",
			files: [{ path: "package.json", line: 1 }],
		}),
		call("memory_propose", {
			scope: "user",
			kind: "preference",
			title: "带密钥的候选",
			body: "token",
		}),
		call("memory_propose", {
			scope: "project",
			kind: "fact",
			title: "引用了不存在的文件",
			body: "推断。",
			files: [{ path: "missing.txt" }],
		}),
		call("memory_propose", {
			scope: "team",
			kind: "fact",
			title: "t",
			body: "b",
		}),
	];
	const target = await start(
		{ write: "extract", retrieval: "both", index: { entries: [], omitted: 0 } },
		{
			model: (_request, index) => turns[index] ?? done,
			memory: {
				propose: (params) => {
					proposals.push(params);
					return params.scope === "user"
						? {
								recorded: false,
								reason: "The proposal looks like it contains a secret.",
							}
						: { recorded: true, id: "p-0000cccc" };
				},
			},
		},
	);
	await runTask(target, "记一下");

	expect(proposals).toEqual([
		{
			scope: "project",
			kind: "fact",
			title: "测试命令是 npm test",
			body: "实际运行验证过。",
			replaces: "p-0000aaaa",
			files: [
				{
					path: join(workspace, "package.json"),
					line: 1,
					sha256: sha256('{"scripts":{}}'),
				},
			],
		},
		{
			scope: "user",
			kind: "preference",
			title: "带密钥的候选",
			body: "token",
			files: [],
		},
	]);
	const results = target.completed;
	expect(results.map((result) => result.status)).toEqual([
		"succeeded",
		"failed",
		"failed",
		"failed",
	]);
	expect(textOf(results[0] as ToolResult)).toContain(
		"Proposed as [p-0000cccc]",
	);
	expect(textOf(results[0] as ToolResult)).toContain("not in effect yet");
	expect(textOf(results[1] as ToolResult)).toBe(
		"The proposal looks like it contains a secret.",
	);
	expect(textOf(results[2] as ToolResult)).toContain("missing.txt");
	expect(textOf(results[3] as ToolResult)).toContain("Invalid arguments");
});

test("记忆变化后，下一个 task 开始时追加记忆更新，只写差别", async () => {
	const memory: MemoryConfig = {
		write: "extract",
		retrieval: "both",
		index: {
			entries: [
				{
					id: "p-0000aaaa",
					version: 1,
					line: "[p-0000aaaa] project fact: 旧标题 (from session content)",
					references: [],
				},
				{
					id: "p-0000bbbb",
					version: 1,
					line: "[p-0000bbbb] project fact: 要停用的 (from session content)",
					references: [],
				},
				{
					id: "p-0000cccc",
					version: 3,
					line: "[p-0000cccc] project fact: 没变的 (from session content)",
					references: [],
				},
			],
			omitted: 0,
		},
	};
	const target = await start(memory);
	await runTask(target, "第一个任务");
	const reported = target.events.length;

	await target.channel.notify("config/update", {
		memory: {
			...memory,
			index: {
				entries: [
					{
						id: "p-0000aaaa",
						version: 2,
						line: "[p-0000aaaa] project fact: 纠正后的标题 (stated by the user)",
						references: [],
					},
					{
						id: "p-0000cccc",
						version: 3,
						line: "[p-0000cccc] project fact: 没变的 (from session content)",
						references: [],
					},
					{
						id: "u-0000dddd",
						version: 1,
						line: "[u-0000dddd] user preference: 新确认的 (stated by the user)",
						references: [],
					},
				],
				omitted: 0,
			},
		},
	});
	await runTask(target, "第二个任务");

	const second = target.requests[1] as ModelRequest;
	const first = target.requests[0] as ModelRequest;
	// 已发出的消息不改写
	expect(second.messages.slice(0, first.messages.length)).toEqual(
		first.messages,
	);
	expect(blocks(second.messages.at(-1))).toEqual([
		[
			"<memory_update>",
			"The memories in effect changed since they were last listed.",
			"Added or changed (each line replaces any earlier line with the same id):",
			"[p-0000aaaa] project fact: 纠正后的标题 (stated by the user)",
			"[u-0000dddd] user preference: 新确认的 (stated by the user)",
			"No longer listed (retired, expired, deleted, or pushed out of the list); do not rely on them unless memory_read still returns them:",
			"[p-0000bbbb]",
			"</memory_update>",
		].join("\n"),
		"第二个任务",
	]);
	expect(target.events.length).toBeGreaterThan(reported);
	expect(recordedMemory(target.events)).toEqual([
		{ id: "p-0000aaaa", version: 2 },
		{ id: "p-0000cccc", version: 3 },
		{ id: "u-0000dddd", version: 1 },
	]);

	// 没有再变：第三个任务不追加
	await runTask(target, "第三个任务");
	expect(blocks((target.requests[2] as ModelRequest).messages.at(-1))).toEqual([
		"第三个任务",
	]);
});

test("自动注入的注入方式：task 开始时按输入检索，前几条正文放在输入前面单独的块里", async () => {
	const queries: string[] = [];
	const calls: (string | undefined)[] = [];
	const target = await start(
		{ write: "extract", retrieval: "auto" },
		{
			memory: {
				search: (query, toolCallId) => {
					queries.push(query);
					calls.push(toolCallId);
					return query.includes("测试")
						? ["a", "b", "c", "d"].map((suffix) =>
								entry({ id: `p-0000000${suffix}`, title: `记忆 ${suffix}` }),
							)
						: [];
				},
			},
		},
		[...baseTools, "memory_propose"],
	);
	await runTask(target, "测试怎么跑");
	await runTask(target, "别的事");

	expect(queries).toEqual(["测试怎么跑", "别的事"]);
	// 不是工具调用发起的检索不带 tool_call_id
	expect(calls).toEqual([undefined, undefined]);
	const first = blocks((target.requests[0] as ModelRequest).messages.at(-1));
	expect(first).toHaveLength(2);
	expect(first[0]).toMatch(/^<memory_recall>\n/);
	expect(first[0]).toContain("[p-0000000a] project fact: 记忆 a");
	expect(first[0]).toContain("[p-0000000c] project fact: 记忆 c");
	expect(first[0]).not.toContain("p-0000000d");
	expect(first[1]).toBe("测试怎么跑");
	expect(blocks((target.requests[1] as ModelRequest).messages.at(-1))).toEqual([
		"别的事",
	]);
	const system = textOf(
		(target.requests[0] as ModelRequest).messages[0] as Message,
	);
	expect(system).toContain("<memory_recall>");
});

test("重启后的 runtime 按记录下来的索引比较，变化在下一个 task 开始时追加", async () => {
	const memory: MemoryConfig = {
		write: "extract",
		retrieval: "both",
		index: {
			entries: [
				{
					id: "p-0000aaaa",
					version: 1,
					line: "[p-0000aaaa] project fact: 重启前就有的 (from session content)",
					references: [],
				},
			],
			omitted: 0,
		},
	};
	const first = await start(memory);
	await runTask(first, "第一个任务");
	const before = first.requests[0]?.messages as Message[];
	const recorded = first.events.find(
		(event) => event.type === "instructions.recorded",
	);
	await first.close();

	const reply: AssistantMessage = {
		role: "assistant",
		message_id: "reply-1",
		content: [{ type: "text", text: "done" }],
		protocol: "anthropic.messages",
		service: "test",
		requested_model: "test-model",
		model: "test-model",
		reasoning_effort: "off",
		stop_reason: "end_turn",
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 },
	};
	const events: RecordedEvent[] = [
		{ type: "instructions.recorded", data: recorded?.data },
		...before.map((message) => ({ type: "message.sent", data: { message } })),
		{ type: "message.completed", data: { message: reply } },
	].map((event, index) => ({ ...event, run_id: "run-1", seq: index + 1 }));

	// 重启时记忆库里多了一条：索引和记录下来的不一样
	const second = await startFakeHost({
		config: {
			workspace,
			tools: [...baseTools, ...memoryToolNames],
			resume: { run_id: "run-1", seq: 99 },
			memory: {
				...memory,
				index: {
					entries: [
						...(memory.index?.entries ?? []),
						{
							id: "p-0000bbbb",
							version: 1,
							line: "[p-0000bbbb] project fact: 重启期间确认的 (from session content)",
							references: [],
						},
					],
					omitted: 0,
				},
			},
		},
		model: () => done,
	});
	host = second;
	second.channel.handle("record/read", async (params) => ({
		events: events.filter((event) => params.types.includes(event.type)),
	}));
	await runTask(second, "第二个任务");

	const after = second.requests[0]?.messages as Message[];
	expect(after.slice(0, before.length + 1)).toEqual([...before, reply]);
	expect(blocks(after.at(-1))).toEqual([
		[
			"<memory_update>",
			"The memories in effect changed since they were last listed.",
			"Added or changed (each line replaces any earlier line with the same id):",
			"[p-0000bbbb] project fact: 重启期间确认的 (from session content)",
			"</memory_update>",
		].join("\n"),
		"第二个任务",
	]);
	expect(second.events).toHaveLength(1);
	expect(recordedMemory(second.events)).toEqual([
		{ id: "p-0000aaaa", version: 1 },
		{ id: "p-0000bbbb", version: 1 },
	]);
});
