import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	createHost,
	type Host,
	type HostEvent,
	InputBlockedError,
	type Session,
	type SessionOptions,
	WorkspaceError,
} from "@ospreycode/agent-host";
import type { AssistantContent, ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
import {
	eventRedactedType,
	SessionStore,
	type StoredEvent,
} from "@ospreycode/session-store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	bootId,
	type ProcessIdentity,
	processStartTime,
} from "../src/processes/info.js";
import { tryAcquireExclusiveLock } from "../src/project/locks.js";
import { sessionPaths } from "../src/project/workspace.js";
import { writeHookScript, writeHooks } from "./extension-harness.js";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

// 每个测试都要打开、关闭、再恢复 session，每次启动一个 agent 进程
vi.setConfig({ testTimeout: 60_000 });

const placeholder = "[REDACTED]";
const covered = [{ type: "text", text: placeholder }];
/** 命令的输出；命令行里没有连在一起的这一串。 */
const output = "TOOL-OUTPUT-SECRET";
const printOutput = "printf 'TOOL-%s' OUTPUT-SECRET";

let dirs: TestDirectories;
let host: Host;
/** 脚本模型收到的每次请求。 */
let requests: ModelRequest[];
/** 假的模型服务收到的每个请求体。 */
let bodies: string[];
const opened: Session[] = [];
const logs: EventLog[] = [];

beforeEach(() => {
	dirs = testDirectories();
	requests = [];
	bodies = [];
});

afterEach(async () => {
	await Promise.all(opened.splice(0).map((session) => session.close()));
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	for (const log of logs.splice(0)) expect(log.invalid).toEqual([]);
});

function scriptedHost(script: Script): Host {
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

/**
 * 请求经 anthropic.messages 的转换发给一个假的 fetch，按顺序给出这些回应：这样记录里才有消息在目标
 * 协议里的原文。
 */
function fetchHost(replies: readonly string[]): Host {
	return createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		fetch: async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response(replies[bodies.length - 1]);
		},
	});
}

type Block =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: object };

/** Anthropic 的一次流式回应。 */
function sse(blocks: readonly Block[]): string {
	const events: (readonly [string, object])[] = [
		[
			"message_start",
			{
				message: {
					model: "scripted",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		],
	];
	blocks.forEach((block, index) => {
		const delta = (data: object) =>
			events.push(["content_block_delta", { index, delta: data }]);
		if (block.type === "thinking") {
			events.push([
				"content_block_start",
				{ index, content_block: { type: "thinking", thinking: "" } },
			]);
			delta({ type: "thinking_delta", thinking: block.text });
			delta({ type: "signature_delta", signature: "sig" });
		} else if (block.type === "text") {
			events.push([
				"content_block_start",
				{ index, content_block: { type: "text", text: "" } },
			]);
			delta({ type: "text_delta", text: block.text });
		} else {
			events.push([
				"content_block_start",
				{
					index,
					content_block: {
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: {},
					},
				},
			]);
			delta({
				type: "input_json_delta",
				partial_json: JSON.stringify(block.input),
			});
		}
		events.push(["content_block_stop", { index }]);
	});
	const stop = blocks.some((block) => block.type === "tool_use")
		? "tool_use"
		: "end_turn";
	events.push(
		[
			"message_delta",
			{ delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
		],
		["message_stop", {}],
	);
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
}

function reply(text: string): ScriptedTurn {
	return { content: [{ type: "text", text }] };
}

function shell(callId: string, command: string): AssistantContent {
	return {
		type: "tool_call",
		call_id: callId,
		name: "shell",
		arguments: JSON.stringify({ command }),
	};
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

interface Opened {
	session: Session;
	sessionId: string;
	projectId: string;
	log: EventLog;
}

async function start(
	begin: (onEvent: (event: HostEvent) => void) => Promise<Session>,
): Promise<Opened> {
	const log = new EventLog();
	logs.push(log);
	const session = await begin(log.push);
	opened.push(session);
	const started = await log.waitFor("session.started");
	return {
		session,
		sessionId: started.session_id,
		projectId: started.project_id,
		log,
	};
}

function open(extra: Partial<SessionOptions> = {}): Promise<Opened> {
	return start((onEvent) => host.openSession({ ...options(extra), onEvent }));
}

function resume(
	sessionId: string,
	extra: Partial<SessionOptions> = {},
): Promise<Opened> {
	return start((onEvent) =>
		host.resumeSession({ ...options(extra), sessionId, onEvent }),
	);
}

function fork(sessionId: string): Promise<Opened> {
	return start((onEvent) =>
		host.forkSession({ ...options(), sessionId, onEvent }),
	);
}

async function submit({ session, log }: Opened, input: string): Promise<void> {
	const taskId = await session.submit(input);
	expect(
		await log.waitFor("task.ended", (event) => event.task_id === taskId),
	).toMatchObject({ outcome: "completed" });
}

/** 一个执行过这些任务、已经关闭的 session。 */
async function record(inputs: readonly string[]): Promise<Opened> {
	const result = await open();
	for (const input of inputs) await submit(result, input);
	await result.session.close();
	return result;
}

function ref({ sessionId }: Opened) {
	return { directory: dirs.workspace, sessionId };
}

function storePath(projectId: string): string {
	return join(dirs.root, "data", "projects", projectId, "sessions.sqlite");
}

/** 记录文件和它的 WAL 里的全部字节。 */
function recordBytes({ projectId }: Opened): Buffer {
	const path = storePath(projectId);
	return Buffer.concat(
		[path, `${path}-wal`].filter(existsSync).map((file) => readFileSync(file)),
	);
}

/** 一个 session 自己的事件，按写入的先后。 */
function stored({ projectId, sessionId }: Opened): StoredEvent[] {
	const store = SessionStore.open(storePath(projectId));
	try {
		return store.events(sessionId);
	} finally {
		store.close();
	}
}

/** 正好一个这种类型、内容符合条件的事件。 */
function only(
	events: readonly StoredEvent[],
	type: string,
	match: (data: string) => boolean = () => true,
): StoredEvent {
	const found = events.filter(
		(event) => event.type === type && match(JSON.stringify(event.data)),
	);
	if (found.length !== 1) {
		throw new Error(`应该正好有一个 ${type}，找到 ${found.length} 个`);
	}
	return found[0] as StoredEvent;
}

/** 这些 event_id 各是什么类型的事件，按类型排序。 */
function typesOf(events: readonly StoredEvent[], ids: readonly string[]) {
	return ids
		.map((id) => events.find((event) => event.event_id === id)?.type)
		.sort();
}

function redactions(session: Opened): StoredEvent[] {
	return stored(session).filter((event) => event.type === eventRedactedType);
}

function title({ sessionId }: Opened): string | null | undefined {
	return host
		.listSessions({ directory: dirs.workspace })
		.find((session) => session.session_id === sessionId)?.title;
}

/** 这次调用保存完整输出的文件。 */
function outputFile(session: Opened, completed: StoredEvent): string {
	return join(
		sessionPaths(dirs.root, session.sessionId).output,
		(completed.data as { tool_call_id: string }).tool_call_id,
	);
}

/** 请求里的对话：去掉系统指令和会话开始的上下文消息。 */
function conversation(request: ModelRequest | undefined) {
	if (request === undefined) throw new Error("没有这次请求");
	return request.messages.slice(2);
}

/** 测试进程自己的身份：用它取得的锁，在 Host 看来被一个还在运行的进程持有。 */
function identity(): ProcessIdentity {
	return {
		pid: process.pid,
		start_time: processStartTime(process.pid) as string,
		boot_id: bootId(),
	};
}

/** 像另一个 Host 正打开着它那样，持有一个 session 的写锁。 */
function holdSession(sessionId: string): { release(): void } {
	const lock = tryAcquireExclusiveLock(
		join(dirs.root, "data", "locks", `session-${sessionId}.lock`),
		identity(),
	);
	if (lock === undefined) throw new Error("这个 session 的写锁已经被持有");
	return lock;
}

/** 一张不用缩放的 PNG，内容是随机的像素。 */
function noisePng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	// 8 位、RGB、不隔行；每行开头一个过滤类型的字节
	header.set([8, 2, 0, 0, 0], 8);
	const rows = randomBytes(height * (1 + width * 3));
	for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows, { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe("工具调用", () => {
	test("指名一次调用的结果：记录、WAL 和 output/ 里不再有原文；恢复后发给模型的是占位，之后的推理块不再发", async () => {
		host = fetchHost([
			sse([
				{ type: "thinking", text: "思考甲" },
				{
					type: "tool_use",
					id: "toolu_1",
					name: "shell",
					input: { command: printOutput },
				},
			]),
			sse([
				{ type: "thinking", text: "思考乙" },
				{ type: "text", text: "第一次回答" },
			]),
			sse([{ type: "text", text: "第二次回答" }]),
		]);
		const session = await open();
		await submit(session, "运行命令");
		await session.session.close();
		const before = stored(session);
		const completed = only(before, "tool_call.completed");
		const file = outputFile(session, completed);
		expect(readFileSync(file, "utf8")).toBe(output);
		expect(recordBytes(session).includes(output)).toBe(true);
		const target = { ...ref(session), eventIds: [completed.event_id] };

		// 先看范围：这次调用的结果、把它交给模型的消息和这条消息在目标协议里的原文
		const scope = host.redactionScope(target);
		expect(scope.events[0]).toBe(completed.event_id);
		expect(typesOf(before, scope.events)).toEqual([
			"message.sent",
			"protocol.raw",
			"tool_call.completed",
		]);
		expect(scope).toMatchObject({ sessions: [], outputFiles: [file] });
		expect(stored(session)).toEqual(before);

		expect(await host.redactEvents(target)).toEqual(scope);
		expect(recordBytes(session).includes(output)).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(placeholder);
		const after = stored(session);
		// 事件一个不少，编号、类型和位置都不变；多出来的是记这次脱敏的那个 run
		expect(
			after
				.slice(0, before.length)
				.map(({ event_id, type, run_id, seq }) => [
					event_id,
					type,
					run_id,
					seq,
				]),
		).toEqual(
			before.map(({ event_id, type, run_id, seq }) => [
				event_id,
				type,
				run_id,
				seq,
			]),
		);
		expect(after.slice(before.length).map((event) => event.type)).toEqual([
			"run.started",
			eventRedactedType,
		]);
		expect(
			after
				.filter((event) => (event.data as { redacted?: true }).redacted)
				.map((event) => event.event_id)
				.sort(),
		).toEqual([...scope.events].sort());
		const sent = only(after, "message.sent", (data) =>
			data.includes('"tool_result"'),
		);
		expect(sent.data).toMatchObject({
			redacted: true,
			message: { role: "tool_result", call_id: "toolu_1", content: covered },
		});
		const { message_id: messageId } = (
			sent.data as { message: { message_id: string } }
		).message;
		expect(
			only(after, "protocol.raw", (data) => data.includes(messageId)).data,
		).toMatchObject({ redacted: true, part: "message", pieces: [placeholder] });

		const resumed = await resume(session.sessionId);
		// 读回来的事件结构不变，带着已脱敏的标记
		expect(
			resumed.session
				.history()
				.find((event) => event.type === "tool_call.completed"),
		).toMatchObject({
			event_id: completed.event_id,
			redacted: true,
			result: { status: "succeeded", content: covered },
		});
		await submit(resumed, "继续");
		const body = bodies[2] as string;
		expect(body).toContain(placeholder);
		expect(body).not.toContain(output);
		// 被覆盖的事件之前的回复原样带回，之后的回复里的推理块作废
		expect(body).toContain("思考甲");
		expect(body).not.toContain("思考乙");
		expect(body).toContain("第一次回答");
	});

	test("指名一次调用登记的参数：回复里只覆盖这一次调用的参数，询问里的命令一起覆盖；再指名回复，文字也覆盖", async () => {
		host = scriptedHost((_request, call) =>
			call === 0
				? {
						content: [
							{ type: "text", text: "REPLY-SECRET" },
							shell("call_1", "mkdir ARG-SECRET && rm -rf ARG-SECRET"),
						],
					}
				: reply("完成"),
		);
		const session = await open({ approvalPolicy: "on-request" });
		const taskId = await session.session.submit("清理");
		const asked = await session.log.waitFor("approval.requested");
		session.session.respond(asked.request_id, {
			decision: "approve",
			scope: "once",
		});
		await session.log.waitFor("task.ended", (e) => e.task_id === taskId);
		await session.session.close();
		const before = stored(session);
		const started = only(before, "tool_call.started");
		const issued = only(before, "message.completed", (data) =>
			data.includes("call_1"),
		);

		const first = await host.redactEvents({
			...ref(session),
			eventIds: [started.event_id],
		});
		expect(typesOf(before, first.events)).toEqual([
			"approval.requested",
			"message.completed",
			"tool_call.started",
		]);
		let after = stored(session);
		expect(only(after, "tool_call.started").data).toMatchObject({
			redacted: true,
			call_id: "call_1",
			name: "shell",
			arguments: "{}",
		});
		expect(only(after, "approval.requested").data).toMatchObject({
			redacted: true,
			kind: "tool_call",
			request: { kind: "command", command: placeholder },
			reasons: [],
		});
		expect(
			only(after, "message.completed", (data) => data.includes("call_1")).data,
		).toMatchObject({
			redacted: true,
			message: {
				content: [
					{ type: "text", text: "REPLY-SECRET" },
					{ type: "tool_call", call_id: "call_1", arguments: "{}" },
				],
			},
		});
		expect(recordBytes(session).includes("ARG-SECRET")).toBe(false);

		// 已经覆盖过的参数跳过，这次只有回复自己
		expect(
			await host.redactEvents({ ...ref(session), eventIds: [issued.event_id] }),
		).toMatchObject({ events: [issued.event_id] });
		after = stored(session);
		expect(
			only(after, "message.completed", (data) => data.includes("call_1")).data,
		).toMatchObject({
			message: {
				content: [
					{ type: "text", text: placeholder },
					{ type: "tool_call", call_id: "call_1", arguments: "{}" },
				],
				stop_reason: "tool_use",
			},
		});
		expect(recordBytes(session).includes("REPLY-SECRET")).toBe(false);
		expect(redactions(session)).toHaveLength(2);

		// 恢复后历史照样读得回来，模型看到的调用带着空的参数
		const resumed = await resume(session.sessionId);
		expect(
			resumed.session
				.history()
				.filter((event) => "redacted" in event)
				.map((event) => event.type),
		).toEqual(["message.completed", "tool_call.started", "approval.requested"]);
		await submit(resumed, "继续");
		expect(conversation(requests.at(-1))[1]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: placeholder },
				{ type: "tool_call", call_id: "call_1", arguments: "{}" },
			],
		});
	});
});

describe("用户输入", () => {
	test("task.started 和发给模型的消息里各有一份：指名哪一个，另一个和原文都一起覆盖，记录里再也找不到那段文字；标题取自被覆盖的输入时一起换掉", async () => {
		host = fetchHost([
			sse([{ type: "text", text: "好的" }]),
			sse([{ type: "text", text: "知道了" }]),
			sse([{ type: "text", text: "脱敏之后的回答" }]),
		]);
		const session = await record([
			"USER-SECRET 第一行\n第二行",
			"OTHER-SECRET",
		]);
		expect(title(session)).toBe("USER-SECRET 第一行");
		const before = stored(session);
		const copies = ["message.sent", "protocol.raw", "task.started"];

		// 指名 task.started：放这次输入的那条消息带着同一个编号
		const task = only(before, "task.started", (data) =>
			data.includes("USER-SECRET"),
		);
		const target = { ...ref(session), eventIds: [task.event_id] };
		expect(typesOf(before, host.redactionScope(target).events)).toEqual(copies);
		const summary = await host.redactEvents(target);
		expect(typesOf(before, summary.events)).toEqual(copies);
		expect(title(session)).toBe(placeholder);
		expect(
			stored(session).find((event) => event.event_id === task.event_id)?.data,
		).toMatchObject({ redacted: true, source: "user", input: covered });
		expect(recordBytes(session).includes("USER-SECRET")).toBe(false);

		// 反过来指名发给模型的那条消息
		const sent = only(before, "message.sent", (data) =>
			data.includes("OTHER-SECRET"),
		);
		const reverse = await host.redactEvents({
			...ref(session),
			eventIds: [sent.event_id],
		});
		expect(typesOf(before, reverse.events)).toEqual(copies);
		expect(recordBytes(session).includes("OTHER-SECRET")).toBe(false);

		const resumed = await resume(session.sessionId);
		await submit(resumed, "继续");
		expect(bodies.at(-1)).toContain(placeholder);
		expect(bodies.at(-1)).not.toContain("USER-SECRET");
		expect(bodies.at(-1)).not.toContain("OTHER-SECRET");
	});

	test("指名排队的输入：队列的快照和插进 task 时放它的那条消息一起覆盖", async () => {
		const current: { session?: Session } = {};
		host = scriptedHost((_request, call) => {
			if (call === 0) current.session?.steer("STEER-SECRET");
			return reply(`回答 ${call}`);
		});
		const session = await open();
		current.session = session.session;
		await submit(session, "开始");
		await session.session.close();
		const before = stored(session);
		expect(requests).toHaveLength(2);

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [only(before, "input.queued").event_id],
		});
		expect(typesOf(before, summary.events)).toEqual([
			"input.queued",
			"message.sent",
		]);
		expect(only(stored(session), "input.queued").data).toMatchObject({
			redacted: true,
			kind: "steering",
			input: covered,
			queue: { steering: [{ input: covered }], follow_up: [] },
		});
		expect(recordBytes(session).includes("STEER-SECRET")).toBe(false);
	});

	test("指名排队的 follow-up：它作为新的 task 开始时 task.started 里的那一份一起覆盖，反过来也一样", async () => {
		const current: { session?: Session } = {};
		host = scriptedHost((_request, call) => {
			if (call === 0) {
				current.session?.followUp("FOLLOW-SECRET 甲");
				current.session?.followUp("FOLLOW-SECRET 乙");
			}
			return reply(`回答 ${call}`);
		});
		const session = await open();
		current.session = session.session;
		await session.session.submit("开始");
		const last = await session.log.waitFor(
			"task.started",
			(event) =>
				event.input[0]?.type === "text" &&
				event.input[0].text === "FOLLOW-SECRET 乙",
		);
		await session.log.waitFor(
			"task.ended",
			(event) => event.task_id === last.task_id,
		);
		await session.session.close();
		const before = stored(session);
		const queued = before.filter((event) => event.type === "input.queued");
		const started = before.filter(
			(event) =>
				event.type === "task.started" &&
				JSON.stringify(event.data).includes("FOLLOW-SECRET"),
		);
		expect([queued.length, started.length]).toEqual([2, 2]);

		const sent = before.filter(
			(event) =>
				event.type === "message.sent" &&
				JSON.stringify(event.data).includes("FOLLOW-SECRET"),
		);
		expect(sent).toHaveLength(2);

		// 从排队的事件找到 task.started，再找到放这次输入的那条消息
		const first = await host.redactEvents({
			...ref(session),
			eventIds: [(queued[0] as StoredEvent).event_id],
		});
		expect(first.events).toContain((started[0] as StoredEvent).event_id);
		expect(first.events).toContain((sent[0] as StoredEvent).event_id);
		expect(first.events).not.toContain((started[1] as StoredEvent).event_id);
		expect(typesOf(before, first.events)).toEqual([
			"input.dequeued",
			"input.queued",
			"input.queued",
			"message.sent",
			"task.started",
		]);
		// 从 task.started 找到排队的事件和那条消息
		const second = await host.redactEvents({
			...ref(session),
			eventIds: [(started[1] as StoredEvent).event_id],
		});
		expect(second.events).toContain((queued[1] as StoredEvent).event_id);
		expect(second.events).toContain((sent[1] as StoredEvent).event_id);
		expect(recordBytes(session).includes("FOLLOW-SECRET")).toBe(false);
	});
});

describe("分叉", () => {
	test("分叉沿用了指名的事件：没同意波及别的 session 时什么也不改；同意后父 session 和分叉读到的都是占位，分叉自己记的副本也覆盖", async () => {
		host = fetchHost([
			sse([
				{
					type: "tool_use",
					id: "toolu_1",
					name: "shell",
					input: { command: printOutput },
				},
			]),
			sse([{ type: "text", text: "第一次回答" }]),
			sse([{ type: "text", text: "分叉里的回答" }]),
			sse([{ type: "text", text: "脱敏之后的回答" }]),
		]);
		const parent = await open();
		await submit(parent, "运行命令");
		await parent.session.close();
		const child = await fork(parent.sessionId);
		await submit(child, "分叉里的任务");
		await child.session.close();
		const before = { parent: stored(parent), child: stored(child) };
		const completed = only(before.parent, "tool_call.completed");
		// 分叉重新发出这条工具结果时，又记了一份它在目标协议里的原文
		const copy = only(before.child, "protocol.raw", (data) =>
			data.includes(output),
		);
		const target = { ...ref(parent), eventIds: [completed.event_id] };

		const scope = host.redactionScope(target);
		expect(scope.sessions).toEqual([child.sessionId]);
		expect(scope.events).toContain(copy.event_id);
		// 从分叉指名它沿用的事件，波及的是父 session
		expect(
			host.redactionScope({ ...target, sessionId: child.sessionId }),
		).toMatchObject({
			events: expect.arrayContaining(scope.events),
			sessions: [parent.sessionId],
		});

		await expect(host.redactEvents(target)).rejects.toThrow(WorkspaceError);
		expect(stored(parent)).toEqual(before.parent);
		expect(stored(child)).toEqual(before.child);
		expect(readFileSync(outputFile(parent, completed), "utf8")).toBe(output);

		expect(await host.redactEvents({ ...target, withSessions: true })).toEqual(
			scope,
		);
		expect(recordBytes(parent).includes(output)).toBe(false);
		expect(
			only(stored(child), "protocol.raw", (data) =>
				data.includes('"redacted":true'),
			).event_id,
		).toBe(copy.event_id);
		// 执行覆盖的 session 各记一条 event.redacted，列着它名下被覆盖的事件
		expect(redactions(parent)).toHaveLength(1);
		expect(redactions(child).map((event) => event.data)).toEqual([
			{ events: [{ run_id: copy.run_id, seq: copy.seq }] },
		]);

		const resumed = await resume(child.sessionId);
		expect(
			resumed.session
				.history()
				.find((event) => event.type === "tool_call.completed"),
		).toMatchObject({ redacted: true, result: { content: covered } });
		await submit(resumed, "继续");
		expect(bodies[3]).toContain(placeholder);
		expect(bodies[3]).not.toContain(output);
	});
});

describe("上下文压缩", () => {
	/** 这次请求是不是摘要请求：最后一条消息是压缩的要求。 */
	function isSummaryRequest(request: ModelRequest): boolean {
		return JSON.stringify(request.messages.at(-1)?.content).includes(
			"<compaction_request>",
		);
	}

	test("压缩在被覆盖的事件之后：摘要一起覆盖，这次压缩作废，恢复后按覆盖过的原始历史重建", async () => {
		host = scriptedHost((request, call) => {
			if (isSummaryRequest(request)) return reply("摘要 SUMMARY-SECRET");
			return call === 0
				? { content: [shell("call_1", printOutput)] }
				: reply(`第 ${call} 次回答`);
		});
		const session = await open();
		await submit(session, "第一个任务");
		const compacting = await session.session.compact();
		await session.log.waitFor("task.ended", (e) => e.task_id === compacting);
		await submit(session, "第二个任务");
		await session.session.close();
		const before = stored(session);
		// 压缩之后的请求是从摘要开始的
		expect(JSON.stringify(requests[3]?.messages)).toContain("SUMMARY-SECRET");
		expect(JSON.stringify(requests[3]?.messages)).not.toContain("第一个任务");

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [only(before, "tool_call.completed").event_id],
		});
		// 结果和交给模型的那条消息；压缩事件、模型写摘要的回复，和压缩后的上下文随下一次请求记下的三条消息
		expect(typesOf(before, summary.events)).toEqual([
			"context.compacted",
			"message.completed",
			"message.sent",
			"message.sent",
			"message.sent",
			"message.sent",
			"tool_call.completed",
		]);
		expect(recordBytes(session).includes(output)).toBe(false);
		expect(recordBytes(session).includes("SUMMARY-SECRET")).toBe(false);

		const resumed = await resume(session.sessionId);
		expect(
			resumed.session
				.history()
				.find((event) => event.type === "context.compacted"),
		).toMatchObject({
			redacted: true,
			trigger: "manual",
			summary: placeholder,
		});
		await submit(resumed, "第三个任务");
		const rebuilt = conversation(requests.at(-1));
		expect(rebuilt.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(rebuilt[0]?.content).toEqual([{ type: "text", text: "第一个任务" }]);
		expect(rebuilt[2]?.content).toEqual(covered);
		expect(rebuilt[4]?.content).toEqual([{ type: "text", text: "第二个任务" }]);
		const sentMessages = JSON.stringify(requests.at(-1)?.messages);
		expect(sentMessages).not.toContain("SUMMARY-SECRET");
		expect(sentMessages).not.toContain("<compaction_request>");
		// 历史没有超过阈值，不用再压缩
		expect(requests.filter(isSummaryRequest)).toHaveLength(1);
	});

	test("压缩作废后重建出的历史超过模型的输入容量：再压缩也发不出去，task 以 failed 结束；回退到那段内容之前可以继续", async () => {
		// 带着这段输入的请求，恢复之后模型服务一律按上下文超长拒绝
		const long = "LONG-INPUT";
		let rejecting = false;
		host = scriptedHost((request, call) => {
			if (rejecting && JSON.stringify(request.messages).includes(long)) {
				return {
					content: [],
					error: {
						category: "context_overflow",
						message: "prompt is too long",
					},
				};
			}
			if (isSummaryRequest(request)) return reply("这是摘要");
			return call === 0
				? { content: [shell("call_1", printOutput)] }
				: reply(`第 ${call} 次回答`);
		});
		const session = await open();
		await submit(session, "第一个任务");
		await submit(session, `${long} 第二个任务`);
		const compacting = await session.session.compact();
		await session.log.waitFor("task.ended", (e) => e.task_id === compacting);
		await submit(session, "第三个任务");
		await session.session.close();
		// 压缩之后的请求从摘要开始，里面没有那段输入
		expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(long);

		await host.redactEvents({
			...ref(session),
			eventIds: [only(stored(session), "tool_call.completed").event_id],
		});
		rejecting = true;
		const sentBefore = requests.length;
		const resumed = await resume(session.sessionId);
		const taskId = await resumed.session.submit("第四个任务");
		const failed = await resumed.log.waitFor(
			"task.ended",
			(event) => event.task_id === taskId,
		);
		expect(failed).toMatchObject({ outcome: "failed" });
		expect(failed.error).toContain("压缩上下文失败");
		// 压缩作废了：这次请求带着压缩之前的历史，被拒绝后再压缩，摘要请求同样发不出去
		const rejected = requests.slice(sentBefore);
		expect(rejected.map(isSummaryRequest)).toEqual([false, true]);
		for (const request of rejected) {
			expect(JSON.stringify(request.messages)).toContain(long);
		}

		// 回退到那段输入之前：路径上只剩第一个任务，工具结果是占位
		const checkpoint = resumed.session
			.checkpoints()
			.find((candidate) => candidate.text?.startsWith(long));
		if (checkpoint === undefined) throw new Error("没有这个检查点");
		await resumed.session.rewind(checkpoint.id);
		await submit(resumed, "换个做法");
		const rebuilt = conversation(requests.at(-1));
		expect(rebuilt.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"assistant",
			"user",
		]);
		expect(rebuilt[2]?.content).toEqual(covered);
		expect(rebuilt[4]?.content).toEqual([{ type: "text", text: "换个做法" }]);
	});

	test("脱敏之后才做的压缩是照着占位写的：再指名已经脱敏的事件时不动它", async () => {
		host = scriptedHost((request, call) => {
			if (isSummaryRequest(request)) return reply("摘要：没有原文");
			return call === 0
				? { content: [shell("call_1", printOutput)] }
				: reply(`第 ${call} 次回答`);
		});
		const session = await record(["第一个任务"]);
		const named = {
			...ref(session),
			eventIds: [only(stored(session), "tool_call.completed").event_id],
		};
		await host.redactEvents(named);

		const resumed = await resume(session.sessionId);
		const compacting = await resumed.session.compact();
		await resumed.log.waitFor("task.ended", (e) => e.task_id === compacting);
		await resumed.session.close();
		const before = stored(resumed);
		expect(only(before, "context.compacted").data).toMatchObject({
			summary: "摘要：没有原文",
		});

		expect(() => host.redactionScope(named)).toThrow(/已经脱敏过/);
		await expect(host.redactEvents(named)).rejects.toThrow(/已经脱敏过/);
		expect(stored(resumed)).toEqual(before);
	});
});

describe("引用同一份大内容的事件", () => {
	test("同一张图片出现在两次工具结果里：指名其中一次，图片被覆盖，另一次的结果和消息也覆盖", async () => {
		const shot = noisePng(200, 100);
		const digest = createHash("sha256").update(shot).digest("hex");
		writeFileSync(join(dirs.workspace, "shot.png"), shot);
		const read = (id: string) =>
			sse([
				{ type: "tool_use", id, name: "read", input: { path: "shot.png" } },
			]);
		host = fetchHost([
			read("toolu_1"),
			sse([{ type: "text", text: "一张图" }]),
			read("toolu_2"),
			sse([{ type: "text", text: "还是那张图" }]),
			sse([{ type: "text", text: "脱敏之后的回答" }]),
		]);
		const images = { models: { scripted: { ...testModel, images: true } } };
		const session = await open(images);
		await submit(session, "看 shot.png");
		await submit(session, "再看一遍");
		await session.session.close();
		const before = stored(session);
		const [first, second] = before.filter(
			(event) => event.type === "tool_call.completed",
		);
		if (first === undefined || second === undefined) {
			throw new Error("应该有两次工具调用");
		}
		const fragment = shot.subarray(64, 128);
		expect(recordBytes(session).includes(fragment)).toBe(true);
		expect(JSON.stringify(second.data)).toContain(digest);

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [first.event_id],
		});
		expect(summary.events).toContain(second.event_id);
		const after = stored(session);
		expect(
			after.filter((event) => JSON.stringify(event.data).includes(digest)),
		).toEqual([]);
		expect(recordBytes(session).includes(fragment)).toBe(false);
		expect(
			after
				.filter((event) => event.type === "tool_call.completed")
				.map((event) => event.data),
		).toMatchObject([
			{ redacted: true, result: { status: "succeeded", content: covered } },
			{ redacted: true, result: { status: "succeeded", content: covered } },
		]);

		const resumed = await resume(session.sessionId, images);
		await submit(resumed, "继续");
		expect(bodies[4]).not.toContain(shot.toString("base64").slice(1000, 1200));
	});

	test("同一张图片在同一个项目的另一个 session 里：没同意时什么也不改；同意后那个 session 里引用它的事件也覆盖，各记一条 event.redacted", async () => {
		const shot = noisePng(200, 100);
		const digest = createHash("sha256").update(shot).digest("hex");
		writeFileSync(join(dirs.workspace, "shot.png"), shot);
		const read = (id: string) =>
			sse([
				{ type: "tool_use", id, name: "read", input: { path: "shot.png" } },
			]);
		host = fetchHost([
			read("toolu_1"),
			sse([{ type: "text", text: "一张图" }]),
			read("toolu_2"),
			sse([{ type: "text", text: "另一个 session 也看了" }]),
		]);
		const images = { models: { scripted: { ...testModel, images: true } } };
		const first = await open(images);
		await submit(first, "看 shot.png");
		await first.session.close();
		const other = await open(images);
		await submit(other, "看 shot.png");
		await other.session.close();
		const before = { first: stored(first), other: stored(other) };
		const referring = (events: readonly StoredEvent[]) =>
			events.filter((event) => JSON.stringify(event.data).includes(digest));
		expect(referring(before.other).length).toBeGreaterThan(0);
		const target = {
			...ref(first),
			eventIds: [only(before.first, "tool_call.completed").event_id],
		};

		const scope = host.redactionScope(target);
		expect(scope.sessions).toEqual([other.sessionId]);
		expect(scope.events).toEqual(
			expect.arrayContaining(
				referring(before.other).map((event) => event.event_id),
			),
		);
		await expect(host.redactEvents(target)).rejects.toThrow(WorkspaceError);
		expect(stored(first)).toEqual(before.first);
		expect(stored(other)).toEqual(before.other);

		expect(await host.redactEvents({ ...target, withSessions: true })).toEqual(
			scope,
		);
		expect(referring(stored(first))).toEqual([]);
		expect(referring(stored(other))).toEqual([]);
		expect(recordBytes(first).includes(shot.subarray(64, 128))).toBe(false);
		expect(redactions(first)).toHaveLength(1);
		expect(redactions(other)).toHaveLength(1);
		expect(only(stored(other), "tool_call.completed").data).toMatchObject({
			redacted: true,
			result: { status: "succeeded", content: covered },
		});
	});
});

describe("hooks 的输出", () => {
	const configured: Record<string, object[]> = {};

	beforeEach(() => {
		for (const key of Object.keys(configured)) delete configured[key];
	});

	/** 配一个用户级的 hook；`output` 是字符串时当作函数的源码，用它从输入算出要输出的对象。 */
	function userHook(event: string, output: object | string): void {
		const name = `${event}.cjs`;
		writeHookScript(join(dirs.root, "hooks", name), { output });
		configured[event] = [
			{
				hooks: [
					{
						command: `./${name}`,
						onFailure: "continue",
						permissions: "workspace-write",
					},
				],
			},
		];
		writeHooks(join(dirs.root, "hooks.json"), configured);
	}

	function ran(events: readonly StoredEvent[], event: string) {
		return events.filter(
			(stored) =>
				stored.type === "hooks.ran" &&
				(stored.data as { event: string }).event === event,
		);
	}

	function messageId(sent: StoredEvent): string {
		return (sent.data as { message: { message_id: string } }).message
			.message_id;
	}

	test("补充的信息随输入交给模型：指名输入，这些 hooks 的输出一起覆盖；指名一次 hooks 的运行，放它的原因的那条消息一起覆盖", async () => {
		userHook("SessionStart", { additional_context: "HOOK-START-SECRET" });
		// 输出里带着用户的输入：这样的 hook 把输入又抄了一份
		userHook(
			"UserPromptSubmit",
			'(input) => ({ additional_context: "hook saw: " + input.prompt })',
		);
		userHook(
			"Stop",
			'(input) => input.continuation_count === 0 ? { decision: "block", reason: "HOOK-STOP-SECRET" } : {}',
		);
		host = scriptedHost((_request, call) => reply(`第 ${call} 次回答`));
		const session = await record(["PROMPT-SECRET 任务"]);
		const before = stored(session);
		const input = only(before, "message.sent", (data) =>
			data.includes("PROMPT-SECRET"),
		);
		const feedback = only(before, "message.sent", (data) =>
			data.includes("HOOK-STOP-SECRET"),
		);
		const [start] = ran(before, "SessionStart");
		const [prompt] = ran(before, "UserPromptSubmit");
		const [blocked, passed] = ran(before, "Stop");
		// hooks 的输出放进了哪条消息，记在它的运行里
		expect(start?.data).toMatchObject({ message_id: messageId(input) });
		expect(prompt?.data).toMatchObject({
			message_id: messageId(input),
			additional_context: "hook saw: PROMPT-SECRET 任务",
		});
		expect(blocked?.data).toMatchObject({ message_id: messageId(feedback) });
		// 没有要求接着做的那一次什么也没交给模型
		expect(passed?.data).not.toHaveProperty("message_id");

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [only(before, "task.started").event_id],
		});
		expect(typesOf(before, summary.events)).toEqual([
			"hooks.ran",
			"hooks.ran",
			"message.sent",
			"task.started",
		]);
		expect(summary.events).toEqual(
			expect.arrayContaining([start?.event_id, prompt?.event_id]),
		);
		expect(recordBytes(session).includes("PROMPT-SECRET")).toBe(false);
		expect(recordBytes(session).includes("HOOK-START-SECRET")).toBe(false);
		expect(recordBytes(session).includes("HOOK-STOP-SECRET")).toBe(true);

		const stop = await host.redactEvents({
			...ref(session),
			eventIds: [(blocked as StoredEvent).event_id],
		});
		expect(typesOf(before, stop.events)).toEqual(["hooks.ran", "message.sent"]);
		expect(stop.events).toContain(feedback.event_id);
		expect(recordBytes(session).includes("HOOK-STOP-SECRET")).toBe(false);
	});

	test("PreCompact 补充的信息在摘要请求里：指名这次 hooks 的运行，那条消息和照着它写的压缩一起覆盖", async () => {
		userHook("PreCompact", { additional_context: "HOOK-COMPACT-SECRET" });
		host = scriptedHost((request, call) =>
			JSON.stringify(request.messages.at(-1)?.content).includes(
				"<compaction_request>",
			)
				? reply("摘要 SUMMARY-TEXT")
				: reply(`第 ${call} 次回答`),
		);
		const session = await open();
		await submit(session, "第一个任务");
		const compacting = await session.session.compact();
		await session.log.waitFor("task.ended", (e) => e.task_id === compacting);
		await session.session.close();
		const before = stored(session);
		const hook = only(before, "hooks.ran");
		const request = only(before, "message.sent", (data) =>
			data.includes("HOOK-COMPACT-SECRET"),
		);
		expect(hook.data).toMatchObject({
			event: "PreCompact",
			message_id: messageId(request),
		});

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [hook.event_id],
		});
		expect(summary.events).toEqual(
			expect.arrayContaining([
				request.event_id,
				only(before, "context.compacted").event_id,
			]),
		);
		expect(recordBytes(session).includes("HOOK-COMPACT-SECRET")).toBe(false);
		expect(recordBytes(session).includes("SUMMARY-TEXT")).toBe(false);
	});

	test("被阻止的输入没有交给模型：这次 hooks 的运行不带消息的编号，指名它只覆盖它自己", async () => {
		userHook("UserPromptSubmit", {
			decision: "block",
			reason: "HOOK-BLOCK-SECRET",
		});
		host = scriptedHost(() => reply("好的"));
		const session = await open();
		await expect(session.session.submit("一个任务")).rejects.toThrow(
			InputBlockedError,
		);
		await session.session.close();
		const hook = only(stored(session), "hooks.ran");
		expect(hook.data).toMatchObject({ blocked: true });
		expect(hook.data).not.toHaveProperty("message_id");

		expect(
			await host.redactEvents({ ...ref(session), eventIds: [hook.event_id] }),
		).toMatchObject({ events: [hook.event_id] });
		expect(recordBytes(session).includes("HOOK-BLOCK-SECRET")).toBe(false);
	});
});

describe("记忆检索的查询和候选列表", () => {
	test("模型提议的候选，标题在候选列表里还有一份：指名那次 memory_propose 调用登记的参数，标题一起覆盖", async () => {
		host = scriptedHost((_request, call) =>
			call === 0
				? {
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "memory_propose",
								arguments: JSON.stringify({
									scope: "project",
									kind: "fact",
									title: "CANDIDATE-TITLE-SECRET",
									body: "CANDIDATE-BODY-SECRET",
								}),
							},
						],
					}
				: reply("记下了"),
		);
		const session = await record(["记一下"]);
		const before = stored(session);
		const started = only(before, "tool_call.started");
		const listed = only(before, "memory.candidates");
		// 候选依据的事件记在候选列表里
		expect(listed.data).toMatchObject({
			candidates: [
				{
					title: "CANDIDATE-TITLE-SECRET",
					source_event_ids: [started.event_id],
				},
			],
		});

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [started.event_id],
		});
		expect(summary.events).toContain(listed.event_id);
		expect(recordBytes(session).includes("CANDIDATE-TITLE-SECRET")).toBe(false);
		expect(recordBytes(session).includes("CANDIDATE-BODY-SECRET")).toBe(false);
	});

	test("memory_search 的查询记在 memory.retrieved 里：指名这次调用登记的参数，查询一起覆盖", async () => {
		host = scriptedHost((_request, call) =>
			call === 0
				? {
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "memory_search",
								arguments: JSON.stringify({ query: "QUERY-SECRET" }),
							},
						],
					}
				: reply("没有找到"),
		);
		const session = await record(["查一下记忆"]);
		const before = stored(session);
		const started = only(before, "tool_call.started");
		const retrieved = only(before, "memory.retrieved");
		expect(retrieved.data).toMatchObject({
			query: "QUERY-SECRET",
			tool_call_id: (started.data as { tool_call_id: string }).tool_call_id,
		});

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [started.event_id],
		});
		expect(summary.events).toContain(retrieved.event_id);
		expect(recordBytes(session).includes("QUERY-SECRET")).toBe(false);
	});

	test("自动注入时查询就是用户的输入：指名输入，memory.retrieved 里的查询一起覆盖", async () => {
		host = scriptedHost(() => reply("好的"));
		const session = await open({ memory: { retrieval: "auto" } });
		await submit(session, "PROMPT-SECRET 任务");
		await session.session.close();
		const before = stored(session);
		const input = only(before, "message.sent", (data) =>
			data.includes("PROMPT-SECRET"),
		);
		const retrieved = only(before, "memory.retrieved");
		expect(retrieved.data).toMatchObject({
			query: "PROMPT-SECRET 任务",
			message_id: (input.data as { message: { message_id: string } }).message
				.message_id,
		});
		expect(retrieved.data).not.toHaveProperty("tool_call_id");

		const summary = await host.redactEvents({
			...ref(session),
			eventIds: [only(before, "task.started").event_id],
		});
		expect(summary.events).toContain(retrieved.event_id);
		expect(recordBytes(session).includes("PROMPT-SECRET")).toBe(false);
	});
});

describe("不能执行的情况", () => {
	test("session 正打开着：范围还能看，执行时报错，什么也不改", async () => {
		host = scriptedHost(() => reply("ANSWER-SECRET"));
		const session = await open();
		await submit(session, "第一个任务");
		const before = stored(session);
		const target = {
			...ref(session),
			eventIds: [only(before, "message.completed").event_id],
		};

		expect(host.redactionScope(target).events).toEqual(target.eventIds);
		await expect(host.redactEvents(target)).rejects.toThrow(
			/正被一个 Host 进程打开着，不能脱敏/,
		);
		expect(stored(session)).toEqual(before);

		await session.session.close();
		await host.redactEvents(target);
		expect(recordBytes(session).includes("ANSWER-SECRET")).toBe(false);
	});

	test("受影响的分叉正被别的 Host 打开着：报错，父 session 也不改", async () => {
		host = scriptedHost(() => reply("ANSWER-SECRET"));
		const parent = await record(["第一个任务"]);
		const child = await fork(parent.sessionId);
		await child.session.close();
		const before = stored(parent);
		const held = holdSession(child.sessionId);
		try {
			await expect(
				host.redactEvents({
					...ref(parent),
					eventIds: [only(before, "message.completed").event_id],
					withSessions: true,
				}),
			).rejects.toThrow(WorkspaceError);
		} finally {
			held.release();
		}
		expect(stored(parent)).toEqual(before);
		// 没取到全部的写锁时，已经取到的也放掉了
		await (await resume(parent.sessionId)).session.close();
	});

	test("指名的事件不存在、不在这个 session 读得到的记录里，或者类型不能指名：报错说明是哪一个", async () => {
		host = scriptedHost(() => reply("好的"));
		const parent = await record(["第一个任务"]);
		const child = await fork(parent.sessionId);
		await child.session.close();
		const later = await resume(parent.sessionId);
		await submit(later, "分叉之后的任务");
		await later.session.close();
		const other = await record(["另一个 session 的任务"]);
		const events = stored(parent);
		const [inherited, afterFork] = events.filter(
			(event) => event.type === "task.started",
		);
		if (inherited === undefined || afterFork === undefined) {
			throw new Error("父 session 应该有两个 task");
		}
		const attempt = (session: Opened, eventIds: string[]) => () =>
			host.redactionScope({ ...ref(session), eventIds });

		expect(attempt(parent, [])).toThrow(WorkspaceError);
		const missing = "00000000-0000-4000-8000-000000000000";
		expect(attempt(parent, [inherited.event_id, missing])).toThrow(
			new RegExp(`没有事件 ${missing}`),
		);
		// 同一个项目里别的 session 的事件
		const foreign = only(stored(other), "task.started").event_id;
		expect(attempt(parent, [foreign])).toThrow(WorkspaceError);
		// 分叉读得到分叉之前的事件，读不到父 session 之后写的
		expect(attempt(child, [inherited.event_id])).not.toThrow();
		expect(attempt(child, [afterFork.event_id])).toThrow(
			new RegExp(`没有事件 ${afterFork.event_id}`),
		);
		const ended = events.find((event) => event.type === "task.ended");
		expect(attempt(parent, [ended?.event_id as string])).toThrow(
			/task\.ended，不能按它脱敏/,
		);
		await expect(
			host.redactEvents({ ...ref(parent), eventIds: [missing] }),
		).rejects.toThrow(WorkspaceError);
		expect(stored(parent)).toEqual(events);
	});

	test("重复执行：已经覆盖的跳过；指名的都已经脱敏过时报错", async () => {
		host = scriptedHost((_request, call) => reply(`ANSWER-${call}-SECRET`));
		const session = await record(["第一个任务", "第二个任务"]);
		const [first, second] = stored(session).filter(
			(event) => event.type === "message.completed",
		);
		if (first === undefined || second === undefined) {
			throw new Error("应该有两条回复");
		}
		const target = { ...ref(session), eventIds: [first.event_id] };
		await host.redactEvents(target);
		const once = stored(session);

		expect(() => host.redactionScope(target)).toThrow(/已经脱敏过/);
		await expect(host.redactEvents(target)).rejects.toThrow(WorkspaceError);
		expect(stored(session)).toEqual(once);

		// 和还没脱敏的一起指名：只覆盖没做过的
		expect(
			await host.redactEvents({
				...ref(session),
				eventIds: [first.event_id, second.event_id],
			}),
		).toMatchObject({ events: [second.event_id] });
		expect(recordBytes(session).includes("SECRET")).toBe(false);
	});
});

describe("彻底删除记忆", () => {
	/** 记忆的正文：模型提议时写在 `memory_propose` 的参数里，这次调用就是记忆的来源事件。 */
	const body = "MEMORY-BODY-SECRET";

	/** 每个 task 里模型先提议一条记忆，再回答。 */
	function proposingHost(scope: "project" | "user"): Host {
		return scriptedHost((_request, call) =>
			call % 2 === 0
				? {
						content: [
							{
								type: "tool_call",
								call_id: `call_${call}`,
								name: "memory_propose",
								arguments: JSON.stringify({
									scope,
									kind: "fact",
									title: `第 ${call / 2 + 1} 条记忆`,
									body: `${body}-${call / 2 + 1}`,
								}),
							},
						],
					}
				: reply("记下了"),
		);
	}

	function memoryOf({ session }: Opened) {
		const { memory } = session;
		if (memory === undefined) throw new Error("这个 session 没有启用长期记忆");
		return memory;
	}

	/** 执行一个任务，确认模型在里面提议的那条记忆，返回它的编号和来源事件。 */
	async function remember(session: Opened, input: string) {
		const listed = session.log.events.filter(
			(event) => event.type === "memory.candidates",
		).length;
		await submit(session, input);
		const announced = session.log.events.filter(
			(event) => event.type === "memory.candidates",
		)[listed];
		const candidate = announced?.candidates[0];
		if (candidate === undefined) throw new Error("没有列出候选");
		const { id } = memoryOf(session).confirm(candidate.id, candidate.version);
		const started = session.log.events.findLast(
			(event) => event.type === "tool_call.started",
		);
		if (started === undefined) throw new Error("没有登记工具调用");
		return { id, eventId: started.event_id };
	}

	test("来源在已经关闭的 session 里：来源事件一起脱敏，记录里不再有原文；以前脱敏过的来源不算留在记录里", async () => {
		host = proposingHost("project");
		const source = await open();
		const first = await remember(source, "第一个任务");
		const second = await remember(source, "第二个任务");
		await source.session.close();
		expect(recordBytes(source).includes(body)).toBe(true);

		const later = await open();
		expect(await memoryOf(later).purge(first.id)).toEqual({
			redacted: [source.sessionId],
			remaining: [],
		});
		const calls = stored(source).filter(
			(event) => event.type === "tool_call.started",
		);
		expect(calls.map((event) => event.event_id)).toEqual([
			first.eventId,
			second.eventId,
		]);
		// 只覆盖这条记忆的来源：另一条的还在
		expect(calls[0]?.data).toMatchObject({ redacted: true });
		expect(calls[1]?.data).not.toMatchObject({ redacted: true });
		expect(recordBytes(source).includes(`${body}-1`)).toBe(false);
		expect(recordBytes(source).includes(`${body}-2`)).toBe(true);
		// 标题也一样：候选列表和第二个 task 开始时的"记忆更新"里列过它
		expect(recordBytes(source).includes("第 1 条记忆")).toBe(false);
		expect(recordBytes(source).includes("第 2 条记忆")).toBe(true);
		expect(redactions(source)).toHaveLength(1);

		// 另一条的来源先被用户按事件脱敏了，候选列表里它的标题那时一起覆盖了：彻底删除时没有要
		// 覆盖的，也不算留在记录里
		await host.redactEvents({ ...ref(source), eventIds: [second.eventId] });
		expect(recordBytes(source).includes("条记忆")).toBe(false);
		expect(await memoryOf(later).purge(second.id)).toEqual({
			redacted: [source.sessionId],
			remaining: [],
		});
		expect(memoryOf(later).list()).toEqual([]);
		expect(recordBytes(source).includes(body)).toBe(false);
		expect(redactions(source)).toHaveLength(2);
	});

	test("来源就在打开着的 session 里：记忆照样删除，来源、工作区和原因原样给出；关闭之后按给出的事件和记忆的编号脱敏", async () => {
		host = proposingHost("project");
		const source = await open();
		const { id, eventId } = await remember(source, "第一个任务");
		const before = stored(source);

		const { redacted, remaining } = await memoryOf(source).purge(id);
		expect(redacted).toEqual([]);
		expect(remaining).toEqual([
			{
				session_id: source.sessionId,
				workspace: dirs.workspace,
				event_ids: [eventId],
				reason: expect.stringContaining("正被一个 Host 进程打开着"),
			},
		]);
		expect(memoryOf(source).get(id)).toBeUndefined();
		// 打开着的 session 的记录没有被改写
		expect(stored(source).slice(0, before.length)).toEqual(before);

		await source.session.close();
		// 记忆已经删除，编号还能用来找它留在记录里的内容
		await host.redactEvents({
			...ref(source),
			eventIds: [eventId],
			memoryIds: [id],
		});
		expect(recordBytes(source).includes(body)).toBe(false);
		expect(recordBytes(source).includes("条记忆")).toBe(false);
	});

	test("内容只在打开着的 session 里列过、没有来源在里面：也留在结果里，事件为空，之后只按记忆的编号脱敏", async () => {
		host = scriptedHost(() => reply("好的"));
		const session = await open();
		const { id } = memoryOf(session).add({
			scope: "project",
			kind: "fact",
			title: "TITLE-SECRET 标题",
			body: "正文",
		});
		// 第一个 task 开始时索引随上下文消息交给了模型
		await submit(session, "第一个任务");
		expect(recordBytes(session).includes("TITLE-SECRET")).toBe(true);

		expect(await memoryOf(session).purge(id)).toEqual({
			redacted: [],
			remaining: [
				{
					session_id: session.sessionId,
					workspace: dirs.workspace,
					event_ids: [],
					reason: expect.stringContaining("正被一个 Host 进程打开着"),
				},
			],
		});
		await session.session.close();
		const target = { ...ref(session), eventIds: [], memoryIds: [id] };
		expect(host.redactionScope(target).events).toHaveLength(1);
		await host.redactEvents(target);
		expect(recordBytes(session).includes("TITLE-SECRET")).toBe(false);
		// 这个 session 的记录里已经没有它的内容
		expect(() => host.redactionScope(target)).toThrow(WorkspaceError);
		expect(() =>
			host.redactionScope({ ...target, memoryIds: ["not-an-id"] }),
		).toThrow(/不是记忆的编号/);
	});

	test("标题和正文进过的每个地方：索引、记忆更新、检索和读取的结果、候选列表，在哪个 session 里都一起覆盖；同一条消息里的规则文件还在，恢复后发给模型的是占位", async () => {
		writeFileSync(join(dirs.workspace, "AGENTS.md"), "RULE-FILE-TEXT\n");
		const turns: ScriptedTurn[] = [];
		const tool = (name: string, args: object): ScriptedTurn => ({
			content: [
				{
					type: "tool_call",
					call_id: `call_${turns.length}`,
					name,
					arguments: JSON.stringify(args),
				},
			],
		});
		host = scriptedHost(() => turns.shift() ?? reply("好的"));

		// 第一个 session：模型提议，用户确认；之后模型读取它，再检索到它
		const first = await open();
		turns.push(
			tool("memory_propose", {
				scope: "project",
				kind: "fact",
				title: "TITLE-SECRET 标题",
				body: "BODY-SECRET 正文",
			}),
		);
		await submit(first, "第一个任务");
		const [candidate] =
			first.log.events.find((event) => event.type === "memory.candidates")
				?.candidates ?? [];
		if (candidate === undefined) throw new Error("没有列出候选");
		const { id } = memoryOf(first).confirm(candidate.id, candidate.version);
		turns.push(tool("memory_read", { id }));
		await submit(first, "第二个任务");
		turns.push(tool("memory_search", { query: "SECRET" }));
		await submit(first, "第三个任务");
		await first.session.close();

		// 第二个 session：索引在会话开始的上下文消息里；用户改了标题，下一个 task 开始时有"记忆更新"
		const second = await open();
		await submit(second, "第一个任务");
		const listed = memoryOf(second).get(id);
		if (listed === undefined) throw new Error("记忆应该在生效");
		memoryOf(second).correct(id, listed.record.version, {
			title: "TITLE-SECRET 改过的标题",
		});
		await submit(second, "第二个任务");
		await second.session.close();
		const sent = JSON.stringify(requests.map((request) => request.messages));
		for (const copy of [
			"<memory_index>",
			"<memory_update>",
			"TITLE-SECRET 改过的标题",
			"BODY-SECRET",
		]) {
			expect(sent).toContain(copy);
		}

		const third = await open();
		const { redacted, remaining } = await memoryOf(third).purge(id);
		expect(remaining).toEqual([]);
		expect([...redacted].sort()).toEqual(
			[first.sessionId, second.sessionId].sort(),
		);
		expect(recordBytes(first).includes("TITLE-SECRET")).toBe(false);
		expect(recordBytes(first).includes("BODY-SECRET")).toBe(false);
		// 索引和规则文件在同一条消息里，各是一块：只覆盖索引那一块
		expect(recordBytes(first).includes("RULE-FILE-TEXT")).toBe(true);
		const opening = only(stored(second), "message.sent", (data) =>
			data.includes("RULE-FILE-TEXT"),
		);
		expect(JSON.stringify(opening.data)).toContain(placeholder);
		await third.session.close();

		requests = [];
		const resumed = await resume(second.sessionId);
		await submit(resumed, "第三个任务");
		const rebuilt = JSON.stringify(requests[0]?.messages);
		expect(rebuilt).toContain("RULE-FILE-TEXT");
		expect(rebuilt).toContain(placeholder);
		expect(rebuilt).not.toContain("TITLE-SECRET");
	});

	test("自动注入的正文放在输入前面单独的一块：只覆盖这一块，同一条消息里用户的输入还在", async () => {
		host = scriptedHost(() => reply("好的"));
		const session = await open({ memory: { retrieval: "auto" } });
		const { id } = memoryOf(session).add({
			scope: "project",
			kind: "fact",
			title: "RECALL 的用法",
			body: "RECALL-BODY-SECRET",
		});
		await submit(session, "RECALL 怎么用 USER-TEXT");
		await session.session.close();
		expect(JSON.stringify(requests[0]?.messages.at(-1)?.content)).toContain(
			"<memory_recall>",
		);
		expect(recordBytes(session).includes("RECALL-BODY-SECRET")).toBe(true);

		const later = await open();
		expect(await memoryOf(later).purge(id)).toEqual({
			redacted: [session.sessionId],
			remaining: [],
		});
		expect(recordBytes(session).includes("RECALL-BODY-SECRET")).toBe(false);
		expect(recordBytes(session).includes("RECALL 的用法")).toBe(false);
		expect(recordBytes(session).includes("USER-TEXT")).toBe(true);
	});

	test("压缩之后重新生成的上下文消息里也有索引：这次压缩整个覆盖，记录里不再有标题", async () => {
		host = scriptedHost((request) =>
			JSON.stringify(request.messages.at(-1)?.content).includes(
				"<compaction_request>",
			)
				? reply("摘要")
				: reply("好的"),
		);
		const session = await open();
		const { id } = memoryOf(session).add({
			scope: "project",
			kind: "fact",
			title: "COMPACT-TITLE-SECRET",
			body: "正文",
		});
		await submit(session, "第一个任务");
		const compacting = await session.session.compact();
		await session.log.waitFor("task.ended", (e) => e.task_id === compacting);
		await session.session.close();
		const compacted = only(stored(session), "context.compacted");
		expect(JSON.stringify(compacted.data)).toContain("COMPACT-TITLE-SECRET");

		const later = await open();
		expect(await memoryOf(later).purge(id)).toEqual({
			redacted: [session.sessionId],
			remaining: [],
		});
		expect(recordBytes(session).includes("COMPACT-TITLE-SECRET")).toBe(false);
		expect(
			stored(session).find((event) => event.event_id === compacted.event_id)
				?.data,
		).toMatchObject({ redacted: true });
	});

	test("带着图片的输入前面有记忆更新：图片随事件一起覆盖，所以这条消息和 task.started 里的输入整个覆盖", async () => {
		host = scriptedHost(() => reply("好的"));
		const images = { models: { scripted: { ...testModel, images: true } } };
		const session = await open(images);
		const added = memoryOf(session).add({
			scope: "project",
			kind: "fact",
			title: "标题",
			body: "正文",
		});
		await submit(session, "第一个任务");
		memoryOf(session).correct(added.id, added.version, {
			title: "IMAGE-TITLE-SECRET",
		});
		const taskId = await session.session.submit([
			{ type: "text", text: "看这张图 USER-TEXT" },
			{
				type: "image",
				media_type: "image/png",
				data: noisePng(200, 100).toString("base64"),
			},
		]);
		await session.log.waitFor("task.ended", (e) => e.task_id === taskId);
		await session.session.close();
		const before = stored(session);
		const input = only(before, "message.sent", (data) =>
			data.includes("USER-TEXT"),
		);
		expect(JSON.stringify(input.data)).toContain("IMAGE-TITLE-SECRET");

		const later = await open(images);
		expect(await memoryOf(later).purge(added.id)).toEqual({
			redacted: [session.sessionId],
			remaining: [],
		});
		expect(recordBytes(session).includes("IMAGE-TITLE-SECRET")).toBe(false);
		expect(
			stored(session).find((event) => event.event_id === input.event_id)?.data,
		).toMatchObject({ redacted: true, message: { content: covered } });
		expect(
			stored(session).filter((event) => event.type === "task.started")[1]?.data,
		).toMatchObject({ redacted: true, input: covered });
	});

	test("user 记忆的来源和内容在别的项目里：每个登记过的项目里都找，那个项目的记录一起覆盖", async () => {
		host = proposingHost("user");
		const source = await open();
		const { id } = await remember(source, "第一个任务");
		// 确认之后再做一个 task：这个项目的记录里除了来源，还有"记忆更新"里的标题
		await submit(source, "第二个任务");
		await source.session.close();
		expect(recordBytes(source).includes("第 1 条记忆")).toBe(true);

		const other = join(dirname(dirs.workspace), "other-project");
		mkdirSync(other);
		const elsewhere = await open({ workspace: other });
		expect(elsewhere.projectId).not.toBe(source.projectId);
		expect(await memoryOf(elsewhere).purge(id)).toEqual({
			redacted: [source.sessionId],
			remaining: [],
		});
		expect(memoryOf(elsewhere).get(id)).toBeUndefined();
		expect(recordBytes(source).includes(`${body}-1`)).toBe(false);
		expect(recordBytes(source).includes("第 1 条记忆")).toBe(false);
	});
});
