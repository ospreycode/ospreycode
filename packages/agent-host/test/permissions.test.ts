import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ApprovalRequestedEvent,
	createHost,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
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
/** 工作区之外的一个目录。 */
let outside: string;
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	answer = undefined;
	outside = join(dirs.home, "outside");
	mkdirSync(outside);
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

function call(name: string, args: object): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: `call_${crypto.randomUUID()}`,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };

/** 打开 session：模型依次给出 `turns` 里的回复，用完之后回复一句话。 */
async function open(
	turns: ScriptedTurn[],
	options: Partial<SessionOptions> = {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((_request, index) => turns[index] ?? done),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: (event) => {
			log.push(event);
			if (event.type === "approval.requested" && answer !== undefined) {
				session?.respond(event.request_id, answer(event));
			}
		},
	});
	return session;
}

async function runTask(input: string) {
	if (session === undefined) throw new Error("session 还没有打开");
	const taskId = await session.submit(input);
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

function results(): ToolResult[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result] : [],
	);
}

function asked(): ApprovalRequestedEvent[] {
	return log.events.filter((event) => event.type === "approval.requested");
}

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

test("没有沙盒时没有可申请的权限：直接告诉模型不需要", async () => {
	await open([
		call("request_permissions", { file_system: { write: [outside] } }),
	]);
	await runTask("申请权限");

	expect(results()).toMatchObject([{ status: "succeeded" }]);
	expect(output(results()[0])).toContain("no permission is needed");
	expect(asked()).toEqual([]);
});

test("申请写得不对时不询问：什么都没申请、相对路径、不存在的路径、还不支持的域名", async () => {
	await open([
		call("request_permissions", { justification: "just in case" }),
		call("request_permissions", { file_system: { read: ["relative/dir"] } }),
		call("request_permissions", {
			file_system: { write: [join(outside, "missing")] },
		}),
		call("request_permissions", { network: ["registry.npmjs.org"] }),
		call("request_permissions", { file_system: { delete: [outside] } }),
	]);
	await runTask("申请权限");

	expect(results().map((result) => result.status)).toEqual(
		Array.from({ length: 5 }, () => "failed"),
	);
	expect(results().map(output)).toEqual([
		expect.stringContaining("Nothing was requested"),
		"Paths must be absolute: relative/dir",
		`${join(outside, "missing")} does not exist.`,
		expect.stringContaining("Network access cannot be granted"),
		expect.stringContaining("Invalid arguments: /file_system"),
	]);
	expect(asked()).toEqual([]);
});

describe.runIf(process.platform === "darwin")(
	"沙盒模式下（macOS 真实沙盒，脚本模型）",
	() => {
		const sandboxed = {
			sandboxMode: "workspace-write",
			approvalPolicy: "on-request",
		} as const;
		const writeFromShell = (file: string) =>
			call("shell", { command: `echo shell > '${join(outside, file)}'` });

		test("批下来的目录在本任务内有效：之后的命令不用再申请，落在里面的编辑不再询问；下一个任务没有", async () => {
			answer = () => ({ decision: "approve", scope: "task" });
			await open(
				[
					call("request_permissions", {
						file_system: { write: [outside] },
						justification: "The build writes its output there.",
					}),
					writeFromShell("from-shell.txt"),
					call("write", {
						path: join(outside, "from-tool.txt"),
						content: "tool\n",
					}),
					done,
					writeFromShell("next-task.txt"),
				],
				sandboxed,
			);
			expect(await runTask("第一个任务")).toMatchObject({
				outcome: "completed",
			});

			expect(asked()).toMatchObject([
				{
					kind: "tool_call",
					request: {
						kind: "permissions",
						file_system: { write: [outside] },
						justification: "The build writes its output there.",
					},
					reasons: [`申请在本任务内写入 ${outside}`],
				},
			]);
			expect(results().map((result) => result.status)).toEqual([
				"succeeded",
				"succeeded",
				"succeeded",
			]);
			expect(output(results()[0])).toContain(`- write: ${outside}`);
			expect(readFileSync(join(outside, "from-shell.txt"), "utf8")).toBe(
				"shell\n",
			);
			expect(readFileSync(join(outside, "from-tool.txt"), "utf8")).toBe(
				"tool\n",
			);
			// 命令的结果写明它的沙盒多了哪个可写路径
			expect(results()[1]).toMatchObject({
				shell: {
					sandbox: { writable_roots: expect.arrayContaining([outside]) },
				},
			});

			await runTask("第二个任务");
			expect(results()[3]?.status).toBe("failed");
			expect(existsSync(join(outside, "next-task.txt"))).toBe(false);
			expect(asked()).toHaveLength(1);
		});

		test("用户只批准一部分：没批的路径照样受沙盒限制", async () => {
			const secrets = join(dirs.home, ".ssh");
			mkdirSync(secrets);
			writeFileSync(join(secrets, "key"), "key-material");
			answer = () => ({
				decision: "approve",
				scope: "task",
				granted: { file_system: { write: [outside] } },
			});
			await open(
				[
					call("request_permissions", {
						file_system: { read: [secrets], write: [outside] },
					}),
					writeFromShell("allowed.txt"),
					call("shell", { command: `cat '${join(secrets, "key")}'` }),
				],
				sandboxed,
			);
			await runTask("申请两项");

			expect(results().map((result) => result.status)).toEqual([
				"succeeded",
				"succeeded",
				"failed",
			]);
			expect(output(results()[0])).toContain(
				`Not granted:\n- read: ${secrets}`,
			);
			expect(existsSync(join(outside, "allowed.txt"))).toBe(true);
			expect(output(results()[2])).not.toContain("key-material");
		});

		test("批准的读取路径放开沙盒本来不让读的位置", async () => {
			const secrets = join(dirs.home, ".ssh");
			mkdirSync(secrets);
			writeFileSync(join(secrets, "known_hosts"), "github.com ssh-ed25519");
			answer = () => ({ decision: "approve", scope: "task" });
			const read = call("shell", {
				command: `cat '${join(secrets, "known_hosts")}'`,
			});
			await open(
				[
					read,
					call("request_permissions", {
						file_system: { read: [join(secrets, "known_hosts")] },
					}),
					read,
				],
				sandboxed,
			);
			await runTask("读 known_hosts");

			expect(results().map((result) => result.status)).toEqual([
				"failed",
				"succeeded",
				"succeeded",
			]);
			expect(output(results()[2])).toContain("github.com ssh-ed25519");
		});

		test("用户拒绝时什么都不批；审批策略为 never 时不询问直接拒绝", async () => {
			answer = () => ({ decision: "deny", scope: "once" });
			await open(
				[
					call("request_permissions", { file_system: { write: [outside] } }),
					writeFromShell("denied.txt"),
				],
				sandboxed,
			);
			await runTask("被拒绝");
			expect(results()).toMatchObject([
				{ status: "denied", reason: "user" },
				{ status: "failed" },
			]);
			expect(existsSync(join(outside, "denied.txt"))).toBe(false);
			await session?.close();

			log = new EventLog();
			await open(
				[call("request_permissions", { file_system: { write: [outside] } })],
				{ sandboxMode: "workspace-write", approvalPolicy: "never" },
			);
			await runTask("不询问");
			expect(results()).toMatchObject([{ status: "denied", reason: "policy" }]);
			expect(asked()).toEqual([]);
		});

		test("Host 根目录和包含它的目录不能申请", async () => {
			await open(
				[
					call("request_permissions", { file_system: { read: [dirs.root] } }),
					call("request_permissions", { file_system: { write: [dirs.home] } }),
				],
				sandboxed,
			);
			await runTask("申请 Host 根目录");

			expect(results()).toMatchObject([
				{ status: "denied", reason: "forbidden_rule" },
				{ status: "denied", reason: "forbidden_rule" },
			]);
			expect(asked()).toEqual([]);
		});

		test("回答里批准的超出了申请的范围是前端的错误", async () => {
			const current = await open(
				[call("request_permissions", { file_system: { write: [outside] } })],
				sandboxed,
			);
			await current.submit("申请权限");
			const question = await log.waitFor("approval.requested");

			expect(() =>
				current.respond(question.request_id, {
					decision: "approve",
					scope: "task",
					granted: { file_system: { write: [dirs.home] } },
				}),
			).toThrow("超出了申请的范围");
			// 询问还在，可以再回答
			expect(
				current.respond(question.request_id, {
					decision: "deny",
					scope: "once",
				}),
			).toBe(true);
			await log.waitFor("task.ended");
		});
	},
);
