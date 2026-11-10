import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHost,
	type HostOptions,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { Message } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
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
/** 模型每次请求收到的消息。 */
let requests: Message[][];

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
		onEvent: log.push,
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

test("系统指令和工具声明里有四个默认启用的工具", async () => {
	await open([]);
	await runTask("你好");
	const [system] = requests[0] ?? [];
	const text = system?.role === "system" ? system.content[0]?.text : undefined;
	for (const name of ["read", "edit", "write", "shell"]) {
		expect(text).toContain(`- ${name}: `);
	}
});

describe.runIf(process.platform === "darwin")(
	"沙盒里的文件工具（macOS 真实沙盒，脚本模型）",
	() => {
		test("workspace-write 下能写工作区，写不了工作区之外", async () => {
			const outsideFile = join(dirs.home, "escape.txt");
			await open(
				[
					call("write", { path: "inside.txt", content: "in" }),
					call("write", { path: outsideFile, content: "out" }),
				],
				{ sandboxMode: "workspace-write", approvalPolicy: "on-request" },
			);
			expect(await runTask("写两个文件")).toMatchObject({
				outcome: "completed",
			});

			expect(readFileSync(join(dirs.workspace, "inside.txt"), "utf8")).toBe(
				"in",
			);
			expect(existsSync(outsideFile)).toBe(false);
			expect(results().map((result) => result.status)).toEqual([
				"succeeded",
				"failed",
			]);
			expect(output(results()[1])).toContain("outside the writable roots");
		});

		test("read-only 下读得了工作区，写不了", async () => {
			writeFileSync(join(dirs.workspace, "notes.txt"), "keep");
			await open(
				[
					call("read", { path: "notes.txt" }),
					call("write", { path: "notes.txt", content: "changed" }),
				],
				{ sandboxMode: "read-only", approvalPolicy: "on-request" },
			);
			expect(await runTask("读了再改")).toMatchObject({
				outcome: "completed",
			});

			expect(results().map((result) => result.status)).toEqual([
				"succeeded",
				"failed",
			]);
			expect(readFileSync(join(dirs.workspace, "notes.txt"), "utf8")).toBe(
				"keep",
			);
		});
	},
);

describe("登记之后没有提交结果的文件改动（假的 agent 进程）", () => {
	const agentEntry = fileURLToPath(
		new URL("./fixtures/unfinished-edit-agent.mjs", import.meta.url),
	);

	test("task 结束时 Host 按登记的哈希核对磁盘：新内容记成功，旧内容记失败，都不是记结果不确定", async () => {
		const file = join(dirs.workspace, "target.txt");
		const edit = {
			path: file,
			old_sha256: sha256("old"),
			new_sha256: sha256("new"),
		};
		await open([], {}, { agentEntry });

		for (const content of ["new", "old", "something else"]) {
			writeFileSync(file, content);
			expect(await runTask(JSON.stringify(edit))).toMatchObject({
				outcome: "completed",
			});
		}
		// 登记的是新建文件、文件到 task 结束时还不存在：没有改动
		await runTask(
			JSON.stringify({
				path: join(dirs.workspace, "never-created.txt"),
				old_sha256: null,
				new_sha256: sha256("new"),
			}),
		);
		// 路径上是目录，不是普通文件
		mkdirSync(join(dirs.workspace, "dir"));
		await runTask(
			JSON.stringify({ ...edit, path: join(dirs.workspace, "dir") }),
		);

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

	test("改动落在可写根之外时不允许执行", async () => {
		await open(
			[],
			{ sandboxMode: "workspace-write", approvalPolicy: "on-request" },
			{ agentEntry },
		);
		await runTask(
			JSON.stringify({
				path: join(dirs.home, "escape.txt"),
				old_sha256: null,
				new_sha256: sha256("x"),
			}),
		);

		expect(results()).toHaveLength(1);
		expect(results()[0]?.status).toBe("failed");
		expect(output(results()[0])).toContain("outside the writable roots");
	});

	test("登记的路径不是规范化的绝对路径时按协议错误处理：结束 agent 进程，session 以 error 关闭", async () => {
		const current = await open([], {}, { agentEntry });
		await current.submit(
			JSON.stringify({
				path: "relative.txt",
				old_sha256: null,
				new_sha256: sha256("x"),
			}),
		);

		expect((await log.waitFor("session.ended")).reason).toBe("error");
		expect((await log.waitFor("error")).message).toContain("规范化的绝对路径");
		await current.ended;
	});
});
