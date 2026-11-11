import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type Session,
	SessionCommandError,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import {
	type CountScript,
	type Script,
	type ScriptedTurn,
	scriptedCounter,
	scriptedModel,
} from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

/** 测试用模型的上下文是 200,000 token，压缩的阈值是它的 90%。 */
const limit = 180_000;

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 脚本模型收到的每次请求。 */
let requests: ModelRequest[];
/** 计数接口收到的每次请求。 */
let counts: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	requests = [];
	counts = [];
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	expect(log.invalid).toEqual([]);
});

async function open(
	script: Script,
	count: CountScript = () => {
		throw new Error("这个测试里不该用到计数接口");
	},
	options: Partial<SessionOptions> = {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(request);
			return script(request, call);
		}),
		countTokens: scriptedCounter((request, call) => {
			counts.push(request);
			return count(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: log.push,
	});
	return session;
}

/** 一条文字回复。`context` 是它报告的输入 token：之后的估算以这条回复的用量为锚点。 */
function reply(text: string, context = 1_000): ScriptedTurn {
	return {
		content: [{ type: "text", text }],
		usage: { input: context, output: 10 },
	};
}

function textOf(message: Message | undefined): string {
	if (message === undefined) throw new Error("没有这条消息");
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

function roles(request: ModelRequest | undefined): string[] {
	if (request === undefined) throw new Error("没有这次请求");
	return request.messages.map((message) => message.role);
}

/** 这次请求是不是摘要请求：最后一条消息是压缩的要求。 */
function isSummaryRequest(request: ModelRequest): boolean {
	const last = request.messages.at(-1);
	return (
		last?.role === "user" && textOf(last).startsWith("<compaction_request>")
	);
}

/** 第一个 task 的回复报告的用量是 `context`，之后摘要请求得到摘要，别的请求得到普通的回答。 */
function scripted(context: number): Script {
	return (request, call) => {
		if (call === 0) return reply("第一次回答", context);
		return isSummaryRequest(request)
			? reply("这是摘要")
			: reply(`第 ${call} 次回答`);
	};
}

async function ended(taskId: string) {
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

function compactions() {
	return log.events.filter((event) => event.type === "context.compacted");
}

/** 启动过的 agent 进程，按启动的顺序。 */
function agentPids(): number[] {
	return log.events.flatMap((event) =>
		event.type === "process.started" && event.kind === "agent"
			? [event.pid]
			: [],
	);
}

/** 接在一条用量为 170,000 的回复后面：按每 token 1.7 字节算超过阈值，按 4 字节算没超过。 */
const borderlineInput = "x".repeat(20_000);

describe("自动压缩", () => {
	test("估算超过阈值：先让模型写摘要，再从摘要接着做，task 照常完成", async () => {
		const current = await open(scripted(185_000));
		await ended(await current.submit("第一个任务"));
		const second = await current.submit("第二个任务");
		expect(await ended(second)).toMatchObject({ outcome: "completed" });

		expect(requests.map(isSummaryRequest)).toEqual([false, true, false]);
		// 锚点自己就超过了阈值，怎么估都超过，不用计数
		expect(counts).toEqual([]);
		const [first, summarizing, after] = requests as [
			ModelRequest,
			ModelRequest,
			ModelRequest,
		];
		// 摘要请求带着原来的历史，新的输入不交给摘要
		expect(summarizing.messages.slice(0, first.messages.length)).toEqual(
			first.messages,
		);
		expect(JSON.stringify(summarizing.messages)).not.toContain("第二个任务");
		expect(summarizing.tools).toEqual(first.tools);
		// 压缩后的请求：重新生成的系统指令和上下文消息、摘要、新的输入
		expect(roles(after)).toEqual(["system", "user", "user", "user"]);
		expect(textOf(after.messages[2])).toContain("这是摘要");
		expect(textOf(after.messages[3])).toContain("第二个任务");
		expect(JSON.stringify(after.messages)).not.toContain("第一个任务");

		expect(compactions()).toMatchObject([
			{ task_id: second, trigger: "auto", summary: "这是摘要" },
		]);
		expect(compactions()[0]?.tokens_before).toBeGreaterThan(limit);
		// 压缩的事件排在摘要的回复之后、压缩后那次请求的回复之前
		const completed = log.events.filter(
			(event) => event.type === "message.completed" && event.task_id === second,
		);
		expect(completed).toHaveLength(2);
		const at = log.events.indexOf(compactions()[0] as (typeof log.events)[0]);
		expect(at).toBeGreaterThan(
			log.events.indexOf(completed[0] as (typeof log.events)[0]),
		);
		expect(at).toBeLessThan(
			log.events.indexOf(completed[1] as (typeof log.events)[0]),
		);
	});

	test("临界时请模型服务数一次：没超过就不压缩，数的请求和接下来发出的相同", async () => {
		const current = await open(scripted(170_000), () => 175_000);
		await ended(await current.submit("第一个任务"));
		expect(counts).toEqual([]);
		expect(await ended(await current.submit(borderlineInput))).toMatchObject({
			outcome: "completed",
		});

		expect(counts).toHaveLength(1);
		expect(requests.map(isSummaryRequest)).toEqual([false, false]);
		const { max_tokens: _, ...sent } = requests[1] as ModelRequest;
		expect(counts[0]).toEqual(sent);
		expect(compactions()).toEqual([]);
	});

	test("数出来超过阈值就压缩", async () => {
		const current = await open(scripted(170_000), () => limit + 1);
		await ended(await current.submit("第一个任务"));
		expect(await ended(await current.submit(borderlineInput))).toMatchObject({
			outcome: "completed",
		});

		expect(counts).toHaveLength(1);
		expect(requests.map(isSummaryRequest)).toEqual([false, true, false]);
		expect(compactions()).toMatchObject([{ trigger: "auto" }]);
	});

	test("计数接口出错时按偏保守的估算处理：压缩，不重试计数", async () => {
		const current = await open(scripted(170_000), () => ({
			category: "permission",
			message: "Invalid URL (POST /v1/messages/count_tokens)",
		}));
		await ended(await current.submit("第一个任务"));
		expect(await ended(await current.submit(borderlineInput))).toMatchObject({
			outcome: "completed",
		});

		expect(counts).toHaveLength(1);
		expect(requests.map(isSummaryRequest)).toEqual([false, true, false]);
		expect(compactions()).toHaveLength(1);
	});

	test("计数计入这个 run 的请求次数上限", async () => {
		const current = await open(scripted(170_000), () => 175_000, {
			budget: { maxRequests: 1 },
		});
		await ended(await current.submit("第一个任务"));
		// 这个 run 只能发一次请求，计数用掉了它
		expect(await ended(await current.submit(borderlineInput))).toMatchObject({
			outcome: "budget_exceeded",
			limit: "requests",
		});
		expect(counts).toHaveLength(1);
		expect(requests).toHaveLength(1);
	});

	test("模型服务报上下文超长：压缩后重发一次", async () => {
		const current = await open((request, call) => {
			if (call === 1) {
				return {
					content: [],
					error: {
						category: "context_overflow",
						message: "prompt is too long",
					},
				};
			}
			return isSummaryRequest(request)
				? reply("这是摘要")
				: reply(`第 ${call} 次回答`);
		});
		await ended(await current.submit("第一个任务"));
		const second = await current.submit("第二个任务");
		expect(await ended(second)).toMatchObject({ outcome: "completed" });

		expect(requests.map(isSummaryRequest)).toEqual([false, false, true, false]);
		expect(compactions()).toMatchObject([{ task_id: second, trigger: "auto" }]);
		// 被拒绝的那次请求里的输入已经在摘要请求的历史里，重发的请求从摘要开始
		expect(JSON.stringify(requests[2]?.messages)).toContain("第二个任务");
		expect(roles(requests[3])).toEqual(["system", "user", "user"]);
		expect(textOf(requests[3]?.messages[2])).toContain("这是摘要");
	});

	test("摘要请求出错：task 以 failed 结束并说明原因，历史不截断", async () => {
		const current = await open((request, call) => {
			if (call === 0) return reply("第一次回答", 185_000);
			if (call === 1) {
				return {
					content: [],
					error: {
						category: "invalid_request",
						message: "bad summary request",
					},
				};
			}
			return isSummaryRequest(request)
				? reply("这是摘要")
				: reply(`第 ${call} 次回答`);
		});
		await ended(await current.submit("第一个任务"));
		const failed = await ended(await current.submit("第二个任务"));
		expect(failed).toMatchObject({ outcome: "failed" });
		expect(failed.error).toContain("压缩上下文失败");
		expect(failed.error).toContain("bad summary request");
		expect(compactions()).toEqual([]);

		// 下一个 task 再压缩一次：原来的历史还在摘要请求里；上一个 task 的输入还没发给过模型，
		// 和新的输入一起原样接在摘要后面
		expect(await ended(await current.submit("第三个任务"))).toMatchObject({
			outcome: "completed",
		});
		expect(requests.map(isSummaryRequest)).toEqual([false, true, true, false]);
		expect(JSON.stringify(requests[2]?.messages)).toContain("第一个任务");
		const after = requests[3] as ModelRequest;
		expect(roles(after)).toEqual(["system", "user", "user", "user", "user"]);
		expect(textOf(after.messages[2])).toContain("这是摘要");
		expect(textOf(after.messages[3])).toContain("第二个任务");
		expect(textOf(after.messages[4])).toContain("第三个任务");
		expect(compactions()).toHaveLength(1);
	});
});

describe("Session.compact()", () => {
	test("空闲时开始一个压缩 task：压缩完发出 context.compacted，下一个 task 从摘要接着做", async () => {
		const current = await open(scripted(1_000));
		await ended(await current.submit("第一个任务"));
		const compacting = await current.compact();
		expect(await ended(compacting)).toMatchObject({ outcome: "completed" });

		expect(
			await log.waitFor("task.started", (e) => e.task_id === compacting),
		).toMatchObject({ source: "user", kind: "compact", input: [] });
		expect(requests.map(isSummaryRequest)).toEqual([false, true]);
		expect(compactions()).toMatchObject([
			{ task_id: compacting, trigger: "manual", summary: "这是摘要" },
		]);
		// 压缩 task 有自己的 run
		const runs = log.events.filter((event) => event.type === "run.started");
		expect(runs.map((run) => run.task_id)).toContain(compacting);

		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
		const after = requests[2] as ModelRequest;
		expect(roles(after)).toEqual(["system", "user", "user", "user"]);
		expect(textOf(after.messages[2])).toContain("这是摘要");
		expect(textOf(after.messages[3])).toContain("第二个任务");
		expect(JSON.stringify(after.messages)).not.toContain("第一个任务");
	});

	test("task 运行时抛出 SessionCommandError，进行中的 task 不受影响", async () => {
		const current = await open(() => ({
			content: [{ type: "text", text: "写到一半" }],
			hang: true,
		}));
		const running = await current.submit("第一个任务");
		await log.waitFor("model.delta", (event) => event.task_id === running);
		await expect(current.compact()).rejects.toThrow(SessionCommandError);
		expect(
			log.events.filter((event) => event.type === "task.started"),
		).toHaveLength(1);
		await current.cancel();
		expect(await ended(running)).toMatchObject({ outcome: "cancelled" });
	});

	test("上下文里还没有模型的回复：task 以 failed 结束，不发出请求", async () => {
		const current = await open(scripted(1_000));
		const failed = await ended(await current.compact());
		expect(failed).toMatchObject({ outcome: "failed" });
		expect(failed.error).toContain("没有可压缩的内容");
		expect(requests).toEqual([]);
		expect(compactions()).toEqual([]);
	});
});

describe("PreCompact hooks", () => {
	/** 配一个用户级的 `PreCompact` hook：`output` 是它写到 stdout 的 JSON。 */
	function preCompactHook(output: object): void {
		const directory = join(dirs.root, "hooks");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(directory, "pre-compact.sh"),
			`#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(output)}'\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(dirs.root, "hooks.json"),
			JSON.stringify({
				hooks: {
					PreCompact: [
						{
							matcher: "manual",
							hooks: [
								{
									command: "./pre-compact.sh",
									onFailure: "block",
									permissions: "read-only",
								},
							],
						},
					],
				},
			}),
		);
	}

	test("hook 补充的信息作为单独的一块交给写摘要的模型", async () => {
		preCompactHook({ additional_context: "发布日期是周五" });
		const current = await open(scripted(1_000));
		await ended(await current.submit("第一个任务"));
		expect(await ended(await current.compact())).toMatchObject({
			outcome: "completed",
		});

		const asked = requests[1]?.messages.at(-1);
		expect(asked?.content).toHaveLength(2);
		expect(textOf(asked)).toMatch(/^<compaction_request>/);
		expect(textOf(asked)).toContain('<hook_context event="PreCompact">');
		expect(textOf(asked)).toContain("发布日期是周五");
		expect(compactions()).toHaveLength(1);
	});

	test("hook 阻止压缩：task 以 failed 结束并带上 hook 给的原因，不发摘要请求，历史不变", async () => {
		preCompactHook({ decision: "block", reason: "先把笔记存好" });
		const current = await open(scripted(1_000));
		await ended(await current.submit("第一个任务"));
		const failed = await ended(await current.compact());

		expect(failed).toMatchObject({ outcome: "failed" });
		expect(failed.error).toContain(
			"PreCompact hook 阻止了这次压缩：先把笔记存好",
		);
		expect(requests).toHaveLength(1);
		expect(compactions()).toEqual([]);
		await ended(await current.submit("第二个任务"));
		expect(requests.map(isSummaryRequest)).toEqual([false, false]);
		expect(JSON.stringify(requests[1]?.messages)).toContain("第一个任务");
	});

	test("matcher 只写了 manual：自动压缩不运行它", async () => {
		preCompactHook({ decision: "block", reason: "先把笔记存好" });
		const current = await open(scripted(185_000));
		await ended(await current.submit("第一个任务"));
		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
		expect(compactions()).toMatchObject([{ trigger: "auto" }]);
	});
});

describe("压缩之后重启 agent 进程", () => {
	test("重建出的历史从摘要开始，之后的请求以压缩后的请求为前缀", async () => {
		const current = await open(scripted(185_000));
		await ended(await current.submit("第一个任务"));
		await ended(await current.submit("第二个任务"));
		expect(requests.map(isSummaryRequest)).toEqual([false, true, false]);
		const after = requests[2] as ModelRequest;

		await current.reload();
		expect(agentPids()).toHaveLength(2);
		expect(await ended(await current.submit("第三个任务"))).toMatchObject({
			outcome: "completed",
		});
		const resumed = requests[3] as ModelRequest;
		expect(resumed.messages.slice(0, after.messages.length)).toEqual(
			after.messages,
		);
		expect(resumed.messages.slice(after.messages.length)).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "第 2 次回答" }] },
			{ role: "user", content: [{ type: "text", text: "第三个任务" }] },
		]);
		expect(compactions()).toHaveLength(1);
	});

	test("压缩完还没发出下一次模型请求进程就退出：新进程从压缩事件重建", async () => {
		const current = await open(scripted(1_000));
		await ended(await current.submit("第一个任务"));
		await ended(await current.compact());
		const pid = agentPids().at(-1);
		if (pid === undefined) throw new Error("还没有 agent 进程");
		process.kill(pid, "SIGKILL");
		await log.waitFor("process.exited", (event) => event.pid === pid);

		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
		expect(agentPids()).toHaveLength(2);
		const resumed = requests[2] as ModelRequest;
		expect(roles(resumed)).toEqual(["system", "user", "user", "user"]);
		expect(textOf(resumed.messages[2])).toContain("这是摘要");
		expect(textOf(resumed.messages[3])).toContain("第二个任务");
		expect(JSON.stringify(resumed.messages)).not.toContain("第一个任务");
		// 压缩前的系统指令不再发出：重建出的是压缩时重新生成的那一条
		expect(resumed.messages[0]?.message_id).not.toBe(
			requests[0]?.messages[0]?.message_id,
		);
	});

	test.runIf(process.platform === "darwin")(
		"验收（macOS 真实沙盒）：压缩过的 session 切换沙盒模式，新进程的第一次请求原样带着压缩后发过的全部消息（重新生成的系统指令和摘要）和最后一条回复，只多出新的输入和沙盒模式的补丁；工具声明和请求参数不变",
		async () => {
			const current = await open(scripted(185_000), undefined, {
				sandboxMode: "workspace-write",
				approvalPolicy: "on-request",
			});
			await ended(await current.submit("第一个任务"));
			await ended(await current.submit("第二个任务"));
			expect(requests.map(isSummaryRequest)).toEqual([false, true, false]);

			for (const [mode, input] of [
				["read-only", "第三个任务"],
				["workspace-write", "第四个任务"],
			] as const) {
				const before = requests.at(-1) as ModelRequest;
				const lastReply = log.events.findLast(
					(event) => event.type === "message.completed",
				);
				await current.setSandboxMode(mode);
				expect(await ended(await current.submit(input))).toMatchObject({
					outcome: "completed",
				});

				const after = requests.at(-1) as ModelRequest;
				const sent = before.messages.length;
				// 消息的标识也一样：是从 session 记录重建的同一批消息，不是重新生成的
				expect(after.messages.slice(0, sent)).toEqual(before.messages);
				expect(after.messages[sent]).toEqual(lastReply?.message);
				expect(after.messages.slice(sent + 1)).toMatchObject([
					{ role: "user", content: [{ type: "text", text: input }] },
					{
						role: "system",
						content: [
							{
								type: "text",
								text: expect.stringContaining(`Sandbox mode: ${mode}`),
							},
						],
					},
				]);
				expect({ ...after, messages: [] }).toEqual({ ...before, messages: [] });
			}
			const last = JSON.stringify(requests.at(-1)?.messages);
			expect(last).toContain("这是摘要");
			expect(last).not.toContain("第一个任务");
			expect(agentPids()).toHaveLength(3);
			expect(compactions()).toHaveLength(1);
		},
	);
});
