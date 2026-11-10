import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ApprovalRequestedEvent,
	createHost,
	type HostOptions,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { Message } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

const onMac = process.platform === "darwin";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 模型每次请求收到的消息。 */
let requests: Message[][];
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	requests = [];
	answer = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function call(name: string, args: object, id = "call_1"): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: id,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

/** 打开 session：模型依次给出 `turns` 里的回复，之后回复一句话结束。 */
async function open(
	turns: ScriptedTurn[],
	options: Partial<SessionOptions> = {},
	host: Partial<HostOptions> = {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, index) => {
			requests.push(request.messages);
			return turns[index] ?? { content: [{ type: "text", text: "done" }] };
		}),
		...host,
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

/** 这个 session 里工具调用的结果，按完成的顺序。 */
function results(): ToolResult[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result] : [],
	);
}

/** 这个 session 里的询问。 */
function asked(): ApprovalRequestedEvent[] {
	return log.events.filter((event) => event.type === "approval.requested");
}

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

test("模型用 write、edit 和 read 改工作区里的文件，调用由 runtime 执行、Host 记录（脚本模型）", async () => {
	const file = join(dirs.workspace, "src/greeting.txt");
	await open([
		call("write", { path: "src/greeting.txt", content: "hello\nworld\n" }),
		call("edit", {
			path: "src/greeting.txt",
			edits: [{ old_text: "world", new_text: "osprey" }],
		}),
		call("read", { path: "src/greeting.txt" }),
	]);
	expect(await runTask("改文件")).toMatchObject({ outcome: "completed" });

	expect(readFileSync(file, "utf8")).toBe("hello\nosprey\n");
	expect(
		log.events.flatMap((event) =>
			event.type === "tool_call.started" ? [[event.name, event.executor]] : [],
		),
	).toEqual([
		["write", "runtime"],
		["edit", "runtime"],
		["read", "runtime"],
	]);
	expect(results().map((result) => result.status)).toEqual([
		"succeeded",
		"succeeded",
		"succeeded",
	]);
	// 读到的内容作为工具结果交回模型
	expect(requests.at(-1)?.at(-1)).toMatchObject({
		role: "tool_result",
		is_error: false,
		content: [{ type: "text", text: "hello\nosprey" }],
	});
});

test("系统指令里有五个默认启用的工具", async () => {
	await open([]);
	await runTask("你好");
	const [system] = requests[0] ?? [];
	const text = system?.role === "system" ? system.content[0]?.text : undefined;
	for (const name of [
		"read",
		"edit",
		"write",
		"shell",
		"request_permissions",
	]) {
		expect(text).toContain(`- ${name}: `);
	}
});

describe.runIf(onMac)("沙盒里的文件工具（macOS 真实沙盒，脚本模型）", () => {
	const sandboxed = {
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
	} as const;

	test("工作区里的改动直接写；工作区之外的改动经用户批准后由 apply-edits 写入，选了本任务内允许的文件不再问", async () => {
		const outsideFile = join(dirs.home, "outside.txt");
		const edit = (oldText: string, newText: string) =>
			call("edit", {
				path: outsideFile,
				edits: [{ old_text: oldText, new_text: newText }],
			});
		// 第一次只批准这一次，第二次选本任务内允许
		answer = () => ({
			decision: "approve",
			scope: asked().length === 1 ? "once" : "task",
		});
		await open(
			[
				call("write", { path: "inside.txt", content: "in" }),
				call("write", { path: outsideFile, content: "one\n" }),
				edit("one", "two"),
				edit("two", "three"),
			],
			sandboxed,
		);
		expect(await runTask("写几个文件")).toMatchObject({
			outcome: "completed",
		});

		expect(readFileSync(join(dirs.workspace, "inside.txt"), "utf8")).toBe("in");
		expect(readFileSync(outsideFile, "utf8")).toBe("three\n");
		expect(results().map((result) => result.status)).toEqual(
			Array.from({ length: 4 }, () => "succeeded"),
		);
		expect(
			log.events.flatMap((event) =>
				event.type === "tool_call.started" ? [event.executor] : [],
			),
		).toEqual(["runtime", "host", "host", "host"]);
		// 询问里是将要写入的内容和改动前内容的哈希
		expect(asked()).toMatchObject([
			{
				kind: "tool_call",
				request: {
					kind: "file_edits",
					edits: [
						{
							op: "add",
							path: outsideFile,
							old_sha256: null,
							content: "one\n",
						},
					],
				},
				reasons: [`申请新建 ${outsideFile}`],
			},
			{
				kind: "tool_call",
				request: {
					kind: "file_edits",
					edits: [
						{
							op: "update",
							path: outsideFile,
							old_sha256: sha256("one\n"),
							content: "two\n",
						},
					],
				},
				reasons: [`申请修改 ${outsideFile}`],
			},
		]);
	});

	test("用户拒绝的改动不写，拒绝时说的话交回模型", async () => {
		const outsideFile = join(dirs.home, "outside.txt");
		answer = () => ({
			decision: "deny",
			scope: "once",
			message: "Keep it in the workspace.",
		});
		await open([call("write", { path: outsideFile, content: "x" })], sandboxed);
		await runTask("写到外面");

		expect(existsSync(outsideFile)).toBe(false);
		expect(results()).toMatchObject([
			{
				status: "denied",
				reason: "user",
				message: "Keep it in the workspace.",
			},
		]);
		expect(requests.at(-1)?.at(-1)).toMatchObject({
			role: "tool_result",
			is_error: true,
		});
	});

	test("审批策略为 never 时工作区之外的改动直接拒绝，不询问", async () => {
		const outsideFile = join(dirs.home, "outside.txt");
		await open([call("write", { path: outsideFile, content: "x" })], {
			sandboxMode: "workspace-write",
			approvalPolicy: "never",
		});
		await runTask("写到外面");

		expect(existsSync(outsideFile)).toBe(false);
		expect(asked()).toEqual([]);
		expect(results()).toMatchObject([{ status: "denied", reason: "policy" }]);
	});

	test("read-only 下工作区里的改动也要批准", async () => {
		const file = join(dirs.workspace, "notes.txt");
		writeFileSync(file, "keep\n");
		answer = () => ({ decision: "approve", scope: "once" });
		await open(
			[
				call("read", { path: "notes.txt" }),
				call("edit", {
					path: "notes.txt",
					edits: [{ old_text: "keep", new_text: "changed" }],
				}),
			],
			{ sandboxMode: "read-only", approvalPolicy: "on-request" },
		);
		expect(await runTask("读了再改")).toMatchObject({ outcome: "completed" });

		expect(readFileSync(file, "utf8")).toBe("changed\n");
		expect(asked()).toHaveLength(1);
		expect(results().map((result) => result.status)).toEqual([
			"succeeded",
			"succeeded",
		]);
	});
});

describe("有缺陷或被攻破的 runtime（假的 agent 进程）", () => {
	const agentEntry = fileURLToPath(
		new URL("./fixtures/request-agent.mjs", import.meta.url),
	);
	const toolCall = {
		call_id: "call_1",
		message_id: "message_1",
		name: "write",
		arguments: "{}",
	};

	/** 让假的 agent 进程发出一个请求，等这个 task 结束。 */
	function send(method: string, params: object) {
		return runTask(JSON.stringify({ method, params }));
	}

	test("登记了改动、没有提交结果就结束 task：Host 按登记的哈希核对磁盘，新内容记成功，旧内容记失败，都不是记结果不确定", async () => {
		const file = join(dirs.workspace, "target.txt");
		const edit = {
			path: file,
			old_sha256: sha256("old"),
			new_sha256: sha256("new"),
		};
		await open([], {}, { agentEntry });

		for (const content of ["new", "old", "something else"]) {
			writeFileSync(file, content);
			expect(
				await send("tool_call/register", { ...toolCall, edit }),
			).toMatchObject({ outcome: "completed" });
		}
		// 登记的是新建文件、文件到 task 结束时还不存在：没有改动
		await send("tool_call/register", {
			...toolCall,
			edit: {
				path: join(dirs.workspace, "never-created.txt"),
				old_sha256: null,
				new_sha256: sha256("new"),
			},
		});
		// 路径上是目录，不是普通文件
		mkdirSync(join(dirs.workspace, "dir"));
		await send("tool_call/register", {
			...toolCall,
			edit: { ...edit, path: join(dirs.workspace, "dir") },
		});

		expect(results().map((result) => result.status)).toEqual([
			"succeeded",
			"failed",
			"interrupted",
			"failed",
			"interrupted",
		]);
		// 每个 task 的 tool_call.completed 都在它的 task.ended 之前
		expect(
			log
				.types()
				.filter(
					(type) => type === "tool_call.completed" || type === "task.ended",
				),
		).toEqual(
			Array.from({ length: 5 }, () => [
				"tool_call.completed",
				"task.ended",
			]).flat(),
		);
	});

	test("协议错误结束 agent 进程，session 以 error 关闭：登记的路径不是规范化的绝对路径", async () => {
		const current = await open([], {}, { agentEntry });
		await current.submit(
			JSON.stringify({
				method: "tool_call/register",
				params: {
					...toolCall,
					edit: {
						path: "relative.txt",
						old_sha256: null,
						new_sha256: sha256("x"),
					},
				},
			}),
		);

		expect((await log.waitFor("session.ended")).reason).toBe("error");
		expect((await log.waitFor("error")).message).toContain("规范化的绝对路径");
		await current.ended;
	});

	test("协议错误：没有沙盒时申请可写范围之外的文件改动", async () => {
		const current = await open([], {}, { agentEntry });
		await current.submit(
			JSON.stringify({
				method: "tool_call/run",
				params: {
					...toolCall,
					file_edits: [
						{
							op: "add",
							path: join(dirs.home, "outside.txt"),
							old_sha256: null,
							content: "x",
						},
					],
				},
			}),
		);

		expect((await log.waitFor("session.ended")).reason).toBe("error");
		expect((await log.waitFor("error")).message).toContain("没有沙盒时");
		expect(existsSync(join(dirs.home, "outside.txt"))).toBe(false);
		await current.ended;
	});

	// 只有沙盒模式下才有可写根之外的路径，现在只有 macOS 有沙盒后端
	describe.runIf(onMac)("沙盒模式下（macOS 真实沙盒）", () => {
		const sandboxed = {
			sandboxMode: "workspace-write",
			approvalPolicy: "on-request",
		} as const;
		const fileEdits = (
			path: string,
			old: string | null,
			content = "changed",
		) => ({
			...toolCall,
			file_edits: [
				{
					op: old === null ? "add" : "update",
					path,
					old_sha256: old === null ? null : sha256(old),
					content,
				},
			],
		});

		test("登记的改动落在可写根之外时不允许执行", async () => {
			await open([], sandboxed, { agentEntry });
			await send("tool_call/register", {
				...toolCall,
				edit: {
					path: join(dirs.home, "escape.txt"),
					old_sha256: null,
					new_sha256: sha256("x"),
				},
			});

			expect(results()).toHaveLength(1);
			expect(results()[0]?.status).toBe("failed");
			expect(output(results()[0])).toContain("outside the writable roots");
		});

		test("申请的改动在询问之前核对：Host 根目录里的文件不能改，旧内容要对得上，路径不能经过符号链接", async () => {
			const stale = join(dirs.home, "stale.txt");
			writeFileSync(stale, "changed by the user");
			mkdirSync(join(dirs.home, "real"));
			symlinkSync(join(dirs.home, "real"), join(dirs.home, "link"));
			answer = () => ({ decision: "approve", scope: "once" });
			await open([], sandboxed, { agentEntry });

			await send(
				"tool_call/run",
				fileEdits(join(dirs.root, "config.toml"), null),
			);
			await send("tool_call/run", fileEdits(stale, "what the agent read"));
			await send(
				"tool_call/run",
				fileEdits(join(dirs.home, "link/new.txt"), null),
			);
			await send(
				"tool_call/run",
				fileEdits(join(dirs.home, "missing/new.txt"), null),
			);

			expect(asked()).toEqual([]);
			expect(results()).toMatchObject([
				{ status: "denied", reason: "forbidden_rule" },
				{ status: "failed" },
				{ status: "failed" },
				{ status: "failed" },
			]);
			expect(results().slice(1).map(output)).toEqual([
				expect.stringContaining("not what the edit was prepared against"),
				expect.stringContaining(
					`Use the real path ${join(dirs.home, "real/new.txt")}`,
				),
				expect.stringContaining("does not exist"),
			]);
			expect(existsSync(join(dirs.root, "config.toml"))).toBe(false);
			expect(readFileSync(stale, "utf8")).toBe("changed by the user");
			expect(existsSync(join(dirs.home, "real/new.txt"))).toBe(false);
		});

		test("批准之后、写入之前文件又变了：apply-edits 核对不上，不写", async () => {
			const file = join(dirs.home, "racy.txt");
			writeFileSync(file, "old");
			// 用户在批准的同时改了文件
			answer = () => {
				writeFileSync(file, "edited while approving");
				return { decision: "approve", scope: "once" };
			};
			await open([], sandboxed, { agentEntry });
			await send("tool_call/run", fileEdits(file, "old", "new"));

			expect(asked()).toHaveLength(1);
			expect(results()).toMatchObject([{ status: "failed" }]);
			expect(output(results()[0])).toContain("has changed");
			expect(readFileSync(file, "utf8")).toBe("edited while approving");
		});
	});
});
