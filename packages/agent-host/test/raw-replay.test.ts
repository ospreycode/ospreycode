import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type ProtocolRaw,
	type Session,
} from "@ospreycode/agent-host";
import { SessionStore } from "@ospreycode/session-store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;

beforeEach(() => {
	dirs = testDirectories();
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

/** 录制的真实流：模型调用 shell，参数原文是 `{"command": "echo hi"}`（冒号后有空格）。 */
const toolUse = readFileSync(
	new URL("../../api/test/fixtures/anthropic-tool-use.sse", import.meta.url),
);

function textReply(text: string): string {
	const events = [
		[
			"message_start",
			{
				message: {
					model: "scripted",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		],
		[
			"content_block_start",
			{ index: 0, content_block: { type: "text", text: "" } },
		],
		["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { index: 0 }],
		[
			"message_delta",
			{ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		],
		["message_stop", {}],
	] as const;
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
}

test("消息在目标协议里的原文第一次发出时记进 session 记录，之后的请求原样拼接", async () => {
	const bodies: string[] = [];
	const log = new EventLog();
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		fetch: async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response(bodies.length === 1 ? toolUse : textReply("done"));
		},
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	const started = await log.waitFor("session.started");
	await session.submit("run it");
	await log.waitFor("task.ended");
	const second = await session.submit("again");
	await log.waitFor("task.ended", (event) => event.task_id === second);
	await session.close();

	expect(bodies).toHaveLength(3);
	// 工具参数按流里拼出的原文带回，不经 JSON 往返；之后的请求逐字节相同
	const call =
		'{"type":"tool_use","id":"toolu_01htIuHzXbcC0mn1LMZQBF66","name":"shell","input":{"command": "echo hi"}}';
	expect(bodies[1]).toContain(call);
	expect(bodies[2]).toContain(call);

	const store = SessionStore.open(
		join(dirs.root, "data", "projects", started.project_id, "sessions.sqlite"),
	);
	try {
		const raws = store
			.events(session.id)
			.filter((event) => event.type === "protocol.raw")
			.map((event) => event.data as ProtocolRaw);
		// 第一次请求：系统指令、会话开始的上下文消息、输入、工具声明
		expect(raws.map((raw) => raw.part)).toEqual([
			"system",
			"message",
			"message",
			"tools",
			"message",
			"message",
			"message",
			"message",
		]);
		// 每一部分只记一次：系统指令和消息各有自己的 message_id，工具声明没有
		expect(new Set(raws.map((raw) => raw.message_id)).size).toBe(raws.length);
		for (const raw of raws) {
			expect(raw).toMatchObject({
				protocol: "anthropic.messages",
				service: "test",
				api_version: "2026-10-21",
			});
			for (const piece of raw.pieces) {
				expect(bodies[2]).toContain(piece.slice(0, -1));
			}
		}
	} finally {
		store.close();
	}
});
