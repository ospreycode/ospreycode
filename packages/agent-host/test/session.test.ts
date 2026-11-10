import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentStartError,
	ConfigError,
	CredentialError,
	createHost,
	type HostOptions,
	SandboxUnavailableError,
	type Session,
	type SessionOptions,
	WorkspaceError,
} from "@ospreycode/agent-host";
import { type Script, scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let logs: EventLog[];

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	logs = [];
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	for (const log of logs) expect(log.invalid).toEqual([]);
});

async function open(
	log: EventLog,
	host: Partial<HostOptions> & { script?: Script } = {},
	options: Partial<SessionOptions> = {},
): Promise<Session> {
	const { script, ...hostOptions } = host;
	logs.push(log);
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		...(script === undefined ? {} : { streamModel: scriptedModel(script) }),
		...hostOptions,
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: log.push,
	});
	return session;
}

async function waitUntil(condition: () => boolean): Promise<void> {
	while (!condition()) await new Promise((resolve) => setTimeout(resolve, 20));
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
			"process.started",
			"run.started",
			"task.started",
			"message.completed",
			"task.ended",
			"run.started",
			"task.started",
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

test("命令先关掉输出、过一会儿才退出：Host 照样拿到结果（脚本模型）", async () => {
	const log = new EventLog();
	const current = await open(log, {
		script: (_request, call) =>
			call === 0
				? {
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "shell",
								arguments: JSON.stringify({
									command: "exec >&- 2>&-; sleep 0.2",
								}),
							},
						],
					}
				: { content: [{ type: "text", text: "完成" }] },
	});
	await current.submit("运行命令");
	expect(await log.waitFor("task.ended")).toMatchObject({
		outcome: "completed",
	});
	expect(await log.waitFor("tool_call.completed")).toMatchObject({
		result: { status: "succeeded" },
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

	test("发来不合规的消息时结束 agent 进程，run 记 failed，session 保留", async () => {
		const log = new EventLog();
		const current = await open(log, {
			agentEntry: fixture("garbage-agent.mjs"),
			script: () => ({ content: [] }),
		});
		await current.submit("你好");
		expect(await log.waitFor("task.ended")).toMatchObject({
			outcome: "failed",
		});
		expect((await log.waitFor("error")).message).toContain("JSON");
		await log.waitFor("process.exited");
		// 连续三次才关闭 session（见 restart.test.ts）：一次之后下一个输入会重启 agent 进程
		expect(log.types()).not.toContain("session.ended");
	});
});

describe("打开 session 之前的检查", () => {
	test("模型不在清单里、缺少凭据来源、凭据文件权限过宽", async () => {
		const host = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
		});
		const base = {
			workspace: dirs.workspace,
			model: "scripted",
			models: { scripted: testModel },
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
		).rejects.toThrow(/没有模型服务 test 的凭据来源/);
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
				model: "scripted",
				models: { scripted: testModel },
				credentials: { test: { file: dirs.credentialFile } },
				sandboxMode: "danger-full-access",
				approvalPolicy: "never",
				onEvent: () => {},
			}),
		).rejects.toBeInstanceOf(WorkspaceError);
	});
});

describe.runIf(process.platform === "darwin")(
	"沙盒里的 session（macOS 真实沙盒）",
	() => {
		test("agent 进程在离线沙盒里完成握手；命令在命令沙盒里运行，写得了工作区、写不了主目录；运行中取消（脚本模型）", async () => {
			const log = new EventLog();
			const command = `echo hi > inside.txt; echo x > "$HOME/escape.txt"; sleep 30`;
			const current = await open(
				log,
				{
					script: () => ({
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "shell",
								arguments: JSON.stringify({ command }),
							},
						],
					}),
				},
				{ sandboxMode: "workspace-write", approvalPolicy: "on-request" },
			);
			expect(await log.waitFor("session.started")).toMatchObject({
				sandbox_mode: "workspace-write",
			});
			await current.submit("写一个文件");
			await log.waitFor("tool_call.started");
			await waitUntil(() => existsSync(join(dirs.workspace, "inside.txt")));
			await current.cancel();
			expect(await log.waitFor("task.ended")).toMatchObject({
				outcome: "cancelled",
			});
			expect(existsSync(join(dirs.home, "escape.txt"))).toBe(false);
		});
	},
);

// macOS 和 Linux 都有沙盒后端
const noBackend = process.platform !== "darwin" && process.platform !== "linux";
describe.runIf(noBackend)("没有沙盒后端的平台", () => {
	test("沙盒模式报告不支持，不降级运行", async () => {
		await expect(
			open(new EventLog(), {}, { sandboxMode: "workspace-write" }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
	});
});
