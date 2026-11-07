import { createHost, type Session } from "@ospreycode/agent-host";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
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
	log = new EventLog();
	requests = [];
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

/** 上下文只有 8,000 token、最多输出 7,900 的模型：请求稍长一点，剩余的上下文就比最大输出少。 */
async function open(): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request) => {
			requests.push(request);
			return { content: [{ type: "text", text: "ok" }] };
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "small",
		models: {
			small: { ...testModel, context_window: 8_000, max_output_tokens: 7_900 },
		},
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

test("max_tokens 取最大输出长度和剩余的上下文中较小的一个", async () => {
	const current = await open();
	const taskId = await current.submit("hi");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });
	const [request] = requests;
	expect(request?.max_tokens).toBeLessThan(7_900);
	expect(request?.max_tokens).toBeGreaterThan(0);
});

test("估算超过上下文的 90% 时明确报错停止，不发出请求", async () => {
	const current = await open();
	const taskId = await current.submit("x".repeat(20_000));
	const ended = await log.waitFor("task.ended", (e) => e.task_id === taskId);
	expect(ended).toMatchObject({ outcome: "failed" });
	expect(ended.error).toContain("上下文快到模型的上限了");
	expect(requests).toEqual([]);
});
