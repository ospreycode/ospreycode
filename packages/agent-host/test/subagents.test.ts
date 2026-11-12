import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHost,
	type Host,
	type HostEvent,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import { SessionStore } from "@ospreycode/session-store";
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
/** 主 agent 和子 agent 各自收到的请求，按顺序。 */
let mainRequests: ModelRequest[];
let childRequests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	mainRequests = [];
	childRequests = [];
	mkdirSync(dirs.root, { mode: 0o700 });
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

/** 用户级配置里的子 agent 定义。 */
function agents(text: string): void {
	writeFileSync(join(dirs.root, "config.toml"), text);
}

const explorer = `
[agents.explorer]
description = "Looks things up in the repository."
`;

function reply(text: string, usage?: ScriptedTurn["usage"]): ScriptedTurn {
	return {
		content: [{ type: "text", text }],
		...(usage === undefined ? {} : { usage }),
	};
}

function call(name: string, args: object): ScriptedTurn {
	return calls([name, args]);
}

/** 一条回复里的几个工具调用。 */
function calls(...list: [name: string, args: object][]): ScriptedTurn {
	return {
		content: list.map(([name, args]) => ({
			type: "tool_call",
			call_id: `call_${crypto.randomUUID()}`,
			name,
			arguments: JSON.stringify(args),
		})),
	};
}

const hanging: ScriptedTurn = {
	content: [{ type: "text", text: "还在做" }],
	hang: true,
};

function text(message: Message | undefined): string {
	if (message === undefined) return "";
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/** 子 agent 的系统指令里写着它是谁启动的。 */
function isChild(request: ModelRequest): boolean {
	return text(request.messages[0]).includes("You are running as the subagent");
}

/** 一方的脚本：依次给出的回复（用完之后回复一句话），或者按请求算出回复的函数。 */
type Side =
	| ScriptedTurn[]
	| ((request: ModelRequest, index: number) => ScriptedTurn);

function turn(side: Side, request: ModelRequest, index: number): ScriptedTurn {
	return typeof side === "function"
		? side(request, index)
		: (side[index] ?? reply("done"));
}

/** 主 agent 和子 agent 共用一个脚本模型，按系统指令分开，各自从 0 数自己的请求。 */
function host(main: Side, child: Side = []): Host {
	return createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request) => {
			if (isChild(request)) {
				childRequests.push(request);
				return turn(child, request, childRequests.length - 1);
			}
			mainRequests.push(request);
			return turn(main, request, mainRequests.length - 1);
		}),
	});
}

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
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

async function open(
	main: Side,
	child: Side = [],
	extra: Partial<SessionOptions> = {},
	onEvent: (event: HostEvent) => void = () => {},
): Promise<Session> {
	session = await host(main, child).openSession({
		...options(extra),
		onEvent: (event) => {
			log.push(event);
			onEvent(event);
		},
	});
	return session;
}

async function runTask(input = "开始") {
	if (session === undefined) throw new Error("session 还没有打开");
	const taskId = await session.submit(input);
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

function results(): ToolResult[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result] : [],
	);
}

function resultText(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function toolNames(request: ModelRequest | undefined): string[] {
	return (request?.tools ?? []).map((tool) => tool.name);
}

/** 请求里所有 user 消息的文字。 */
function userTexts(request: ModelRequest | undefined): string[] {
	return (request?.messages ?? [])
		.filter((message) => message.role === "user")
		.map(text);
}

const spawnExplorer = call("spawn_agent", {
	agent: "explorer",
	prompt: "Find the entry point.",
});

/** 主 agent 收到的工具结果和通知里写着的那个子 agent 的标识。 */
function spawnedId(request: ModelRequest): string {
	const id = request.messages
		.map((message) => /Its id is ([0-9a-f-]{36})\./.exec(text(message))?.[1])
		.find((found) => found !== undefined);
	if (id === undefined) throw new Error("请求里没有子 agent 的标识");
	return id;
}

function ofType<Type extends HostEvent["type"]>(
	type: Type,
): Extract<HostEvent, { type: Type }>[] {
	return log.events.filter(
		(event): event is Extract<HostEvent, { type: Type }> => event.type === type,
	);
}

describe("启动和结果", () => {
	test("启动的子 agent 是另一个进程里的一次 run：有自己的 agent 标识，结束后最终回复作为通知回到主 agent，用量计入 task", async () => {
		agents(explorer);
		await open(
			[
				spawnExplorer,
				reply("等它的结果", { input: 10, output: 5 }),
				reply("入口是 src/main.ts"),
			],
			[reply("The entry point is src/main.ts.", { input: 100, output: 20 })],
		);
		const ended = await runTask();
		expect(ended).toMatchObject({ outcome: "completed" });

		const [mainRun, childRun, ...more] = ofType("run.started");
		if (mainRun === undefined || childRun === undefined) {
			throw new Error("没有两个 run");
		}
		expect(more).toEqual([]);
		expect(childRun).toMatchObject({
			task_id: mainRun.task_id,
			parent_agent_id: mainRun.agent_id,
			parent_tool_call_id: ofType("tool_call.started")[0]?.tool_call_id,
		});
		expect(childRun.agent_id).not.toBe(mainRun.agent_id);
		expect(childRun.run_id).not.toBe(mainRun.run_id);
		expect(mainRun.parent_agent_id).toBeUndefined();
		expect(ofType("subagent.started")).toMatchObject([
			{
				agent_id: childRun.agent_id,
				run_id: childRun.run_id,
				name: "explorer",
				model: "scripted",
				sandbox_mode: "danger-full-access",
				workspace: dirs.workspace,
			},
		]);
		expect(resultText(results()[0])).toContain(
			`Started the subagent explorer. Its id is ${childRun.agent_id}.`,
		);

		// 子 agent 从空白的上下文开始，第一条输入是主 agent 写的任务
		expect(childRequests).toHaveLength(1);
		expect(userTexts(childRequests[0]).at(-1)).toBe("Find the entry point.");
		expect(userTexts(childRequests[0]).join("\n")).not.toContain("开始");
		// 它的回复是带着自己标识的事件
		expect(
			ofType("message.completed")
				.filter((event) => event.agent_id === childRun.agent_id)
				.map((event) => text(event.message)),
		).toEqual(["The entry point is src/main.ts."]);

		expect(ofType("subagent.ended")).toMatchObject([
			{
				agent_id: childRun.agent_id,
				outcome: "completed",
				usage: { input: 100, output: 20 },
			},
		]);
		// 主 agent 回复完了还在等子 agent：结果到了接着请求模型
		expect(mainRequests).toHaveLength(3);
		const notice = userTexts(mainRequests[2]).at(-1) ?? "";
		expect(notice).toContain("Automatic notification, not user input.");
		expect(notice).toContain(
			`Subagent explorer (${childRun.agent_id}) finished. Its final reply:\nThe entry point is src/main.ts.`,
		);
		expect(ended.usage).toMatchObject({ input: 110, output: 25 });
		expect(log.types().indexOf("subagent.ended")).toBeLessThan(
			log.types().indexOf("task.ended"),
		);
	});

	test("没有定义时主 agent 没有子 agent 的工具；有定义时列表在上下文里，名字不对的启动不了", async () => {
		await open([reply("好的")]);
		await runTask();
		expect(toolNames(mainRequests[0])).not.toContain("spawn_agent");
		expect(userTexts(mainRequests[0]).join("\n")).not.toContain("<subagents>");
		await session?.close();

		agents(explorer);
		mainRequests = [];
		await open([call("spawn_agent", { agent: "reviewer", prompt: "看一遍" })]);
		expect(await runTask()).toMatchObject({ outcome: "completed" });
		expect(toolNames(mainRequests[0])).toEqual(
			expect.arrayContaining([
				"spawn_agent",
				"send_message",
				"interrupt_agent",
			]),
		);
		expect(userTexts(mainRequests[0]).join("\n")).toContain(
			"- explorer: Looks things up in the repository.",
		);
		expect(results()).toMatchObject([{ status: "failed" }]);
		expect(resultText(results()[0])).toContain(
			"There is no subagent named reviewer. The subagents are: explorer.",
		);
		expect(log.types()).not.toContain("subagent.started");
		expect(childRequests).toEqual([]);
	});

	test("子 agent 不能再启动子 agent，也没有记忆工具；定义里的指令在它的上下文里，列了工具的只有这些工具", async () => {
		agents(`
${explorer}
instructions = "Only read files. Report paths."

[agents.reader]
description = "Reads one file."
tools = ["read", "grep"]
`);
		await open(
			[
				calls(
					["spawn_agent", { agent: "explorer", prompt: "explore" }],
					["spawn_agent", { agent: "reader", prompt: "read" }],
				),
				reply("等"),
			],
			(request) =>
				reply(userTexts(request).at(-1) === "read" ? "read it" : "explored"),
			{ memory: { enabled: true } },
		);
		expect(await runTask()).toMatchObject({ outcome: "completed" });
		expect(toolNames(mainRequests[0])).toEqual(
			expect.arrayContaining(["memory_search", "spawn_agent", "shell"]),
		);
		const explore = childRequests.find(
			(request) => userTexts(request).at(-1) === "explore",
		);
		const read = childRequests.find(
			(request) => userTexts(request).at(-1) === "read",
		);
		expect(toolNames(explore).sort()).toEqual(
			toolNames(mainRequests[0])
				.filter(
					(name) =>
						!name.startsWith("memory_") &&
						!["spawn_agent", "send_message", "interrupt_agent"].includes(name),
				)
				.sort(),
		);
		expect(toolNames(explore)).toContain("shell");
		expect(toolNames(read).sort()).toEqual(["grep", "read"]);
		expect(userTexts(explore).join("\n")).toContain(
			'<subagent_instructions name="explorer">\nOnly read files. Report paths.\n</subagent_instructions>',
		);
		expect(userTexts(explore).join("\n")).not.toContain("<subagents>");
		expect(userTexts(read).join("\n")).not.toContain("<subagent_instructions");
		expect(text(read?.messages[0])).toContain(
			"You are running as the subagent reader",
		);
	});
});

describe("运行中的子 agent", () => {
	test("send_message 的内容在子 agent 的下一次模型请求之前插入", async () => {
		agents(explorer);
		const started = join(dirs.workspace, "started");
		const sent = join(dirs.workspace, "sent");
		const waitFor = (path: string) =>
			`while [ ! -e ${path} ]; do sleep 0.05; done`;
		await open(
			(request, index) =>
				[
					spawnExplorer,
					// 子 agent 的第一次请求发出之后再发消息
					call("shell", { command: waitFor(started) }),
					call("send_message", {
						agent_id: index === 2 ? spawnedId(request) : "",
						message: "Also check the tests.",
					}),
					// 消息排上之后才放子 agent 往下走
					call("shell", { command: `touch ${sent}` }),
					reply("等"),
				][index] ?? reply("好了"),
			[
				call("shell", { command: `touch ${started}; ${waitFor(sent)}` }),
				reply("Checked both."),
			],
		);
		expect(await runTask()).toMatchObject({ outcome: "completed" });
		expect(resultText(results()[2])).toBe("The message was sent.");
		expect(childRequests).toHaveLength(2);
		expect(userTexts(childRequests[0]).join("\n")).not.toContain(
			"Also check the tests.",
		);
		expect(userTexts(childRequests[1]).at(-1)).toContain(
			"Also check the tests.",
		);
		expect(userTexts(mainRequests.at(-1)).at(-1)).toContain(
			"finished. Its final reply:\nChecked both.",
		);
	});

	test("interrupt_agent 停止子 agent：它以 cancelled 结束，结果不再通知；已经结束的不能再停、不能再发消息", async () => {
		agents(explorer);
		await open(
			(request, index) =>
				[
					spawnExplorer,
					call("interrupt_agent", {
						agent_id: index === 1 ? spawnedId(request) : "",
					}),
					calls(
						[
							"interrupt_agent",
							{ agent_id: index === 2 ? spawnedId(request) : "" },
						],
						[
							"send_message",
							{
								agent_id: index === 2 ? spawnedId(request) : "",
								message: "还在吗",
							},
						],
					),
				][index] ?? reply("停了"),
			() => hanging,
		);
		expect(await runTask()).toMatchObject({ outcome: "completed" });
		const [child] = ofType("subagent.started");
		expect(ofType("subagent.ended")).toMatchObject([
			{ agent_id: child?.agent_id, outcome: "cancelled" },
		]);
		expect(results().map((result) => result.status)).toEqual([
			"succeeded",
			"succeeded",
			"failed",
			"failed",
		]);
		expect(resultText(results()[1])).toBe("The subagent was stopped.");
		expect(resultText(results()[2])).toContain(
			`No running subagent has the id ${child?.agent_id}`,
		);
		expect(log.types()).not.toContain("background.notification");
		expect(mainRequests).toHaveLength(4);
	});

	test("同一个主 agent 同时最多 6 个子 agent；取消 task 时它们都先以 cancelled 结束", async () => {
		agents(explorer);
		await open(
			[
				calls(
					...Array.from({ length: 7 }, (_, index): [string, object] => [
						"spawn_agent",
						{ agent: "explorer", prompt: `part ${index}` },
					]),
				),
				reply("等它们"),
			],
			() => hanging,
		);
		if (session === undefined) throw new Error("session 还没有打开");
		const taskId = await session.submit("开始");
		// 主 agent 回复完了，在等子 agent
		await log.waitFor(
			"message.completed",
			(event) => text(event.message) === "等它们",
		);
		expect(ofType("subagent.started")).toHaveLength(6);
		const refused = results().filter((result) => result.status === "failed");
		expect(refused).toHaveLength(1);
		expect(resultText(refused[0])).toContain(
			"6 subagents are already running, which is the limit.",
		);

		await session.cancel();
		const ended = await log.waitFor("task.ended", (e) => e.task_id === taskId);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		const outcomes = ofType("subagent.ended").map((event) => event.outcome);
		expect(outcomes).toEqual(Array.from({ length: 6 }, () => "cancelled"));
		expect(log.types().lastIndexOf("subagent.ended")).toBeLessThan(
			log.types().indexOf("task.ended"),
		);
		expect(log.types()).not.toContain("background.notification");
	});

	test("子 agent 的进程握手之后退出：记成 failed 并发警告，原因作为通知交给主 agent，task 照常进行", async () => {
		agents(explorer);
		await open([spawnExplorer, reply("等")], () => hanging);
		if (session === undefined) throw new Error("session 还没有打开");
		const taskId = await session.submit("开始");
		await log.waitFor("subagent.started");
		const main = ofType("process.started").find(
			(event) => event.kind === "agent",
		)?.pid;
		// 子 agent 的进程不发进程事件，只在进程登记表里
		const { processes } = JSON.parse(
			readFileSync(join(dirs.root, "data", "processes.json"), "utf8"),
		) as { processes: { pid: number; kind: string }[] };
		const others = processes.filter(
			(record) => record.kind === "agent" && record.pid !== main,
		);
		expect(others).toHaveLength(1);
		process.kill(others[0]?.pid as number, "SIGKILL");

		const ended = await log.waitFor("task.ended", (e) => e.task_id === taskId);
		expect(ended).toMatchObject({ outcome: "completed" });
		expect(ofType("subagent.ended")).toMatchObject([
			{ outcome: "failed", error: expect.stringContaining("SIGKILL") },
		]);
		expect(
			ofType("warning").some((event) =>
				event.message.startsWith("子 agent explorer 异常退出"),
			),
		).toBe(true);
		expect(userTexts(mainRequests.at(-1)).at(-1)).toMatch(
			/Subagent explorer \([0-9a-f-]{36}\) failed: /,
		);
		// 失败的通知里是原因，不引用哪条回复
		expect(ofType("background.notification")).toHaveLength(1);
		expect(ofType("background.notification")[0]).not.toHaveProperty(
			"message_id",
		);
	});
});

/** 每次都调用 shell 的子 agent：不加上限就不会停。 */
const busy = (): ScriptedTurn => call("shell", { command: "true" });

describe("预算", () => {
	test("子 agent 的请求计入同一个 task 的上限：超出时整个 task 停止，子 agent 先结束", async () => {
		agents(explorer);
		await open([spawnExplorer, reply("等")], busy, {
			budget: { maxRequests: 4 },
		});
		const ended = await runTask();
		expect(ended).toMatchObject({
			outcome: "budget_exceeded",
			limit: "requests",
		});
		expect(mainRequests.length + childRequests.length).toBe(4);
		expect(childRequests.length).toBeGreaterThanOrEqual(2);
		expect(ofType("subagent.ended")).toMatchObject([{ outcome: "cancelled" }]);
		expect(log.types().indexOf("subagent.ended")).toBeLessThan(
			log.types().indexOf("task.ended"),
		);
	});

	test("交互模式下几个子 agent 同时超出时只问用户一次，拒绝后一起停止", async () => {
		agents(explorer);
		await open(
			[
				calls(
					["spawn_agent", { agent: "explorer", prompt: "one" }],
					["spawn_agent", { agent: "explorer", prompt: "two" }],
				),
				reply("等"),
			],
			busy,
			{ approvalPolicy: "on-request", budget: { maxRequests: 2 } },
			(event) => {
				if (event.type === "approval.requested" && event.kind === "budget") {
					// 等主 agent 和两个子 agent 的下一次请求都到了再回答
					setTimeout(() => {
						session?.respond(event.request_id, {
							decision: "deny",
							scope: "once",
						});
					}, 300);
				}
			},
		);
		expect(await runTask()).toMatchObject({
			outcome: "budget_exceeded",
			limit: "requests",
		});
		const asked = ofType("approval.requested");
		expect(asked).toMatchObject([{ kind: "budget", limit: "requests" }]);
		// 问的是整个 task 的预算，记在主 agent 的 run 上
		expect(asked[0]?.agent_id).toBe(ofType("run.started")[0]?.agent_id);
		expect(mainRequests.length + childRequests.length).toBe(2);
		expect(ofType("subagent.ended").map((event) => event.outcome)).toEqual([
			"cancelled",
			"cancelled",
		]);
	});
});

describe("记录", () => {
	test("子 agent 的对话不在主 agent 的历史里：history() 只有结果的通知，下一个 task 和恢复之后的请求以原来的历史为前缀", async () => {
		agents(explorer);
		await open(
			[spawnExplorer, reply("等"), reply("第一次回答"), reply("第二次回答")],
			[reply("The entry point is src/main.ts.")],
		);
		if (session === undefined) throw new Error("session 还没有打开");
		await runTask("第一个任务");
		const child = ofType("subagent.started")[0]?.agent_id;
		const history = session.history();
		expect(history.map((event) => event.type)).not.toContain(
			"subagent.started",
		);
		expect(
			history.some((event) => "agent_id" in event && event.agent_id === child),
		).toBe(false);
		expect(history.map((event) => event.type)).toContain(
			"background.notification",
		);

		await runTask("第二个任务");
		const [, , before, after] = mainRequests as ModelRequest[];
		if (before === undefined || after === undefined) {
			throw new Error("没有四次请求");
		}
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);
		const id = session.id;
		await session.close();

		log = new EventLog();
		mainRequests = [];
		session = await host([reply("第三次回答")]).resumeSession({
			...options(),
			sessionId: id,
			onEvent: log.push,
		});
		expect(await runTask("第三个任务")).toMatchObject({ outcome: "completed" });
		const [resumed] = mainRequests as [ModelRequest];
		expect(resumed.messages.slice(0, after.messages.length)).toEqual(
			after.messages,
		);
		expect(childRequests).toHaveLength(1);
	});

	test("按事件脱敏：指名子 agent 最后一条回复时，父 run 里引用它的结果通知一起覆盖；把通知交给模型的那条消息另外指名", async () => {
		agents(explorer);
		await open(
			[spawnExplorer, reply("等"), reply("知道了")],
			[reply("The token is CHILD-SECRET.")],
		);
		if (session === undefined) throw new Error("session 还没有打开");
		await runTask();
		const child = ofType("subagent.started")[0]?.agent_id;
		const said = ofType("message.completed").find(
			(event) => event.agent_id === child,
		);
		const notice = ofType("background.notification")[0];
		const projectId = ofType("session.started")[0]?.project_id;
		if (said === undefined || notice === undefined || projectId === undefined) {
			throw new Error("没有子 agent 的回复和结果通知");
		}
		expect(notice.message_id).toBe(said.message.message_id);
		const target = { directory: dirs.workspace, sessionId: session.id };
		await session.close();

		const first = await host([]).redactEvents({
			...target,
			eventIds: [said.event_id],
		});
		expect(first.events).toContain(said.event_id);
		expect(first.events).toContain(notice.event_id);

		const store = SessionStore.open(
			join(dirs.root, "data", "projects", projectId, "sessions.sqlite"),
		);
		const delivered = store
			.events(target.sessionId)
			.find(
				(event) =>
					event.type === "message.sent" &&
					event.run_id === notice.run_id &&
					JSON.stringify(event.data).includes("CHILD-SECRET"),
			);
		store.close();
		if (delivered === undefined) throw new Error("没有带着通知的消息");
		expect(first.events).not.toContain(delivered.event_id);
		await host([]).redactEvents({ ...target, eventIds: [delivered.event_id] });

		log = new EventLog();
		mainRequests = [];
		session = await host([reply("接上了")]).resumeSession({
			...options(),
			sessionId: target.sessionId,
			onEvent: log.push,
		});
		expect(await runTask("接着做")).toMatchObject({ outcome: "completed" });
		expect(JSON.stringify(mainRequests[0])).not.toContain("CHILD-SECRET");
		expect(JSON.stringify(session.history())).not.toContain("CHILD-SECRET");
	});

	test("中断时还在运行的子 agent 不恢复：恢复时它的 run 以 failed 结束，没有结果的 spawn_agent 记成 interrupted，模型在下一个 task 里知道", async () => {
		agents(explorer);
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
					turns: [spawnExplorer],
					crashOn: "subagent.started",
					input: "开始",
					approvalPolicy: "never",
					sandboxMode: "danger-full-access",
				}),
			],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		const [, signal] = await once(child, "exit");
		expect(signal).toBe("SIGKILL");
		const [interrupted] = host([]).listSessions({ directory: dirs.workspace });
		if (interrupted === undefined) throw new Error("没有中断的 session");

		// never 下也能恢复：不用问用户
		session = await host([reply("知道了")]).resumeSession({
			...options(),
			sessionId: interrupted.session_id,
			onEvent: log.push,
		});
		expect(log.types().slice(0, 4)).toEqual([
			"session.started",
			"tool_call.completed",
			"subagent.ended",
			"background.notification",
		]);
		expect(ofType("tool_call.completed")).toMatchObject([
			{ result: { status: "interrupted" } },
		]);
		expect(ofType("subagent.ended")).toMatchObject([
			{ outcome: "failed", error: expect.stringContaining("没有正常关闭") },
		]);
		expect(ofType("task.ended")).toMatchObject([{ outcome: "failed" }]);
		// 留下的子 agent 进程已经清理掉
		const { processes } = JSON.parse(
			readFileSync(join(dirs.root, "data", "processes.json"), "utf8"),
		) as { processes: { kind: string }[] };
		expect(processes.filter((record) => record.kind === "agent")).toHaveLength(
			1,
		);

		expect(await runTask("接着做")).toMatchObject({ outcome: "completed" });
		expect(childRequests).toEqual([]);
		const request = mainRequests[0];
		expect(
			request?.messages
				.filter((message) => message.role === "tool_result")
				.map(text),
		).toEqual([expect.stringContaining("Subagents do not survive")]);
		expect(userTexts(request).join("\n")).toMatch(
			/Subagent explorer \([0-9a-f-]{36}\) was still running when the session was interrupted\./,
		);
	});
});

describe.runIf(process.platform === "darwin")("沙盒和工作区", () => {
	const sandboxed: Partial<SessionOptions> = {
		sandboxMode: "workspace-write",
	};

	test("定义写了 read-only 的子 agent 在只读沙盒里运行，写不了工作区；主 agent 不受影响", async () => {
		agents(`
${explorer}
sandbox_mode = "read-only"
`);
		await open(
			[
				spawnExplorer,
				reply("等"),
				call("shell", { command: "echo main > main.txt" }),
			],
			[call("shell", { command: "echo child > child.txt" })],
			sandboxed,
		);
		expect(await runTask()).toMatchObject({ outcome: "completed" });
		expect(ofType("subagent.started")).toMatchObject([
			{ sandbox_mode: "read-only", workspace: dirs.workspace },
		]);
		expect(existsSync(join(dirs.workspace, "child.txt"))).toBe(false);
		expect(readFileSync(join(dirs.workspace, "main.txt"), "utf8")).toBe(
			"main\n",
		);
		expect(ofType("subagent.ended")).toMatchObject([{ outcome: "completed" }]);
	});

	test("worker 在自己的克隆里工作：改动不进主工作区，主 agent 能读不能写它的目录，session 关闭时删除", async () => {
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", dirs.workspace, ...args], {
				env: {
					...dirs.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@example.invalid",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@example.invalid",
				},
			});
		git("init", "-q");
		writeFileSync(join(dirs.workspace, "a.txt"), "original\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "init");
		agents(`
[agents.worker]
description = "Makes changes in its own copy."
workspace = "isolated"
`);
		let copy = "";
		await open(
			(request, index) => {
				if (index === 0) {
					return call("spawn_agent", { agent: "worker", prompt: "改 a.txt" });
				}
				if (index === 1) {
					copy =
						/own copy of the repository at (\S+)\. You can read/.exec(
							request.messages.map(text).join("\n"),
						)?.[1] ?? "";
					return reply("等");
				}
				return (
					[
						call("shell", { command: `cat ${copy}/a.txt` }),
						call("shell", { command: `echo no > ${copy}/b.txt` }),
					][index - 2] ?? reply("好了")
				);
			},
			[call("shell", { command: "echo changed > a.txt" }), reply("改好了")],
			sandboxed,
		);
		if (session === undefined) throw new Error("session 还没有打开");
		expect(await runTask()).toMatchObject({ outcome: "completed" });

		const workers = join(dirs.root, "workers", session.id.slice(0, 12));
		const [started] = ofType("subagent.started");
		expect(started).toMatchObject({ name: "worker", workspace: copy });
		expect(copy).toBe(
			join(workers, (started?.agent_id ?? "").slice(0, 12), "repo"),
		);
		// 改动在它的克隆里，主工作区没有动
		expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(dirs.workspace, "a.txt"), "utf8")).toBe(
			"original\n",
		);
		expect(
			userTexts(mainRequests[2]).find((item) => item.includes("finished")),
		).toContain(
			`Its changes are in ${copy}. They are not in your workspace until you merge them.`,
		);
		const [, read, write] = results().filter(
			(_, index) =>
				ofType("tool_call.completed")[index]?.agent_id !== started?.agent_id,
		);
		expect(resultText(read)).toContain("changed");
		expect(existsSync(join(copy, "b.txt"))).toBe(false);
		expect(write?.status).not.toBe("succeeded");

		await session.close();
		expect(existsSync(workers)).toBe(false);
	});

	test("工作区不是 git 仓库时 worker 启动不了：原因交给模型并发警告，不留下目录", async () => {
		agents(`
[agents.worker]
description = "Makes changes in its own copy."
workspace = "isolated"
`);
		await open(
			[call("spawn_agent", { agent: "worker", prompt: "改 a.txt" })],
			[],
			sandboxed,
		);
		if (session === undefined) throw new Error("session 还没有打开");
		expect(await runTask()).toMatchObject({ outcome: "completed" });
		expect(results()).toMatchObject([{ status: "failed" }]);
		expect(resultText(results()[0])).toContain(
			"Its copy of the repository could not be made",
		);
		expect(
			ofType("warning").some((event) =>
				event.message.startsWith("子 agent worker 没能启动"),
			),
		).toBe(true);
		expect(log.types()).not.toContain("subagent.started");
		expect(
			readdirSync(join(dirs.root, "workers", session.id.slice(0, 12))),
		).toEqual([]);
	});
});
