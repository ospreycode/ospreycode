import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentConfig,
	type HostChannel,
	openHostChannel,
	runAgent,
	type ToolCallRegisterParams,
	type ToolCallRegisterResult,
	type ToolResult,
} from "@ospreycode/agent-runtime";
import type { AssistantMessage } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { socketPair } from "./socket-pair.js";

interface Call {
	name: string;
	arguments: unknown;
}

/** 假 Host 看到的一次运行。 */
interface Trace {
	/** 每次调用的登记，按模型发出调用的顺序。 */
	registered: ToolCallRegisterParams[];
	/** 每次调用提交的结果，按模型发出调用的顺序；被拒绝的调用不提交结果，对应的位置为空。 */
	results: (ToolResult | undefined)[];
	/** 登记和提交结果到达的先后，如 `register read`、`complete read`。 */
	order: string[];
}

interface Options {
	writableRoots?: string[];
	/** 每一轮模型回复之前做的事，参数是第几轮（从 0 开始）。 */
	beforeRound?: (round: number) => void;
	/** 假 Host 对登记的回答；不写时都允许。 */
	register?: (
		params: ToolCallRegisterParams,
		toolCallId: string,
	) => Promise<ToolCallRegisterResult> | ToolCallRegisterResult;
}

let base: string;
let workspace: string;
let outside: string;
let host: HostChannel | undefined;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "osp-tools-")));
	workspace = join(base, "workspace");
	outside = join(base, "outside");
	mkdirSync(workspace);
	mkdirSync(outside);
});

afterEach(() => {
	host?.close();
	rmSync(base, { recursive: true, force: true });
});

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/**
 * 在进程内运行 runtime，另一端是假 Host：模型按 `rounds` 每轮发出一组工具调用，都执行完后结束 task。
 * 返回假 Host 看到的登记和结果。
 */
async function run(rounds: Call[][], options: Options = {}): Promise<Trace> {
	const [hostSide, agentSide] = await socketPair();
	const failures: Error[] = [];
	const channel = openHostChannel(hostSide, (error) => failures.push(error));
	host = channel;
	const order: string[] = [];
	/** 模型发出的调用编号，按发出的顺序。 */
	const issued: string[] = [];
	const registered = new Map<string, ToolCallRegisterParams>();
	const results = new Map<string, ToolResult>();
	/** Host 分配的编号对应的登记。 */
	const byToolCallId = new Map<string, ToolCallRegisterParams>();
	const ended = Promise.withResolvers<void>();
	let round = 0;

	channel.handle("initialize", async () => {
		const config: AgentConfig = {
			workspace,
			writable_roots: options.writableRoots ?? [workspace],
			model: {
				id: "test-model",
				protocol: "anthropic.messages",
				reasoning_effort: "off",
				context_window: 200_000,
				max_output_tokens: 8_000,
			},
			sandbox_mode: "workspace-write",
			approval_policy: "on-request",
			tools: ["read", "edit", "write", "shell"],
			user_instructions: null,
			date: "2026-11-10",
			os: "test",
		};
		return config;
	});
	channel.handle("model/request", async ({ message_id }) => {
		options.beforeRound?.(round);
		const calls = (rounds[round] ?? []).map((call, index) => ({
			type: "tool_call" as const,
			call_id: `call_${round}_${index}`,
			name: call.name,
			arguments:
				typeof call.arguments === "string"
					? call.arguments
					: JSON.stringify(call.arguments),
		}));
		round += 1;
		issued.push(...calls.map((call) => call.call_id));
		const message: AssistantMessage = {
			role: "assistant",
			message_id,
			content: calls.length === 0 ? [{ type: "text", text: "done" }] : calls,
			protocol: "anthropic.messages",
			service: "test",
			requested_model: "test-model",
			model: "test-model",
			reasoning_effort: "off",
			stop_reason: calls.length === 0 ? "end_turn" : "tool_use",
			usage: {
				input: 1,
				output: 1,
				cache_read: 0,
				cache_write: 0,
				reasoning: 0,
			},
		};
		return { message };
	});
	channel.handle("tool_call/register", async (params) => {
		const toolCallId = `tc-${registered.size + 1}`;
		registered.set(params.call_id, params);
		byToolCallId.set(toolCallId, params);
		order.push(`register ${params.name}`);
		return (
			(await options.register?.(params, toolCallId)) ?? {
				tool_call_id: toolCallId,
				allowed: true,
			}
		);
	});
	channel.handle("tool_call/complete", async ({ tool_call_id, result }) => {
		const params = byToolCallId.get(tool_call_id);
		if (params === undefined) {
			throw new Error(`提交了没有登记的调用的结果：${tool_call_id}`);
		}
		results.set(params.call_id, result);
		order.push(`complete ${params.name}`);
		return {};
	});
	channel.handle("task/end", async () => {
		ended.resolve();
		return { continue: false };
	});

	const agent = runAgent(agentSide);
	await channel.notify("task/start", {
		input: [{ type: "text", text: "go" }],
	});
	await ended.promise;
	channel.close();
	await agent;
	expect(failures).toEqual([]);
	return {
		registered: issued.map((callId) => {
			const params = registered.get(callId);
			if (params === undefined) throw new Error(`调用 ${callId} 没有登记`);
			return params;
		}),
		results: issued.map((callId) => results.get(callId)),
		order,
	};
}

test("write 新建文件和上级目录，登记改动前后的哈希；之后可以直接 edit 和 read", async () => {
	const file = join(workspace, "src/deep/hello.txt");
	const trace = await run([
		[
			{
				name: "write",
				arguments: { path: "src/deep/hello.txt", content: "hello\nworld\n" },
			},
		],
		[
			{
				name: "edit",
				arguments: {
					path: file,
					edits: [{ old_text: "world", new_text: "osprey" }],
				},
			},
		],
		[{ name: "read", arguments: { path: "src/deep/hello.txt" } }],
	]);

	expect(readFileSync(file, "utf8")).toBe("hello\nosprey\n");
	expect(trace.results.map((result) => result?.status)).toEqual([
		"succeeded",
		"succeeded",
		"succeeded",
	]);
	expect(trace.registered.map((params) => params.edit)).toEqual([
		{
			path: file,
			old_sha256: null,
			new_sha256: sha256("hello\nworld\n"),
		},
		{
			path: file,
			old_sha256: sha256("hello\nworld\n"),
			new_sha256: sha256("hello\nosprey\n"),
		},
		undefined,
	]);
	expect(output(trace.results[2])).toBe("hello\nosprey");
});

test("已有的文件要先读过才能改；读过以后被别人改了，要重新读", async () => {
	const file = join(workspace, "notes.txt");
	writeFileSync(file, "one\n");
	const edit = (oldText: string, newText: string) => ({
		name: "edit",
		arguments: {
			path: "notes.txt",
			edits: [{ old_text: oldText, new_text: newText }],
		},
	});
	const trace = await run(
		[
			[edit("one", "two")],
			[
				{
					name: "write",
					arguments: { path: "notes.txt", content: "overwritten" },
				},
			],
			[{ name: "read", arguments: { path: "notes.txt" } }],
			// 这一轮之前用户在编辑器里改了文件
			[edit("one", "two")],
			[{ name: "read", arguments: { path: "notes.txt" } }],
			[edit("three", "four")],
		],
		{
			beforeRound: (round) => {
				if (round === 3) writeFileSync(file, "three\n");
			},
		},
	);

	expect(trace.results.map((result) => result?.status)).toEqual([
		"failed",
		"failed",
		"succeeded",
		"failed",
		"succeeded",
		"succeeded",
	]);
	expect(output(trace.results[0])).toContain("has not been read yet");
	expect(output(trace.results[1])).toContain("has not been read yet");
	expect(output(trace.results[3])).toContain(
		"has changed since it was last read",
	);
	expect(readFileSync(file, "utf8")).toBe("four\n");
	// 没有通过检查的改动不带哈希登记
	expect(trace.registered[0]?.edit).toBeUndefined();
	expect(trace.registered[3]?.edit).toBeUndefined();
});

test("edit 的每处 old_text 要恰好出现一次、互不重叠、确实改了内容，否则文件不动", async () => {
	const file = join(workspace, "code.ts");
	const original = "const a = 1;\nconst b = 1;\nconst c = 3;\n";
	writeFileSync(file, original);
	const edit = (edits: { old_text: string; new_text: string }[]) => ({
		name: "edit",
		arguments: { path: "code.ts", edits },
	});
	const trace = await run([
		[{ name: "read", arguments: { path: "code.ts" } }],
		[edit([{ old_text: "const d", new_text: "x" }])],
		[edit([{ old_text: "= 1;", new_text: "= 2;" }])],
		[
			edit([
				{ old_text: "const a = 1;\nconst b", new_text: "x" },
				{ old_text: "const b = 1;", new_text: "y" },
			]),
		],
		[edit([{ old_text: "const c = 3;", new_text: "const c = 3;" }])],
		[edit([{ old_text: "", new_text: "x" }])],
		[edit([])],
		[
			edit([
				{ old_text: "const c = 3;", new_text: "const c = 4;" },
				{ old_text: "const a = 1;", new_text: "const a = 0;" },
			]),
		],
	]);

	const failures = trace.results.slice(1, 7);
	expect(failures.map((result) => result?.status)).toEqual(
		Array.from({ length: 6 }, () => "failed"),
	);
	expect(failures.map(output)).toEqual([
		expect.stringContaining("Could not find old_text"),
		expect.stringContaining("Found 2 occurrences of old_text"),
		expect.stringContaining("edits[0] and edits[1] overlap"),
		expect.stringContaining("No changes made"),
		expect.stringContaining("must not be empty"),
		expect.stringContaining("Invalid arguments: /edits"),
	]);
	expect(trace.results[7]?.status).toBe("succeeded");
	expect(readFileSync(file, "utf8")).toBe(
		"const a = 0;\nconst b = 1;\nconst c = 4;\n",
	);
});

test("edit 保留文件原来的 CRLF 换行和开头的 BOM", async () => {
	const file = join(workspace, "windows.txt");
	writeFileSync(file, "\uFEFFfirst\r\nsecond\r\nthird\r\n");
	const trace = await run([
		[{ name: "read", arguments: { path: "windows.txt" } }],
		[
			{
				name: "edit",
				arguments: {
					path: "windows.txt",
					edits: [{ old_text: "first\nsecond", new_text: "1\n2\n2.5" }],
				},
			},
		],
	]);

	expect(trace.results[1]?.status).toBe("succeeded");
	expect(readFileSync(file, "utf8")).toBe("\uFEFF1\r\n2\r\n2.5\r\nthird\r\n");
});

test("edit 不改不是合法 UTF-8 的文件", async () => {
	const file = join(workspace, "latin1.txt");
	const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
	writeFileSync(file, bytes);
	const trace = await run([
		[{ name: "read", arguments: { path: "latin1.txt" } }],
		[
			{
				name: "edit",
				arguments: {
					path: "latin1.txt",
					edits: [{ old_text: "caf", new_text: "tea" }],
				},
			},
		],
	]);

	expect(trace.results[1]?.status).toBe("failed");
	expect(output(trace.results[1])).toContain("not valid UTF-8");
	expect(readFileSync(file)).toEqual(bytes);
});

test("read 按 offset 和 limit 取行，超过单次上限时截断并写明怎样续读", async () => {
	writeFileSync(
		join(workspace, "lines.txt"),
		`${Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
	);
	writeFileSync(join(workspace, "wide.txt"), `${"x".repeat(60_000)}\nshort\n`);
	writeFileSync(join(workspace, "empty.txt"), "");
	const read = (args: object) => ({ name: "read", arguments: args });
	const trace = await run([
		[
			read({ path: "lines.txt", offset: 10, limit: 2 }),
			read({ path: "lines.txt" }),
			read({ path: "lines.txt", offset: 2400 }),
			read({ path: "lines.txt", offset: 2501 }),
			read({ path: "wide.txt" }),
			read({ path: "wide.txt", offset: 2 }),
			read({ path: "empty.txt" }),
		],
	]);

	const texts = trace.results.map(output);
	expect(texts[0]).toBe(
		"line 10\nline 11\n\n[2489 more lines in the file. Use offset=12 to continue.]",
	);
	expect(texts[1]?.startsWith("line 1\nline 2\n")).toBe(true);
	expect(
		texts[1]?.endsWith(
			"line 2000\n\n[Showing lines 1-2000 of 2500 (2000 lines limit). Use offset=2001 to continue.]",
		),
	).toBe(true);
	expect(texts[2]?.startsWith("line 2400\n")).toBe(true);
	expect(texts[2]?.endsWith("line 2500")).toBe(true);
	expect(trace.results[3]?.status).toBe("failed");
	expect(texts[3]).toContain("beyond the end of the file (2500 lines)");
	expect(texts[4]).toContain("Line 1 is 58.6KB, over the 50.0KB limit");
	expect(texts[5]).toBe("short");
	expect(texts[6]).toBe("[The file is empty.]");
});

test("read 对不存在的文件、目录和二进制文件报告失败", async () => {
	mkdirSync(join(workspace, "dir"));
	writeFileSync(join(workspace, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	const trace = await run([
		[
			{ name: "read", arguments: { path: "missing.txt" } },
			{ name: "read", arguments: { path: "dir" } },
			{ name: "read", arguments: { path: "blob.bin" } },
		],
	]);

	expect(trace.results.map((result) => result?.status)).toEqual([
		"failed",
		"failed",
		"failed",
	]);
	expect(trace.results.map(output)).toEqual([
		expect.stringContaining("ENOENT"),
		expect.stringContaining("EISDIR"),
		expect.stringContaining("binary file"),
	]);
});

test("可写范围之外的文件不写，经符号链接指到范围外的也一样", async () => {
	const target = join(outside, "escape.txt");
	writeFileSync(target, "original");
	mkdirSync(join(workspace, "sub"));
	// 工作区里指向范围外的符号链接
	symlinkSync(outside, join(workspace, "sub/link"));
	const trace = await run([
		[
			{
				name: "write",
				arguments: { path: join(outside, "new.txt"), content: "x" },
			},
		],
		[{ name: "write", arguments: { path: "sub/link/new.txt", content: "x" } }],
		[{ name: "read", arguments: { path: target } }],
		[
			{
				name: "edit",
				arguments: {
					path: "sub/link/escape.txt",
					edits: [{ old_text: "original", new_text: "changed" }],
				},
			},
		],
	]);

	expect(trace.results.map((result) => result?.status)).toEqual([
		"failed",
		"failed",
		"succeeded",
		"failed",
	]);
	expect(output(trace.results[0])).toContain("outside the writable roots");
	expect(output(trace.results[3])).toContain(
		`${target} is outside the writable roots`,
	);
	expect(existsSync(join(outside, "new.txt"))).toBe(false);
	expect(readFileSync(target, "utf8")).toBe("original");
	expect(trace.registered.every((params) => params.edit === undefined)).toBe(
		true,
	);
});

test("参数不是 JSON 或不符合 schema 的调用照样登记，结果记为失败", async () => {
	const trace = await run([
		[
			{ name: "write", arguments: "{not json" },
			{ name: "write", arguments: { path: "a.txt" } },
			{ name: "read", arguments: { path: "a.txt", offset: 0 } },
			{ name: "read", arguments: { path: "a.txt", extra: true } },
		],
	]);

	expect(trace.registered).toHaveLength(4);
	expect(trace.results.map((result) => result?.status)).toEqual(
		Array.from({ length: 4 }, () => "failed"),
	);
	expect(trace.results.map(output)).toEqual([
		"The arguments are not valid JSON.",
		expect.stringContaining("Invalid arguments: /"),
		expect.stringContaining("Invalid arguments: /offset"),
		expect.stringContaining("Invalid arguments: /"),
	]);
	expect(existsSync(join(workspace, "a.txt"))).toBe(false);
});

test("Host 拒绝登记的改动不执行，拒绝的结果交回模型", async () => {
	const denied: ToolResult = {
		status: "denied",
		reason: "policy",
		content: [{ type: "text", text: "That path is protected." }],
	};
	const trace = await run(
		[[{ name: "write", arguments: { path: "blocked.txt", content: "x" } }]],
		{
			register: (_params, toolCallId) => ({
				tool_call_id: toolCallId,
				allowed: false,
				result: denied,
			}),
		},
	);

	expect(existsSync(join(workspace, "blocked.txt"))).toBe(false);
	// 被拒绝的调用不再提交结果
	expect(trace.results).toEqual([undefined]);
});

test("同一轮里的读取同时执行，改动按顺序一个一个执行", async () => {
	writeFileSync(join(workspace, "a.txt"), "a");
	writeFileSync(join(workspace, "b.txt"), "b");
	const bothReads = Promise.withResolvers<void>();
	let reads = 0;
	const trace = await run(
		[
			[
				{ name: "read", arguments: { path: "a.txt" } },
				{ name: "read", arguments: { path: "b.txt" } },
				{ name: "write", arguments: { path: "c.txt", content: "c" } },
				{ name: "write", arguments: { path: "d.txt", content: "d" } },
			],
		],
		{
			register: async (params, toolCallId) => {
				// 两次读取都登记了才放行：按顺序执行的话第二次永远不会登记
				if (params.name === "read") {
					reads += 1;
					if (reads === 2) bothReads.resolve();
					await bothReads.promise;
				}
				return { tool_call_id: toolCallId, allowed: true };
			},
		},
	);

	expect(trace.order.slice(0, 2)).toEqual(["register read", "register read"]);
	expect(trace.order.slice(4)).toEqual([
		"register write",
		"complete write",
		"register write",
		"complete write",
	]);
});
