import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "@ospreycode/agent-runtime";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type FakeHost, startFakeHost, type Turn, text } from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-model-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

const shell: Turn = {
	content: [
		{
			type: "tool_call",
			call_id: "call_1",
			name: "shell",
			arguments: JSON.stringify({ command: "echo hi" }),
		},
	],
};

const other: ModelInfo = {
	id: "other-model",
	protocol: "openai.responses",
	reasoning_effort: "high",
	context_window: 100_000,
	max_output_tokens: 4_000,
};

test("换模型之后的请求用新的模型和推理强度，之前的历史原样带上，不追加消息", async () => {
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) => (index === 0 ? shell : done),
		runTool: () => ({ status: "succeeded", content: text("hi") }),
	});
	await host.start("first");
	await host.until(() => host?.ends.length === 1);
	await host.channel.notify("config/update", { model: other });
	await host.start("second");
	await host.until(() => host?.ends.length === 2);

	const [, before, after] = host.requests as ModelRequest[];
	expect(before).toMatchObject({
		model: "test-model",
		reasoning_effort: "off",
	});
	expect(after).toMatchObject({
		model: "other-model",
		reasoning_effort: "high",
	});
	// 上一个模型的回复、工具调用和结果都还在，后面只多了它的最终回复和新的输入
	expect(after?.messages.slice(0, before?.messages.length)).toEqual(
		before?.messages,
	);
	expect(
		after?.messages.slice(before?.messages.length).map((m) => m.role),
	).toEqual(["assistant", "user"]);
	expect(after?.tools).toEqual(before?.tools);
	// 输出长度按新模型的上限
	expect(before?.max_tokens).toBe(8_000);
	expect(after?.max_tokens).toBe(4_000);
	expect(host.failures).toEqual([]);
});

test("task 运行中换模型：这一轮的工具调用做完，下一次请求起用新的模型", async () => {
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) => (index === 0 ? shell : done),
		runTool: async () => {
			await host?.channel.notify("config/update", { model: other });
			return { status: "succeeded", content: text("hi") };
		},
	});
	await host.start("do it");
	await host.until(() => host?.ends.length === 1);

	expect(host.requests.map((request) => request.model)).toEqual([
		"test-model",
		"other-model",
	]);
	expect(host.requests[1]?.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
		"assistant",
		"tool_result",
	]);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	expect(host.failures).toEqual([]);
});

test("只换推理强度：模型不变，请求的推理强度变了", async () => {
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start("first");
	await host.until(() => host?.ends.length === 1);
	await host.channel.notify("config/update", {
		model: {
			id: "test-model",
			protocol: "anthropic.messages",
			reasoning_effort: "xhigh",
			context_window: 200_000,
			max_output_tokens: 8_000,
		},
	});
	await host.start("second");
	await host.until(() => host?.ends.length === 2);

	expect(
		host.requests.map((request) => [request.model, request.reasoning_effort]),
	).toEqual([
		["test-model", "off"],
		["test-model", "xhigh"],
	]);
	// 推理强度只改请求的参数，不追加消息
	expect(host.requests[1]?.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
		"assistant",
		"user",
	]);
});

test("换到上下文更小的模型后历史放不下：明确报错停止，不发出请求", async () => {
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start("x".repeat(20_000));
	await host.until(() => host?.ends.length === 1);
	await host.channel.notify("config/update", {
		model: { ...other, context_window: 8_000, max_output_tokens: 1_000 },
	});
	await host.start("again");
	await host.until(() => host?.ends.length === 2);

	expect(host.requests).toHaveLength(1);
	expect(host.ends[1]?.outcome).toBe("failed");
	expect(host.ends[1]?.error).toContain("上下文快到模型的上限了");
});
