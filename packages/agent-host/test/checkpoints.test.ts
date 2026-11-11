import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
	type ApprovalRequestedEvent,
	createHost,
	type Host,
	type HostEvent,
	type Session,
	SessionCommandError,
	type SessionOptions,
	WorkspaceError,
} from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
import { SessionStore } from "@ospreycode/session-store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

// 每次工具调用前后都要运行几条 git 命令，真实沙盒里还要启动辅助进程：机器忙的时候默认的 5 秒不够
vi.setConfig({ testTimeout: 30_000 });

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 脚本模型接下来依次给出的回复；用完之后回复一句话。 */
let turns: ScriptedTurn[];
/** 脚本模型收到的每次请求。 */
let requests: ModelRequest[];
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;
let calls = 0;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	turns = [];
	requests = [];
	answer = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

const say = (text: string): ScriptedTurn => ({
	content: [{ type: "text", text }],
});

function call(name: string, args: object): ScriptedTurn {
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

const shell = (command: string, extra: object = {}) =>
	call("shell", { command, ...extra });

function host(env = dirs.env): Host {
	return createHost({
		root: dirs.root,
		env,
		credentialStore: null,
		streamModel: scriptedModel((request) => {
			requests.push(request);
			return turns.shift() ?? say("done");
		}),
	});
}

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
	return {
		workspace: dirs.workspace,
		model: "scripted",
		models: {
			scripted: testModel,
			second: { ...testModel, model: "scripted-2" },
		},
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...extra,
	};
}

/** 这次打开的 session 的事件从头记起。 */
function onEvent(): (event: HostEvent) => void {
	log = new EventLog();
	const current = log;
	return (event) => {
		current.push(event);
		if (event.type === "approval.requested" && answer !== undefined) {
			session?.respond(event.request_id, answer(event));
		}
	};
}

async function open(
	extra: Partial<SessionOptions> = {},
	env = dirs.env,
): Promise<Session> {
	session = await host(env).openSession({
		...options(extra),
		onEvent: onEvent(),
	});
	return session;
}

/** 开始一个 task，模型依次给出 `script` 里的回复，等它结束。 */
async function task(input: string, ...script: ScriptedTurn[]) {
	if (session === undefined) throw new Error("session 还没有打开");
	turns.push(...script);
	const taskId = await session.submit(input);
	const ended = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	expect(ended).toMatchObject({ outcome: "completed" });
	return ended;
}

const file = (name: string) => join(dirs.workspace, name);
const read = (name: string) => readFileSync(file(name), "utf8");
const write = (name: string, content: string) =>
	writeFileSync(file(name), content);

function ofType<Type extends HostEvent["type"]>(
	type: Type,
): Extract<HostEvent, { type: Type }>[] {
	return log.events.filter(
		(event): event is Extract<HostEvent, { type: Type }> => event.type === type,
	);
}

function text(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/** 请求里用户说的话，按顺序；会话开始时的上下文消息不算。 */
function said(request: ModelRequest | undefined): string[] {
	return (request?.messages ?? [])
		.slice(2)
		.filter((message) => message.role === "user")
		.map(text);
}

const warnings = () => ofType("warning").map((event) => event.message);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立。 */
async function eventually(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("等待的情况没有出现");
		await sleep(20);
	}
}

describe("检查点和撤销", () => {
	test("每次用户输入一个检查点；撤销把这个检查点以来 agent 改过的文件还原，别的文件不动，再告诉模型", async () => {
		write("a.txt", "one\n");
		write("keep.txt", "mine\n");
		const current = await open();
		expect(current.checkpoints()).toEqual([]);
		expect(await current.diff()).toEqual({
			diff: "",
			unsnapshotted: [],
			failures: [],
		});

		await task(
			"第一步",
			shell("echo two > a.txt"),
			call("write", { path: "sub/new.txt", content: "new\n" }),
		);
		// agent 没碰过的文件，用户在两个 task 之间改了
		write("keep.txt", "mine, edited\n");
		await task("第二步", shell("echo three > a.txt; echo b > b.txt"));

		const checkpoints = current.checkpoints();
		expect(checkpoints).toMatchObject([
			{ kind: "task", text: "第一步", on_path: true, restorable: true },
			{ kind: "task", text: "第二步", on_path: true, restorable: true },
		]);
		const [first, second] = checkpoints.map(({ id }) => id) as [string, string];
		// 检查点的编号就是输入事件的编号
		expect(ofType("task.started").map((event) => event.event_id)).toEqual([
			first,
			second,
		]);

		const sinceSecond = await current.diff(second);
		expect(sinceSecond.diff).toContain("-two\n+three\n");
		expect(sinceSecond.diff).toContain("b.txt");
		expect(sinceSecond.diff).not.toContain("new.txt");
		expect(sinceSecond.diff).not.toContain("keep.txt");
		const all = await current.diff();
		expect(all.diff).toContain("-one\n+three\n");
		expect(all.diff).toContain("sub/new.txt");
		expect(all.diff).not.toContain("keep.txt");

		expect(await current.undo(second)).toEqual({
			restored: ["a.txt", "b.txt"],
			conflicts: [],
			unsnapshotted: [],
			failed: [],
			failures: [],
			outside: [],
		});
		expect(read("a.txt")).toBe("two\n");
		expect(existsSync(file("b.txt"))).toBe(false);
		expect(read("sub/new.txt")).toBe("new\n");
		expect(read("keep.txt")).toBe("mine, edited\n");

		expect((await current.undo(first)).restored).toEqual([
			"a.txt",
			"sub/new.txt",
		]);
		expect(read("a.txt")).toBe("one\n");
		expect(existsSync(file("sub/new.txt"))).toBe(false);
		expect(read("keep.txt")).toBe("mine, edited\n");
		// 撤销之后没有可还原的了
		expect((await current.diff()).diff).toBe("");

		// 对话没有动；模型在下一次输入时知道文件被还原了
		await task("接着做");
		expect(said(requests.at(-1))).toEqual([
			"第一步",
			"第二步",
			"接着做",
			expect.stringContaining("restored these files"),
		]);
		expect(said(requests.at(-1)).at(-1)).toContain("a.txt");
		expect(ofType("task.started").map((event) => event.source)).toEqual([
			"user",
			"user",
			"user",
		]);
	});

	test("agent 改过之后又被别处改过的文件是冲突：默认不还原，确认覆盖才还原", async () => {
		write("a.txt", "one\n");
		write("b.txt", "one\n");
		const current = await open();
		await task("改两个文件", shell("echo two > a.txt; echo two > b.txt"));
		write("a.txt", "user's version\n");
		const [checkpoint] = current.checkpoints();
		if (checkpoint === undefined) throw new Error("没有检查点");

		expect(await current.undo(checkpoint.id)).toMatchObject({
			restored: ["b.txt"],
			conflicts: ["a.txt"],
		});
		expect(read("a.txt")).toBe("user's version\n");
		expect(read("b.txt")).toBe("one\n");

		expect(
			await current.undo(checkpoint.id, { overwrite: true }),
		).toMatchObject({ restored: ["a.txt"], conflicts: [] });
		expect(read("a.txt")).toBe("one\n");
	});

	test("运行中插入的输入也有检查点：还原到它，是它送达之后第一次工具调用之前的样子", async () => {
		const current = await open();
		turns.push(shell("echo 1 > a.txt"), shell("echo 2 > a.txt"));
		const taskId = await current.submit("写文件");
		// 第一条命令执行的时候插入
		await log.waitFor("tool_call.started");
		current.steer("改成 2");
		await log.waitFor("task.ended", (event) => event.task_id === taskId);
		expect(read("a.txt")).toBe("2\n");

		const checkpoints = current.checkpoints();
		expect(checkpoints).toMatchObject([
			{ kind: "task", text: "写文件" },
			{ kind: "steering", text: "改成 2" },
		]);
		const [inserted] = ofType("input.inserted");
		expect(checkpoints[1]?.id).toBe(inserted?.event_id);

		expect((await current.undo(checkpoints[1]?.id as string)).restored).toEqual(
			["a.txt"],
		);
		expect(read("a.txt")).toBe("1\n");
	});

	test("后台命令的改动在它结束时记下，撤销时一起还原；撤销之前先结束还在运行的后台命令", async () => {
		const current = await open();
		await task(
			"后台写文件",
			shell("until [ -e go ]; do sleep 0.05; done; echo bg > bg.txt", {
				background: true,
			}),
		);
		write("go", "");
		await log.waitFor("background.ended");
		// 后台命令结束的通知唤醒一个 task，等它做完
		await log.waitFor("task.started", (e) => e.source === "notification");
		await current.whenIdle();
		const [checkpoint] = current.checkpoints();
		if (checkpoint === undefined) throw new Error("没有检查点");

		await task(
			"再起一条",
			shell("echo started > running.txt; sleep 60", { background: true }),
		);
		await eventually(() => existsSync(file("running.txt")));
		expect(current.backgroundCommands()).toHaveLength(1);

		const undone = await current.undo(checkpoint.id);
		// 后台命令运行期间分不清是谁改的：测试放的 `go` 也算在里面
		expect(undone.restored).toEqual(["bg.txt", "go", "running.txt"]);
		expect(existsSync(file("bg.txt"))).toBe(false);
		expect(existsSync(file("running.txt"))).toBe(false);
		expect(current.backgroundCommands()).toEqual([]);
		expect(ofType("background.ended").at(-1)).toMatchObject({
			reason: "stopped",
		});
	});

	test("被忽略的文件不保存，撤销时列为无快照；编辑工具改的文件即使被忽略也能还原", async () => {
		write(".gitignore", "*.log\nbuild/\n");
		mkdirSync(file("build"));
		write("build/out.js", "old\n");
		const current = await open();
		await task(
			"构建",
			call("read", { path: "build/out.js" }),
			call("write", { path: "build/out.js", content: "new\n" }),
			shell("echo line > debug.log; echo x > kept.txt"),
		);
		expect(read("build/out.js")).toBe("new\n");
		const [checkpoint] = current.checkpoints();
		if (checkpoint === undefined) throw new Error("没有检查点");

		const undone = await current.undo(checkpoint.id);
		expect(undone.restored).toEqual(["build/out.js", "kept.txt"]);
		expect(read("build/out.js")).toBe("old\n");
		expect(existsSync(file("kept.txt"))).toBe(false);
		// 命令写的被忽略的文件没有记录，撤销不知道它
		expect(read("debug.log")).toBe("line\n");
	});

	test("后台命令运行期间用编辑工具改一个被忽略的文件：撤销还原成原来的内容，不把它当成新建的删掉", async () => {
		write(".gitignore", "build/\n");
		mkdirSync(file("build"));
		write("build/out.js", "old\n");
		const current = await open();
		await task(
			"构建",
			shell("sleep 60", { background: true }),
			call("read", { path: "build/out.js" }),
			call("write", { path: "build/out.js", content: "new\n" }),
		);
		expect(read("build/out.js")).toBe("new\n");
		const [checkpoint] = current.checkpoints();
		if (checkpoint === undefined) throw new Error("没有检查点");

		expect((await current.undo(checkpoint.id)).restored).toEqual([
			"build/out.js",
		]);
		expect(read("build/out.js")).toBe("old\n");
	});

	test("只能在 session 空闲时撤销；没有这个检查点时拒绝，session 不受影响", async () => {
		const current = await open();
		await task("写", shell("echo 1 > a.txt"));
		const [checkpoint] = current.checkpoints();
		if (checkpoint === undefined) throw new Error("没有检查点");
		await expect(current.undo("no-such-checkpoint")).rejects.toThrow(
			SessionCommandError,
		);
		await expect(current.diff("no-such-checkpoint")).rejects.toThrow(
			SessionCommandError,
		);

		turns.push({ content: [], hang: true });
		const taskId = await current.submit("等着");
		await eventually(() => requests.length === 3);
		await expect(current.undo(checkpoint.id)).rejects.toThrow(
			/只能在 session 空闲时撤销改动/,
		);
		// task 运行中可以看改动
		expect((await current.diff()).diff).toContain("a.txt");
		await current.cancel();
		await log.waitFor("task.ended", (event) => event.task_id === taskId);
		expect(read("a.txt")).toBe("1\n");
	});

	test("PATH 里没有 git：打开 session 时警告，照常运行，只是不能看改动和撤销", async () => {
		const bin = join(dirs.home, "bin");
		mkdirSync(bin);
		const bash = (process.env.PATH ?? "")
			.split(delimiter)
			.map((dir) => join(dir, "bash"))
			.find((path) => existsSync(path));
		if (bash === undefined) throw new Error("测试环境里没有 bash");
		symlinkSync(bash, join(bin, "bash"));
		const current = await open({}, { ...dirs.env, PATH: bin });

		expect(warnings()).toEqual([
			expect.stringMatching(/^这个 session 不做快照.*PATH 里找不到 git/),
		]);
		await task("写", shell("echo 1 > a.txt"));
		expect(read("a.txt")).toBe("1\n");
		// 检查点照样有，可以回退对话
		const [checkpoint] = current.checkpoints();
		expect(checkpoint).toMatchObject({ text: "写", on_path: true });
		await expect(current.diff()).rejects.toThrow(SessionCommandError);
		await expect(current.undo(checkpoint?.id as string)).rejects.toThrow(
			/没有做快照/,
		);
	});

	test("恢复 session 之后还能撤销上次的改动", async () => {
		write("a.txt", "one\n");
		const first = await open();
		await task("改", shell("echo two > a.txt"));
		const id = first.id;
		await first.close();

		session = await host().resumeSession({
			...options(),
			sessionId: id,
			onEvent: onEvent(),
		});
		const [checkpoint] = session.checkpoints();
		expect(checkpoint).toMatchObject({ text: "改", restorable: true });
		expect((await session.undo(checkpoint?.id as string)).restored).toEqual([
			"a.txt",
		]);
		expect(read("a.txt")).toBe("one\n");
	});

	test("没有沙盒时编辑工具直接写到工作区之外的文件：撤销不了，列出来", async () => {
		const outside = join(dirs.home, "outside.txt");
		const current = await open();
		await task(
			"写",
			call("write", { path: "a.txt", content: "a\n" }),
			call("write", { path: outside, content: "out\n" }),
		);
		expect(readFileSync(outside, "utf8")).toBe("out\n");
		const [checkpoint] = current.checkpoints();

		expect(await current.undo(checkpoint?.id as string)).toMatchObject({
			restored: ["a.txt"],
			outside: [outside],
		});
		expect(existsSync(file("a.txt"))).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe("out\n");
	});

	test("只保留最近 100 个检查点的快照：更早的不能还原代码，还能回退对话", async () => {
		const current = await open();
		await task("第 1 步", shell("echo 1 > a.txt"));
		for (let step = 2; step <= 101; step += 1) {
			await task(`第 ${step} 步`);
		}
		const checkpoints = current.checkpoints();
		expect(checkpoints).toHaveLength(101);
		expect(checkpoints.map(({ restorable }) => restorable)).toEqual([
			false,
			...Array.from({ length: 100 }, () => true),
		]);
		const oldest = checkpoints[0]?.id as string;
		await expect(current.undo(oldest)).rejects.toThrow(/快照已经清理/);
		await expect(current.diff(oldest)).rejects.toThrow(SessionCommandError);
		// 全部改动里，快照已经清理的那一段只知道改过哪些文件
		expect(await current.diff()).toEqual({
			diff: "",
			unsnapshotted: ["a.txt"],
			failures: [],
		});

		await current.rewind(oldest);
		expect(current.history()).toEqual([]);
		expect(read("a.txt")).toBe("1\n");
	}, 120_000);

	test("超出保留数的检查点攒够 20 个才从影子仓库里删掉，剩下的在下次打开 session 时删掉", async () => {
		const current = await open();
		const id = current.id;
		/** 影子仓库里这个 session 还有快照的检查点。 */
		const kept = () =>
			readdirSync(join(dirs.root, "snapshots"), {
				recursive: true,
				encoding: "utf8",
			}).filter((path) => dirname(path).endsWith(join("ospreycode", id)))
				.length;
		for (let step = 1; step <= 119; step += 1) {
			await task(`第 ${step} 步`, shell("true"));
		}
		expect(kept()).toBe(119);
		await task("第 120 步", shell("true"));
		expect(kept()).toBe(100);
		await task("第 121 步", shell("true"));
		expect(kept()).toBe(101);
		expect(
			current.checkpoints().filter(({ restorable }) => restorable),
		).toHaveLength(100);
		await current.close();

		session = await host().resumeSession({
			...options(),
			sessionId: id,
			onEvent: onEvent(),
		});
		await eventually(() => kept() === 100);
	}, 180_000);
});

describe("回退", () => {
	test("只回退对话：当前位置移到那次输入之前，之后的输入接在那里，文件不动；回退记在记录里，恢复后还在", async () => {
		const current = await open();
		await task("第一步", shell("echo 1 > a.txt"), say("第一步做完了"));
		await task("第二步", shell("echo 2 > a.txt"), say("第二步做完了"));
		const before = current.history();
		const [, second] = current.checkpoints();
		if (second === undefined) throw new Error("没有第二个检查点");

		expect(await current.rewind(second.id)).toBeUndefined();
		expect(read("a.txt")).toBe("2\n");
		// 历史只剩第一个 task；第二个检查点还在，但不在路径上了
		const firstTask =
			before[0]?.type === "run.started" ? before[0].task_id : "";
		const kept = current.history();
		expect(kept.length).toBeGreaterThan(0);
		expect(kept).toEqual(
			before.filter(
				(event) => "task_id" in event && event.task_id === firstTask,
			),
		);
		expect(current.checkpoints()).toMatchObject([
			{ text: "第一步", on_path: true },
			{ text: "第二步", on_path: false, restorable: true },
		]);
		await expect(current.rewind(second.id)).rejects.toThrow(
			/不在当前的对话路径上/,
		);

		await task("换个做法");
		expect(said(requests.at(-1))).toEqual(["第一步", "换个做法"]);
		expect(
			requests
				.at(-1)
				?.messages.some((message) => text(message) === "第二步做完了"),
		).toBe(false);
		expect(current.checkpoints()).toMatchObject([
			{ text: "第一步", on_path: true },
			{ text: "第二步", on_path: false },
			{ text: "换个做法", on_path: true },
		]);
		const id = current.id;
		const history = current.history();
		await current.close();

		session = await host().resumeSession({
			...options(),
			sessionId: id,
			onEvent: onEvent(),
		});
		expect(session.history()).toEqual(history);
		await task("恢复之后");
		expect(said(requests.at(-1))).toEqual(["第一步", "换个做法", "恢复之后"]);
	});

	test("同时还原代码：文件回到那个检查点，返回还原的结果，不另外通知模型", async () => {
		write("a.txt", "zero\n");
		const current = await open();
		await task("第一步", shell("echo 1 > a.txt"));
		await task("第二步", shell("echo 2 > a.txt; echo b > b.txt"));
		const [first] = current.checkpoints();
		if (first === undefined) throw new Error("没有检查点");

		expect(await current.rewind(first.id, { code: true })).toMatchObject({
			restored: ["a.txt", "b.txt"],
			conflicts: [],
		});
		expect(read("a.txt")).toBe("zero\n");
		expect(existsSync(file("b.txt"))).toBe(false);
		// 回退到第一次输入之前：对话从头开始
		expect(current.history()).toEqual([]);
		await task("重新来");
		expect(said(requests.at(-1))).toEqual(["重新来"]);
	});

	test("回退到运行中插入的输入之前：那个 task 做到一半的部分留在历史里", async () => {
		const current = await open();
		turns.push(shell("echo 1 > a.txt"), shell("echo 2 > a.txt"), say("好了"));
		const taskId = await current.submit("写文件");
		await log.waitFor("tool_call.started");
		current.steer("改成 2");
		await log.waitFor("task.ended", (event) => event.task_id === taskId);
		const steering = current.checkpoints()[1];
		expect(steering).toMatchObject({ kind: "steering", on_path: true });

		await current.rewind(steering?.id as string);
		await task("改成 3");
		const messages = (requests.at(-1)?.messages ?? []).slice(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"user",
		]);
		expect(text(messages[0])).toBe("写文件");
		expect(text(messages[3])).toBe("改成 3");
	});

	test("结束这个检查点之后启动的后台命令，之前启动的保留；它们没交给模型的通知一起丢掉", async () => {
		const current = await open();
		await task("起服务", shell("sleep 60", { background: true }));
		await task(
			"再起一条",
			shell("until [ -e go ]; do sleep 0.05; done", { background: true }),
			shell("sleep 61", { background: true }),
		);
		const [earlier, finished, later] = ofType("background.started").map(
			(event) => event.background_id,
		);
		// 第二条在 session 空闲时结束：通知排着，等下一次输入
		write("go", "");
		await log.waitFor(
			"background.notification",
			(event) => event.background_id === finished,
		);
		// 通知唤醒的 task 结束之后再回退
		await current.whenIdle();
		const [, second] = current.checkpoints();

		await current.rewind(second?.id as string);
		expect(
			current.backgroundCommands().map((command) => command.background_id),
		).toEqual([earlier]);
		expect(
			ofType("background.ended").find((event) => event.background_id === later),
		).toMatchObject({ reason: "stopped" });

		await task("接着做");
		const heard = said(requests.at(-1)).join("\n");
		expect(heard).not.toContain(later as string);
		expect(heard).not.toContain(finished as string);
	});

	test("模型和推理强度按路径上的记录：回退到换模型之前，接着用那时的模型", async () => {
		const current = await open();
		await task("第一步");
		await current.setModel("second", "high");
		await task("第二步");
		expect(requests.map((request) => request.model)).toEqual([
			"scripted",
			"second",
		]);
		const [, second] = current.checkpoints();

		await current.rewind(second?.id as string);
		expect(current.config().model.id).toBe("scripted");
		expect(current.config().reasoningEffort).toBe(
			requests[0]?.reasoning_effort,
		);
		await task("换个做法");
		expect(requests.at(-1)).toMatchObject({
			model: "scripted",
			reasoning_effort: requests[0]?.reasoning_effort,
		});
		// 和路径上的记录相同，不算换过模型
		expect(ofType("model.changed")).toHaveLength(1);
	});

	test("只能在 session 空闲时回退；没有这个检查点时拒绝", async () => {
		const current = await open();
		await task("第一步");
		const [checkpoint] = current.checkpoints();
		await expect(current.rewind("no-such-checkpoint")).rejects.toThrow(
			SessionCommandError,
		);
		turns.push({ content: [], hang: true });
		const taskId = await current.submit("等着");
		await eventually(() => requests.length === 2);
		await expect(current.rewind(checkpoint?.id as string)).rejects.toThrow(
			/只能在 session 空闲时回退会话/,
		);
		await current.cancel();
		await log.waitFor("task.ended", (event) => event.task_id === taskId);
	});
});

describe("切回被放弃的分支", () => {
	test("对话回到那一段的末端，之后的输入接在那里，文件不动；现在这一段成为被放弃的分支，恢复后还在", async () => {
		const current = await open();
		await task("第一步", say("第一步做完了"));
		await task("第二步", shell("echo 2 > a.txt"), say("第二步做完了"));
		const original = current.history();
		expect(current.branches()).toEqual([]);
		const [, second] = current.checkpoints();
		await current.rewind(second?.id as string);
		const branches = current.branches();
		expect(branches).toMatchObject([{ text: "第二步" }]);
		await task("换个做法", shell("echo 3 > a.txt"), say("换好了"));

		await current.switchBranch(branches[0]?.id as string);
		expect(current.history()).toEqual(original);
		expect(read("a.txt")).toBe("3\n");
		expect(current.branches()).toMatchObject([{ text: "换个做法" }]);
		expect(current.checkpoints()).toMatchObject([
			{ text: "第一步", on_path: true },
			{ text: "第二步", on_path: true },
			{ text: "换个做法", on_path: false },
		]);

		await task("接着第二步");
		expect(said(requests.at(-1))).toEqual(["第一步", "第二步", "接着第二步"]);
		expect(
			requests.at(-1)?.messages.some((message) => text(message) === "换好了"),
		).toBe(false);
		const id = current.id;
		const history = current.history();
		await current.close();

		session = await host().resumeSession({
			...options(),
			sessionId: id,
			onEvent: onEvent(),
		});
		expect(session.history()).toEqual(history);
		expect(session.branches()).toMatchObject([{ text: "换个做法" }]);
	});

	test("结束不在那个分支上启动的后台命令，两个分支分开之前启动的保留", async () => {
		const current = await open();
		await task("起服务", shell("sleep 60", { background: true }));
		await task("第二步");
		const [, second] = current.checkpoints();
		await current.rewind(second?.id as string);
		await task("换个做法", shell("sleep 61", { background: true }));
		const [earlier, later] = ofType("background.started").map(
			(event) => event.background_id,
		);

		await current.switchBranch(current.branches()[0]?.id as string);
		expect(
			current.backgroundCommands().map((command) => command.background_id),
		).toEqual([earlier]);
		expect(
			ofType("background.ended").find((event) => event.background_id === later),
		).toMatchObject({ reason: "stopped" });
	});

	test("模型和推理强度按那个分支上的记录", async () => {
		const current = await open();
		await task("第一步");
		await current.setModel("second", "high");
		await task("第二步");
		const [, second] = current.checkpoints();
		await current.rewind(second?.id as string);
		expect(current.config().model.id).toBe("scripted");

		await current.switchBranch(current.branches()[0]?.id as string);
		expect(current.config().model.id).toBe("second");
		expect(current.config().reasoningEffort).toBe("high");
		await task("接着做");
		expect(requests.at(-1)).toMatchObject({
			model: "second",
			reasoning_effort: "high",
		});
	});

	test("只能在 session 空闲时切换；没有这个分支时拒绝", async () => {
		const current = await open();
		await task("第一步");
		await task("第二步");
		const [, second] = current.checkpoints();
		await current.rewind(second?.id as string);
		const [branch] = current.branches();
		await expect(current.switchBranch("no-such-branch")).rejects.toThrow(
			SessionCommandError,
		);
		turns.push({ content: [], hang: true });
		const taskId = await current.submit("等着");
		await eventually(() => requests.length === 3);
		await expect(current.switchBranch(branch?.id as string)).rejects.toThrow(
			/只能在 session 空闲时切换分支/,
		);
		await current.cancel();
		await log.waitFor("task.ended", (event) => event.task_id === taskId);
	});
});

describe("分叉", () => {
	test("从当前位置分叉：新的 session 沿用到此为止的对话和检查点，之后各写各的，来源 session 不变", async () => {
		write("a.txt", "zero\n");
		const parent = await open();
		await task("第一步", shell("echo 1 > a.txt"), say("第一步做完了"));
		const parentId = parent.id;
		const parentHistory = parent.history();
		const [inherited] = parent.checkpoints();
		await parent.close();
		const started = log.events[0];
		if (started?.type !== "session.started") throw new Error("没有开始事件");
		const recorded = () => {
			const store = SessionStore.open(
				join(
					dirs.root,
					"data",
					"projects",
					started.project_id,
					"sessions.sqlite",
				),
			);
			try {
				return store.events(parentId).length;
			} finally {
				store.close();
			}
		};
		const before = recorded();

		const forking = host();
		session = await forking.forkSession({
			...options(),
			sessionId: parentId,
			onEvent: onEvent(),
		});
		const fork = session;
		expect(fork.id).not.toBe(parentId);
		expect(fork.history()).toEqual(parentHistory);
		expect(fork.checkpoints()).toEqual([inherited]);

		await task("分叉里的第二步", shell("echo 2 > a.txt"));
		expect(said(requests.at(-1))).toEqual(["第一步", "分叉里的第二步"]);
		expect(
			requests
				.at(-1)
				?.messages.some((message) => text(message) === "第一步做完了"),
		).toBe(true);
		expect(fork.checkpoints()).toMatchObject([
			{ text: "第一步", on_path: true, restorable: true },
			{ text: "分叉里的第二步", on_path: true, restorable: true },
		]);

		// 沿用的检查点在分叉里也能还原代码
		expect((await fork.undo(inherited?.id as string)).restored).toEqual([
			"a.txt",
		]);
		expect(read("a.txt")).toBe("zero\n");
		await fork.close();

		expect(recorded()).toBe(before);
		expect(
			forking.sessionForks({ sessionId: parentId, directory: dirs.workspace }),
		).toEqual([fork.id]);
		expect(
			forking
				.listSessions({ directory: dirs.workspace })
				.map((info) => info.session_id)
				.toSorted(),
		).toEqual([parentId, fork.id].toSorted());

		// 来源 session 接着自己的对话，看不到分叉里的内容
		session = await host().resumeSession({
			...options(),
			sessionId: parentId,
			onEvent: onEvent(),
		});
		expect(session.history()).toEqual(parentHistory);
		expect(session.checkpoints()).toMatchObject([{ text: "第一步" }]);
		await task("来源里的第二步");
		expect(said(requests.at(-1))).toEqual(["第一步", "来源里的第二步"]);
	});

	test("从某个检查点分叉：只沿用那次输入之前的对话", async () => {
		const parent = await open();
		await task("第一步", say("一"));
		await task("第二步", say("二"));
		await task("第三步", say("三"));
		const parentId = parent.id;
		const checkpoints = parent.checkpoints();
		await parent.close();

		session = await host().forkSession({
			...options(),
			sessionId: parentId,
			checkpointId: checkpoints[2]?.id as string,
			onEvent: onEvent(),
		});
		expect(ofType("session.started")).toHaveLength(1);
		// 父 session 的检查点索引整个沿用：不在路径上的也在里面，只用来还原代码，读不到那次输入
		expect(session.checkpoints()).toMatchObject([
			{ text: "第一步", on_path: true },
			{ text: "第二步", on_path: true },
			{ text: null, time: null, on_path: false, restorable: true },
		]);
		await task("另一个第三步");
		expect(said(requests.at(-1))).toEqual(["第一步", "第二步", "另一个第三步"]);
	});

	test("删除来源 session 之后，分叉的对话还是完整的", async () => {
		const parent = await open();
		await task("第一步", say("一"));
		const parentId = parent.id;
		await parent.close();
		const admin = host();
		session = await admin.forkSession({
			...options(),
			sessionId: parentId,
			onEvent: onEvent(),
		});
		const forkId = session.id;
		await task("第二步", say("二"));
		const history = session.history();
		await session.close();

		await admin.deleteSession({
			sessionId: parentId,
			directory: dirs.workspace,
		});
		session = await host().resumeSession({
			...options(),
			sessionId: forkId,
			onEvent: onEvent(),
		});
		// 沿用的那一段改记到了分叉名下：内容和顺序不变
		const strip = (events: HostEvent[]) =>
			events.map(({ session_id: _session, ...event }) => event);
		expect(strip(session.history())).toEqual(strip(history));
		await task("第三步");
		expect(said(requests.at(-1))).toEqual(["第一步", "第二步", "第三步"]);
	});

	test("没有另外指定模型时，恢复和分叉接着用路径上最后一次请求的模型；指定了别的就记一次换模型", async () => {
		const parent = await open();
		await task("第一步");
		await parent.setModel("second", "high");
		await task("第二步");
		const parentId = parent.id;
		await parent.close();
		const { model: _model, ...unspecified } = options();

		session = await host().forkSession({
			...unspecified,
			sessionId: parentId,
			onEvent: onEvent(),
		});
		expect(session.config()).toMatchObject({
			model: { id: "second" },
			reasoningEffort: "high",
		});
		expect(ofType("session.started")).toMatchObject([{ model: "second" }]);
		await task("分叉里接着做");
		expect(requests.at(-1)).toMatchObject({
			model: "second",
			reasoning_effort: "high",
		});
		expect(ofType("model.changed")).toEqual([]);
		await session.close();

		session = await host().resumeSession({
			...options({ model: "scripted" }),
			sessionId: parentId,
			onEvent: onEvent(),
		});
		expect(session.config().model.id).toBe("scripted");
		await task("换回原来的模型");
		expect(ofType("model.changed")).toMatchObject([
			{ model: "scripted", previous_model: "second" },
		]);
	});

	test("不存在的 session 和检查点、第一次输入之前、停在没有结束的 task 里的位置，都不能分叉", async () => {
		const parent = await open();
		await task("第一步");
		const parentId = parent.id;
		const [first] = parent.checkpoints();
		const fork = (extra: { sessionId: string; checkpointId?: string }) =>
			host().forkSession({ ...options(), ...extra, onEvent: () => {} });
		// 来源 session 还开着：这个工作区已经有打开的 session
		await expect(fork({ sessionId: parentId })).rejects.toThrow(WorkspaceError);
		await parent.close();

		await expect(
			fork({ sessionId: "0193e2a0-0000-7000-8000-000000000000" }),
		).rejects.toThrow(/没有 session/);
		await expect(
			fork({ sessionId: parentId, checkpointId: "no-such-checkpoint" }),
		).rejects.toThrow(/没有检查点/);
		await expect(
			fork({ sessionId: parentId, checkpointId: first?.id as string }),
		).rejects.toThrow(/之前还没有对话/);
		// 没有分叉成的尝试不留下 session 和锁
		const admin = host();
		expect(admin.listSessions({ directory: dirs.workspace })).toHaveLength(1);
		session = await fork({ sessionId: parentId });
		expect(
			admin.sessionForks({ sessionId: parentId, directory: dirs.workspace }),
		).toEqual([session.id]);
	});
});

describe.runIf(process.platform === "darwin")(
	"真实沙盒里的快照（macOS，脚本模型）",
	() => {
		const sandboxed = {
			sandboxMode: "workspace-write",
			approvalPolicy: "on-request",
		} as const;

		test("git 在快照沙盒里运行：命令和编辑工具的改动都能撤销；批准后写到工作区外的文件列为撤销不了", async () => {
			write("a.txt", "one\n");
			const outside = join(dirs.home, "outside.txt");
			answer = () => ({ decision: "approve", scope: "once" });
			const current = await open(sandboxed);
			await task(
				"改文件",
				shell("echo two > a.txt"),
				call("write", { path: "b.txt", content: "b\n" }),
				call("write", { path: outside, content: "out\n" }),
			);
			expect(read("a.txt")).toBe("two\n");
			expect(readFileSync(outside, "utf8")).toBe("out\n");
			expect(warnings()).toEqual([]);
			const [checkpoint] = current.checkpoints();
			if (checkpoint === undefined) throw new Error("没有检查点");

			expect((await current.diff()).diff).toContain("-one\n+two\n");
			expect(await current.undo(checkpoint.id)).toEqual({
				restored: ["a.txt", "b.txt"],
				conflicts: [],
				unsnapshotted: [],
				failed: [],
				failures: [],
				outside: [outside],
			});
			expect(read("a.txt")).toBe("one\n");
			expect(existsSync(file("b.txt"))).toBe(false);
			expect(readFileSync(outside, "utf8")).toBe("out\n");
		});

		test("沙盒读不到的文件不保存进快照：警告一次，撤销时列为无快照", async () => {
			write("secret.txt", "key\n");
			write("a.txt", "one\n");
			const current = await open({
				...sandboxed,
				denyRead: [file("secret.txt")],
			});
			await task("改文件", shell("echo two > a.txt"));
			expect(warnings()).toEqual([
				expect.stringMatching(/这些文件没有保存进快照.*secret\.txt/),
			]);
			// 用户自己改了它：不是 agent 的改动，撤销不管
			write("secret.txt", "rotated\n");
			const [checkpoint] = current.checkpoints();
			const undone = await current.undo(checkpoint?.id as string);
			expect(undone.restored).toEqual(["a.txt"]);
			expect(read("secret.txt")).toBe("rotated\n");
			expect(warnings()).toHaveLength(1);
		});
	},
);

test("影子仓库放在 Host 根目录下，agent 的沙盒写不到；工作区里不留下任何东西", async () => {
	chmodSync(dirs.workspace, 0o755);
	await open();
	await task("写", shell("echo 1 > a.txt"));
	const snapshots = join(dirs.root, "snapshots");
	expect(existsSync(snapshots)).toBe(true);
	expect(existsSync(file(".git"))).toBe(false);
	expect(existsSync(file(".ospreycode"))).toBe(false);
});
