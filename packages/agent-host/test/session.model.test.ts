import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;

beforeEach(() => {
	dirs = testDirectories();
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

test("真实模型经通道请求模型、由 Host 执行 shell，完成任务", {
	tags: ["model"],
}, async () => {
	const entry: ModelFields = {
		protocol: "anthropic.messages",
		service: "anthropic",
		base_url: inject("modelBaseUrl"),
		model: "claude-haiku-5-5",
		context_window: 200_000,
		max_output_tokens: 2_000,
	};
	const log = new EventLog();
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
		onEvent: log.push,
	});
	await session.submit(
		"Use the shell tool to create a file named hello.txt in the workspace whose content is exactly the word osprey. Then reply with the single word: done.",
	);

	const ended = await log.waitFor("task.ended");
	expect(ended.outcome).toBe("completed");
	expect(ended.usage.input).toBeGreaterThan(0);
	expect(readFileSync(join(dirs.workspace, "hello.txt"), "utf8").trim()).toBe(
		"osprey",
	);
	const results = log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result.status] : [],
	);
	expect(results).toContain("succeeded");
	expect(log.invalid).toEqual([]);
});
