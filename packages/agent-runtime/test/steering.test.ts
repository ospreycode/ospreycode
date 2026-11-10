import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ChannelRequestError,
	type PendingInput,
} from "@ospreycode/agent-runtime";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type FakeHost, startFakeHost, type Turn, text } from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-steer-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

function shell(callId: string, command: string): Turn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments: JSON.stringify({ command }),
			},
		],
	};
}

function steering(id: string, value: string): PendingInput {
	return { input_id: id, kind: "steering", content: text(value) };
}

/** 请求里系统指令和上下文消息之后的消息。 */
function conversation(request: ModelRequest): Message[] {
	return request.messages.slice(2);
}

test("steering 等这一轮的工具调用都结束后、下一次模型请求之前插入，跟在工具结果后面，每条单独一块", async () => {
	let pending: PendingInput[] = [];
	const ran: string[] = [];
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) =>
			index === 0
				? {
						content: [
							...shell("call_1", "first").content,
							...shell("call_2", "second").content,
						],
					}
				: done,
		runTool: async (params) => {
			ran.push(params.call_id);
			if (params.call_id === "call_1") {
				// 第一条命令还在执行时用户发来两条 steering，同时有一条后台通知
				pending = [
					steering("in-1", "also update the docs"),
					steering("in-2", "and keep it short"),
					{
						input_id: "note-1",
						kind: "notification",
						content: text(
							"Automatic notification, not user input. bg-1 exited.",
						),
					},
				];
				await host?.channel.notify("input/available", {});
			}
			return { status: "succeeded", content: text(`ran ${params.call_id}`) };
		},
		takeInputs: () => {
			const taken = pending;
			pending = [];
			return taken;
		},
	});
	await host.start("do it");
	await host.until(() => host?.ends.length === 1);

	// 剩下的工具调用没有被跳过
	expect(ran).toEqual(["call_1", "call_2"]);
	expect(host.requests).toHaveLength(2);
	const messages = conversation(host.requests[1] as ModelRequest);
	expect(messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"tool_result",
		"tool_result",
		"user",
	]);
	expect(messages[4]?.content).toEqual([
		...text("also update the docs"),
		...text("and keep it short"),
		...text("Automatic notification, not user input. bg-1 exited."),
	]);
	// 插入的位置上报给 Host：跟在这一轮最后一个工具结果后面
	expect(
		host.events.filter((event) => event.type === "input.inserted"),
	).toEqual([
		{
			type: "input.inserted",
			data: {
				input_ids: ["in-1", "in-2", "note-1"],
				message_id: messages[4]?.message_id,
				after_tool_call_id: "tc-2",
			},
		},
	]);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	expect(host.failures).toEqual([]);
});

test("模型已经给出最终回复时还有 steering：Host 回复继续，同一个 task 再请求一次模型", async () => {
	let pending = [steering("in-1", "one more thing")];
	host = await startFakeHost({
		config: { workspace },
		model: () => done,
		taskEnd: () => pending.length > 0,
		takeInputs: () => {
			const taken = pending;
			pending = [];
			return taken;
		},
	});
	await host.start("do it");
	await host.until(() => host?.ends.length === 2);

	expect(host.ends).toEqual([
		{ outcome: "completed" },
		{ outcome: "completed" },
	]);
	expect(host.requests).toHaveLength(2);
	const messages = conversation(host.requests[1] as ModelRequest);
	expect(messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"user",
	]);
	expect(messages[2]?.content).toEqual(text("one more thing"));
	expect(host.events.find((event) => event.type === "input.inserted")).toEqual({
		type: "input.inserted",
		data: {
			input_ids: ["in-1"],
			message_id: messages[2]?.message_id,
			after_tool_call_id: null,
		},
	});
	expect(host.failures).toEqual([]);
});

test("取消之后 Host 回复继续：没插入的 steering 马上交给模型，同一个 task 接着进行，之后还能再取消", async () => {
	let pending: PendingInput[] = [];
	const requested = Promise.withResolvers<void>();
	const requestedAgain = Promise.withResolvers<void>();
	host = await startFakeHost({
		config: { workspace },
		model: async (_request, index, { signal }) => {
			if (index === 2) return done;
			(index === 0 ? requested : requestedAgain).resolve();
			await once(signal, "abort");
			throw new ChannelRequestError("cancelled", "已取消");
		},
		taskEnd: () => pending.length > 0,
		takeInputs: () => {
			const taken = pending;
			pending = [];
			return taken;
		},
	});
	await host.start("write a long poem");
	await requested.promise;
	pending = [steering("in-1", "make it a haiku instead")];
	await host.channel.request("run/cancel", {});
	await requestedAgain.promise;

	// 第二次请求带着 steering；被取消的那次回复没有留在历史里
	const messages = conversation(host.requests[1] as ModelRequest);
	expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
	expect(messages[1]?.content).toEqual(text("make it a haiku instead"));

	// 继续之后的这一段也能取消，这次没有 steering，task 结束
	await host.channel.request("run/cancel", {});
	await host.until(() => host?.ends.length === 2);
	expect(host.ends).toEqual([
		{ outcome: "cancelled" },
		{ outcome: "cancelled" },
	]);
	expect(await host.channel.request("status", {})).toEqual({
		state: "idle",
		tool_call_ids: [],
	});
	expect(host.failures).toEqual([]);
});

test("Host 回复继续但输入已经被取回：runtime 再报告一次结束", async () => {
	let first = true;
	host = await startFakeHost({
		config: { workspace },
		model: () => done,
		taskEnd: () => {
			const more = first;
			first = false;
			return more;
		},
	});
	await host.start("do it");
	await host.until(() => host?.ends.length === 2);

	expect(host.requests).toHaveLength(1);
	expect(host.ends).toEqual([
		{ outcome: "completed" },
		{ outcome: "completed" },
	]);
	expect(host.failures).toEqual([]);
});

test("下一个 task 的 task/start 比 task/end 的响应先到时，等响应到了再开始", async () => {
	let started = false;
	host = await startFakeHost({
		config: { workspace },
		model: () => done,
		taskEnd: () => {
			if (!started) {
				started = true;
				// follow-up：Host 在回复 task/end 之前就发出了下一个 task
				void host?.start("next task");
			}
			return false;
		},
	});
	await host.start("first task");
	await host.until(() => host?.ends.length === 2);

	expect(host.requests).toHaveLength(2);
	expect(
		conversation(host.requests[1] as ModelRequest).map((message) =>
			message.role === "user" ? message.content : message.role,
		),
	).toEqual([text("first task"), "assistant", text("next task")]);
	expect(host.failures).toEqual([]);
});
