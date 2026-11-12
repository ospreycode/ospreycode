import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

const model = "claude-haiku-5-5";

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

test("真实模型把一件事交给子 agent：子 agent 在自己的 run 里用工具做完，结果回到主 agent", {
	tags: ["model"],
}, async () => {
	mkdirSync(dirs.root, { mode: 0o700 });
	writeFileSync(
		join(dirs.root, "config.toml"),
		`
[agents.explorer]
description = "Reads files in the workspace and reports what they contain."
`,
	);
	writeFileSync(
		join(dirs.workspace, "notes.txt"),
		"The code word is heron-7204.\n",
	);
	session = await createHost({ root: dirs.root, env: dirs.env }).openSession({
		workspace: dirs.workspace,
		model,
		models: {
			[model]: { base_url: inject("modelBaseUrl"), max_output_tokens: 4_000 },
		},
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		// 主 agent 和子 agent 共用这一份上限
		budget: testRunLimits,
		onEvent: log.push,
	});
	const taskId = await session.submit(
		"Start the explorer subagent with the spawn_agent tool and have it read notes.txt in the workspace and report the code word in it. Do not read the file yourself. When its result arrives, reply with just the code word.",
	);
	const ended = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	charge(ended.usage);
	throwIfTransient(ended);
	expect(ended.outcome).toBe("completed");

	const started = log.events.filter((e) => e.type === "subagent.started");
	expect(started).toMatchObject([{ name: "explorer", model }]);
	const child = started[0]?.agent_id;
	expect(child).not.toBe(ended.agent_id);
	const calls = log.events.filter((e) => e.type === "tool_call.started");
	expect(
		calls.filter((e) => e.agent_id === ended.agent_id).map((e) => e.name),
	).toContain("spawn_agent");
	// 文件是子 agent 读的
	expect(calls.some((e) => e.agent_id === child)).toBe(true);
	expect(log.events.filter((e) => e.type === "subagent.ended")).toMatchObject([
		{ agent_id: child, outcome: "completed" },
	]);
	// 子 agent 的用量计入这个 task
	const childUsage = log.events.find((e) => e.type === "subagent.ended")?.usage;
	expect(childUsage?.input).toBeGreaterThan(0);
	expect(ended.usage.input).toBeGreaterThan(childUsage?.input ?? 0);
	// 结果作为通知回到主 agent，它的最终回复里有子 agent 找到的内容
	const replies = log.events
		.filter((e) => e.type === "message.completed")
		.filter((e) => e.agent_id === ended.agent_id);
	expect(
		(replies.at(-1)?.message.content ?? [])
			.map((block) => (block.type === "text" ? block.text : ""))
			.join(""),
	).toContain("heron-7204");
	expect(log.invalid).toEqual([]);
});
