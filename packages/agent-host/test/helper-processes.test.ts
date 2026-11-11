import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type ApprovalRequestedEvent,
	createHost,
	type HostEvent,
	type Session,
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
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	answer = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

const shell = (command: string, extra: object = {}): ScriptedTurn => ({
	content: [
		{
			type: "tool_call",
			call_id: `call_${crypto.randomUUID()}`,
			name: "shell",
			arguments: JSON.stringify({ command, ...extra }),
		},
	],
});

const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };

/** 打开 session：模型依次给出 `turns` 里的回复，用完之后回复一句话。 */
async function open(
	turns: ScriptedTurn[],
	sandboxMode: "workspace-write" | "danger-full-access" = "workspace-write",
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
		sandboxMode,
		approvalPolicy: "on-request",
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

type ProcessEvent = Extract<
	HostEvent,
	{ type: "process.started" | "process.exited" }
>;

/** 到现在为止的进程事件。 */
function processEvents(): ProcessEvent[] {
	return log.events.filter(
		(event): event is ProcessEvent =>
			event.type === "process.started" || event.type === "process.exited",
	);
}

/** 启动过的辅助进程，按启动的顺序。 */
function helperPids(): number[] {
	return processEvents().flatMap((event) =>
		event.type === "process.started" && event.kind === "helper"
			? [event.pid]
			: [],
	);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function results(): ToolResult[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result] : [],
	);
}

async function waitUntil(condition: () => boolean): Promise<void> {
	while (!condition()) await new Promise((resolve) => setTimeout(resolve, 20));
}

test("没有沙盒时没有辅助进程：进程事件只有 agent 进程的", async () => {
	const current = await open([], "danger-full-access");
	await current.close();
	expect(processEvents().map(({ type, kind }) => ({ type, kind }))).toEqual([
		{ type: "process.started", kind: "agent" },
		{ type: "process.exited", kind: "agent" },
	]);
});

describe.runIf(process.platform === "darwin")(
	"辅助进程的进程事件（macOS 真实沙盒，脚本模型）",
	() => {
		test("随 session 存在的两个辅助进程：启动记在 session.started 之后，关闭 session 时各记一条退出，kind 是 helper", async () => {
			const current = await open([]);
			expect(log.types()[0]).toBe("session.started");
			const helpers = helperPids();
			expect(helpers).toHaveLength(2);
			expect(new Set(helpers).size).toBe(2);
			for (const pid of helpers) expect(alive(pid), `${pid}`).toBe(true);

			await current.close();
			for (const pid of helpers) {
				expect(
					processEvents().filter(
						(event) => event.type === "process.exited" && event.pid === pid,
					),
				).toMatchObject([{ kind: "helper", exit_code: 0, signal: null }]);
				expect(alive(pid), `${pid}`).toBe(false);
			}
			// 退出事件要进 session 记录：都在 session.ended 之前
			expect(log.types().at(-1)).toBe("session.ended");
		});

		test("辅助进程被杀：记 process.exited 带信号并发 warning；运行中的命令不中断，结果里注明代理已失效；之后的命令换一个新的辅助进程", async () => {
			const current = await open([
				shell("touch started; sleep 2; echo still-running"),
				done,
				shell("echo again"),
			]);
			const original = helperPids();
			const first = runTask("运行一条命令");
			await waitUntil(() => existsSync(join(dirs.workspace, "started")));
			for (const pid of original) process.kill(pid, "SIGKILL");

			for (const pid of original) {
				expect(
					await log.waitFor("process.exited", (event) => event.pid === pid),
				).toMatchObject({ kind: "helper", exit_code: null, signal: "SIGKILL" });
			}
			expect(
				log.events.flatMap((event) =>
					event.type === "warning" && event.message.includes("辅助进程退出了")
						? [event.message]
						: [],
				),
			).toHaveLength(2);
			expect(await first).toMatchObject({ outcome: "completed" });
			expect(results()[0]).toMatchObject({ status: "succeeded" });
			expect(output(results()[0])).toContain("still-running");
			expect(output(results()[0])).toContain("network proxy exited");
			// agent 进程的沙盒不靠辅助进程维持：它没有跟着退出
			expect(
				processEvents().filter((event) => event.kind === "agent"),
			).toHaveLength(1);

			expect(await runTask("再运行一条")).toMatchObject({
				outcome: "completed",
			});
			expect(output(results()[1])).toContain("again");
			// 两个辅助进程都按需换新：命令用带代理的那个，命令前后的快照用离线的那个
			const replaced = helperPids().filter((pid) => !original.includes(pid));
			expect(replaced).toHaveLength(2);

			await current.close();
			for (const pid of replaced) {
				expect(
					processEvents().filter(
						(event) => event.type === "process.exited" && event.pid === pid,
					),
				).toMatchObject([{ kind: "helper", exit_code: 0, signal: null }]);
			}
			// 每个辅助进程的启动和退出各记一次
			const count = (type: ProcessEvent["type"]) =>
				processEvents().filter(
					(event) => event.type === type && event.kind === "helper",
				).length;
			expect(count("process.started")).toBe(4);
			expect(count("process.exited")).toBe(4);
		});

		test("为一条越界命令单独启动的辅助进程不另记进程事件：它随这次工具调用开始和结束", async () => {
			answer = () => ({ decision: "approve", scope: "once" });
			const target = join(dirs.home, "escalated.txt");
			await open([
				shell(`echo x > '${target}'`, {
					sandbox_permissions: "require_escalated",
				}),
			]);
			const before = processEvents().length;
			expect(await runTask("越界执行")).toMatchObject({ outcome: "completed" });
			expect(results()[0]).toMatchObject({ status: "succeeded" });
			expect(existsSync(target)).toBe(true);
			expect(processEvents()).toHaveLength(before);
		});
	},
);
