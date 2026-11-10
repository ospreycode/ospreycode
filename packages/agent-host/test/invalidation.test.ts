import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type {
	AssistantContent,
	Invalidation,
	ModelRequest,
} from "@ospreycode/api/protocol";
import { type Script, scriptedModel } from "@ospreycode/api/testing";
import { SessionStore } from "@ospreycode/session-store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	requests = [];
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

async function open(script: Script): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(structuredClone(request));
			return script(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

async function run(input: string): Promise<string> {
	if (session === undefined) throw new Error("session 还没有打开");
	const taskId = await session.submit(input);
	const ended = await log.waitFor("task.ended", (e) => e.task_id === taskId);
	return ended.outcome;
}

/** session 记录里 runtime 上报的作废事件。 */
async function invalidations(): Promise<Invalidation[]> {
	const started = await log.waitFor("session.started");
	await session?.close();
	const store = SessionStore.open(
		join(dirs.root, "data", "projects", started.project_id, "sessions.sqlite"),
	);
	try {
		return store
			.events(started.session_id)
			.filter((event) => event.type === "blocks.invalidated")
			.map((event) => event.data as Invalidation);
	} finally {
		store.close();
	}
}

const origin = {
	protocol: "anthropic.messages",
	service: "test",
	model: "scripted",
} as const;

function thought(text: string): AssistantContent {
	return { type: "reasoning", text, redacted: false, opaque: "sig", origin };
}

function shell(callId: string, command: string): AssistantContent {
	return {
		type: "tool_call",
		call_id: callId,
		name: "shell",
		arguments: JSON.stringify({ command }),
	};
}

describe("拒绝和回退（脚本模型）", () => {
	test("中途拒绝：task 以 refused 结束，本轮输出作废，之后的请求里没有它", async () => {
		await open((_request, call) =>
			call === 0
				? {
						content: [{ type: "text", text: "Sure, here is" }],
						stop_reason: "refusal",
						refusal: { category: "cyber" },
					}
				: { content: [{ type: "text", text: "ok" }] },
		);
		expect(await run("first")).toBe("refused");
		expect(await run("second")).toBe("completed");
		// 系统指令、会话开始的上下文消息、两次输入
		expect(requests[1]?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"user",
			"user",
		]);
		expect(await invalidations()).toMatchObject([
			{ reason: "refusal", blocks: [{ index: 0 }] },
		]);
	});

	test("中途回退：分界之前的工具调用不执行，分界和之后的内容带回下一轮", async () => {
		await open((_request, call) =>
			call === 0
				? {
						content: [
							thought("plan"),
							shell("call_a", "echo a"),
							{
								type: "fallback",
								from: "scripted",
								to: "scripted-fallback",
								origin: { ...origin, model: "scripted-fallback" },
							},
							{ type: "text", text: "ok" },
							shell("call_b", "echo b"),
						],
					}
				: { content: [{ type: "text", text: "done" }] },
		);
		expect(await run("go")).toBe("completed");
		const started = log.events.filter(
			(event) => event.type === "tool_call.started",
		);
		expect(started).toMatchObject([{ call_id: "call_b" }]);
		const completed = await log.waitFor("message.completed");
		expect(completed.message.model).toBe("scripted-fallback");
		const [, , , reply, result] = requests[1]?.messages ?? [];
		expect(reply?.role === "assistant" && reply.content).toMatchObject([
			{ type: "fallback" },
			{ type: "text", text: "ok" },
			{ type: "tool_call", call_id: "call_b" },
		]);
		expect(result).toMatchObject({ role: "tool_result", call_id: "call_b" });
		expect(await invalidations()).toMatchObject([
			{ reason: "fallback", blocks: [{ index: 0 }, { index: 1 }] },
		]);
	});

	test("回退的模型被限流后返回拒绝：task 以 refused 结束，回复带上建议的模型", async () => {
		await open(() => ({
			content: [],
			stop_reason: "refusal",
			refusal: { category: "cyber", recommended_model: "claude-opus-4-8" },
		}));
		expect(await run("go")).toBe("refused");
		expect(await log.waitFor("message.completed")).toMatchObject({
			message: {
				stop_reason: "refusal",
				refusal: { recommended_model: "claude-opus-4-8" },
			},
		});
	});
});

describe("推理内容前缀不符（脚本模型）", () => {
	/** 第二次请求起报前缀不符，指向第一条回复里的推理块。 */
	function mismatch(times: number): Script {
		return (request, call) => {
			if (call === 0) {
				return { content: [thought("plan"), shell("call_1", "echo hi")] };
			}
			const reply = request.messages.find(
				(message) => message.role === "assistant",
			);
			if (call <= times && reply !== undefined) {
				return {
					content: [],
					error: {
						category: "reasoning_prefix_mismatch",
						message: `messages.1.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`,
						block: { message_id: reply.message_id, index: 0 },
					},
				};
			}
			return { content: [{ type: "text", text: "done" }] };
		};
	}

	test("去掉出错的推理块起之后的推理内容，向用户显示警告，再试一次", async () => {
		await open(mismatch(1));
		expect(await run("go")).toBe("completed");
		const reply = requests[2]?.messages.find(
			(message) => message.role === "assistant",
		);
		expect(reply?.role === "assistant" && reply.content).toEqual([
			shell("call_1", "echo hi"),
		]);
		expect(
			log.events.some(
				(event) =>
					event.type === "warning" && event.message.includes("前缀校验失败"),
			),
		).toBe(true);
		expect(await invalidations()).toMatchObject([
			{ reason: "reasoning_prefix_mismatch", blocks: [{ index: 0 }] },
		]);
	});

	test("重试之后仍然不符就结束 task", async () => {
		await open(mismatch(2));
		expect(await run("go")).toBe("failed");
		const ended = await log.waitFor("task.ended");
		expect(ended.error).toContain("reasoning_prefix_mismatch");
	});
});

test("流中途出错：已收到的部分作废，重试的请求里没有它", async () => {
	await open((_request, call) =>
		call === 0
			? {
					content: [{ type: "text", text: "half" }],
					error: { category: "rate_limit", message: "slow", retry_after_ms: 0 },
				}
			: { content: [{ type: "text", text: "done" }] },
	);
	expect(await run("go")).toBe("completed");
	// 系统指令、会话开始的上下文消息、输入
	expect(requests[1]?.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
	]);
	expect(await invalidations()).toMatchObject([
		{ reason: "stream_error", blocks: [{ index: 0 }] },
	]);
});
