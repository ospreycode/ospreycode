import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
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

/** 用真实模型做完一个 task，返回 `task.ended`。 */
async function runTask(input: string) {
	// 内置清单里的条目，只把地址换成中转服务
	const entry: ModelFields = {
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
	session = await createHost({ root: dirs.root, env: dirs.env }).openSession({
		workspace: dirs.workspace,
		model: "claude-haiku-5-5",
		models: { "claude-haiku-5-5": entry },
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		budget: testRunLimits,
		onEvent: log.push,
	});
	await session.submit(input);
	const ended = await log.waitFor("task.ended");
	charge(ended.usage);
	throwIfTransient(ended);
	return ended;
}

/** 完成的工具调用：工具名和结果的状态。 */
function toolCalls(): [string, string][] {
	const names = new Map(
		log.events.flatMap((event) =>
			event.type === "tool_call.started"
				? [[event.tool_call_id, event.name] as const]
				: [],
		),
	);
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed"
			? [[names.get(event.tool_call_id) ?? "", event.result.status]]
			: [],
	);
}

test("真实模型经通道请求模型、由 Host 执行 shell，完成任务", {
	tags: ["model"],
}, async () => {
	const ended = await runTask(
		"Use the shell tool to create a file named hello.txt in the workspace whose content is exactly the word osprey. Then reply with the single word: done.",
	);

	expect(ended.outcome).toBe("completed");
	expect(ended.usage.input).toBeGreaterThan(0);
	expect(readFileSync(join(dirs.workspace, "hello.txt"), "utf8").trim()).toBe(
		"osprey",
	);
	expect(toolCalls()).toContainEqual(["shell", "succeeded"]);
	expect(log.invalid).toEqual([]);
});

test("真实模型用 write 新建文件，再用 edit 改其中一处", {
	tags: ["model"],
}, async () => {
	const ended = await runTask(
		"Use the write tool to create notes.txt in the workspace with exactly two lines: `alpha` and `beta`. Then use the edit tool to replace `beta` with `gamma`. Do not use the shell tool. Then reply with the single word: done.",
	);

	expect(ended.outcome).toBe("completed");
	expect(
		readFileSync(join(dirs.workspace, "notes.txt"), "utf8").trim().split("\n"),
	).toEqual(["alpha", "gamma"]);
	expect(toolCalls()).toContainEqual(["write", "succeeded"]);
	expect(toolCalls()).toContainEqual(["edit", "succeeded"]);
	expect(log.invalid).toEqual([]);
});
