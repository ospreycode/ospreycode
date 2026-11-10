import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type HostEvent,
	type Session,
} from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
import type { ApprovalPolicy, SandboxMode } from "@ospreycode/sandbox";
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
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	log = new EventLog();
	requests = [];
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	expect(log.invalid).toEqual([]);
});

interface OpenOptions {
	/** 审批策略 `never` 是非交互运行。 */
	approvalPolicy?: ApprovalPolicy;
	/** 不写时没有沙盒，命令由 Host 直接启动。 */
	sandboxMode?: SandboxMode;
	/** 第几次模型请求在回复之前先等什么：用来让后台命令在指定的时刻结束。 */
	before?: (call: number) => Promise<unknown> | undefined;
}

async function open(
	script: Script,
	options: OpenOptions = {},
): Promise<Session> {
	const model = scriptedModel((request, call) => {
		requests.push(request);
		return script(request, call);
	});
	let call = 0;
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: async function* (entry, request, streamOptions) {
			await options.before?.(call++);
			yield* model(entry, request, streamOptions);
		},
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: options.sandboxMode ?? "danger-full-access",
		approvalPolicy: options.approvalPolicy ?? "on-request",
		onEvent: log.push,
	});
	return session;
}

const say = (text: string): ScriptedTurn => ({
	content: [{ type: "text", text }],
});

let calls = 0;
/** 模型调用一次工具。 */
function tool(name: string, args: Record<string, unknown>): ScriptedTurn {
	calls += 1;
	return {
		content: [
			{
				type: "tool_call",
				call_id: `call_${calls}`,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

const shell = (args: Record<string, unknown>) => tool("shell", args);

function ofType<Type extends HostEvent["type"]>(
	type: Type,
): Extract<HostEvent, { type: Type }>[] {
	return log.events.filter(
		(event): event is Extract<HostEvent, { type: Type }> => event.type === type,
	);
}

/** 第一条后台命令的编号。 */
function backgroundId(index = 0): string {
	const started = ofType("background.started")[index];
	if (started === undefined) throw new Error("还没有后台命令开始");
	return started.background_id;
}

/** 按顺序的工具调用结果。 */
function results() {
	return ofType("tool_call.completed").map((event) => event.result);
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content.map((block) => block.text ?? "").join("\n");
}

function lastMessage(request: ModelRequest | undefined): Message {
	const message = request?.messages.at(-1);
	if (message === undefined) throw new Error("请求里没有消息");
	return message;
}

async function ended(taskId: string) {
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/** 由后台通知开始的第几个 task。 */
async function wakeup(index = 0) {
	await log.waitFor(
		"task.started",
		(event) =>
			event.source === "notification" &&
			ofType("task.started").filter((e) => e.source === "notification")[
				index
			] === event,
	);
	const started = ofType("task.started").filter(
		(event) => event.source === "notification",
	)[index];
	if (started === undefined) throw new Error("没有等到唤醒的 task");
	await ended(started.task_id);
	return started;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等工作区里出现这个文件再往下走的 shell 片段：命令什么时候继续由测试决定，不靠估计的时间。 */
const waitFor = (name: string) => `until [ -e ${name} ]; do sleep 0.05; done`;

/** 让等着这个文件的命令继续。 */
function release(name: string): void {
	writeFileSync(join(dirs.workspace, name), "");
}

/** 等到条件成立：进程的输出过一会才到。 */
async function eventually(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("等待的情况没有出现");
		await sleep(20);
	}
}

/** 后台命令的输出文件。 */
function outputPath(index = 0): string {
	const started = ofType("background.started")[index];
	if (started === undefined) throw new Error("还没有后台命令开始");
	return started.output_path;
}

/** 后台命令的输出文件现在的内容。 */
const output = (index = 0) => readFileSync(outputPath(index), "utf8");

const prefix = "Automatic notification, not user input.";

test("放到后台的命令在 task 结束后继续运行，结束时唤醒 session，通知作为新 task 的输入交给模型", async () => {
	const job = `${waitFor("release")}; echo finished`;
	const current = await open((_request, call) => {
		switch (call) {
			case 0:
				return shell({ command: job, background: true });
			case 1:
				return say("started");
			case 2: {
				// 被唤醒之后，模型用读文件工具读输出文件
				const [started] = ofType("background.started");
				return tool("read", { path: started?.output_path });
			}
			default:
				return say("noted");
		}
	});
	const first = await current.submit("start the job");
	expect(await ended(first)).toMatchObject({ outcome: "completed" });

	const id = backgroundId();
	const [result] = results();
	expect(result).toMatchObject({ status: "running", background_id: id });
	expect(textOf(result?.content ?? [])).toContain(
		`Started background command ${id}. It has no time limit.`,
	);
	// 转入后台不是出错
	expect(lastMessage(requests[1])).toMatchObject({
		role: "tool_result",
		is_error: false,
	});
	const [started] = ofType("background.started");
	const [call] = ofType("tool_call.started");
	expect(started).toMatchObject({
		task_id: first,
		tool_call_id: call?.tool_call_id,
		kind: "command",
		command: job,
		deadline: null,
	});
	// task 结束了，命令还在运行
	expect(current.backgroundCommands()).toMatchObject([
		{
			background_id: id,
			kind: "command",
			command: job,
			task_id: first,
			tool_call_id: call?.tool_call_id,
			deadline: null,
			output_path: started?.output_path,
		},
	]);

	release("release");
	const second = await wakeup();
	expect(current.backgroundCommands()).toEqual([]);
	expect(output()).toBe("finished\n");
	expect(ofType("background.ended")).toMatchObject([
		{
			background_id: id,
			reason: "exited",
			exit_code: 0,
			signal: null,
			output_bytes: 9,
		},
	]);
	const [notification] = ofType("background.notification");
	expect(notification?.text).toBe(
		[
			`Background command ${id} exited with code 0.`,
			`Command: ${job}`,
			`Output: 9 bytes in ${started?.output_path}`,
		].join("\n"),
	);
	// 通知加固定前缀，作为 user 消息交给模型
	const input = [{ type: "text", text: `${prefix} ${notification?.text}` }];
	expect(second).toMatchObject({ source: "notification", input });
	expect(lastMessage(requests[2])).toMatchObject({
		role: "user",
		content: input,
	});
	expect(ofType("background.delivered")).toMatchObject([
		{
			task_id: second.task_id,
			notification_ids: [notification?.notification_id],
		},
	]);
	const read = results()[1];
	expect(read?.status).toBe("succeeded");
	expect(textOf(read?.content ?? [])).toBe("finished");
	// 结束和通知记在最近的 run 里，排在它的 task.ended 之后
	expect(
		log.events
			.filter((event) => "task_id" in event && event.task_id === first)
			.map((event) => event.type)
			.slice(-3),
	).toEqual(["task.ended", "background.ended", "background.notification"]);
});

test("前台命令到了时限转入后台：结果带编号和到此为止的输出，之后能查询，但没有 stdin", async () => {
	const current = await open((_request, call) => {
		if (call === 0) {
			return shell({
				command: `echo start; ${waitFor("release")}; echo end`,
				timeout_ms: 200,
			});
		}
		if (call === 1) {
			return shell({ action: "status", background_id: backgroundId() });
		}
		if (call === 2) {
			return shell({
				action: "write_stdin",
				background_id: backgroundId(),
				stdin: "x\n",
			});
		}
		return say("ok");
	});
	const first = await current.submit("run it");
	expect(await ended(first)).toMatchObject({ outcome: "completed" });

	const id = backgroundId();
	const [moved, status, write] = results();
	expect(moved).toMatchObject({ status: "running", background_id: id });
	const movedText = textOf(moved?.content ?? []);
	expect(movedText).toContain(
		`The command passed its time limit of 200 ms and was moved to the background, where it is still running as background command ${id}. It has no time limit.`,
	);
	expect(movedText).toContain("Output so far:\nstart\n");
	expect(movedText).not.toContain("end\n");
	// 前台运行期间的输出照常流回
	expect(ofType("tool_call.output").map((event) => event.text)).toEqual([
		"start\n",
	]);
	expect(status?.status).toBe("succeeded");
	expect(textOf(status?.content ?? [])).toContain(
		`Background command ${id} is running`,
	);
	expect(write?.status).toBe("failed");
	expect(textOf(write?.content ?? [])).toContain("has no stdin");

	// 命令继续运行到自己退出，结束时照常通知
	release("release");
	await wakeup();
	expect(output()).toBe("start\nend\n");
	expect(ofType("background.ended")).toMatchObject([
		{ background_id: id, reason: "exited", exit_code: 0, output_bytes: 10 },
	]);
});

test("写 stdin、查询和停止；模型自己停掉的命令不产生通知", async () => {
	const current = await open((_request, call) => {
		switch (call) {
			case 0:
				return shell({ command: "cat", background: true });
			case 1:
				return shell({
					action: "write_stdin",
					background_id: backgroundId(),
					stdin: "hello\n",
				});
			case 2:
				// 等 cat 把这一行写出来
				return shell({
					command: `until [ -s ${outputPath()} ]; do sleep 0.05; done`,
				});
			case 3:
				return shell({ action: "status" });
			case 4:
				return shell({ action: "stop", background_id: backgroundId() });
			case 5:
				return shell({ action: "status", background_id: backgroundId() });
			case 6:
				return shell({ action: "stop", background_id: "no-such-id" });
			default:
				return say("done");
		}
	});
	const taskId = await current.submit("talk to cat");
	expect(await ended(taskId)).toMatchObject({ outcome: "completed" });

	const id = backgroundId();
	const [started] = ofType("background.started");
	const [, write, , list, stop, after, unknown] = results();
	expect(write?.status).toBe("succeeded");
	expect(textOf(write?.content ?? [])).toBe(
		`Wrote 6 bytes to the stdin of background command ${id}.`,
	);
	const listed = textOf(list?.content ?? []);
	expect(listed).toContain("1 background commands are running:");
	expect(listed).toMatch(
		new RegExp(`- ${id} \\(command, running for \\d+ s, no time limit\\): cat`),
	);
	expect(listed).toContain(`Output: 6 bytes in ${started?.output_path}`);
	expect(stop?.status).toBe("succeeded");
	expect(textOf(stop?.content ?? [])).toBe(
		[
			`Background command ${id} was stopped.`,
			"Command: cat",
			`Output: 6 bytes in ${started?.output_path}`,
		].join("\n"),
	);
	expect(textOf(after?.content ?? [])).toContain("was stopped.");
	expect(unknown?.status).toBe("failed");
	expect(textOf(unknown?.content ?? [])).toContain(
		"No background command has the id no-such-id.",
	);
	expect(output()).toBe("hello\n");
	expect(ofType("background.ended")).toMatchObject([
		{ background_id: id, reason: "stopped", exit_code: null },
	]);

	// 结果已经在那次工具调用里：不产生通知，也不唤醒
	await sleep(100);
	expect(ofType("background.notification")).toEqual([]);
	expect(ofType("task.started")).toHaveLength(1);
	expect(current.backgroundCommands()).toEqual([]);
});

test("监视：输出的每一行作为通知交给模型，task 运行时排在 steering 之后插入，空闲时唤醒 session", async () => {
	const current = await open((_request, call) => {
		switch (call) {
			case 0:
				return shell({
					command: `${waitFor("one")}; echo one; ${waitFor("two")}; echo two; ${waitFor("never")}`,
					monitor: true,
					timeout_ms: 60_000,
				});
			case 1:
				current.steer("keep watching");
				release("one");
				// 这条命令运行期间第一行到了
				return shell({
					command: `until [ -s ${outputPath()} ]; do sleep 0.05; done`,
				});
			default:
				return say("ok");
		}
	});
	const first = await current.submit("watch the log");
	expect(await ended(first)).toMatchObject({ outcome: "completed" });

	const id = backgroundId();
	const [started] = ofType("background.started");
	expect(started).toMatchObject({ kind: "monitor" });
	const limit =
		Date.parse(started?.deadline ?? "") - Date.parse(started?.time ?? "");
	expect(limit).toBeGreaterThan(59_000);
	expect(limit).toBeLessThanOrEqual(60_000);
	const [result] = results();
	expect(textOf(result?.content ?? [])).toContain(
		`Started monitor ${id}. Every line it prints arrives as a notification. It is stopped after 60000 ms.`,
	);
	// task 运行时到的通知在下一次模型请求之前插入，排在 steering 之后
	expect(lastMessage(requests[2])).toMatchObject({
		role: "user",
		content: [
			{ type: "text", text: "keep watching" },
			{ type: "text", text: `${prefix} Monitor ${id} printed:\none` },
		],
	});
	const [one] = ofType("background.notification");
	expect(one).toMatchObject({
		task_id: first,
		text: `Monitor ${id} printed:\none`,
	});
	expect(ofType("background.delivered")[0]).toMatchObject({
		task_id: first,
		notification_ids: [one?.notification_id],
	});

	// session 空闲时到的一行唤醒它
	release("two");
	const second = await wakeup();
	expect(second.input).toEqual([
		{ type: "text", text: `${prefix} Monitor ${id} printed:\ntwo` },
	]);
	expect(current.backgroundCommands()).toMatchObject([
		{ background_id: id, kind: "monitor", output_bytes: 8 },
	]);
});

test("到 16 条的上限时拒绝启动并列出正在运行的命令；这时前台命令到了时限按超时结束", async () => {
	const current = await open((_request, call) => {
		if (call === 0) {
			return {
				content: Array.from({ length: 17 }, (_, index) => ({
					type: "tool_call" as const,
					call_id: `bg_${index}`,
					name: "shell",
					arguments: JSON.stringify({
						command: `sleep 30.${index}`,
						background: true,
					}),
				})),
			};
		}
		if (call === 1) {
			return shell({ command: "echo before; sleep 5", timeout_ms: 200 });
		}
		return say("ok");
	});
	const taskId = await current.submit("start them all");
	expect(await ended(taskId)).toMatchObject({ outcome: "completed" });

	const all = results();
	expect(all.slice(0, 16).map((result) => result.status)).toEqual(
		Array.from({ length: 16 }, () => "running"),
	);
	const refused = all[16];
	expect(refused?.status).toBe("failed");
	const refusal = textOf(refused?.content ?? []);
	expect(refusal).toContain(
		"16 background commands are running, which is the limit.",
	);
	for (const [index, started] of ofType("background.started").entries()) {
		expect(refusal).toContain(`- ${started.background_id} (command, `);
		expect(refusal).toContain(`: sleep 30.${index}`);
	}
	expect(current.backgroundCommands()).toHaveLength(16);

	// 不能再转入后台的前台命令按超时结束
	const timedOut = all[17];
	expect(timedOut).toMatchObject({
		status: "timed_out",
		shell: { exit_code: null, signal: "SIGKILL" },
	});
	expect(textOf(timedOut?.content ?? [])).toContain(
		"Command timed out after 200 ms and was ended: it could not be moved to the background, because 16 background commands are already running.\nbefore\n",
	);
	expect(ofType("background.started")).toHaveLength(16);
});

test("session 关闭时结束后台命令和它们的子孙进程", async () => {
	const current = await open((_request, call) =>
		call === 0
			? shell({
					command: "sleep 30 & echo $! > child.pid; echo $$ > parent.pid; wait",
					background: true,
				})
			: say("ok"),
	);
	const taskId = await current.submit("start a server");
	await ended(taskId);
	// 等命令写完两个进程号
	const files = ["parent.pid", "child.pid"].map((name) =>
		join(dirs.workspace, name),
	);
	await eventually(() =>
		files.every(
			(file) => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"),
		),
	);
	const pids = files.map((file) => Number(readFileSync(file, "utf8")));
	for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();

	await current.close();
	expect(ofType("background.ended")).toMatchObject([
		{ background_id: backgroundId(), reason: "session_closed" },
	]);
	// 结束的事件在 session.ended 之前，关闭不产生通知
	expect(log.types().at(-1)).toBe("session.ended");
	expect(ofType("background.notification")).toEqual([]);
	for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow("ESRCH");
});

test("非交互运行里后台命令有时限，到时结束并通知；超出上限的时限直接拒绝", async () => {
	const current = await open(
		(_request, call) => {
			switch (call) {
				case 0:
					return shell({ command: "sleep 600", timeout_ms: 600_001 });
				case 1:
					return shell({
						command: "sleep 600",
						monitor: true,
						timeout_ms: 600_001,
					});
				case 2:
					return shell({ command: "sleep 30", background: true });
				case 3:
					return shell({ action: "stop", background_id: backgroundId() });
				case 4:
					return shell({
						command: "sleep 30",
						background: true,
						timeout_ms: 300,
					});
				default:
					return say("ok");
			}
		},
		{ approvalPolicy: "never" },
	);
	const taskId = await current.submit("go");
	expect(await ended(taskId)).toMatchObject({ outcome: "completed" });

	const [foreground, monitor, unlimited] = results();
	expect(foreground?.status).toBe("failed");
	expect(textOf(foreground?.content ?? [])).toContain(
		"timeout_ms for a foreground command (use `background: true` for longer ones) is at most 600000.",
	);
	expect(monitor?.status).toBe("failed");
	expect(textOf(monitor?.content ?? [])).toContain(
		"timeout_ms for a monitor in a non-interactive run is at most 600000.",
	);
	// 不给时限时默认 10 分钟
	expect(textOf(unlimited?.content ?? [])).toContain(
		"It is stopped after 600000 ms.",
	);
	const [first, second] = ofType("background.started");
	const tenMinutes =
		Date.parse(first?.deadline ?? "") - Date.parse(first?.time ?? "");
	expect(tenMinutes).toBeGreaterThan(599_000);
	expect(tenMinutes).toBeLessThanOrEqual(600_000);

	const woken = await wakeup();
	expect(textOf(woken.input)).toContain(
		`Background command ${second?.background_id} reached its time limit of 300 ms and was stopped.`,
	);
	expect(ofType("background.ended")).toMatchObject([
		{ reason: "stopped" },
		{ background_id: second?.background_id, reason: "time_limit" },
	]);
});

test("用户停掉的命令不唤醒 session，通知等用户下一次开始 task 时交给模型", async () => {
	const current = await open((_request, call) =>
		call === 0 ? shell({ command: "sleep 30", background: true }) : say("ok"),
	);
	const first = await current.submit("start");
	await ended(first);
	const id = backgroundId();

	expect(await current.stopBackgroundCommand(id)).toBe(true);
	expect(await current.stopBackgroundCommand(id)).toBe(false);
	expect(ofType("background.ended")).toMatchObject([
		{ background_id: id, reason: "stopped", task_id: first },
	]);
	const [notification] = ofType("background.notification");
	expect(notification?.text).toContain(
		`Background command ${id} was stopped by the user.`,
	);
	await sleep(100);
	expect(ofType("task.started")).toHaveLength(1);

	const second = await current.submit("what happened?");
	await ended(second);
	// 先是用户的输入，通知在第一次模型请求之前跟着插入
	const messages = requests[2]?.messages.slice(-2) ?? [];
	expect(messages).toMatchObject([
		{ role: "user", content: [{ type: "text", text: "what happened?" }] },
		{
			role: "user",
			content: [{ type: "text", text: `${prefix} ${notification?.text}` }],
		},
	]);
	expect(ofType("background.delivered")).toMatchObject([
		{ task_id: second, notification_ids: [notification?.notification_id] },
	]);
});

test("task 被取消之后到用户下一次输入之前，后台命令结束不唤醒 session", async () => {
	const current = await open((_request, call) => {
		if (call === 0) {
			return shell({
				command: `${waitFor("release")}; echo done`,
				background: true,
			});
		}
		if (call === 1) return { content: [], hang: true };
		return say("ok");
	});
	const first = await current.submit("start");
	await log.waitFor("background.started");
	await sleep(50);
	await current.cancel();
	expect(await ended(first)).toMatchObject({ outcome: "cancelled" });

	// 取消不影响后台命令：它运行到自己退出
	expect(current.backgroundCommands()).toHaveLength(1);
	release("release");
	const done = await log.waitFor("background.ended");
	expect(done).toMatchObject({ reason: "exited", exit_code: 0 });
	await sleep(100);
	expect(ofType("task.started")).toHaveLength(1);

	const second = await current.submit("continue");
	await ended(second);
	expect(textOf(lastMessage(requests[2]).content)).toContain(
		`${prefix} Background command ${backgroundId()} exited with code 0.`,
	);
});

test("连续由通知开始的 task 最多 3 个，之后的通知等用户下一次输入时一起交给模型", async () => {
	// 测试每放出一个信号，监视的命令输出一行
	const watch = `for i in 1 2 3 4 5; do ${waitFor("go$i")}; echo line $i; done`;
	const current = await open((_request, call) =>
		call === 0
			? shell({ command: watch, monitor: true, timeout_ms: 60_000 })
			: say("ok"),
	);
	const first = await current.submit("watch");
	await ended(first);
	const id = backgroundId();
	for (const line of [1, 2, 3]) {
		release(`go${line}`);
		const woken = await wakeup(line - 1);
		expect(textOf(woken.input)).toBe(
			`${prefix} Monitor ${id} printed:\nline ${line}`,
		);
	}

	// 第四行起不再唤醒
	release("go4");
	await eventually(() => ofType("background.notification").length === 4);
	release("go5");
	await log.waitFor("background.ended");
	await sleep(100);
	expect(
		ofType("task.started").filter((event) => event.source === "notification"),
	).toHaveLength(3);

	const next = await current.submit("anything new?");
	await ended(next);
	// 同一条监视还没交给模型的行并成一条通知，结束的通知另一条
	expect(lastMessage(requests.at(-1)).content).toEqual([
		{
			type: "text",
			text: `${prefix} Monitor ${id} printed:\nline 4\nline 5`,
		},
		{
			type: "text",
			text: [
				`${prefix} Monitor ${id} exited with code 0.`,
				`Command: ${watch}`,
				`Output: 35 bytes in ${outputPath()}`,
			].join("\n"),
		},
	]);
});

test("向之前的 task 留下的命令写 stdin 要重新批准：批准后写入，拒绝时不写", async () => {
	const current = await open((_request, call) => {
		switch (call) {
			case 0:
				return shell({ command: "cat", background: true });
			case 1:
				// 同一个 task 里启动的，不用问
				return shell({
					action: "write_stdin",
					background_id: backgroundId(),
					stdin: "same task\n",
				});
			case 2:
				return say("started");
			case 3:
			case 5:
				return shell({
					action: "write_stdin",
					background_id: backgroundId(),
					stdin: `later ${call}\n`,
				});
			default:
				return say("ok");
		}
	});
	const first = await current.submit("start cat");
	await ended(first);
	expect(ofType("approval.requested")).toEqual([]);

	const second = await current.submit("write again");
	const question = await log.waitFor("approval.requested");
	current.respond(question.request_id, { decision: "approve", scope: "once" });
	await ended(second);
	const third = await current.submit("and again");
	const again = await log.waitFor(
		"approval.requested",
		(event) => event.request_id !== question.request_id,
	);
	current.respond(again.request_id, {
		decision: "deny",
		scope: "once",
		message: "not now",
	});
	await ended(third);

	const id = backgroundId();
	const [asked] = ofType("approval.requested");
	expect(asked).toMatchObject({
		kind: "tool_call",
		request: {
			kind: "stdin",
			background_id: id,
			command: "cat",
			input: "later 3\n",
		},
		reasons: ["这条后台命令是之前的 task 启动的，向它的 stdin 写入要重新批准"],
	});
	const [, same, approved, denied] = results();
	expect(same?.status).toBe("succeeded");
	expect(approved?.status).toBe("succeeded");
	expect(denied).toMatchObject({
		status: "denied",
		reason: "user",
		message: "not now",
	});
	await eventually(() => output().includes("later 3"));
	// 被拒绝的那一次没有写进去
	await sleep(100);
	expect(output()).toBe("same task\nlater 3\n");
});

test("审批策略 never 下，要重新批准的 stdin 写入直接拒绝", async () => {
	const current = await open(
		(_request, call) => {
			if (call === 0) return shell({ command: "cat", background: true });
			if (call === 2) {
				return shell({
					action: "write_stdin",
					background_id: backgroundId(),
					stdin: "later\n",
				});
			}
			return say("ok");
		},
		{ approvalPolicy: "never" },
	);
	await ended(await current.submit("start cat"));
	await ended(await current.submit("write"));

	expect(ofType("approval.requested")).toEqual([]);
	expect(results()[1]).toMatchObject({
		status: "denied",
		reason: "policy",
		categories: ["sandbox_approval"],
	});
	await sleep(100);
	expect(output()).toBe("");
});

test("唤醒开始的 task 有调用被内置的 forbidden 规则阻止之后，到用户下一次输入之前不再唤醒", async () => {
	const current = await open((_request, call) => {
		switch (call) {
			case 0:
				return shell({
					command: `${waitFor("one")}; echo one; ${waitFor("two")}; echo two`,
					monitor: true,
					timeout_ms: 60_000,
				});
			case 2:
				// 第一行唤醒的 task 里，模型想用 sudo
				return shell({ command: "sudo ls" });
			default:
				return say("ok");
		}
	});
	await ended(await current.submit("watch"));
	release("one");
	await wakeup();
	expect(results().at(-1)).toMatchObject({
		status: "denied",
		reason: "forbidden_rule",
	});

	// 第二行和监视的结束都不再唤醒
	release("two");
	await log.waitFor("background.ended");
	await sleep(100);
	expect(
		ofType("task.started").filter((event) => event.source === "notification"),
	).toHaveLength(1);
	expect(ofType("background.notification")).toHaveLength(3);

	// 用户有了输入，留下的通知一起交给模型，之后又能唤醒
	const id = backgroundId();
	await ended(await current.submit("what did it print?"));
	expect(lastMessage(requests.at(-1)).content).toMatchObject([
		{ text: `${prefix} Monitor ${id} printed:\ntwo` },
		{ text: expect.stringContaining(`Monitor ${id} exited with code 0.`) },
	]);
});

test("follow-up 列表里有条目时先开始 follow-up，排着的通知跟着它交给模型，不另外唤醒", async () => {
	const current = await open(
		(_request, call) =>
			call === 0
				? shell({
						command: `${waitFor("release")}; echo done`,
						background: true,
					})
				: say("ok"),
		{
			// 第一个 task 的最后一次模型请求等到后台命令结束之后才回复：通知到的时候 task 已经要结束了
			before: (call) =>
				call === 1 ? log.waitFor("background.notification") : undefined,
		},
	);
	const first = await current.submit("start");
	await log.waitFor("background.started");
	const queued = current.followUp("then do this");
	release("release");
	expect(await ended(first)).toMatchObject({ outcome: "completed" });

	const second = await log.waitFor(
		"task.started",
		(event) => event.task_id !== first,
	);
	expect(second).toMatchObject({
		source: "follow_up",
		input: [{ type: "text", text: "then do this" }],
	});
	await ended(second.task_id);
	const [notification] = ofType("background.notification");
	// 只有通知排着时第一个 task 不继续；通知排在 follow-up 的输入之后
	expect(requests).toHaveLength(3);
	expect(requests[2]?.messages.slice(-2)).toMatchObject([
		{ role: "user", content: [{ type: "text", text: "then do this" }] },
		{
			role: "user",
			content: [{ type: "text", text: `${prefix} ${notification?.text}` }],
		},
	]);
	expect(ofType("background.delivered")).toMatchObject([
		{
			task_id: second.task_id,
			notification_ids: [notification?.notification_id],
		},
	]);
	await sleep(100);
	expect(ofType("task.started").map((event) => event.source)).toEqual([
		"user",
		"follow_up",
	]);
	expect(queued).toEqual(expect.any(String));
});

test("agent 进程重启不影响后台命令：重启之后照样能查询和停止", async () => {
	const current = await open((_request, call) => {
		switch (call) {
			case 0:
				return shell({ command: "echo up; sleep 30", background: true });
			case 2:
				return shell({ action: "status" });
			case 3:
				return shell({ action: "stop", background_id: backgroundId() });
			default:
				return say("ok");
		}
	});
	await ended(await current.submit("start a server"));
	const id = backgroundId();
	const before = current.backgroundCommands();
	expect(before).toMatchObject([{ background_id: id }]);

	await current.reload();
	expect(ofType("process.exited").length).toBeGreaterThan(0);
	expect(current.backgroundCommands()).toMatchObject([
		{ background_id: id, started_at: before[0]?.started_at },
	]);

	await ended(await current.submit("is it still running?"));
	const [, status, stop] = results();
	expect(textOf(status?.content ?? [])).toContain(
		"1 background commands are running:",
	);
	expect(textOf(status?.content ?? [])).toContain(`- ${id} (command, `);
	expect(stop?.status).toBe("succeeded");
	expect(ofType("background.ended")).toMatchObject([
		{ background_id: id, reason: "stopped" },
	]);
});

// 每个测试都要启动辅助进程，有的还要换沙盒、重启 agent 进程：机器忙的时候默认的 5 秒不够
describe.runIf(process.platform === "darwin")(
	"真实沙盒（macOS）",
	{
		timeout: 30_000,
	},
	() => {
		test("后台命令在自己的命令沙盒里运行，输出文件 agent 沙盒里读得到", async () => {
			const outside = join(dirs.home, "outside.txt");
			const current = await open(
				(_request, call) => {
					switch (call) {
						case 0:
							return shell({
								command: `echo inside > inside.txt; echo outside > ${outside}; echo printed`,
								background: true,
							});
						case 1:
							return say("started");
						case 2: {
							const [started] = ofType("background.started");
							return tool("read", { path: started?.output_path });
						}
						default:
							return say("ok");
					}
				},
				{ sandboxMode: "workspace-write" },
			);
			await ended(await current.submit("write two files"));
			await wakeup();

			// 工作区里写得进去，工作区外被沙盒拦下
			expect(readFileSync(join(dirs.workspace, "inside.txt"), "utf8")).toBe(
				"inside\n",
			);
			expect(existsSync(outside)).toBe(false);
			expect(ofType("background.ended")).toMatchObject([
				{ reason: "exited", exit_code: 0 },
			]);
			const read = results()[1];
			expect(read?.status).toBe("succeeded");
			const output = textOf(read?.content ?? []);
			expect(output).toContain(`${outside}: Operation not permitted\n`);
			expect(output.endsWith("\nprinted")).toBe(true);
		});

		test("换到更窄的沙盒模式时结束后台命令，通知等用户下一次输入时交给模型；换到更宽的模式时保留", async () => {
			const current = await open(
				(_request, call) => {
					switch (call) {
						case 0:
							return shell({ command: "sleep 30", background: true });
						case 2:
							// 等测试放出信号再退出：换模式要多久不一定
							return shell({
								command:
									"until [ -e release ]; do sleep 0.1; done; echo still here",
								background: true,
							});
						default:
							return say("ok");
					}
				},
				{ sandboxMode: "workspace-write" },
			);
			await ended(await current.submit("start a server"));
			const first = backgroundId();

			await current.setSandboxMode("read-only");
			expect(current.backgroundCommands()).toEqual([]);
			expect(ofType("background.ended")).toMatchObject([
				{ background_id: first, reason: "stopped" },
			]);
			const [notification] = ofType("background.notification");
			expect(notification?.text).toContain(
				`Background command ${first} was stopped because the user switched to a narrower sandbox mode.`,
			);
			// 用户操作导致的结束不唤醒 session
			await sleep(100);
			expect(ofType("task.started")).toHaveLength(1);

			await ended(await current.submit("start another"));
			// 最后一条是沙盒模式变了之后系统指令的补丁，跟在 user 轮后面
			expect(requests[2]?.messages.slice(-3)).toMatchObject([
				{ role: "user", content: [{ type: "text", text: "start another" }] },
				{
					role: "user",
					content: [{ type: "text", text: `${prefix} ${notification?.text}` }],
				},
				{ role: "system" },
			]);
			const second = backgroundId(1);

			// 换到更宽的模式：只读模式下启动的命令照常运行到自己退出
			await current.setSandboxMode("workspace-write");
			expect(current.backgroundCommands()).toMatchObject([
				{ background_id: second },
			]);
			writeFileSync(join(dirs.workspace, "release"), "");
			const woken = await wakeup();
			expect(textOf(woken.input)).toContain(
				`Background command ${second} exited with code 0.`,
			);
			expect(output(1)).toBe("still here\n");
		});

		test("越界启动的后台命令：同一个 task 里向它的 stdin 写入也要重新批准", async () => {
			const current = await open(
				(_request, call) => {
					switch (call) {
						case 0:
							return shell({
								command: "cat",
								background: true,
								sandbox_permissions: "require_escalated",
								justification: "needs to write outside the workspace",
							});
						case 1:
							return shell({
								action: "write_stdin",
								background_id: backgroundId(),
								stdin: "hello\n",
							});
						default:
							return say("ok");
					}
				},
				{ sandboxMode: "workspace-write" },
			);
			const taskId = await current.submit("start cat");
			const launch = await log.waitFor("approval.requested");
			expect(launch).toMatchObject({ request: { kind: "command" } });
			current.respond(launch.request_id, {
				decision: "approve",
				scope: "once",
			});
			const write = await log.waitFor(
				"approval.requested",
				(event) => event.request_id !== launch.request_id,
			);
			expect(write).toMatchObject({
				kind: "tool_call",
				request: {
					kind: "stdin",
					background_id: backgroundId(),
					command: "cat",
					input: "hello\n",
				},
				reasons: [
					"这条后台命令是越界或带额外权限启动的，向它的 stdin 写入要重新批准",
				],
			});
			current.respond(write.request_id, { decision: "approve", scope: "once" });
			expect(await ended(taskId)).toMatchObject({ outcome: "completed" });

			expect(results().map((result) => result.status)).toEqual([
				"running",
				"succeeded",
			]);
			await eventually(() => output() === "hello\n");
		});

		test("task 批准的域名在它启动的后台命令结束之前继续放行，之后重新询问", async () => {
			// 经沙盒的代理请求一个解析不了的域名：代理在连接之前先问，被拒绝时返回 403
			const fetch =
				"curl -s -o /dev/null -w '%{http_code}' --max-time 20 'http://carried.example.invalid:8080/'";
			const current = await open(
				(_request, call) => {
					switch (call) {
						case 0:
							return shell({ command: fetch });
						case 1:
							return shell({
								command: `${waitFor("go")}; ${fetch}`,
								background: true,
							});
						case 4:
							return shell({ command: fetch });
						default:
							return say("ok");
					}
				},
				{ sandboxMode: "workspace-write" },
			);
			const first = await current.submit("fetch, then keep fetching");
			const asked = await log.waitFor(
				"approval.requested",
				(event) => event.kind === "network",
			);
			current.respond(asked.request_id, { decision: "approve", scope: "task" });
			expect(await ended(first)).toMatchObject({ outcome: "completed" });

			// task 已经结束，后台命令这时才去连：不询问，照常放行
			release("go");
			await wakeup();
			const fetched = output();
			expect(fetched).not.toBe("");
			expect(fetched).not.toContain("403");
			expect(
				ofType("approval.requested").filter(
					(event) => event.kind === "network",
				),
			).toHaveLength(1);

			// 后台命令都结束了，那个 task 批准的域名不再放行
			const third = await current.submit("fetch again");
			const again = await log.waitFor(
				"approval.requested",
				(event) =>
					event.kind === "network" && event.request_id !== asked.request_id,
			);
			current.respond(again.request_id, { decision: "deny", scope: "once" });
			expect(await ended(third)).toMatchObject({ outcome: "completed" });
			expect(textOf(results().at(-1)?.content ?? [])).toContain("403");
		});

		test("等待网络批准期间前台命令不计超时：用户回答之前不会转入后台", async () => {
			const current = await open(
				(_request, call) =>
					call === 0
						? shell({
								// 经沙盒的代理请求一个名单之外的域名：代理在连接之前先问
								command:
									"curl -s -o /dev/null -w '%{http_code}' --max-time 20 'http://paused.example.invalid:8080/'",
								timeout_ms: 1000,
							})
						: say("ok"),
				{ sandboxMode: "workspace-write" },
			);
			const taskId = await current.submit("fetch it");
			const asked = await log.waitFor(
				"approval.requested",
				(event) => event.kind === "network",
			);
			// 用户想了比命令的时限更久
			await sleep(1500);
			expect(ofType("tool_call.completed")).toEqual([]);
			current.respond(asked.request_id, { decision: "deny", scope: "once" });
			expect(await ended(taskId)).toMatchObject({ outcome: "completed" });

			// 命令在前台结束，结果里是代理拒绝的 403
			const [result] = results();
			expect(result?.status).toBe("succeeded");
			expect(textOf(result?.content ?? [])).toContain("403");
			expect(ofType("background.started")).toEqual([]);
		});
	},
);
