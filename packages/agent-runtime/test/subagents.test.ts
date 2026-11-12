import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	PendingInput,
	SubagentInfo,
	SubagentSendParams,
	SubagentStartParams,
	SubagentStopParams,
} from "@ospreycode/agent-runtime";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
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
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-sub-")));
});

afterEach(async () => {
	expect(host?.failures).toEqual([]);
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const tools = ["read", "spawn_agent", "send_message", "interrupt_agent"];

const subagents: SubagentInfo[] = [
	{ name: "reviewer", description: "Reviews a change.", isolated: false },
	{ name: "worker", description: "Implements one part.", isolated: true },
];

const done: Turn = { content: [{ type: "text", text: "done" }] };

function call(callId: string, name: string, args: object): Turn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

function last(request: ModelRequest | undefined): string {
	const message = request?.messages.at(-1);
	if (message === undefined) throw new Error("没有这次请求");
	return textOf(message);
}

/** 等到 runtime 在等子 agent 结束：这个状态不伴随任何发给 Host 的消息，只能问。 */
async function waiting(): Promise<void> {
	if (host === undefined) throw new Error("假 Host 没有启动");
	for (;;) {
		const { state } = await host.channel.request("status", {});
		if (state === "subagents") return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** 子 agent 的结果通知：Host 排进通知队列的样子。 */
function notice(id: string, body: string): PendingInput {
	return {
		input_id: id,
		kind: "notification",
		content: text(`Automatic notification, not user input. ${body}`),
	};
}

test("定义的列表放在会话开始的上下文消息里，三个工具有声明", async () => {
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: () => done,
	});
	await host.start("hi");
	await host.until(() => host?.ends.length === 1);
	const [request] = host.requests;
	const context = textOf(request?.messages[1] ?? { content: [] });
	expect(context).toContain("<subagents>");
	expect(context).toContain("- reviewer: Reviews a change.");
	expect(context).toContain(
		"- worker: Implements one part. (works in its own copy of the repository)",
	);
	expect(request?.tools.map((tool) => tool.name)).toEqual(tools);
	// 系统指令里没有子 agent 自己才有的那一段
	expect(textOf(request?.messages[0] ?? { content: [] })).not.toContain(
		"# Subagent",
	);
});

test("子 agent 自己：系统指令多一段，补充说明放在上下文消息里", async () => {
	host = await startFakeHost({
		config: {
			workspace,
			tools: ["read"],
			subagent: { name: "reviewer", instructions: "Only report bugs.\n" },
		},
		model: () => done,
	});
	await host.start("review the change");
	await host.until(() => host?.ends.length === 1);
	const [request] = host.requests;
	expect(textOf(request?.messages[0] ?? { content: [] })).toContain(
		"# Subagent\nYou are running as the subagent reviewer",
	);
	expect(textOf(request?.messages[1] ?? { content: [] })).toContain(
		'<subagent_instructions name="reviewer">\nOnly report bugs.\n</subagent_instructions>',
	);
});

test("spawn_agent 不等子 agent 做完；模型给出回复时它还在运行，task 等到结果插入后再请求模型", async () => {
	const started: SubagentStartParams[] = [];
	let pending: PendingInput[] = [];
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: (_request, index) =>
			[
				call("c1", "spawn_agent", {
					agent: "reviewer",
					prompt: "look at a.ts",
				}),
				{ content: [{ type: "text" as const, text: "waiting" }] },
				done,
			][index] ?? done,
		subagents: {
			start: (params) => {
				started.push(params);
				return { started: true, agent_id: "agent-1" };
			},
		},
		takeInputs: () => {
			const inputs = pending;
			pending = [];
			return inputs;
		},
	});
	await host.start("review");
	// 第二次请求之后模型给出了回复，子 agent 还在运行：task 不结束
	await host.until(() => host?.requests.length === 2);
	expect(started).toEqual([
		{ tool_call_id: "tc-1", agent: "reviewer", prompt: "look at a.ts" },
	]);
	expect(last(host.requests[1])).toContain(
		"Started the subagent reviewer. Its id is agent-1.",
	);
	await waiting();
	expect(host.ends).toEqual([]);

	// 子 agent 结束：结果在通知队列里
	pending = [
		notice("n1", "The subagent reviewer (agent-1) completed.\nno bugs"),
	];
	await host.channel.notify("input/available", {});
	await host.channel.notify("subagent/ended", { agent_id: "agent-1" });
	await host.until(() => host?.ends.length === 1);
	expect(host.requests).toHaveLength(3);
	expect(last(host.requests[2])).toContain("no bugs");
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	// 插入的位置照常上报
	expect(
		host.events.filter((event) => event.type === "input.inserted"),
	).toHaveLength(1);
});

test("结果在模型回复之前就到了：照常在下一次模型请求之前插入，task 正常结束", async () => {
	let pending: PendingInput[] = [];
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: async (_request, index) => {
			if (index === 0) {
				return call("c1", "spawn_agent", { agent: "reviewer", prompt: "p" });
			}
			return done;
		},
		subagents: {
			start: async () => {
				// 子 agent 在启动的响应发出之前就结束了
				pending = [
					notice("n1", "The subagent reviewer (agent-1) completed.\nok"),
				];
				setImmediate(() => {
					void host?.channel.notify("input/available", {});
					void host?.channel.notify("subagent/ended", { agent_id: "agent-1" });
				});
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { started: true, agent_id: "agent-1" };
			},
		},
		takeInputs: () => {
			const inputs = pending;
			pending = [];
			return inputs;
		},
	});
	await host.start("review");
	await host.until(() => host?.ends.length === 1);
	expect(host.requests).toHaveLength(2);
	expect(last(host.requests[1])).toContain("ok");
	expect(host.ends).toEqual([{ outcome: "completed" }]);
});

test("启动不了、发不出、停不了：原因作为失败的工具结果交给模型", async () => {
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: (_request, index) =>
			[
				call("c1", "spawn_agent", { agent: "nobody", prompt: "p" }),
				call("c2", "send_message", { agent_id: "agent-9", message: "m" }),
				call("c3", "interrupt_agent", { agent_id: "agent-9" }),
			][index] ?? done,
		subagents: {
			start: () => ({ started: false, reason: "No subagent named nobody." }),
			send: () => ({ sent: false, reason: "agent-9 is not running." }),
			stop: () => ({ stopped: false, reason: "agent-9 is not running." }),
		},
	});
	await host.start("go");
	await host.until(() => host?.ends.length === 1);
	expect(host.completed).toEqual([
		{ status: "failed", content: text("No subagent named nobody.") },
		{ status: "failed", content: text("agent-9 is not running.") },
		{ status: "failed", content: text("agent-9 is not running.") },
	]);
	// 没有子 agent 在运行：task 照常结束
	expect(host.ends).toEqual([{ outcome: "completed" }]);
});

test("send_message 和 interrupt_agent：停止之后不再等它", async () => {
	const sent: SubagentSendParams[] = [];
	const stopped: SubagentStopParams[] = [];
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: (_request, index) =>
			[
				call("c1", "spawn_agent", { agent: "worker", prompt: "p" }),
				call("c2", "send_message", {
					agent_id: "agent-1",
					message: "also b.ts",
				}),
				call("c3", "interrupt_agent", { agent_id: "agent-1" }),
			][index] ?? done,
		subagents: {
			start: () => ({
				started: true,
				agent_id: "agent-1",
				workspace: "/host/workers/s/a/repo",
			}),
			send: (params) => {
				sent.push(params);
				return { sent: true };
			},
			stop: (params) => {
				stopped.push(params);
				return { stopped: true };
			},
		},
	});
	await host.start("go");
	await host.until(() => host?.ends.length === 1);
	expect(last(host.requests[1])).toContain(
		"It works in its own copy of the repository at /host/workers/s/a/repo.",
	);
	expect(sent).toEqual([
		{ tool_call_id: "tc-2", agent_id: "agent-1", input: "also b.ts" },
	]);
	expect(stopped).toEqual([{ tool_call_id: "tc-3", agent_id: "agent-1" }]);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
});

test("等子 agent 时取消：task 以 cancelled 结束，下一个 task 不再等上一个 task 的子 agent", async () => {
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: (_request, index) =>
			index === 0
				? call("c1", "spawn_agent", { agent: "reviewer", prompt: "p" })
				: done,
		subagents: { start: () => ({ started: true, agent_id: "agent-1" }) },
	});
	await host.start("review");
	await waiting();
	await host.channel.request("run/cancel", {});
	await host.until(() => host?.ends.length === 1);
	expect(host.ends).toEqual([{ outcome: "cancelled" }]);

	await host.start("again");
	await host.until(() => host?.ends.length === 2);
	expect(host.ends[1]).toEqual({ outcome: "completed" });
});

test("等子 agent 时用户的 steering 到了：插入后再请求模型，子 agent 结束后 task 才结束", async () => {
	let pending: PendingInput[] = [];
	host = await startFakeHost({
		config: { workspace, tools, subagents },
		model: (_request, index) =>
			index === 0
				? call("c1", "spawn_agent", { agent: "reviewer", prompt: "p" })
				: { content: [{ type: "text" as const, text: `reply ${index}` }] },
		subagents: { start: () => ({ started: true, agent_id: "agent-1" }) },
		takeInputs: () => {
			const inputs = pending;
			pending = [];
			return inputs;
		},
	});
	await host.start("review");
	await waiting();
	pending = [
		{ input_id: "s1", kind: "steering", content: text("also check b") },
	];
	await host.channel.notify("input/available", {});
	await host.until(() => host?.requests.length === 3);
	expect(last(host.requests[2])).toBe("also check b");
	await waiting();
	expect(host.ends).toEqual([]);

	pending = [notice("n1", "The subagent reviewer (agent-1) completed.\nfine")];
	await host.channel.notify("subagent/ended", { agent_id: "agent-1" });
	await host.until(() => host?.ends.length === 1);
	expect(host.requests).toHaveLength(4);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
});
