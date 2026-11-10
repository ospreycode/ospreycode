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

	test("记录有缺陷时报错：有消息却没有系统指令的记录；登记过的调用没有结果", () => {
		expect(() => rebuildState([sent(user("u1", "你好"))])).toThrow(
			/instructions\.recorded/,
		);
		expect(() =>
			rebuildState([
				event("instructions.recorded", instructions),
				sent(user("u1", "跑命令")),
				completed(assistant("a1", [call("c1")], "tool_use")),
				event("tool_call.started", {
					tool_call_id: "tc-1",
					call_id: "c1",
					message_id: "a1",
					name: "shell",
					arguments: "{}",
					executor: "host",
				}),
			]),
		).toThrow(/tc-1/);
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
});
