import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HooksRunParams,
	McpToolInfo,
	SkillInfo,
} from "@ospreycode/agent-runtime";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-ext-")));
});

afterEach(async () => {
	expect(host?.failures).toEqual([]);
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

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

/** 这次请求里最后一条消息的文字。 */
function last(request: ModelRequest | undefined): string {
	const message = request?.messages.at(-1);
	if (message === undefined) throw new Error("没有这次请求");
	return textOf(message);
}

/** 会话开始的上下文消息：系统指令之后的第一条。 */
function opening(request: ModelRequest | undefined): string {
	const message = request?.messages[1];
	if (message === undefined) throw new Error("没有这次请求");
	return textOf(message);
}

async function finished(count = 1): Promise<void> {
	await host?.until(() => (host?.ends.length ?? 0) >= count);
}

const skills: SkillInfo[] = [
	{ name: "review", description: "Review a change.", directory: "/s/review" },
	{ name: "deploy", description: "Deploy the app.", directory: "/s/deploy" },
];

describe("skills", () => {
	test("列表放在会话开始的上下文消息里，只有名字、说明和目录", async () => {
		host = await startFakeHost({
			config: { workspace, tools: ["read", "skill_load"], skills },
			model: () => done,
		});
		await host.start("hi");
		await finished();
		const context = opening(host.requests[0]);
		expect(context).toContain("<skills>");
		expect(context).toContain(
			"- review: Review a change. (directory: /s/review)\n- deploy: Deploy the app. (directory: /s/deploy)",
		);
		expect(host.requests[0]?.tools.map((tool) => tool.name)).toEqual([
			"read",
			"skill_load",
		]);
		expect(
			host.events.find((event) => event.type === "instructions.recorded")?.data
				.skills,
		).toEqual(skills);
	});

	test("没有启用的 skill 时不提 skills", async () => {
		host = await startFakeHost({
			config: { workspace },
			model: () => done,
		});
		await host.start("hi");
		await finished();
		expect(opening(host.requests[0])).not.toContain("<skills>");
	});

	test("skill_load 先登记，再经 skill/load 向 Host 取内容", async () => {
		const loaded: string[] = [];
		host = await startFakeHost({
			config: { workspace, tools: ["read", "skill_load"], skills },
			model: (_request, index) =>
				index === 0 ? call("call_1", "skill_load", { name: "review" }) : done,
			loadSkill: (name) => {
				loaded.push(name);
				return {
					loaded: true,
					content: "<skill_content>REVIEW</skill_content>",
				};
			},
		});
		await host.start("hi");
		await finished();
		expect(loaded).toEqual(["review"]);
		expect(host.completed).toEqual([
			{
				status: "succeeded",
				content: text("<skill_content>REVIEW</skill_content>"),
			},
		]);
		expect(JSON.stringify(host.requests[1]?.messages.at(-1))).toContain(
			"REVIEW",
		);
	});

	test("Host 不给内容时把原因告诉模型", async () => {
		host = await startFakeHost({
			config: { workspace, tools: ["skill_load"], skills },
			model: (_request, index) =>
				index === 0 ? call("call_1", "skill_load", { name: "review" }) : done,
			loadSkill: () => ({
				loaded: false,
				reason: "The content of the skill review changed.",
			}),
		});
		await host.start("hi");
		await finished();
		expect(host.completed).toMatchObject([
			{
				status: "failed",
				content: text("The content of the skill review changed."),
			},
		]);
	});

	test("启用的 skills 变了：下一次模型请求之前追加完整的新列表", async () => {
		host = await startFakeHost({
			config: { workspace, tools: ["skill_load"], skills },
			model: () => done,
			taskEnd: () => false,
		});
		await host.start("first");
		await finished(1);
		await host.channel.notify("config/update", { skills: skills.slice(1) });
		await host.start("second");
		await finished(2);
		const messages = host.requests[1]?.messages ?? [];
		const update = messages
			.map(textOf)
			.find((value) => value.startsWith("<skills_update>"));
		expect(update).toContain("- deploy: Deploy the app.");
		expect(update).not.toContain("review");
		// 开头的上下文消息不动：提示缓存的前缀不变
		expect(opening(host.requests[1])).toBe(opening(host.requests[0]));

		await host.channel.notify("config/update", { skills: [] });
		await host.start("third");
		await finished(3);
		expect(
			(host.requests[2]?.messages ?? [])
				.map(textOf)
				.filter((value) => value.startsWith("<skills_update>"))
				.at(-1),
		).toContain("No skill is available any more");
	});
});

const echo: McpToolInfo = {
	declaration: {
		name: "docs__echo",
		description: "Echo text.",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	read_only: false,
	idempotent: false,
	concurrent: false,
};

describe("MCP 工具", () => {
	test("声明接在内置工具后面，调用交给 Host 执行", async () => {
		const ran: { name: string; arguments: string }[] = [];
		host = await startFakeHost({
			config: { workspace, mcp_tools: [echo] },
			model: (_request, index) =>
				index === 0 ? call("call_1", "docs__echo", { text: "hi" }) : done,
			runTool: (params) => {
				ran.push({ name: params.name, arguments: params.arguments });
				return { status: "succeeded", content: text("hi") };
			},
		});
		await host.start("go");
		await finished();
		expect(host.requests[0]?.tools.map((tool) => tool.name)).toEqual([
			"read",
			"edit",
			"write",
			"shell",
			"docs__echo",
		]);
		expect(host.requests[0]?.tools.at(-1)).toEqual(echo.declaration);
		expect(ran).toEqual([{ name: "docs__echo", arguments: '{"text":"hi"}' }]);
		expect(JSON.stringify(host.requests[1]?.messages.at(-1))).toContain("hi");
	});

	test("参数不符合 server 给的 schema 时也交给 Host：由 server 判断", async () => {
		const ran: string[] = [];
		host = await startFakeHost({
			config: { workspace, mcp_tools: [echo] },
			model: (_request, index) =>
				index === 0 ? call("call_1", "docs__echo", { other: 1 }) : done,
			runTool: (params) => {
				ran.push(params.arguments);
				return { status: "failed", content: text("text is required") };
			},
		});
		await host.start("go");
		await finished();
		expect(ran).toEqual(['{"other":1}']);
	});

	test("工具集变了：从下一次模型请求起用新的列表", async () => {
		host = await startFakeHost({
			config: { workspace, mcp_tools: [echo] },
			model: () => done,
		});
		await host.start("first");
		await finished(1);
		const extra: McpToolInfo = {
			...echo,
			declaration: { ...echo.declaration, name: "docs__extra" },
		};
		await host.channel.notify("config/update", { mcp_tools: [extra] });
		await host.start("second");
		await finished(2);
		expect(host.requests[1]?.tools.map((tool) => tool.name)).toEqual([
			"read",
			"edit",
			"write",
			"shell",
			"docs__extra",
		]);
	});
});

describe("Stop hooks", () => {
	test("没有配时不经 hooks/run", async () => {
		const asked: HooksRunParams[] = [];
		host = await startFakeHost({
			config: { workspace },
			model: () => done,
			hooks: (params) => {
				asked.push(params);
				return { blocked: false };
			},
		});
		await host.start("go");
		await finished();
		expect(asked).toEqual([]);
	});

	test("模型给出最终回复后运行；要求接着做时原因作为一条标明来源的消息交给模型", async () => {
		const asked: HooksRunParams[] = [];
		host = await startFakeHost({
			config: { workspace, stop_hooks: true },
			model: (_request, index) => ({
				content: [
					{ type: "text", text: index === 0 ? "all done" : "tests pass" },
				],
			}),
			hooks: (params) => {
				asked.push(params);
				return asked.length === 1
					? { blocked: true, reason: "Run the tests first." }
					: { blocked: false };
			},
		});
		await host.start("go");
		await finished();
		expect(asked).toEqual([
			{
				event: "Stop",
				last_assistant_message: "all done",
				continuation_count: 0,
				message_id: expect.any(String),
			},
			{
				event: "Stop",
				last_assistant_message: "tests pass",
				continuation_count: 1,
				message_id: expect.any(String),
			},
		]);
		expect(host.requests).toHaveLength(2);
		// 请求里带的编号就是放原因的那条消息的：Host 靠它把这次 hooks 的记录和消息对上
		expect(host.requests[1]?.messages.at(-1)?.message_id).toBe(
			asked[0]?.message_id,
		);
		expect(last(host.requests[1])).toBe(
			'<hook_feedback event="Stop">\nA hook configured by the user ran when you finished and asks you to continue. It is not a message from the user. Its reason:\nRun the tests first.\n</hook_feedback>',
		);
		expect(host.ends).toMatchObject([{ outcome: "completed" }]);
	});

	test("模型还要调用工具时不运行", async () => {
		const asked: HooksRunParams[] = [];
		host = await startFakeHost({
			config: { workspace, stop_hooks: true },
			model: (_request, index) =>
				index === 0 ? call("call_1", "shell", { command: "true" }) : done,
			runTool: () => ({ status: "succeeded", content: text("") }),
			hooks: (params) => {
				asked.push(params);
				return { blocked: false };
			},
		});
		await host.start("go");
		await finished();
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ last_assistant_message: "done" });
	});

	test("一个 task 里最多让模型接着做 8 轮", async () => {
		let asked = 0;
		host = await startFakeHost({
			config: { workspace, stop_hooks: true },
			model: () => done,
			hooks: () => {
				asked += 1;
				return { blocked: true, reason: "again" };
			},
		});
		await host.start("go");
		await finished();
		expect(asked).toBe(8);
		expect(host.requests).toHaveLength(9);
		expect(host.ends).toMatchObject([{ outcome: "completed" }]);
	});
});

describe("tool_call/complete 的回复", () => {
	test("Host 补充过的结果代替 runtime 自己的那一份交给模型", async () => {
		host = await startFakeHost({
			config: { workspace, tools: ["skill_load"], skills },
			model: (_request, index) =>
				index === 0 ? call("call_1", "skill_load", { name: "review" }) : done,
			loadSkill: () => ({ loaded: true, content: "REVIEW" }),
			amendResult: (result) => ({
				...result,
				content: [
					...result.content,
					...text("<hook_context>checked</hook_context>"),
				],
			}),
		});
		await host.start("go");
		await finished();
		const seen = JSON.stringify(host.requests[1]?.messages.at(-1));
		expect(seen).toContain("REVIEW");
		expect(seen).toContain("<hook_context>checked</hook_context>");
	});
});
