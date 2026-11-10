import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	PendingInput,
	ToolCallRunParams,
} from "@ospreycode/agent-runtime";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type FakeHost, startFakeHost, type Turn, text } from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-background-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

function shell(callId: string, args: Record<string, unknown>): Turn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments: JSON.stringify(args),
			},
		],
	};
}

test("后台命令的几种动作都经 shell 工具交给 Host；转入后台的结果不算出错", async () => {
	const turns = [
		shell("call_1", { command: "npm run dev", background: true }),
		shell("call_2", {
			command: "tail -f log",
			monitor: true,
			timeout_ms: 60_000,
		}),
		// 不带命令的动作也是合法的参数
		shell("call_3", { action: "status" }),
		shell("call_4", {
			action: "write_stdin",
			background_id: "bg-1",
			stdin: "y\n",
		}),
		shell("call_5", { action: "stop", background_id: "bg-1" }),
	];
	const ran: ToolCallRunParams[] = [];
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) => turns[index] ?? done,
		runTool: async (params) => {
			ran.push(params);
			return params.call_id === "call_1"
				? {
						status: "running",
						content: text("Started background command bg-1."),
						background_id: "bg-1",
					}
				: { status: "succeeded", content: text(`ran ${params.call_id}`) };
		},
	});
	await host.start("start the dev server");
	await host.until(() => host?.ends.length === 1);

	// 参数照模型写的原样交给 Host，由 Host 校验
	expect(ran.map((params) => [params.name, params.arguments])).toEqual(
		turns.map((turn) => {
			const [call] = turn.content;
			if (call?.type !== "tool_call") throw new Error("不是工具调用");
			return ["shell", call.arguments];
		}),
	);
	// 命令还在后台运行：结果照原样交给模型，不标成出错
	const second = host.requests[1] as ModelRequest;
	expect(second.messages.at(-1)).toMatchObject({
		role: "tool_result",
		call_id: "call_1",
		is_error: false,
		content: text("Started background command bg-1."),
	});
	// 模型从工具声明里知道这几项参数
	const declaration = second.tools.find((tool) => tool.name === "shell");
	if (declaration === undefined) throw new Error("请求里没有 shell 工具");
	const { properties } = declaration.parameters as { properties: object };
	expect(Object.keys(properties)).toEqual(
		expect.arrayContaining([
			"action",
			"command",
			"timeout_ms",
			"background",
			"monitor",
			"background_id",
			"stdin",
		]),
	);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	expect(host.failures).toEqual([]);
});

test("task 开始之前 Host 就说有输入：第一次模型请求之前取走，排在这次输入之后", async () => {
	// session 空闲时留下的后台通知，随用户的下一个 task 交给模型
	let pending: PendingInput[] = [
		{
			input_id: "note-1",
			kind: "notification",
			content: text("Automatic notification, not user input. bg-1 exited."),
		},
	];
	host = await startFakeHost({
		config: { workspace },
		model: () => done,
		takeInputs: () => {
			const taken = pending;
			pending = [];
			return taken;
		},
	});
	await host.channel.notify("input/available", {});
	await host.start("what happened?");
	await host.until(() => host?.ends.length === 1);

	expect(host.requests).toHaveLength(1);
	const messages = (host.requests[0] as ModelRequest).messages.slice(-2);
	expect(messages.map((message) => [message.role, message.content])).toEqual([
		["user", text("what happened?")],
		["user", text("Automatic notification, not user input. bg-1 exited.")],
	]);
	expect(
		host.events.filter((event) => event.type === "input.inserted"),
	).toEqual([
		{
			type: "input.inserted",
			data: {
				input_ids: ["note-1"],
				message_id: messages[1]?.message_id,
				after_tool_call_id: null,
			},
		},
	]);
	expect(host.failures).toEqual([]);
});
