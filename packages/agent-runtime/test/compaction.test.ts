import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ChannelRequestError,
	type ContextCompacted,
	type HooksRunParams,
	type ModelInfo,
	type PendingInput,
	type RecordedEvent,
	type RuntimeEvent,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
	TextBlock,
} from "@ospreycode/api/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rebuildState } from "../src/context/resume.js";
import {
	type FakeHost,
	startFakeHost,
	type Turn,
	text,
	textOf,
} from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-compact-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

/** 上下文 40,000 token 的模型：超过 36,000（90%）就要压缩。 */
const small: ModelInfo = {
	id: "test-model",
	protocol: "anthropic.messages",
	reasoning_effort: "off",
	context_window: 40_000,
	max_output_tokens: 6_000,
};

const done: Turn = { content: [{ type: "text", text: "done" }] };

const summary: Turn = {
	content: [
		{ type: "text", text: "SUMMARY: the user asked for X; Y is done." },
	],
};

function shell(callId: string): Turn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments: JSON.stringify({ command: "cat big.log" }),
			},
		],
	};
}

/** 这次请求是不是摘要请求：最后一条消息是压缩的要求。 */
function isSummaryRequest(request: ModelRequest): boolean {
	const last = request.messages.at(-1);
	return (
		last?.role === "user" && textOf(last).startsWith("<compaction_request>")
	);
}

function compactions(events: readonly RuntimeEvent[]): ContextCompacted[] {
	return events.flatMap((event) =>
		event.type === "context.compacted" ? [event.data] : [],
	);
}

function roles(request: ModelRequest | undefined): string[] {
	return (request?.messages ?? []).map((message) => message.role);
}

async function finished(count: number): Promise<void> {
	await host?.until(() => host?.ends.length === count);
}

describe("估算超过阈值时压缩", () => {
	test("工具结果让上下文超过阈值：先让模型写摘要，再用重新生成的开头和摘要接着做完", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) =>
				index === 0
					? shell("call_1")
					: isSummaryRequest(request)
						? summary
						: done,
			// 按每 token 4 字节算也超过阈值，不用计数
			runTool: () => ({
				status: "succeeded",
				content: text("y".repeat(200_000)),
			}),
		});
		await host.start("read the log");
		await finished(1);

		expect(host.failures).toEqual([]);
		expect(host.ends).toEqual([{ outcome: "completed" }]);
		expect(host.counts).toEqual([]);
		const [first, summarizing, after] = host.requests as [
			ModelRequest,
			ModelRequest,
			ModelRequest,
		];
		expect(host.requests).toHaveLength(3);

		// 摘要请求：之前的历史原样在前面，末尾多一条要求，工具声明和别的参数都不变
		expect(roles(summarizing)).toEqual([
			"system",
			"user",
			"user",
			"assistant",
			"tool_result",
			"user",
		]);
		expect(summarizing.messages.slice(0, first.messages.length)).toEqual(
			first.messages,
		);
		expect(isSummaryRequest(summarizing)).toBe(true);
		expect(summarizing.tools).toEqual(first.tools);
		expect(summarizing.tool_choice).toBe(first.tool_choice);
		expect(summarizing.reasoning_effort).toBe(first.reasoning_effort);

		// 压缩之后：重新生成的系统指令和上下文消息、摘要，旧的轮次都不在了
		expect(roles(after)).toEqual(["system", "user", "user"]);
		const [system, context, summarized] = after.messages as [
			Message,
			Message,
			Message,
		];
		expect(textOf(system)).toBe(textOf(first.messages[0] as Message));
		expect(textOf(context)).toBe(textOf(first.messages[1] as Message));
		expect(system.message_id).not.toBe(first.messages[0]?.message_id);
		expect(textOf(summarized)).toContain("<conversation_summary>");
		expect(textOf(summarized)).toContain(
			"SUMMARY: the user asked for X; Y is done.",
		);
		expect(JSON.stringify(after.messages)).not.toContain("yyyy");

		// 压缩事件带着压缩后的整份上下文；之后照常再记一条 instructions.recorded
		expect(host.events.map((event) => event.type)).toEqual([
			"instructions.recorded",
			"context.compacted",
			"instructions.recorded",
		]);
		const [compaction] = compactions(host.events);
		expect(compaction).toMatchObject({
			trigger: "auto",
			summary: "SUMMARY: the user asked for X; Y is done.",
			messages: after.messages,
		});
		expect(compaction?.tokens_before).toBeGreaterThan(36_000);
		expect(compaction?.loaded_skills).toBeUndefined();
		expect(host.events[2]).toEqual({
			type: "instructions.recorded",
			data: compaction?.instructions,
		});
	});

	test("还没发给过模型的新输入不交给摘要，压缩后原样接在摘要后面；压缩期间到的 steering 等压缩结束再插入", async () => {
		let pending: PendingInput[] = [];
		host = await startFakeHost({
			config: { workspace, model: small },
			model: async (request, index) => {
				// 第一个 task 的回复报告的用量离阈值已经很近
				if (index === 0)
					return { ...done, usage: { input: 34_000, output: 500 } };
				if (isSummaryRequest(request)) {
					pending = [
						{
							input_id: "in-1",
							kind: "steering",
							content: text("and keep it short"),
						},
					];
					await host?.channel.notify("input/available", {});
					return summary;
				}
				return done;
			},
			takeInputs: () => {
				const taken = pending;
				pending = [];
				return taken;
			},
		});
		await host.start("first question");
		await finished(1);
		const question = `second question ${"z".repeat(8_000)}`;
		await host.start(question);
		await finished(2);

		expect(host.failures).toEqual([]);
		expect(host.ends[1]).toEqual({ outcome: "completed" });
		const [, summarizing, after] = host.requests as ModelRequest[];
		expect(host.requests).toHaveLength(3);
		// 摘要请求里没有新的输入
		expect(roles(summarizing)).toEqual([
			"system",
			"user",
			"user",
			"assistant",
			"user",
		]);
		expect(JSON.stringify(summarizing?.messages)).not.toContain(
			"second question",
		);
		// 压缩之后：摘要、原样的新输入、然后才是 steering
		expect(roles(after)).toEqual(["system", "user", "user", "user", "user"]);
		expect(after?.messages[3]?.content).toEqual(text(question));
		expect(after?.messages[4]?.content).toEqual(text("and keep it short"));
		expect(host.events.map((event) => event.type)).toEqual([
			"instructions.recorded",
			"context.compacted",
			"input.inserted",
			"instructions.recorded",
		]);
		// 新输入不写进压缩事件：它随下一次模型请求记成 message.sent
		expect(compactions(host.events)[0]?.messages).toEqual(
			after?.messages.slice(0, 3),
		);
	});

	test("上下文里还没有模型的回复时没有可压缩的内容：明确报错，不发出请求", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: () => done,
		});
		await host.start("x".repeat(300_000));
		await finished(1);

		expect(host.requests).toEqual([]);
		expect(host.ends).toEqual([
			{
				outcome: "failed",
				error: "压缩上下文失败：上下文里还没有模型的回复，没有可压缩的内容",
			},
		]);
	});

	test("压缩之后加上新输入仍然超过阈值：明确报错，不再压缩", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) =>
				index === 0
					? { ...done, usage: { input: 34_000, output: 500 } }
					: isSummaryRequest(request)
						? summary
						: done,
		});
		await host.start("first question");
		await finished(1);
		await host.start("x".repeat(300_000));
		await finished(2);

		// 只多了一次摘要请求
		expect(host.requests).toHaveLength(2);
		expect(compactions(host.events)).toHaveLength(1);
		expect(host.ends[1]?.outcome).toBe("failed");
		expect(host.ends[1]?.error).toContain("压缩之后上下文仍然超过上限");
	});
});

describe("临界时请 Host 计数", () => {
	/** 第一个 task 的回复报告 30,100 token；第二个 task 的输入按 1.7 算 7,059、按 4 算 3,000。 */
	async function borderline(
		options: Pick<Parameters<typeof startFakeHost>[0], "countTokens"> & {
			model?: ModelInfo;
		},
	): Promise<FakeHost> {
		const started = await startFakeHost({
			config: { workspace, model: options.model ?? small },
			model: (request, index) =>
				index === 0
					? { ...done, usage: { input: 30_000, output: 100 } }
					: isSummaryRequest(request)
						? summary
						: done,
			...(options.countTokens === undefined
				? {}
				: { countTokens: options.countTokens }),
		});
		host = started;
		await started.start("first question");
		await finished(1);
		await started.start("z".repeat(12_000));
		await finished(2);
		expect(started.failures).toEqual([]);
		expect(started.ends[1]).toEqual({ outcome: "completed" });
		return started;
	}

	test("数出来没有超过阈值：不压缩，请求的 max_tokens 按数出来的长度算", async () => {
		const started = await borderline({ countTokens: () => 33_000 });

		expect(compactions(started.events)).toEqual([]);
		expect(started.counts).toHaveLength(1);
		expect(started.requests).toHaveLength(2);
		// 计数的请求就是接下来真正发出的那一个，只差 max_tokens
		const { max_tokens, ...sent } = started.requests[1] as ModelRequest;
		expect(started.counts[0]).toEqual(sent);
		// 按除以 1.7 的估算只剩 2,841 个 token；数出来的是 33,000，剩 7,000，取最大输出长度
		expect(max_tokens).toBe(6_000);
	});

	test("数出来超过了阈值：压缩", async () => {
		const started = await borderline({ countTokens: () => 36_500 });

		expect(started.counts).toHaveLength(1);
		expect(compactions(started.events)).toHaveLength(1);
		expect(started.requests.map(isSummaryRequest)).toEqual([
			false,
			true,
			false,
		]);
	});

	test("计数接口报错：按除以 1.7 的估算处理，压缩，不重试计数", async () => {
		const started = await borderline({
			countTokens: () => ({
				category: "permission",
				message: "Invalid URL (POST /v1/messages/count_tokens)",
			}),
		});

		expect(started.counts).toHaveLength(1);
		expect(compactions(started.events)).toHaveLength(1);
	});

	test("openai.chat 没有计数接口：阈值是 85%，临界时直接压缩", async () => {
		// 30,100 加上按 4 算的 3,000 在 34,000（85%）以内，按 1.7 算超过
		const started = await borderline({
			model: { ...small, protocol: "openai.chat" },
		});

		expect(started.counts).toEqual([]);
		expect(compactions(started.events)).toHaveLength(1);
	});

	test("估算没到阈值时不计数", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: () => ({ ...done, usage: { input: 20_000, output: 100 } }),
		});
		await host.start("first question");
		await finished(1);
		await host.start("z".repeat(12_000));
		await finished(2);

		expect(host.counts).toEqual([]);
		expect(compactions(host.events)).toEqual([]);
		expect(host.ends[1]).toEqual({ outcome: "completed" });
	});
});

describe("服务端报上下文超长", () => {
	test("错误类别是 context_overflow：压缩后重发一次", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) => {
				if (index === 0) return shell("call_1");
				if (index === 1) {
					return {
						content: [],
						error: {
							category: "context_overflow",
							message: "prompt is too long",
						},
					};
				}
				return isSummaryRequest(request) ? summary : done;
			},
			runTool: () => ({ status: "succeeded", content: text("ok") }),
		});
		await host.start("run it");
		await finished(1);

		expect(host.failures).toEqual([]);
		expect(host.ends).toEqual([{ outcome: "completed" }]);
		expect(host.requests.map(isSummaryRequest)).toEqual([
			false,
			false,
			true,
			false,
		]);
		expect(roles(host.requests[3])).toEqual(["system", "user", "user"]);
		expect(compactions(host.events)).toMatchObject([{ trigger: "auto" }]);
	});

	test("回复撞上上下文窗口被截断（context_window_exceeded）：这条回复不留在历史里，压缩后重发一次", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) => {
				if (index === 0) return shell("call_1");
				if (index === 1) {
					return {
						content: [{ type: "text", text: "TRUNCATED REPLY" }],
						stop_reason: "context_window_exceeded",
					};
				}
				return isSummaryRequest(request) ? summary : done;
			},
			runTool: () => ({ status: "succeeded", content: text("ok") }),
		});
		await host.start("run it");
		await finished(1);

		expect(host.ends).toEqual([{ outcome: "completed" }]);
		const summarizing = host.requests[2] as ModelRequest;
		expect(isSummaryRequest(summarizing)).toBe(true);
		expect(JSON.stringify(summarizing.messages)).not.toContain(
			"TRUNCATED REPLY",
		);
		expect(roles(host.requests[3])).toEqual(["system", "user", "user"]);
	});

	test("压缩后重发仍然超长：明确报错，只重试一次", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) => {
				if (index === 0) return shell("call_1");
				if (isSummaryRequest(request)) return summary;
				return {
					content: [],
					error: {
						category: "context_overflow",
						message: "prompt is too long",
					},
				};
			},
			runTool: () => ({ status: "succeeded", content: text("ok") }),
		});
		await host.start("run it");
		await finished(1);

		expect(host.requests).toHaveLength(4);
		expect(compactions(host.events)).toHaveLength(1);
		expect(host.ends).toEqual([
			{
				outcome: "failed",
				error: "压缩之后上下文仍然超过模型的上限：prompt is too long",
			},
		]);
	});
});

describe("压缩不了时明确报错，不截断历史", () => {
	/**
	 * 第一个 task 正常结束、用量接近阈值，第二个 task 的输入触发压缩，这次摘要请求得到 `failure`；
	 * 之后的摘要请求照常成功。
	 */
	async function failing(failure: Turn): Promise<FakeHost> {
		const started = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) =>
				index === 0
					? { ...done, usage: { input: 34_000, output: 500 } }
					: index === 1
						? failure
						: isSummaryRequest(request)
							? summary
							: done,
			runTool: () => {
				throw new Error("摘要请求里的工具调用不该执行");
			},
		});
		host = started;
		await started.start("first question");
		await finished(1);
		await started.start(`second question ${"z".repeat(8_000)}`);
		await finished(2);
		expect(started.failures).toEqual([]);
		expect(compactions(started.events)).toEqual([]);
		return started;
	}

	test("摘要请求出错", async () => {
		const started = await failing({
			content: [],
			error: { category: "invalid_request", message: "bad request" },
		});

		expect(started.ends[1]).toEqual({
			outcome: "failed",
			error: "压缩上下文失败：invalid_request: bad request",
		});
		// 历史没有被截断：下一个 task 再压缩时，之前的消息都还在摘要请求里，没能发出的输入接在摘要后面
		await started.start("third question");
		await finished(3);
		expect(started.ends[2]).toEqual({ outcome: "completed" });
		const [before, , summarizing, after] = started.requests as ModelRequest[];
		expect(summarizing?.messages.slice(0, before?.messages.length)).toEqual(
			before?.messages,
		);
		expect(roles(after)).toEqual(["system", "user", "user", "user", "user"]);
		expect(textOf(after?.messages[3] as Message)).toContain("second question");
		expect(textOf(after?.messages[4] as Message)).toBe("third question");
	});

	test("模型没有写摘要而是调用了工具：工具不执行，补上已取消的结果", async () => {
		// 摘要请求带着整段历史，它的回复报告的用量也接近阈值
		const started = await failing({
			...shell("call_9"),
			usage: { input: 34_600, output: 50 },
		});

		expect(started.ends[1]).toEqual({
			outcome: "failed",
			error: "压缩上下文失败：模型没有写摘要，而是调用了工具",
		});
		// 下一次摘要请求里，那次工具调用后面跟着已取消的结果
		await started.start("third question");
		await finished(3);
		const summarizing = started.requests[2] as ModelRequest;
		expect(roles(summarizing).slice(-4)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"user",
		]);
		expect(summarizing.messages.at(-2)).toMatchObject({
			call_id: "call_9",
			is_error: true,
		});
	});

	test("摘要达到了输出长度上限", async () => {
		const started = await failing({
			content: [{ type: "text", text: "SUMMARY: the user as" }],
			stop_reason: "max_tokens",
		});

		expect(started.ends[1]).toEqual({
			outcome: "failed",
			error: "压缩上下文失败：摘要达到了输出长度上限",
		});
	});

	test("回复里没有文字", async () => {
		const started = await failing({ content: [] });

		expect(started.ends[1]).toEqual({
			outcome: "failed",
			error: "压缩上下文失败：模型没有写出摘要",
		});
	});

	test("压缩进行到一半被取消：task 以 cancelled 结束，没有压缩事件，新输入还在历史里", async () => {
		const requested = Promise.withResolvers<void>();
		host = await startFakeHost({
			config: { workspace, model: small },
			model: async (request, index, { signal }) => {
				if (index === 0)
					return { ...done, usage: { input: 34_000, output: 500 } };
				if (index === 1) {
					expect(isSummaryRequest(request)).toBe(true);
					requested.resolve();
					await once(signal, "abort");
					throw new ChannelRequestError("cancelled", "已取消");
				}
				return isSummaryRequest(request) ? summary : done;
			},
		});
		await host.start("first question");
		await finished(1);
		await host.start(`second question ${"z".repeat(8_000)}`);
		await requested.promise;
		await host.channel.request("run/cancel", {});
		await finished(2);

		expect(host.ends[1]).toEqual({ outcome: "cancelled" });
		expect(compactions(host.events)).toEqual([]);

		// 下一个 task 再压缩一次：两条没能发出的输入都接在摘要后面
		await host.start("third question");
		await finished(3);
		expect(host.ends[2]).toEqual({ outcome: "completed" });
		expect(compactions(host.events)).toHaveLength(1);
		const after = host.requests.at(-1) as ModelRequest;
		expect(roles(after)).toEqual(["system", "user", "user", "user", "user"]);
		expect(textOf(after.messages[3] as Message)).toContain("second question");
		expect(textOf(after.messages[4] as Message)).toBe("third question");
	});
});

describe("用户发起的压缩（task/start 带 kind: compact）", () => {
	test("只压缩上下文，然后报告 task 结束；下一个 task 从摘要接着做", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request) => (isSummaryRequest(request) ? summary : done),
		});
		await host.start("first question");
		await finished(1);
		await host.compact();
		await finished(2);

		expect(host.failures).toEqual([]);
		expect(host.ends[1]).toEqual({ outcome: "completed" });
		expect(host.requests.map(isSummaryRequest)).toEqual([false, true]);
		expect(compactions(host.events)).toMatchObject([{ trigger: "manual" }]);
		expect(await host.channel.request("status", {})).toEqual({
			state: "idle",
			tool_call_ids: [],
		});

		await host.start("second question");
		await finished(3);
		const after = host.requests[2] as ModelRequest;
		expect(roles(after)).toEqual(["system", "user", "user", "user"]);
		expect(textOf(after.messages[2] as Message)).toContain("SUMMARY:");
		expect(textOf(after.messages[3] as Message)).toBe("second question");
	});

	test("上下文里还没有模型的回复：以 failed 结束，说明没有可压缩的内容", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: () => done,
		});
		await host.compact();
		await finished(1);

		expect(host.requests).toEqual([]);
		expect(host.ends).toEqual([
			{
				outcome: "failed",
				error: "压缩上下文失败：上下文里还没有模型的回复，没有可压缩的内容",
			},
		]);
	});
});

describe("PreCompact hooks", () => {
	test("配了 hooks 时压缩前先运行，补充的信息作为摘要请求里单独的一块", async () => {
		const ran: HooksRunParams[] = [];
		host = await startFakeHost({
			config: { workspace, model: small, pre_compact_hooks: true },
			model: (request) => (isSummaryRequest(request) ? summary : done),
			hooks: (params) => {
				ran.push(params);
				return { blocked: false, additional_context: "Keep the API names." };
			},
		});
		await host.start("first question");
		await finished(1);
		await host.compact();
		await finished(2);

		const request = host.requests[1]?.messages.at(-1);
		// 请求里带的编号就是摘要请求那条消息的：Host 靠它把这次 hooks 的记录和消息对上
		expect(ran).toEqual([
			{
				event: "PreCompact",
				trigger: "manual",
				message_id: request?.message_id,
			},
		]);
		expect(request?.message_id).toEqual(expect.any(String));
		expect(request?.content).toHaveLength(2);
		expect(request?.content[1]).toMatchObject({
			text: expect.stringContaining("Keep the API names."),
		});
		expect(host.ends[1]).toEqual({ outcome: "completed" });
	});

	test("hook 阻止时不压缩，task 以 failed 结束并带上原因", async () => {
		host = await startFakeHost({
			config: { workspace, model: small, pre_compact_hooks: true },
			model: () => done,
			hooks: () => ({ blocked: true, reason: "not now" }),
		});
		await host.start("first question");
		await finished(1);
		await host.compact();
		await finished(2);

		expect(host.requests).toHaveLength(1);
		expect(compactions(host.events)).toEqual([]);
		expect(host.ends[1]).toEqual({
			outcome: "failed",
			error: "压缩上下文失败：PreCompact hook 阻止了这次压缩：not now",
		});
	});

	test("没有配 hooks 时不请求 Host 运行", async () => {
		host = await startFakeHost({
			config: { workspace, model: small },
			model: (request) => (isSummaryRequest(request) ? summary : done),
		});
		await host.start("first question");
		await finished(1);
		await host.compact();
		await finished(2);

		// 假 Host 没有准备运行 hooks，请求了就会出错
		expect(host.failures).toEqual([]);
		expect(host.ends[1]).toEqual({ outcome: "completed" });
	});
});

describe("已加载的 skill", () => {
	const skills = [
		{
			name: "review",
			description: "Review a change.",
			directory: "/skills/review",
		},
		{ name: "deploy", description: "Deploy.", directory: "/skills/deploy" },
	];

	function load(callId: string, name: string): Turn {
		return {
			content: [
				{
					type: "tool_call",
					call_id: callId,
					name: "skill_load",
					arguments: JSON.stringify({ name }),
				},
			],
		};
	}

	test("压缩后原样放回摘要后面，写进压缩事件；加载失败的不算", async () => {
		host = await startFakeHost({
			config: {
				workspace,
				model: small,
				tools: ["read", "shell", "skill_load"],
				skills,
			},
			model: (request, index) => {
				if (index === 0) return load("call_1", "review");
				if (index === 1) return load("call_2", "missing");
				return isSummaryRequest(request) ? summary : done;
			},
			loadSkill: (name) =>
				name === "review"
					? { loaded: true, content: "REVIEW SKILL BODY" }
					: { loaded: false, reason: "没有这个 skill" },
		});
		await host.start("review my change");
		await finished(1);
		await host.compact();
		await finished(2);
		await host.start("go on");
		await finished(3);

		expect(host.failures).toEqual([]);
		const [compaction] = compactions(host.events);
		expect(compaction?.loaded_skills).toEqual([
			{ name: "review", content: "REVIEW SKILL BODY" },
		]);
		const after = host.requests.at(-1) as ModelRequest;
		expect(roles(after)).toEqual(["system", "user", "user", "user", "user"]);
		const loaded = after.messages[3] as Message;
		expect(loaded.content).toHaveLength(1);
		expect(textOf(loaded)).toContain('<loaded_skill name="review">');
		expect(textOf(loaded)).toContain("REVIEW SKILL BODY");
		expect(compaction?.messages).toEqual(after.messages.slice(0, 4));

		// 再压缩一次，它还在
		await host.compact();
		await finished(4);
		expect(compactions(host.events)[1]?.loaded_skills).toEqual([
			{ name: "review", content: "REVIEW SKILL BODY" },
		]);
	});

	test("压缩时已经不再启用的 skill 不带过去", async () => {
		host = await startFakeHost({
			config: {
				workspace,
				model: small,
				tools: ["read", "shell", "skill_load"],
				skills,
			},
			model: (request, index) =>
				index === 0
					? load("call_1", "review")
					: isSummaryRequest(request)
						? summary
						: done,
			loadSkill: () => ({ loaded: true, content: "REVIEW SKILL BODY" }),
		});
		await host.start("review my change");
		await finished(1);
		await host.channel.notify("config/update", { skills: skills.slice(1) });
		await host.compact();
		await finished(2);

		const [compaction] = compactions(host.events);
		expect(compaction?.loaded_skills).toBeUndefined();
		expect(compaction?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"user",
		]);
	});
});

describe("从压缩事件重建历史", () => {
	let seq = 0;

	function event(type: string, data: unknown): RecordedEvent {
		seq += 1;
		return { type, run_id: "run-1", seq, data };
	}

	function sent(message: Message): RecordedEvent {
		return event("message.sent", { message });
	}

	function reply(
		id: string,
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stop_reason"] = "end_turn",
	): AssistantMessage {
		return {
			role: "assistant",
			message_id: id,
			content,
			protocol: "anthropic.messages",
			service: "test",
			requested_model: "test-model",
			model: "test-model",
			reasoning_effort: "off",
			stop_reason: stopReason,
			usage: {
				input: 1,
				output: 1,
				cache_read: 0,
				cache_write: 0,
				reasoning: 0,
			},
		};
	}

	function user(id: string, value: string): Message {
		return { role: "user", message_id: id, content: text(value) };
	}

	function block(value: string): TextBlock[] {
		return [{ type: "text", text: value }];
	}

	const compaction: ContextCompacted = {
		trigger: "auto",
		tokens_before: 190_000,
		summary: "SUMMARY",
		messages: [
			{ role: "system", message_id: "s2", content: block("system v2") },
			{ role: "user", message_id: "c2", content: block("context v2") },
			{ role: "user", message_id: "sum", content: block("<summary>") },
			{ role: "user", message_id: "sk", content: block("<loaded review>") },
		],
		loaded_skills: [{ name: "review", content: "REVIEW" }],
		instructions: {
			sections: [{ name: "Introduction", text: "v2" }],
			rule_files: [],
		},
	};

	/** 压缩之前的记录：一轮带工具调用的对话，其中一块被作废。 */
	function before(): RecordedEvent[] {
		return [
			event("instructions.recorded", {
				sections: [{ name: "Introduction", text: "v1" }],
				rule_files: [],
			}),
			sent({ role: "system", message_id: "s1", content: block("system v1") }),
			sent(user("u1", "old question")),
			event("message.completed", {
				message: reply("a1", [{ type: "text", text: "old answer" }]),
			}),
			event("blocks.invalidated", {
				blocks: [{ message_id: "a1", index: 0 }],
				reason: "refusal",
			}),
		];
	}

	test("压缩完还没发出下一次模型请求就退出：历史就是事件里的消息", () => {
		const state = rebuildState([
			...before(),
			event("context.compacted", compaction),
		]);

		expect(state?.history).toEqual(compaction.messages);
		expect(state?.instructions).toEqual(compaction.instructions);
		expect(state?.invalidated.size).toBe(0);
		expect(state?.loadedSkills).toEqual(new Map([["review", "REVIEW"]]));
	});

	test("只放回最近一次压缩之后的事件；事件里的消息之后又记成 message.sent 的不重复放回", () => {
		const answer = reply(
			"a2",
			[
				{
					type: "tool_call",
					call_id: "c1",
					name: "skill_load",
					arguments: JSON.stringify({ name: "deploy" }),
				},
			],
			"tool_use",
		);
		const later = {
			sections: [{ name: "Introduction", text: "v3" }],
			rule_files: [],
		};
		const state = rebuildState([
			...before(),
			event("context.compacted", { ...compaction, summary: "OLDER" }),
			sent(user("u-mid", "between two compactions")),
			event("context.compacted", compaction),
			...compaction.messages.map(sent),
			sent(user("u2", "new question")),
			event("instructions.recorded", later),
			event("message.completed", { message: answer }),
			event("tool_call.started", {
				tool_call_id: "tc-1",
				call_id: "c1",
				message_id: "a2",
				name: "skill_load",
				arguments: JSON.stringify({ name: "deploy" }),
				executor: "runtime",
			}),
			event("tool_call.completed", {
				tool_call_id: "tc-1",
				result: { status: "succeeded", content: text("DEPLOY") },
				duration_ms: 1,
			}),
		]);

		expect(state?.history.map((message) => message.message_id)).toEqual([
			"s2",
			"c2",
			"sum",
			"sk",
			"u2",
			"a2",
			expect.any(String),
		]);
		expect(state?.history.at(-1)).toMatchObject({
			role: "tool_result",
			call_id: "c1",
			tool_call_id: "tc-1",
			content: text("DEPLOY"),
		});
		expect(state?.instructions).toEqual(later);
		expect(state?.loadedSkills).toEqual(
			new Map([
				["review", "REVIEW"],
				["deploy", "DEPLOY"],
			]),
		);
	});

	test("撞上上下文窗口被截断的回复不放回", () => {
		const state = rebuildState([
			...before(),
			sent(user("u2", "next")),
			event("message.completed", {
				message: reply(
					"a2",
					[{ type: "text", text: "TRUNCATED" }],
					"context_window_exceeded",
				),
			}),
		]);

		expect(state?.history.map((message) => message.message_id)).toEqual([
			"s1",
			"u1",
			"a1",
			"u2",
		]);
	});

	test("重启后的 runtime 从摘要接着做：请求以压缩后的上下文为前缀，编号和内容都不变", async () => {
		const first = await startFakeHost({
			config: { workspace, model: small },
			model: (request, index) =>
				index === 0
					? shell("call_1")
					: isSummaryRequest(request)
						? summary
						: done,
			runTool: () => ({
				status: "succeeded",
				content: text("y".repeat(200_000)),
			}),
		});
		host = first;
		await first.start("read the log");
		await finished(1);
		const compacted = first.requests[2]?.messages as Message[];
		const [recorded] = compactions(first.events);
		await first.close();

		// Host 记下的事件：压缩之前的那一轮、压缩事件、压缩后的请求里的消息和它的回复
		const answer = reply("reply-3", [{ type: "text", text: "done" }]);
		const events = [
			...before(),
			event("context.compacted", recorded),
			...compacted.map(sent),
			event("instructions.recorded", recorded?.instructions),
			event("message.completed", { message: answer }),
		];
		const second = await startFakeHost({
			config: {
				workspace,
				model: small,
				resume: { run_id: "run-1", seq: 99 },
			},
			model: () => done,
		});
		host = second;
		const types: string[][] = [];
		second.channel.handle("record/read", async (params) => {
			types.push(params.types);
			return { events: events.filter((e) => params.types.includes(e.type)) };
		});
		await second.start("next task");
		await finished(1);

		expect(second.failures).toEqual([]);
		expect(types[0]).toContain("context.compacted");
		expect(second.ends).toEqual([{ outcome: "completed" }]);
		const after = second.requests[0]?.messages as Message[];
		expect(after.slice(0, compacted.length + 1)).toEqual([
			...compacted,
			answer,
		]);
		expect(after).toHaveLength(compacted.length + 2);
		expect(textOf(after.at(-1) as Message)).toBe("next task");
		// 系统指令和规则文件没有变：不再上报，也不追加补丁
		expect(second.events).toEqual([]);
	});
});
