import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import { scriptedModel } from "@ospreycode/api/testing";
import { type RunRecord, SessionStore } from "@ospreycode/session-store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;

beforeEach(() => {
	dirs = testDirectories();
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

test("会存储的事件都写进项目的 session 记录，新的 run 接在上一个 run 的最后一个事件之后", async () => {
	const log = new EventLog();
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request) =>
			request.messages.at(-1)?.role === "user"
				? {
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "shell",
								arguments: JSON.stringify({ command: "echo hi" }),
							},
						],
					}
				: { content: [{ type: "text", text: "done" }] },
		),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	const started = await log.waitFor("session.started");
	await session.submit("第一个任务\n第二行");
	await log.waitFor("task.ended");
	const second = await session.submit("第二个任务");
	await log.waitFor("task.ended", (event) => event.task_id === second);
	await session.close();

	const store = SessionStore.open(
		join(dirs.root, "data", "projects", started.project_id, "sessions.sqlite"),
	);
	try {
		const events = store.events(session.id);
		const external = log.events.filter(
			(event) => "event_id" in event && "seq" in event,
		);
		expect(
			events.map((event) => [event.type, event.event_id, event.seq]),
		).toEqual(
			external.map((event) =>
				"event_id" in event && "seq" in event
					? [event.type, event.event_id, event.seq]
					: [],
			),
		);
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"task.started",
			"message.completed",
			"tool_call.started",
			"tool_call.completed",
			"message.completed",
			"task.ended",
			"run.started",
			"task.started",
			"message.completed",
			"tool_call.started",
			"tool_call.completed",
			"message.completed",
			"task.ended",
		]);
		const [first, next] = store.runs(session.id) as [RunRecord, RunRecord];
		const firstEnd = events[6];
		expect(first.base).toBeNull();
		expect(next.base).toEqual({ run_id: firstEnd?.run_id, seq: firstEnd?.seq });
		expect(store.sessions()).toMatchObject([
			{
				session_id: session.id,
				workspace: dirs.workspace,
				title: "第一个任务",
			},
		]);
		expect(events[1]).toMatchObject({
			source: "host",
			data: {
				source: "user",
				input: [{ type: "text", text: "第一个任务\n第二行" }],
			},
		});
	} finally {
		store.close();
	}
});
