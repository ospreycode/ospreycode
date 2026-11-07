import { fileURLToPath } from "node:url";
import {
	AgentStartError,
	ConfigError,
	CredentialError,
	createHost,
	type HostOptions,
	type Session,
	WorkspaceError,
} from "@ospreycode/agent-host";
import { type Script, scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	scriptedEntry,
	type TestDirectories,
	testDirectories,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

async function open(
	log: EventLog,
	host: Partial<HostOptions> & { script?: Script } = {},
): Promise<Session> {
	const { script, ...options } = host;
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		...(script === undefined ? {} : { streamModel: scriptedModel(script) }),
		...options,
	}).openSession({
		workspace: dirs.workspace,
		model: scriptedEntry.id,
		models: [scriptedEntry],
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

describe("在指定时刻取消（脚本模型）", () => {
	test("模型回复中途取消：task 以 cancelled 结束，session 还能开始下一个 task", async () => {
		const log = new EventLog();
		const current = await open(log, {
			script: (_request, call) =>
				call === 0
					? { content: [{ type: "text", text: "写到一半" }], hang: true }
					: { content: [{ type: "text", text: "完成" }] },
		});
		const first = await current.submit("写一首长诗");
		await log.waitFor("model.delta");
		await current.cancel();
		expect(
			await log.waitFor("task.ended", (e) => e.task_id === first),
		).toMatchObject({
			outcome: "cancelled",
		});

		const second = await current.submit("说完成");
		expect(
			await log.waitFor("task.ended", (e) => e.task_id === second),
		).toMatchObject({
			outcome: "completed",
		});
		expect(log.types().filter((type) => type !== "model.delta")).toEqual([
			"session.started",
			"task.started",
			"run.started",
			"message.completed",
			"task.ended",
			"task.started",
			"run.started",
			"message.completed",
			"task.ended",
		]);
	});

	test("命令运行中取消：结束命令的进程组，工具调用记 cancelled", async () => {
		const log = new EventLog();
		const current = await open(log, {
			script: () => ({
				content: [
					{
						type: "tool_call",
						call_id: "call_1",
						name: "shell",
						arguments: JSON.stringify({ command: "sleep 30" }),
					},
				],
			}),
		});
		const started = Date.now();
		await current.submit("等一会");
		await log.waitFor("tool_call.started");
		await current.cancel();
		expect(await log.waitFor("task.ended")).toMatchObject({
			outcome: "cancelled",
		});
		expect(await log.waitFor("tool_call.completed")).toMatchObject({
			result: { status: "cancelled" },
		});
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});

test("模型服务报错（脚本模型）：task 以 failed 结束并写明错误类别", async () => {
	const log = new EventLog();
	const current = await open(log, {
		script: () => ({
			content: [],
			error: { category: "authentication", message: "invalid x-api-key" },
		}),
	});
	await current.submit("你好");
	const ended = await log.waitFor("task.ended");
	expect(ended.outcome).toBe("failed");
	expect(ended.error).toContain("authentication");
});

describe("agent 进程", () => {
	test("版本和 Host 依赖的 agent-runtime 不同时拒绝打开 session", async () => {
		const log = new EventLog();
		const opening = open(log, { agentEntry: fixture("old-version-agent.mjs") });
		await expect(opening).rejects.toBeInstanceOf(AgentStartError);
		await expect(opening).rejects.toThrow(/0\.0\.0-old/);
		expect(log.events).toEqual([]);
	});

	test("发来不合规的消息时结束 agent 进程，run 记 failed，session 以 error 关闭", async () => {
		const log = new EventLog();
		const current = await open(log, {
			agentEntry: fixture("garbage-agent.mjs"),
			script: () => ({ content: [] }),
		});
		await current.submit("你好");
		const ended = await log.waitFor("session.ended");
		expect(ended.reason).toBe("error");
		expect(await log.waitFor("task.ended")).toMatchObject({
			outcome: "failed",
		});
		expect((await log.waitFor("error")).message).toContain("JSON");
		await current.ended;
	});
});

describe("打开 session 之前的检查", () => {
	test("模型不在清单里、缺少凭据来源、凭据文件权限过宽", async () => {
		const host = createHost({ root: dirs.root, env: dirs.env });
		const base = {
			workspace: dirs.workspace,
			model: scriptedEntry.id,
			models: [scriptedEntry],
			credentials: { test: { file: dirs.credentialFile } },
			sandboxMode: "danger-full-access",
			approvalPolicy: "never",
			onEvent: () => {},
		} as const;
		await expect(
			host.openSession({ ...base, model: "missing" }),
		).rejects.toBeInstanceOf(ConfigError);
		await expect(
			host.openSession({ ...base, credentials: {} }),
		).rejects.toBeInstanceOf(ConfigError);
		await expect(
			host.openSession({
				...base,
				credentials: { test: { file: dirs.workspace } },
			}),
		).rejects.toBeInstanceOf(CredentialError);
	});

	test("Host 根目录和工作区互相包含时报错", async () => {
		const host = createHost({ root: dirs.root, env: dirs.env });
		await expect(
			host.openSession({
				workspace: dirs.home,
				model: scriptedEntry.id,
				models: [scriptedEntry],
				credentials: { test: { file: dirs.credentialFile } },
				sandboxMode: "danger-full-access",
				approvalPolicy: "never",
				onEvent: () => {},
			}),
		).rejects.toBeInstanceOf(WorkspaceError);
	});
});
