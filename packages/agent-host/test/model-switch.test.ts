import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ConfigError,
	CredentialError,
	createHost,
	type HostEvent,
	type Session,
	SessionCommandError,
} from "@ospreycode/agent-host";
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
/** 每次模型请求实际用的清单条目、推理强度和凭据。 */
let used: { id: string; model: string; effort: string; key: string }[];
let otherCredentialFile: string;

beforeEach(() => {
	dirs = testDirectories();
	log = new EventLog();
	used = [];
	session = undefined;
	otherCredentialFile = join(dirname(dirs.credentialFile), "other");
	writeFileSync(otherCredentialFile, "other-key\n", { mode: 0o600 });
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

const { price: _price, ...unpriced } = testModel;

async function open(script: Script): Promise<Session> {
	const scripted = scriptedModel(script);
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: (entry, request, options) => {
			used.push({
				id: entry.id,
				model: entry.model,
				effort: request.reasoning_effort,
				key: options.apiKey,
			});
			return scripted(entry, request, options);
		},
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: {
			scripted: testModel,
			second: { ...testModel, model: "scripted-2", max_output_tokens: 4_000 },
			unpriced: { ...unpriced, model: "scripted-3" },
			nokey: { ...testModel, service: "nokey" },
			elsewhere: { ...testModel, service: "other" },
		},
		credentials: {
			test: { file: dirs.credentialFile },
			other: { file: otherCredentialFile },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

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

test("task 运行中换模型和推理强度：下一次请求起生效，事件记在用到新值的第一次请求之前", async () => {
	const current = await open((_request, call) =>
		call === 0
			? {
					content: [
						{
							type: "tool_call",
							call_id: "call_1",
							name: "shell",
							arguments: JSON.stringify({ command: "sleep 0.5" }),
						},
					],
				}
			: say("done"),
	);
	const taskId = await current.submit("do it");
	await log.waitFor("tool_call.started");
	await current.setModel("second", "high");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });

	expect(used).toEqual([
		{ id: "scripted", model: "scripted", effort: "medium", key: "test-key" },
		{ id: "second", model: "scripted-2", effort: "high", key: "test-key" },
	]);
	expect(ofType("model.changed")).toMatchObject([
		{ task_id: taskId, model: "second", previous_model: "scripted" },
	]);
	expect(ofType("reasoning_effort.changed")).toMatchObject([
		{
			task_id: taskId,
			reasoning_effort: "high",
			previous_reasoning_effort: "medium",
		},
	]);
	expect(stored().map((event) => event.type)).toEqual([
		"session.started",
		"run.started",
		"task.started",
		"message.completed",
		"tool_call.started",
		"tool_call.completed",
		"model.changed",
		"reasoning_effort.changed",
		"message.completed",
		"task.ended",
	]);
	// 每条回复都记下请求的模型、实际回答的模型和推理强度
	expect(
		ofType("message.completed").map(({ message }) => [
			message.requested_model,
			message.model,
			message.reasoning_effort,
		]),
	).toEqual([
		["scripted", "scripted", "medium"],
		["second", "scripted-2", "high"],
	]);
});

test("空闲时切换：下一个 task 用新的值；没有变化的不记事件", async () => {
	const current = await open(() => say("done"));
	const first = await current.submit("one");
	await log.waitFor("task.ended", (e) => e.task_id === first);

	await current.setReasoningEffort("low");
	const second = await current.submit("two");
	await log.waitFor("task.ended", (e) => e.task_id === second);

	// 换成现在的模型、现在的推理强度：什么都没变
	await current.setModel("scripted", "low");
	const third = await current.submit("three");
	await log.waitFor("task.ended", (e) => e.task_id === third);

	await current.setModel("second");
	const fourth = await current.submit("four");
	await log.waitFor("task.ended", (e) => e.task_id === fourth);

	expect(used.map(({ id, effort }) => [id, effort])).toEqual([
		["scripted", "medium"],
		["scripted", "low"],
		["scripted", "low"],
		["second", "low"],
	]);
	expect(ofType("reasoning_effort.changed")).toMatchObject([
		{
			task_id: second,
			reasoning_effort: "low",
			previous_reasoning_effort: "medium",
		},
	]);
	expect(ofType("model.changed")).toMatchObject([
		{ task_id: fourth, model: "second", previous_model: "scripted" },
	]);
});

test("切换前做和启动时相同的检查，不满足就拒绝，session 照常用原来的模型", async () => {
	const current = await open(() => say("done"));
	await expect(current.setModel("missing")).rejects.toThrow(ConfigError);
	// 默认启用费用上限，没有价格的模型算不出费用
	await expect(current.setModel("unpriced")).rejects.toThrow(ConfigError);
	await expect(current.setModel("nokey")).rejects.toThrow(CredentialError);

	const taskId = await current.submit("hi");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });
	expect(used).toEqual([
		{ id: "scripted", model: "scripted", effort: "medium", key: "test-key" },
	]);
	expect(ofType("model.changed")).toEqual([]);
	expect(ofType("reasoning_effort.changed")).toEqual([]);
});

test("新模型的凭据来自另一个文件：只能在空闲时换，重启 agent 进程后用新的凭据，历史保留", async () => {
	const current = await open((_request, call) =>
		call === 0
			? { content: [{ type: "text", text: "写到一半" }], hang: true }
			: say("done"),
	);
	const first = await current.submit("one");
	await log.waitFor("model.delta");
	await expect(current.setModel("elsewhere")).rejects.toThrow(
		SessionCommandError,
	);
	await current.cancel();
	await log.waitFor("task.ended", (e) => e.task_id === first);

	await current.setModel("elsewhere");
	const second = await current.submit("two");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === second),
	).toMatchObject({ outcome: "completed" });
	expect(used.map(({ id, key }) => [id, key])).toEqual([
		["scripted", "test-key"],
		["elsewhere", "other-key"],
	]);
	expect(ofType("model.changed")).toMatchObject([
		{ task_id: second, model: "elsewhere", previous_model: "scripted" },
	]);
});
