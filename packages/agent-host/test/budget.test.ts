import {
	type BudgetOptions,
	ConfigError,
	createHost,
	type HostEvent,
	type Session,
} from "@ospreycode/agent-host";
import { type Script, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalPolicy } from "@ospreycode/sandbox";
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
let calls: number;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	calls = 0;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

/** 每次都调用 shell 的模型：不加上限就不会停。 */
const busy: Script = () => ({
	content: [
		{
			type: "tool_call",
			call_id: `call_${crypto.randomUUID()}`,
			name: "shell",
			arguments: JSON.stringify({ command: "true" }),
		},
	],
	usage: { input: 10, output: 10, cost_usd: 1 },
});

async function open(
	budget: BudgetOptions,
	approvalPolicy: ApprovalPolicy,
	script: Script = busy,
	onEvent: (event: HostEvent) => void = () => {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			calls += 1;
			return script(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy,
		budget,
		onEvent: (event) => {
			log.push(event);
			onEvent(event);
		},
	});
	return session;
}

async function run(input: string) {
	if (session === undefined) throw new Error("session 还没有打开");
	const taskId = await session.submit(input);
	return log.waitFor("task.ended", (e) => e.task_id === taskId);
}

test("非交互模式超出请求次数上限时直接停止，task.ended 写明超出的是哪一项", async () => {
	await open({ maxRequests: 2 }, "never");
	expect(await run("loop")).toMatchObject({
		outcome: "budget_exceeded",
		limit: "requests",
	});
	expect(calls).toBe(2);
	expect(log.types()).not.toContain("approval.requested");
});

test("交互模式超出时询问是否追加一份额度：批准就接着做，拒绝就停止", async () => {
	// 第一次询问时批准（上限变成 2 次），第二次拒绝
	await open({ maxRequests: 1 }, "on-request", busy, (event) => {
		if (event.type === "approval.requested" && event.kind === "budget") {
			session?.respond(event.request_id, {
				decision: event.max === 1 ? "approve" : "deny",
				scope: "once",
			});
		}
	});
	expect(await run("loop")).toMatchObject({
		outcome: "budget_exceeded",
		limit: "requests",
	});
	expect(calls).toBe(2);
	expect(
		log.events.flatMap((event) =>
			event.type === "approval.requested" && event.kind === "budget"
				? [[event.limit, event.max, event.used]]
				: [],
		),
	).toEqual([
		["requests", 1, 1],
		["requests", 2, 2],
	]);
	const decided = log.events.flatMap((event) =>
		event.type === "approval.decided" ? [event.decision] : [],
	);
	expect(decided).toEqual(["approved", "denied"]);
});

test("费用累计到了上限就不再发请求", async () => {
	// 每次请求 1 美元
	await open({ maxCostUsd: 1.5 }, "never");
	const ended = await run("loop");
	expect(ended).toMatchObject({ outcome: "budget_exceeded", limit: "cost" });
	expect(ended.usage.cost_usd).toBeCloseTo(2);
	expect(calls).toBe(2);
});

test("非交互运行的时间上限到时直接停止，不等下一次模型请求", async () => {
	await open({ maxDurationMs: 300 }, "never", () => ({
		content: [{ type: "text", text: "thinking..." }],
		hang: true,
	}));
	expect(await run("wait")).toMatchObject({
		outcome: "budget_exceeded",
		limit: "duration",
	});
});

test("启用费用上限而模型没有价格时不打开 session；关闭费用上限就可以", async () => {
	const { price: _, ...unpriced } = testModel;
	const host = createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel(busy),
	});
	const options = {
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: unpriced },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access" as const,
		approvalPolicy: "never" as const,
		onEvent: log.push,
	};
	await expect(host.openSession(options)).rejects.toThrow(ConfigError);
	session = await host.openSession({
		...options,
		budget: { maxCostUsd: null },
	});
	expect(session.id).toEqual(expect.any(String));
});
