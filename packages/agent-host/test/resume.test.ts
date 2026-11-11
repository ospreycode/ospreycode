import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHost,
	type Host,
	type HostEvent,
	type Session,
	type SessionOptions,
	SessionResumeError,
	WorkspaceError,
} from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
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
/** 脚本模型收到的每次请求。 */
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

function reply(text: string): ScriptedTurn {
	return { content: [{ type: "text", text }] };
}

function call(name: string, args: object): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: "call_1",
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

function host(script: Script = () => reply("好的")): Host {
	return createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, index) => {
			requests.push(request);
			return script(request, index);
		}),
	});
}

function options(extra: Partial<SessionOptions>): SessionOptions {
	return {
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...extra,
	};
}

/** 换一份事件记录，恢复出来的 session 的事件从头记起。 */
function resume(
	sessionId: string,
	script?: Script,
	extra: Partial<SessionOptions> = {},
): Promise<Session> {
	log = new EventLog();
	return host(script)
		.resumeSession({ ...options(extra), sessionId, onEvent: log.push })
		.then((resumed) => {
			session = resumed;
			return resumed;
		});
}

async function ended(taskId: string) {
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/**
 * 在另一个进程里开一个 Host，开始一个 task，第一次出现 `crashOn` 类型的事件时它被 SIGKILL 结束：
 * 这个事件已经在记录里，之后的都没有发生。返回这个 session 的标识。
 */
async function interrupt(
	turns: ScriptedTurn[],
	crashOn: HostEvent["type"],
	approvalPolicy: "never" | "on-request" = "never",
	followUp?: string,
): Promise<string> {
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(
				new URL("./fixtures/interrupted-host.mjs", import.meta.url),
			),
			dirs.root,
			dirs.workspace,
			dirs.home,
			dirs.credentialFile,
			JSON.stringify({
				turns,
				crashOn,
				input: "开始",
				followUp,
				approvalPolicy,
				sandboxMode: "danger-full-access",
			}),
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	const [, signal] = await once(child, "exit");
	expect(signal).toBe("SIGKILL");
	const sessions = host().listSessions({ directory: dirs.workspace });
	expect(sessions).toHaveLength(1);
	return (sessions[0] as (typeof sessions)[number]).session_id;
}

/** 请求里的工具结果，按顺序。 */
function toolResults(request: ModelRequest | undefined) {
	return (request?.messages ?? []).filter(
		(message) => message.role === "tool_result",
	);
}

function text(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function completed() {
	return log.events.filter((event) => event.type === "tool_call.completed");
}

describe("恢复正常关闭的 session", () => {
	test("接着原来的记录：标识和 agent 不变，模型请求以原来的历史为前缀，session 还是一个", async () => {
		session = await host(() => reply("第一次回答")).openSession({
			...options({}),
			onEvent: log.push,
		});
		const id = session.id;
		const first = await ended(await session.submit("第一个任务"));
		await session.close();

		const resumed = await resume(id, () => reply("第二次回答"));
		expect(resumed.id).toBe(id);
		expect(log.types()[0]).toBe("session.started");
		// 上次正常结束，没有要收尾的 task
		expect(log.types()).not.toContain("task.ended");
		const second = await ended(await resumed.submit("第二个任务"));
		expect(second).toMatchObject({ outcome: "completed" });
		expect(second.agent_id).toBe(first.agent_id);

		const [before, after] = requests as [ModelRequest, ModelRequest];
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);
		expect(after.messages.slice(before.messages.length)).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "第一次回答" }] },
			{ role: "user", content: [{ type: "text", text: "第二个任务" }] },
		]);
		await resumed.close();
		expect(host().listSessions({ directory: dirs.workspace })).toMatchObject([
			{ session_id: id, title: "第一个任务" },
		]);
	});

	test("不存在的、在别的工作区创建的、还开着的 session 不能恢复", async () => {
		// 同一个仓库的两个子目录是同一个项目的两个工作区
		execFileSync("git", ["init", "-q", dirs.workspace]);
		const [one, other] = ["one", "other"].map((name) => {
			const dir = join(dirs.workspace, name);
			mkdirSync(dir);
			return dir;
		}) as [string, string];
		session = await host().openSession({
			...options({ workspace: one }),
			onEvent: log.push,
		});
		const id = session.id;
		const again = (extra: Partial<SessionOptions>, sessionId = id) =>
			host().resumeSession({
				...options(extra),
				sessionId,
				onEvent: () => {},
			});

		await expect(again({ workspace: one })).rejects.toThrow(WorkspaceError);
		await session.close();
		await expect(again({ workspace: other })).rejects.toThrow(/只能在那里恢复/);
		await expect(again({ workspace: other })).rejects.toThrow(WorkspaceError);
		await expect(
			again({ workspace: one }, "0193e2a0-0000-7000-8000-000000000000"),
		).rejects.toThrow(WorkspaceError);
		// 没有恢复成的尝试不留下锁
		session = await again({ workspace: one });
		expect(session.id).toBe(id);
	});
});

describe("恢复中断的 session", () => {
	test("模型回复到一半时中断：task 紧跟在 session.started 之后以 failed 结束，下一个 task 接着原来的历史", async () => {
		const id = await interrupt(
			[{ content: [{ type: "text", text: "写到一半" }], hang: true }],
			"model.delta",
		);

		const resumed = await resume(id, () => reply("接上了"));
		expect(log.types().slice(0, 2)).toEqual(["session.started", "task.ended"]);
		expect(log.events[1]).toMatchObject({
			outcome: "failed",
			error: expect.stringContaining("没有正常关闭"),
		});

		expect(await ended(await resumed.submit("接着做"))).toMatchObject({
			outcome: "completed",
		});
		const messages = requests[0]?.messages ?? [];
		// 中断的那次请求里的输入还在历史里，新的输入排在最后
		const interrupted = messages.findIndex(
			(message) => text(message) === "开始",
		);
		expect(interrupted).toBeGreaterThan(0);
		expect(interrupted).toBeLessThan(messages.length - 1);
		expect(text(messages.at(-1))).toBe("接着做");
	});

	test("排着的 follow-up 原样保留，列表暂停：用户让它继续才开始", async () => {
		const id = await interrupt(
			[{ content: [{ type: "text", text: "写到一半" }], hang: true }],
			"input.queued",
			"never",
			"后面的事",
		);

		const resumed = await resume(id, () => reply("做了"));
		expect(resumed.inputQueue()).toMatchObject({
			follow_up: [{ input: [{ type: "text", text: "后面的事" }] }],
			follow_up_paused: true,
		});
		await resumed.whenIdle();
		expect(log.types()).not.toContain("task.started");

		await resumed.resumeFollowUps();
		const started = await log.waitFor("task.started");
		expect(started).toMatchObject({ source: "follow_up" });
		expect(await ended(started.task_id)).toMatchObject({
			outcome: "completed",
		});
		expect(resumed.inputQueue().follow_up).toEqual([]);
	});

	test("命令登记后中断：never 下恢复失败、记录不动；交互模式下问用户，拒绝后调用记 interrupted，命令不执行", async () => {
		const marker = join(dirs.workspace, "ran.txt");
		const id = await interrupt(
			[call("shell", { command: `echo ran >> ${marker}` })],
			"tool_call.started",
		);
		expect(existsSync(marker)).toBe(false);

		await expect(resume(id)).rejects.toThrow(SessionResumeError);
		expect(log.events).toEqual([]);

		const resumed = await resume(id, () => reply("知道了"), {
			approvalPolicy: "on-request",
		});
		// 问完才收尾：这时 task 还没有结束
		expect(log.types()).toEqual(["session.started", "approval.requested"]);
		const asked = await log.waitFor("approval.requested");
		expect(asked).toMatchObject({
			kind: "resume_uncertain",
			name: "shell",
			arguments: JSON.stringify({ command: `echo ran >> ${marker}` }),
		});
		// 回答之前的输入等着
		const submitted = resumed.submit("刚才怎么了");
		resumed.respond(asked.request_id, { decision: "deny", scope: "once" });
		expect(await ended(await submitted)).toMatchObject({
			outcome: "completed",
		});

		const [skipped] = completed();
		expect(skipped).toMatchObject({
			tool_call_id: asked.kind === "resume_uncertain" && asked.tool_call_id,
			result: { status: "interrupted" },
		});
		const interruptedTask = log.events.find(
			(event) => event.type === "task.ended",
		);
		expect(interruptedTask).toMatchObject({
			task_id: skipped?.task_id,
			outcome: "failed",
		});
		expect(completed()).toHaveLength(1);
		expect(existsSync(marker)).toBe(false);
		// 模型看到这次调用的结果是"不确定有没有生效"，后面才是新的输入
		const messages = requests[0]?.messages ?? [];
		const results = toolResults(requests[0]);
		expect(results).toHaveLength(1);
		expect(text(results[0])).toContain("unknown whether it took effect");
		expect(messages.indexOf(results[0] as Message)).toBeLessThan(
			messages.findIndex((message) => text(message) === "刚才怎么了"),
		);
	});

	test("批准重新执行：下一个 task 开始时先把这次调用执行一遍，只执行一次，结果排在新输入之前", async () => {
		const marker = join(dirs.workspace, "ran.txt");
		const id = await interrupt(
			[call("shell", { command: `echo ran >> ${marker}` })],
			"tool_call.started",
		);

		const resumed = await resume(id, () => reply("做完了"), {
			approvalPolicy: "on-request",
		});
		const asked = await log.waitFor("approval.requested");
		resumed.respond(asked.request_id, { decision: "approve", scope: "once" });
		await log.waitFor("task.ended");
		// 批准之后不马上执行：session 空闲，等用户的下一次输入
		expect(completed()).toEqual([]);
		expect(existsSync(marker)).toBe(false);

		const next = await resumed.submit("接着做");
		expect(await ended(next)).toMatchObject({ outcome: "completed" });
		expect(readFileSync(marker, "utf8")).toBe("ran\n");
		expect(completed()).toMatchObject([
			{ task_id: next, result: { status: "succeeded" } },
		]);
		const messages = requests[0]?.messages ?? [];
		const result = messages.findIndex(
			(message) => message.role === "tool_result",
		);
		expect(toolResults(requests[0])).toHaveLength(1);
		expect(messages[result]).toMatchObject({ call_id: "call_1" });
		expect(result).toBeLessThan(
			messages.findIndex((message) => text(message) === "接着做"),
		);

		// 再恢复一次：这次调用已经有结果，不再问也不再执行
		await resumed.close();
		const again = await resume(id, () => reply("没有别的了"));
		expect(await ended(await again.submit("还有吗"))).toMatchObject({
			outcome: "completed",
		});
		expect(log.types()).not.toContain("approval.requested");
		expect(readFileSync(marker, "utf8")).toBe("ran\n");
	});

	test("有询问没回答就关闭：task 不结束，再恢复时重新问", async () => {
		const id = await interrupt(
			[call("shell", { command: "echo ran" })],
			"tool_call.started",
		);
		const first = await resume(id, undefined, { approvalPolicy: "on-request" });
		await log.waitFor("approval.requested");
		await first.close();
		expect(log.types()).not.toContain("task.ended");

		await resume(id, undefined, { approvalPolicy: "on-request" });
		expect(await log.waitFor("approval.requested")).toMatchObject({
			kind: "resume_uncertain",
		});
		expect(log.types()).not.toContain("task.ended");
	});

	describe("write 登记后中断：按文件的哈希补上结果，不用问", () => {
		test.each([
			{ name: "文件没有写", content: undefined, status: "failed" },
			{ name: "文件已经是新内容", content: "新内容\n", status: "succeeded" },
			{ name: "文件是别的内容", content: "别的\n", status: "interrupted" },
		])("$name：记 $status", async ({ content, status }) => {
			const path = join(dirs.workspace, "note.txt");
			const id = await interrupt(
				[call("write", { path, content: "新内容\n" })],
				"tool_call.started",
			);
			// Host 在登记之后、回复 runtime 之前被杀，文件还没有写；这里摆出中断在不同时刻的样子
			expect(existsSync(path)).toBe(false);
			if (content !== undefined) writeFileSync(path, content);

			await resume(id);
			expect(log.types().slice(0, 3)).toEqual([
				"session.started",
				"tool_call.completed",
				"task.ended",
			]);
			expect(completed()).toMatchObject([{ result: { status } }]);
			expect(log.types()).not.toContain("approval.requested");
		});
	});

	test("还在等批准的调用没有执行过：恢复时不问重不重新执行，下一个 task 重新登记、重新请求批准", async () => {
		const rules = join(dirs.root, "rules");
		// Host 根目录要求权限为 700
		mkdirSync(rules, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(rules, "team.toml"),
			'[[rules]]\npattern = ["echo", "review"]\ndecision = "prompt"\n',
		);
		const marker = join(dirs.workspace, "ran.txt");
		const id = await interrupt(
			[call("shell", { command: `echo review >> ${marker}` })],
			"approval.requested",
			"on-request",
		);

		const resumed = await resume(id, () => reply("做完了"), {
			approvalPolicy: "on-request",
		});
		expect(log.types().slice(0, 2)).toEqual(["session.started", "task.ended"]);

		const next = await resumed.submit("接着做");
		const asked = await log.waitFor("approval.requested");
		expect(asked).toMatchObject({
			kind: "tool_call",
			task_id: next,
			request: { kind: "command", command: `echo review >> ${marker}` },
		});
		expect(existsSync(marker)).toBe(false);
		resumed.respond(asked.request_id, { decision: "approve", scope: "once" });
		expect(await ended(next)).toMatchObject({ outcome: "completed" });
		expect(readFileSync(marker, "utf8")).toBe("review\n");
	});

	test("上次还在运行的后台命令记成已丢失，进程已经结束，下一个 task 里告诉模型", async () => {
		const pidFile = join(dirs.workspace, "pid.txt");
		const id = await interrupt(
			[
				call("shell", {
					command: `echo $$ > ${pidFile}; exec sleep 300`,
					background: true,
				}),
				reply("在后台跑着"),
			],
			"task.ended",
		);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).not.toThrow();

		const resumed = await resume(id, () => reply("知道了"));
		expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
		const lost = await log.waitFor("background.ended");
		expect(lost).toMatchObject({
			reason: "lost",
			exit_code: null,
			signal: null,
		});
		expect(resumed.backgroundCommands()).toEqual([]);
		// 丢失的命令不唤醒 session
		expect(log.types()).not.toContain("task.started");

		expect(await ended(await resumed.submit("后台的怎么样了"))).toMatchObject({
			outcome: "completed",
		});
		const notice = requests[0]?.messages.find((message) =>
			text(message).includes("was still running when the session was"),
		);
		expect(text(notice)).toContain(lost.background_id);
		expect(text(notice)).toContain("exec sleep 300");
	});
});
