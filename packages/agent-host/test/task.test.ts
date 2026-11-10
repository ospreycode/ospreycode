import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHost,
	type HostOptions,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
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
/** 模型被请求了几次。 */
let modelCalls: number;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	modelCalls = 0;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

function shell(command: string): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: "call_1",
				name: "shell",
				arguments: JSON.stringify({ command }),
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
		streamModel: scriptedModel((_request, index) => {
			modelCalls += 1;
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

test("取消时挂起的询问答为拒绝，命令不执行，task 以 cancelled 结束", async () => {
	const target = join(dirs.workspace, "build");
	const current = await open([shell("mkdir build && rm -rf build")], {
		approvalPolicy: "on-request",
	});
	const taskId = await current.submit("清理");
	const asked = await log.waitFor("approval.requested");

	await current.cancel();
	const ended = await log.waitFor("task.ended", (e) => e.task_id === taskId);

	expect(ended.outcome).toBe("cancelled");
	const decided = await log.waitFor("approval.decided");
	expect(decided).toMatchObject({
		request_id: asked.request_id,
		decision: "denied",
	});
	// 不是用户答的：没有回答的内容
	expect(decided).not.toHaveProperty("answer");
	expect(existsSync(target)).toBe(false);
	const types = log.types();
	expect(types.indexOf("approval.decided")).toBeLessThan(
		types.indexOf("tool_call.completed"),
	);
	expect(types.indexOf("tool_call.completed")).toBeLessThan(
		types.indexOf("task.ended"),
	);
	// 这次询问已经有了结果，之后再回答不算数
	expect(
		current.respond(asked.request_id, { decision: "approve", scope: "once" }),
	).toBe(false);
});

test("取消之后和空闲时，runtime 迟到的请求以 no_active_task 拒绝，迟到的事件丢弃并提醒", async () => {
	const report = join(dirs.workspace, "report.txt");
	const current = await open(
		[],
		{},
		{
			agentEntry: fileURLToPath(
				new URL("./fixtures/late-agent.mjs", import.meta.url),
			),
		},
	);
	const taskId = await current.submit(report);

	await current.cancel();
	const ended = await log.waitFor("task.ended", (e) => e.task_id === taskId);
	const warning = await log.waitFor("warning");

	expect(ended.outcome).toBe("cancelled");
	expect(warning.message).toContain("blocks.invalidated");
	await expect
		.poll(() => (existsSync(report) ? readFileSync(report, "utf8") : ""))
		.toBe("cancelled: no_active_task\nidle: no_active_task\n");
	// 丢弃的事件没有记进 session 记录
	expect(log.types()).not.toContain("blocks.invalidated");
});

test("前台命令的完整输出写进输出文件，交给模型的只有开头和结尾，中间写明省略了多少", async () => {
	const current = await open([shell("seq 1 20000")]);
	const taskId = await current.submit("数数");
	await log.waitFor("task.ended", (e) => e.task_id === taskId);

	const { result } = await log.waitFor("tool_call.completed");
	if (result.status !== "succeeded" || result.shell === undefined) {
		throw new Error("命令应该成功，结果带着 shell 的信息");
	}
	const [block] = result.content;
	if (block?.type !== "text") throw new Error("结果应该是文字");
	const { output_path: path, output_bytes: bytes } = result.shell;
	const full = readFileSync(path, "utf8");
	expect(full).toBe(
		Array.from({ length: 20000 }, (_, index) => `${index + 1}\n`).join(""),
	);
	expect(bytes).toBe(statSync(path).size);
	const omitted = Number(/\[\.\.\. (\d+) bytes omitted/.exec(block.text)?.[1]);
	expect(block.text).toContain(`bytes omitted; the full output is in ${path}]`);
	// 留下的开头和结尾一共 32 KiB
	expect(bytes - omitted).toBe(32 * 1024);
	expect(block.text).toContain("1\n2\n3\n");
	expect(block.text).toContain("19999\n20000");
});

test("runtime 请求配置之外的模型按协议错误处理：结束 agent 进程，task 记 failed", async () => {
	const current = await open(
		[],
		{},
		{
			agentEntry: fileURLToPath(
				new URL("./fixtures/request-agent.mjs", import.meta.url),
			),
		},
	);
	const taskId = await current.submit(
		JSON.stringify({
			method: "model/request",
			params: {
				message_id: "message_1",
				request: {
					model: "some-other-model",
					reasoning_effort: "off",
					tool_choice: "auto",
					cache_retention: "short",
					messages: [],
					tools: [],
				},
			},
		}),
	);

	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({
		outcome: "failed",
		error: expect.stringContaining("配置之外的模型"),
	});
	expect(modelCalls).toBe(0);
});

test("等待批准期间，同一轮里别的调用照常进行", async () => {
	const current = await open(
		[],
		{ approvalPolicy: "on-request" },
		{
			agentEntry: fileURLToPath(
				new URL("./fixtures/parallel-agent.mjs", import.meta.url),
			),
		},
	);
	const taskId = await current.submit("mkdir build && rm -rf build");
	const asked = await log.waitFor("approval.requested");
	if (asked.kind !== "tool_call") throw new Error("应该是工具调用的询问");
	// 询问还挂着，read 已经登记、执行完并交了结果
	const read = await log.waitFor(
		"tool_call.completed",
		(e) => e.result.status === "succeeded",
	);
	expect(log.types()).not.toContain("approval.decided");

	current.respond(asked.request_id, { decision: "approve", scope: "once" });
	await log.waitFor("task.ended", (e) => e.task_id === taskId);

	const completed = log.events.filter((e) => e.type === "tool_call.completed");
	expect(completed.map((e) => e.tool_call_id)).toEqual([
		read.tool_call_id,
		asked.tool_call_id,
	]);
	expect(completed.map((e) => e.result.status)).toEqual([
		"succeeded",
		"succeeded",
	]);
});

test("前台命令退出时，它留在后台的进程一起结束", async () => {
	const current = await open([shell("sleep 30 & echo $! > child.pid")]);
	const taskId = await current.submit("开始");
	await log.waitFor("task.ended", (e) => e.task_id === taskId);

	expect((await log.waitFor("tool_call.completed")).result.status).toBe(
		"succeeded",
	);
	const child = Number(
		readFileSync(join(dirs.workspace, "child.pid"), "utf8").trim(),
	);
	// 发信号 0 只检查进程在不在
	await expect
		.poll(() => {
			try {
				process.kill(child, 0);
				return "running";
			} catch {
				return "gone";
			}
		})
		.toBe("gone");
});

test("whenIdle 等到接着开始的 task 也结束：follow-up 和后台通知唤醒的都算；空闲时立即兑现", async () => {
	const current = await open([
		shell("sleep 0.3"),
		{ content: [{ type: "text", text: "第一件做完了" }] },
		{
			content: [
				{
					type: "tool_call",
					call_id: "call_2",
					name: "shell",
					arguments: JSON.stringify({ command: "sleep 0.5", background: true }),
				},
			],
		},
	]);
	const sources = () =>
		log.events.flatMap((event) =>
			event.type === "task.started" ? [event.source] : [],
		);
	const endedTasks = () =>
		log.events.filter((event) => event.type === "task.ended").length;
	await current.whenIdle();
	expect(sources()).toEqual([]);

	await current.submit("第一件");
	current.followUp("第二件：在后台启动一条命令");
	await current.whenIdle();

	// follow-up 的 task 也结束了；它启动的后台命令还在运行，不算忙
	expect(sources()).toEqual(["user", "follow_up"]);
	expect(endedTasks()).toBe(2);
	expect(current.backgroundCommands()).toHaveLength(1);

	await log.waitFor("background.ended");
	await current.whenIdle();

	// 后台命令结束时 Host 为通知开始的 task 也等到了
	expect(sources()).toEqual(["user", "follow_up", "notification"]);
	expect(endedTasks()).toBe(3);
	expect(current.backgroundCommands()).toEqual([]);
});
