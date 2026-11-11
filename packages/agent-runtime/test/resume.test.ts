import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RecordedEvent,
	RecordedInstructions,
	RecordReadParams,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@ospreycode/api/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rebuildState } from "../src/context/resume.js";
import { type FakeHost, startFakeHost, text, textOf } from "./fake-host.js";

const instructions: RecordedInstructions = {
	sections: [{ name: "intro", text: "You are a coding agent." }],
	rule_files: [],
};

let seq = 0;

function event(type: string, data: unknown): RecordedEvent {
	seq += 1;
	return { type, run_id: "run-1", seq, data };
}

function sent(message: Message): RecordedEvent {
	return event("message.sent", { message });
}

function user(id: string, value: string): Message {
	return { role: "user", message_id: id, content: text(value) };
}

function assistant(
	id: string,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stop_reason"],
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
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 },
	};
}

function completed(message: AssistantMessage): RecordedEvent {
	return event("message.completed", { message });
}

function call(id: string) {
	return {
		type: "tool_call" as const,
		call_id: id,
		name: "shell",
		arguments: "{}",
	};
}

describe("按 session 记录重建 loop 的状态", () => {
	test("路径上没有发给过模型的消息时按新会话开始", () => {
		expect(rebuildState([])).toBeUndefined();
		expect(
			rebuildState([event("instructions.recorded", instructions)]),
		).toBeUndefined();
	});

	test("发给过模型的消息和模型的回复按原来的编号和顺序放回，系统指令取最后一次记录", () => {
		const latest: RecordedInstructions = {
			sections: [{ name: "intro", text: "changed" }],
			rule_files: [],
		};
		const reply = assistant("a1", [{ type: "text", text: "好" }], "end_turn");
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent({
				role: "system",
				message_id: "s1",
				content: [{ type: "text", text: "system" }],
			}),
			sent(user("u1", "你好")),
			completed(reply),
			event("instructions.recorded", latest),
			sent(user("u2", "继续")),
		]);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"s1",
			"u1",
			"a1",
			"u2",
		]);
		expect(state?.history[2]).toEqual(reply);
		expect(state?.instructions).toEqual(latest);
		expect(state?.invalidated.size).toBe(0);
	});

	test("被取消的回复和出错时什么都没收到的回复不放回；流中途出错的回复放回并整条作废", () => {
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent(user("u1", "你好")),
			completed(
				assistant("a1", [{ type: "text", text: "写到一半" }], "cancelled"),
			),
			completed(assistant("a2", [], "error")),
			completed(
				assistant(
					"a3",
					[
						{ type: "text", text: "一" },
						{ type: "text", text: "二" },
					],
					"error",
				),
			),
			event("blocks.invalidated", {
				blocks: [{ message_id: "a0", index: 3 }],
				reason: "reasoning_prefix_mismatch",
			}),
		]);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"u1",
			"a3",
		]);
		expect(state?.invalidated).toEqual(
			new Map([
				["a3", new Set([0, 1])],
				["a0", new Set([3])],
			]),
		);
	});

	test("最后一条回复的工具调用没有把结果发给模型：登记过的取 Host 记下的结果，没登记的记成取消，作废的不补", () => {
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent(user("u1", "跑三条命令")),
			completed(
				assistant("a1", [call("c1"), call("c2"), call("c3")], "tool_use"),
			),
			event("blocks.invalidated", {
				blocks: [{ message_id: "a1", index: 2 }],
				reason: "stream_error",
			}),
			event("tool_call.started", {
				tool_call_id: "tc-1",
				call_id: "c1",
				message_id: "a1",
				name: "shell",
				arguments: "{}",
				executor: "host",
			}),
			event("tool_call.completed", {
				tool_call_id: "tc-1",
				result: { status: "failed", content: text("exit code 1") },
				duration_ms: 5,
			}),
		]);
		const results = state?.history.slice(2) as ToolResultMessage[];
		expect(results).toMatchObject([
			{
				role: "tool_result",
				call_id: "c1",
				tool_call_id: "tc-1",
				content: text("exit code 1"),
				is_error: true,
			},
			{
				role: "tool_result",
				call_id: "c2",
				content: text("The tool call was cancelled."),
				is_error: true,
			},
		]);
		expect(results[1]?.tool_call_id).toBeUndefined();
	});

	test("结果已经发给模型的工具调用不再补", () => {
		const result: Message = {
			role: "tool_result",
			message_id: "t1",
			call_id: "c1",
			tool_call_id: "tc-1",
			content: text("ok"),
			is_error: false,
		};
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent(user("u1", "跑命令")),
			completed(assistant("a1", [call("c1")], "tool_use")),
			sent(result),
		]);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"u1",
			"a1",
			"t1",
		]);
	});

	test("记录有缺陷时报错：有消息却没有系统指令的记录", () => {
		expect(() => rebuildState([sent(user("u1", "你好"))])).toThrow(
			/instructions\.recorded/,
		);
	});

	test("最后一条回复里有登记过、没有结果的调用（Host 被中断）：这一轮的结果先不放进历史，已有的结果留着，同一次调用登记过几次时看最后一次", () => {
		const started = (toolCallId: string, callId: string) =>
			event("tool_call.started", {
				tool_call_id: toolCallId,
				call_id: callId,
				message_id: "a1",
				name: "shell",
				arguments: "{}",
				executor: "host",
			});
		const finished = (toolCallId: string, output: string) =>
			event("tool_call.completed", {
				tool_call_id: toolCallId,
				result: { status: "succeeded", content: text(output) },
				duration_ms: 5,
			});
		const reply = assistant(
			"a1",
			[call("c1"), call("c2"), call("c3")],
			"tool_use",
		);
		const interrupted = [
			event("instructions.recorded", instructions),
			sent(user("u1", "跑三条命令")),
			completed(reply),
			started("tc-1", "c1"),
			finished("tc-1", "第一条的输出"),
			started("tc-2", "c2"),
		];
		const state = rebuildState(interrupted);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"u1",
			"a1",
		]);
		expect(state?.pending?.message).toEqual(reply);
		expect([...(state?.pending?.results ?? [])]).toMatchObject([
			["c1", { call_id: "c1", tool_call_id: "tc-1", is_error: false }],
		]);

		// 上次恢复后重新执行过 c2，这一次有了结果；c3 一直没有登记，按取消补上
		const rerun = rebuildState([
			...interrupted,
			started("tc-3", "c2"),
			finished("tc-3", "第二条的输出"),
		]);
		expect(rerun?.pending).toBeUndefined();
		expect(rerun?.history.slice(2)).toMatchObject([
			{ call_id: "c1", tool_call_id: "tc-1" },
			{ call_id: "c2", tool_call_id: "tc-3", content: text("第二条的输出") },
			{ call_id: "c3", content: text("The tool call was cancelled.") },
		]);
	});
});

describe("路径上有被 Host 按事件脱敏覆盖的事件", () => {
	const placeholder = text("[REDACTED]");

	function reasoning(value: string): AssistantMessage["content"][number] {
		return {
			type: "reasoning",
			text: value,
			redacted: false,
			origin: {
				protocol: "anthropic.messages",
				service: "test",
				model: "test-model",
			},
		};
	}

	const answer = { type: "text" as const, text: "回答" };

	/** 一次压缩在记录里留下的事件：要摘要的消息、摘要的回复、压缩事件、压缩后重新记下的指令和消息的副本。 */
	function compaction(
		id: string,
		summary: string,
		recorded: RecordedInstructions,
		redacted: boolean,
	): RecordedEvent[] {
		const mark = redacted ? { redacted: true } : {};
		const messages = [
			{
				role: "system" as const,
				message_id: `${id}-system`,
				content: redacted ? placeholder : text("regenerated system"),
			},
			{
				role: "user" as const,
				message_id: `${id}-summary`,
				content: redacted ? placeholder : text(summary),
			},
		];
		return [
			sent(user(`${id}-request`, "<compaction_request>")),
			event("message.completed", {
				...mark,
				message: assistant(
					`${id}-reply`,
					[{ type: "text", text: redacted ? "[REDACTED]" : summary }],
					"end_turn",
				),
			}),
			event("context.compacted", {
				...mark,
				trigger: "auto",
				tokens_before: 1000,
				summary: redacted ? "[REDACTED]" : summary,
				messages,
				instructions: recorded,
			}),
			event("instructions.recorded", recorded),
			...messages.map((message) => event("message.sent", { ...mark, message })),
		];
	}

	test("从被覆盖的事件起，回复里的推理块都作废；它之前的不动", () => {
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent(user("u1", "第一个问题")),
			completed(assistant("a1", [reasoning("想一"), answer], "end_turn")),
			event("message.sent", {
				redacted: true,
				message: {
					role: "user",
					message_id: "u2",
					content: placeholder,
				},
			}),
			// 被覆盖的回复：推理块还占着原来的位置，内容是占位
			event("message.completed", {
				redacted: true,
				message: assistant(
					"a2",
					[reasoning("[REDACTED]"), { type: "text", text: "[REDACTED]" }],
					"end_turn",
				),
			}),
			sent(user("u3", "第三个问题")),
			completed(
				assistant("a3", [answer, reasoning("想三"), answer], "end_turn"),
			),
		]);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"u1",
			"a1",
			"u2",
			"a2",
			"u3",
			"a3",
		]);
		expect(state?.history[2]?.content).toEqual(placeholder);
		expect(state?.invalidated).toEqual(
			new Map([
				["a2", new Set([0])],
				["a3", new Set([1])],
			]),
		);
	});

	test("被覆盖的压缩作废：历史接着用压缩之前的，摘要的请求和回复去掉，压缩后消息的副本照样跳过，不取它的系统指令", () => {
		const regenerated: RecordedInstructions = {
			sections: [{ name: "intro", text: "regenerated" }],
			rule_files: [],
		};
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent({
				role: "system",
				message_id: "s1",
				content: [{ type: "text", text: "system" }],
			}),
			sent(user("u1", "第一个问题")),
			completed(assistant("a1", [call("c1")], "tool_use")),
			event("message.sent", {
				redacted: true,
				message: {
					role: "tool_result",
					message_id: "t1",
					call_id: "c1",
					tool_call_id: "tc-1",
					content: placeholder,
					is_error: false,
				},
			}),
			completed(assistant("a2", [answer], "end_turn")),
			...compaction("k1", "摘要里有要忘掉的内容", regenerated, true),
			sent(user("u2", "第二个问题")),
			completed(assistant("a3", [reasoning("想"), answer], "end_turn")),
		]);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"s1",
			"u1",
			"a1",
			"t1",
			"a2",
			"u2",
			"a3",
		]);
		expect(state?.instructions).toEqual(instructions);
		expect(state?.invalidated).toEqual(new Map([["a3", new Set([0])]]));
		expect(state?.loadedSkills.size).toBe(0);
		// 压缩之后的回复报告的用量对不上重建出的历史，去掉；之前的留着
		const replies = (state?.history ?? []).filter(
			(message) => message.role === "assistant",
		);
		expect(replies.map((message) => message.usage.input)).toEqual([1, 1, 0]);
		expect(replies.at(-1)?.usage).toEqual({
			input: 0,
			output: 0,
			cache_read: 0,
			cache_write: 0,
			reasoning: 0,
		});
	});

	test("被覆盖的事件之前的压缩照常生效，之后的才作废", () => {
		const first: RecordedInstructions = {
			sections: [{ name: "intro", text: "after first compaction" }],
			rule_files: [],
		};
		const second: RecordedInstructions = {
			sections: [{ name: "intro", text: "after second compaction" }],
			rule_files: [],
		};
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent(user("u1", "第一个问题")),
			completed(assistant("a1", [answer], "end_turn")),
			...compaction("k1", "第一次的摘要", first, false),
			event("message.sent", {
				redacted: true,
				message: { role: "user", message_id: "u2", content: placeholder },
			}),
			completed(assistant("a2", [answer], "end_turn")),
			...compaction("k2", "第二次的摘要", second, true),
			sent(user("u3", "第三个问题")),
		]);
		expect(state?.history.map((message) => message.message_id)).toEqual([
			"k1-system",
			"k1-summary",
			"u2",
			"a2",
			"u3",
		]);
		expect(state?.instructions).toEqual(first);
	});

	test("被覆盖的 skill_load 调用读不出加载了什么，不算已加载的 skill", () => {
		const load = (callId: string, name: string, redacted: boolean) => [
			event("tool_call.started", {
				...(redacted ? { redacted: true } : {}),
				tool_call_id: `tc-${callId}`,
				call_id: callId,
				message_id: "a1",
				name: "skill_load",
				arguments: redacted ? "{}" : JSON.stringify({ name }),
				executor: "host",
			}),
			event("tool_call.completed", {
				...(redacted ? { redacted: true } : {}),
				tool_call_id: `tc-${callId}`,
				result: {
					status: "succeeded",
					content: redacted ? placeholder : text(`${name} 的内容`),
				},
				duration_ms: 1,
			}),
		];
		const state = rebuildState([
			event("instructions.recorded", instructions),
			sent(user("u1", "加载两个 skill")),
			completed(
				assistant(
					"a1",
					[
						{ ...call("c1"), name: "skill_load" },
						{ ...call("c2"), name: "skill_load" },
					],
					"tool_use",
				),
			),
			...load("c1", "deploy", true),
			...load("c2", "review", false),
		]);
		expect([...(state?.loadedSkills ?? [])]).toEqual([
			["review", "review 的内容"],
		]);
	});
});

describe("重启后的 runtime", () => {
	let workspace: string;
	let host: FakeHost | undefined;

	beforeEach(() => {
		workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-resume-")));
	});

	afterEach(async () => {
		await host?.close();
		host = undefined;
		rmSync(workspace, { recursive: true, force: true });
	});

	test("握手拿到 resume 后分页读出 session 记录，下一次模型请求以原来的历史为前缀", async () => {
		const first = await startFakeHost({
			config: { workspace },
			model: () => ({ content: [{ type: "text", text: "第一轮的回答" }] }),
		});
		host = first;
		await first.start("第一个任务");
		await first.until(() => first.ends.length === 1);
		const before = first.requests[0]?.messages as Message[];
		const recorded = first.events.find(
			(e) => e.type === "instructions.recorded",
		);
		await first.close();

		// Host 记下的事件：请求里的消息、模型的回复和 runtime 上报的系统指令
		const reply = assistant(
			"reply-1",
			[{ type: "text", text: "第一轮的回答" }],
			"end_turn",
		);
		const events = [
			event("instructions.recorded", recorded?.data),
			...before.map(sent),
			completed(reply),
		];
		const reads: RecordReadParams[] = [];
		const second = await startFakeHost({
			config: { workspace, resume: { run_id: "run-1", seq: 99 } },
			model: () => ({ content: [{ type: "text", text: "第二轮的回答" }] }),
		});
		host = second;
		second.channel.handle("record/read", async (params) => {
			reads.push(params);
			// 一页两个事件
			const page = events
				.filter((e) => params.types.includes(e.type))
				.slice(params.offset, params.offset + 2);
			const next = params.offset + page.length;
			return next < events.length
				? { events: page, next_offset: next }
				: { events: page };
		});
		await second.start("第二个任务");
		await second.until(() => second.ends.length === 1);

		expect(second.failures).toEqual([]);
		expect(second.ends).toEqual([{ outcome: "completed" }]);
		expect(reads.map((read) => read.offset)).toEqual([0, 2, 4]);
		expect(reads[0]?.until).toEqual({ run_id: "run-1", seq: 99 });
		const after = second.requests[0]?.messages as Message[];
		expect(after.slice(0, before.length + 1)).toEqual([...before, reply]);
		expect(after).toHaveLength(before.length + 2);
		expect(textOf(after.at(-1) as Message)).toBe("第二个任务");
		// 系统指令和规则文件没有变：不再上报，也不追加补丁
		expect(second.events).toEqual([]);
	});

	test("上次中断的那一轮工具调用在下一个 task 开始时先做完：有结果的不再执行，新的输入排在结果后面", async () => {
		const reply = assistant("a1", [call("c1"), call("c2")], "tool_use");
		const events = [
			event("instructions.recorded", instructions),
			sent(user("u1", "跑两条命令")),
			completed(reply),
			event("tool_call.started", {
				tool_call_id: "old-1",
				call_id: "c1",
				message_id: "a1",
				name: "shell",
				arguments: "{}",
				executor: "host",
			}),
			event("tool_call.completed", {
				tool_call_id: "old-1",
				result: { status: "succeeded", content: text("第一条的输出") },
				duration_ms: 5,
			}),
			event("tool_call.started", {
				tool_call_id: "old-2",
				call_id: "c2",
				message_id: "a1",
				name: "shell",
				arguments: "{}",
				executor: "host",
			}),
		];
		const ran: { call_id: string; message_id: string }[] = [];
		const resumed = await startFakeHost({
			config: { workspace, resume: { run_id: "run-1", seq: 99 } },
			model: () => ({ content: [{ type: "text", text: "都做完了" }] }),
			runTool: ({ call_id, message_id }) => {
				ran.push({ call_id, message_id });
				return { status: "succeeded", content: text("第二条的输出") };
			},
		});
		host = resumed;
		resumed.channel.handle("record/read", async (params) => ({
			events: events.filter((e) => params.types.includes(e.type)),
		}));
		await resumed.start("接着做");
		await resumed.until(() => resumed.ends.length === 1);

		expect(resumed.failures).toEqual([]);
		expect(resumed.ends).toEqual([{ outcome: "completed" }]);
		expect(ran).toEqual([{ call_id: "c2", message_id: "a1" }]);
		const messages = resumed.requests[0]?.messages as Message[];
		// 之后还有一条系统指令的补丁：记录里的段落是这个测试随手写的
		expect(messages.slice(1, 5)).toMatchObject([
			reply,
			{ role: "tool_result", call_id: "c1", tool_call_id: "old-1" },
			{
				role: "tool_result",
				call_id: "c2",
				tool_call_id: "tc-1",
				content: text("第二条的输出"),
			},
			{ role: "user", content: text("接着做") },
		]);
	});

	test("压缩被脱敏作废之后历史又超过阈值：恢复后的第一次请求之前重新压缩", async () => {
		const isSummaryRequest = (request: { messages: Message[] }) => {
			const last = request.messages.at(-1);
			return (
				last?.role === "user" && textOf(last).startsWith("<compaction_request>")
			);
		};
		const usage = (input: number) => ({
			input,
			output: 10,
			cache_read: 0,
			cache_write: 0,
			reasoning: 0,
		});
		const events = [
			event("instructions.recorded", instructions),
			sent(user("u1", "第一个问题")),
			// 压缩之前上下文已经有 39,000 token，超过 40,000 的 90%
			completed({
				...assistant("a1", [{ type: "text", text: "第一个回答" }], "end_turn"),
				usage: usage(39_000),
			}),
			sent(user("old-request", "<compaction_request>")),
			event("message.completed", {
				redacted: true,
				message: assistant(
					"old-summary",
					[{ type: "text", text: "[REDACTED]" }],
					"end_turn",
				),
			}),
			event("context.compacted", {
				redacted: true,
				trigger: "auto",
				tokens_before: 1000,
				summary: "[REDACTED]",
				messages: [
					{
						role: "user",
						message_id: "k-summary",
						content: text("[REDACTED]"),
					},
				],
				instructions,
			}),
			event("message.sent", {
				redacted: true,
				message: user("k-summary", "[REDACTED]"),
			}),
			sent(user("u2", "第二个问题")),
			// 压缩之后的回复报告的用量是对着摘要数的：重建出的历史比它长得多
			completed({
				...assistant("a2", [{ type: "text", text: "第二个回答" }], "end_turn"),
				usage: usage(500),
			}),
		];
		const resumed = await startFakeHost({
			config: {
				workspace,
				resume: { run_id: "run-1", seq: 99 },
				model: {
					id: "test-model",
					protocol: "anthropic.messages",
					reasoning_effort: "off",
					context_window: 40_000,
					max_output_tokens: 6_000,
				},
			},
			model: (request) => ({
				content: [
					{
						type: "text",
						text: isSummaryRequest(request) ? "新的摘要" : "接着做完了",
					},
				],
			}),
		});
		host = resumed;
		resumed.channel.handle("record/read", async (params) => ({
			events: events.filter((e) => params.types.includes(e.type)),
		}));
		await resumed.start("接着做");
		await resumed.until(() => resumed.ends.length === 1);

		expect(resumed.failures).toEqual([]);
		expect(resumed.ends).toEqual([{ outcome: "completed" }]);
		expect(resumed.requests.map(isSummaryRequest)).toEqual([true, false]);
		// 交给摘要的是压缩之前的历史：没有作废的摘要，也没有上一次要摘要的那条消息和它的回复
		const summarizing = resumed.requests[0]?.messages as Message[];
		expect(
			summarizing.map((message) => message.message_id).slice(0, 4),
		).toEqual(["u1", "a1", "u2", "a2"]);
		expect(JSON.stringify(summarizing)).not.toContain("[REDACTED]");
		expect(textOf(resumed.requests[1]?.messages.at(-1) as Message)).toBe(
			"接着做",
		);
		expect(JSON.stringify(resumed.requests[1]?.messages)).toContain("新的摘要");
	});
});
