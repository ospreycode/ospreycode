import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { afterEach, beforeEach, describe, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;

beforeEach(() => {
	checkLedger();
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

/** 用真实模型打开 session：内置清单里的条目，只把地址换成中转服务。 */
async function open(model: string): Promise<Session> {
	const entry: ModelFields = {
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
	session = await createHost({ root: dirs.root, env: dirs.env }).openSession({
		workspace: dirs.workspace,
		model,
		models: { [model]: entry },
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		budget: testRunLimits,
		onEvent: log.push,
	});
	return session;
}

/** 等一个 task 结束并记账；不给 task 就等第一个。 */
async function finished(taskId?: string) {
	const ended = await log.waitFor(
		"task.ended",
		(event) => taskId === undefined || event.task_id === taskId,
	);
	charge(ended.usage);
	throwIfTransient(ended);
	return ended;
}

/** 模型最后一条回复里的文字。 */
function lastReply(): string {
	const completed = log.events.filter((e) => e.type === "message.completed");
	return (completed.at(-1)?.message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function release(name: string): void {
	writeFileSync(join(dirs.workspace, name), "");
}

test("真实模型把命令放到后台后结束这一轮；命令结束的通知唤醒 session，模型读出它的输出", {
	tags: ["model"],
}, async () => {
	const session = await open("claude-haiku-5-5");
	// 命令等工作区里出现 go 文件才结束：模型没法靠等待或查询把它等完
	await session.submit(
		"Start this command in the background with the shell tool (set `background` to true): `until [ -e go ]; do sleep 0.2; done; echo kestrel-77`. It will not finish for a while. Do not wait for it and do not check on it: reply with the single word `started` and stop. You will get an automatic notification when it finishes; when that happens, find out what it printed and reply with that word only.",
	);
	const first = await finished();
	expect(first.outcome).toBe("completed");
	const [started] = log.events.filter((e) => e.type === "background.started");
	expect(started).toMatchObject({ kind: "command" });

	release("go");
	const wake = await log.waitFor(
		"task.started",
		(event) => event.source === "notification",
	);
	const ended = await finished(wake.task_id);

	expect(ended.outcome).toBe("completed");
	expect(lastReply()).toContain("kestrel-77");
	expect(log.events.filter((e) => e.type === "background.ended")).toMatchObject(
		[{ reason: "exited", exit_code: 0 }],
	);
	expect(log.invalid).toEqual([]);
});

// 工具循环中途插入的话和通知放在工具结果后面的 user 内容里；这两个型号可能忽略紧跟在工具结果后面的 system 消息
describe.each(["claude-haiku-5-5", "claude-sonnet-5-5"])(
	"%s：工具循环中途插入的内容跟在工具结果后面",
	(model) => {
		test("steering 的话，模型照着做", { tags: ["model"] }, async () => {
			const session = await open(model);
			await session.submit(
				"Run this command with the shell tool and wait for it to finish: `until [ -e go ]; do sleep 0.2; done; echo ready`. Then reply with the single word: done.",
			);
			const call = await log.waitFor(
				"tool_call.started",
				(event) => event.name === "shell",
			);
			session.steer(
				"Change of plan: once the command has finished, reply with the single word kestrel-91 instead of done.",
			);
			release("go");
			const ended = await finished();

			expect(ended.outcome).toBe("completed");
			expect(
				log.events.filter((e) => e.type === "input.inserted"),
			).toMatchObject([{ after_tool_call_id: call.tool_call_id }]);
			expect(lastReply()).toContain("kestrel-91");
			expect(log.invalid).toEqual([]);
		});

		test("后台命令结束的通知，模型没有忽略", { tags: ["model"] }, async () => {
			const session = await open(model);
			// 退出码只出现在通知里：模型不再调用工具，答得出来就是读了通知
			await session.submit(
				"Do these two steps with the shell tool, one call at a time. Step 1: start `until [ -e go ]; do sleep 0.2; done; exit 7` in the background (set `background` to true). Step 2: run `until [ -e go2 ]; do sleep 0.2; done; echo ready` in the foreground and wait for it to finish. After step 2 make no more tool calls. If you have been told by then how the background command ended, reply with its exit code only; otherwise reply with the single word: unknown.",
			);
			const background = await log.waitFor("background.started");
			await log.waitFor(
				"tool_call.started",
				(event) =>
					event.name === "shell" &&
					event.tool_call_id !== background.tool_call_id,
			);
			release("go");
			await log.waitFor("background.notification");
			release("go2");
			const ended = await finished();

			expect(ended.outcome).toBe("completed");
			expect(
				log.events.filter((e) => e.type === "background.delivered"),
			).toHaveLength(1);
			expect(
				log.events.filter((e) => e.type === "tool_call.started"),
			).toHaveLength(2);
			expect(lastReply()).toContain("7");
			expect(lastReply()).not.toContain("unknown");
			// 通知在这一轮里已经交给模型，不再另外唤醒
			expect(log.events.filter((e) => e.type === "task.started")).toHaveLength(
				1,
			);
			expect(log.invalid).toEqual([]);
		});
	},
);
