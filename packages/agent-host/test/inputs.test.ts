import {
	createHost,
	type HostEvent,
	type Session,
} from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { type Script, scriptedModel } from "@ospreycode/api/testing";
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

/** 脚本在模型请求进行时运行：在里面排输入，相当于用户在模型回复期间输入。 */
async function open(script: Script): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(request);
			return script(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

const text = (value: string) => [{ type: "text" as const, text: value }];

/** 请求里的对话：去掉系统指令和会话开始的上下文消息。 */
function conversation(request: ModelRequest | undefined): Message[] {
	return (request?.messages ?? []).slice(2);
}

/** 存储的事件，去掉流式增量。 */
/** 发给前端的事件里存下来的那些，不含不属于 task 的进程事件。 */
function stored(): HostEvent[] {
	return log.events.filter(
		(event) =>
			event.type !== "model.delta" &&
			event.type !== "tool_call.output" &&
			event.type !== "process.started" &&
			event.type !== "process.exited",
	);
}

function ofType<Type extends HostEvent["type"]>(
	type: Type,
): Extract<HostEvent, { type: Type }>[] {
	return log.events.filter(
		(event): event is Extract<HostEvent, { type: Type }> => event.type === type,
	);
}

test("steering 在这一轮的工具结果之后、下一次模型请求之前插入，事件记下排队和插入的位置", async () => {
	const ids: string[] = [];
	const current = await open((_request, call) => {
		if (call > 0) return say("done");
		ids.push(current.steer("also update the docs"));
		ids.push(current.steer("and keep it short"));
		return {
			content: [
				{
					type: "tool_call",
					call_id: "call_1",
					name: "shell",
					arguments: JSON.stringify({ command: "echo hi" }),
				},
			],
		};
	});
	const taskId = await current.submit("do it");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });

	const messages = conversation(requests[1]);
	expect(messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"tool_result",
		"user",
	]);
	// 几条一起到：按输入的顺序一次插入，每条单独一块
	expect(messages[3]?.content).toEqual([
		...text("also update the docs"),
		...text("and keep it short"),
	]);

	const [first, second] = ofType("input.queued");
	expect(first).toMatchObject({
		task_id: taskId,
		input_id: ids[0],
		kind: "steering",
		input: text("also update the docs"),
		queue: {
			steering: [{ input_id: ids[0] }],
			follow_up: [],
			follow_up_paused: false,
		},
	});
	expect(second?.queue.steering.map((queued) => queued.input_id)).toEqual(ids);
	const [call] = ofType("tool_call.completed");
	expect(ofType("input.inserted")).toMatchObject([
		{
			task_id: taskId,
			input_ids: ids,
			message_id: messages[3]?.message_id,
			after_tool_call_id: call?.tool_call_id,
			queue: { steering: [], follow_up: [], follow_up_paused: false },
		},
	]);
	// 只有一个 task，插入记在工具结果和下一次回复之间
	expect(stored().map((event) => event.type)).toEqual([
		"session.started",
		"run.started",
		"task.started",
		"input.queued",
		"input.queued",
		"message.completed",
		"tool_call.started",
		"tool_call.completed",
		"input.inserted",
		"message.completed",
		"task.ended",
	]);
	expect(current.inputQueue()).toEqual({
		steering: [],
		follow_up: [],
		follow_up_paused: false,
	});
});

test("模型已经给出最终回复时还有 steering：同一个 task 再请求一次模型", async () => {
	const current = await open((_request, call) => {
		if (call === 0) current.steer("one more thing");
		return say(`reply ${call}`);
	});
	const taskId = await current.submit("do it");
	await log.waitFor("task.ended");

	expect(requests).toHaveLength(2);
	const messages = conversation(requests[1]);
	expect(messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"user",
	]);
	expect(messages[2]?.content).toEqual(text("one more thing"));
	expect(ofType("input.inserted")).toMatchObject([
		{ task_id: taskId, after_tool_call_id: null },
	]);
	expect(ofType("task.started")).toHaveLength(1);
	expect(ofType("task.ended")).toMatchObject([
		{ task_id: taskId, outcome: "completed" },
	]);
});

test("取消时还没插入的 steering 立即交给模型，沿用同一个 task 和 run", async () => {
	const current = await open((_request, call) =>
		call === 0
			? { content: [{ type: "text", text: "写到一半" }], hang: true }
			: say("haiku"),
	);
	const taskId = await current.submit("write a long poem");
	await log.waitFor("model.delta");
	const inputId = current.steer("make it a haiku instead");
	await current.cancel();
	const ended = await log.waitFor("task.ended");

	expect(ended).toMatchObject({ task_id: taskId, outcome: "completed" });
	expect(ofType("run.started")).toHaveLength(1);
	expect(ofType("task.ended")).toHaveLength(1);
	expect(ofType("input.inserted")).toMatchObject([
		{ task_id: taskId, run_id: ended.run_id, input_ids: [inputId] },
	]);
	expect(ofType("input.dequeued")).toEqual([]);
	// 被取消的那次回复不在发给模型的历史里
	const messages = conversation(requests[1]);
	expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
	expect(messages[1]?.content).toEqual(text("make it a haiku instead"));
	expect(
		ofType("message.completed").map((event) => event.message.stop_reason),
	).toEqual(["cancelled", "end_turn"]);
});

test("task 没有成功结束时，还没插入的 steering 交还前端，不留在队列里", async () => {
	let inputId = "";
	const current = await open(() => {
		inputId = current.steer("never delivered");
		return {
			content: [],
			error: { category: "authentication", message: "invalid x-api-key" },
		};
	});
	const taskId = await current.submit("do it");
	await log.waitFor("task.ended");

	expect(ofType("input.dequeued")).toMatchObject([
		{
			task_id: taskId,
			reason: "task_ended",
			inputs: [
				{ input_id: inputId, kind: "steering", input: text("never delivered") },
			],
			queue: { steering: [] },
		},
	]);
	expect(stored().map((event) => event.type)).toEqual([
		"session.started",
		"run.started",
		"task.started",
		"input.queued",
		"message.completed",
		"input.dequeued",
		"task.ended",
	]);
	expect(ofType("task.ended")).toMatchObject([{ outcome: "failed" }]);
	expect(current.inputQueue().steering).toEqual([]);
});

test("follow-up 在当前 task 完成后逐条作为新的 task 开始；steering 先于 follow-up", async () => {
	const queued: string[] = [];
	const current = await open((_request, call) => {
		if (call === 0) {
			queued.push(current.followUp("second task"));
			queued.push(current.followUp("third task"));
			current.steer("part of the first task");
		}
		return say(`reply ${call}`);
	});
	const first = await current.submit("first task");
	await log.waitFor(
		"task.started",
		(e) => e.input[0]?.type === "text" && e.input[0].text === "third task",
	);
	const tasks = ofType("task.started");
	await log.waitFor("task.ended", (e) => e.task_id === tasks[2]?.task_id);

	expect(
		tasks.map((event) => [event.source, event.input, event.task_id === first]),
	).toEqual([
		["user", text("first task"), true],
		["follow_up", text("second task"), false],
		["follow_up", text("third task"), false],
	]);
	// 第一个 task：两次请求（steering 让它继续），之后两个 follow-up 各一次
	expect(requests.map((request) => conversation(request).length)).toEqual([
		1, 3, 5, 7,
	]);
	expect(conversation(requests[3]).map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
		"user",
		"assistant",
		"user",
	]);
	expect(conversation(requests[3])[6]?.content).toEqual(text("third task"));
	// follow-up 离开列表记在它开始的 task 里，一次只取一条
	expect(ofType("input.dequeued")).toMatchObject([
		{
			task_id: tasks[1]?.task_id,
			reason: "follow_up_started",
			inputs: [{ input_id: queued[0], kind: "follow_up" }],
			queue: { follow_up: [{ input_id: queued[1] }] },
		},
		{
			task_id: tasks[2]?.task_id,
			reason: "follow_up_started",
			inputs: [{ input_id: queued[1], kind: "follow_up" }],
			queue: { follow_up: [] },
		},
	]);
	expect(ofType("task.ended").map((event) => event.outcome)).toEqual([
		"completed",
		"completed",
		"completed",
	]);
});

test("task 被取消时 follow-up 列表保留并暂停，用户让它继续之后逐条开始", async () => {
	const current = await open((_request, call) =>
		call === 0
			? { content: [{ type: "text", text: "写到一半" }], hang: true }
			: say(`reply ${call}`),
	);
	const first = await current.submit("first task");
	await log.waitFor("model.delta");
	const queuedId = current.followUp("second task");
	await current.cancel();
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === first),
	).toMatchObject({ outcome: "cancelled" });

	// 暂停记在 task 结束之前
	const types = stored().map((event) => event.type);
	expect(types.slice(-2)).toEqual(["input.follow_up_paused", "task.ended"]);
	expect(ofType("input.follow_up_paused")).toMatchObject([
		{ task_id: first, paused: true, queue: { follow_up_paused: true } },
	]);
	expect(ofType("task.started")).toHaveLength(1);
	expect(current.inputQueue()).toMatchObject({
		follow_up: [{ input_id: queuedId }],
		follow_up_paused: true,
	});

	// 列表暂停着，session 空闲时也能往里排
	current.followUp("third task");
	await current.resumeFollowUps();
	await log.waitFor(
		"task.started",
		(e) => e.input[0]?.type === "text" && e.input[0].text === "third task",
	);
	const tasks = ofType("task.started");
	await log.waitFor("task.ended", (e) => e.task_id === tasks[2]?.task_id);

	expect(tasks.map((event) => [event.source, event.input])).toEqual([
		["user", text("first task")],
		["follow_up", text("second task")],
		["follow_up", text("third task")],
	]);
	expect(ofType("input.follow_up_paused").map((event) => event.paused)).toEqual(
		[true, false],
	);
	expect(current.inputQueue()).toEqual({
		steering: [],
		follow_up: [],
		follow_up_paused: false,
	});
});

test("列表暂停时用户的下一次输入让它继续：先做这次输入，再做列表里的", async () => {
	const current = await open((_request, call) =>
		call === 0
			? {
					content: [],
					error: { category: "authentication", message: "invalid x-api-key" },
				}
			: say(`reply ${call}`),
	);
	const first = await current.submit("first task");
	current.followUp("queued task");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === first),
	).toMatchObject({ outcome: "failed" });
	expect(current.inputQueue().follow_up_paused).toBe(true);

	await current.submit("retry");
	await log.waitFor("task.started", (e) => e.source === "follow_up");
	const tasks = ofType("task.started");
	await log.waitFor("task.ended", (e) => e.task_id === tasks[2]?.task_id);
	expect(tasks.map((event) => [event.source, event.input])).toEqual([
		["user", text("first task")],
		["user", text("retry")],
		["follow_up", text("queued task")],
	]);
	// 继续记在用户这次输入开始的 task 里
	expect(ofType("input.follow_up_paused")).toMatchObject([
		{ task_id: first, paused: true },
		{ task_id: tasks[1]?.task_id, paused: false },
	]);
});

test("排队的输入可以取回：按编号取一条，或者全部取回", async () => {
	let one: unknown;
	let all: unknown;
	let ids: string[] = [];
	const current = await open((_request, call) => {
		if (call === 0) {
			ids = [
				current.steer("steering a"),
				current.followUp("follow-up b"),
				current.steer("steering c"),
			];
			one = current.dequeue(ids[0]);
			all = current.dequeue();
		}
		return say("done");
	});
	const taskId = await current.submit("do it");
	await log.waitFor("task.ended");

	expect(one).toEqual([
		{ input_id: ids[0], kind: "steering", input: text("steering a") },
	]);
	expect(all).toEqual([
		{ input_id: ids[2], kind: "steering", input: text("steering c") },
		{ input_id: ids[1], kind: "follow_up", input: text("follow-up b") },
	]);
	expect(ofType("input.dequeued")).toMatchObject([
		{
			task_id: taskId,
			reason: "returned",
			inputs: [{ input_id: ids[0] }],
			queue: {
				steering: [{ input_id: ids[2] }],
				follow_up: [{ input_id: ids[1] }],
			},
		},
		{
			task_id: taskId,
			reason: "returned",
			inputs: [{ input_id: ids[2] }, { input_id: ids[1] }],
			queue: { steering: [], follow_up: [] },
		},
	]);
	// 取回之后没有东西交给模型，也没有新的 task
	expect(requests).toHaveLength(1);
	expect(ofType("task.started")).toHaveLength(1);
	expect(current.dequeue()).toEqual([]);
});

test("session 空闲时不接受 steering 和 follow-up，task 运行时不接受 submit", async () => {
	let submitError: unknown;
	const current = await open(() => {
		submitError = current.submit("another").catch((error: unknown) => error);
		return say("done");
	});
	expect(() => current.steer("too early")).toThrow("submit");
	expect(() => current.followUp("too early")).toThrow("submit");
	await current.submit("do it");
	await log.waitFor("task.ended");
	expect(String(await submitError)).toContain("steer");
	expect(() => current.steer("too late")).toThrow("submit");
	expect(() => current.followUp("too late")).toThrow("submit");
	expect(ofType("input.queued")).toEqual([]);
});
