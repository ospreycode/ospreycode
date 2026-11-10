import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import {
	parseEvents,
	runCli,
	type TestDirectories,
	testDirectories,
} from "./harness.js";

let dirs: TestDirectories;

beforeEach(() => {
	checkLedger();
	dirs = testDirectories();
});

afterEach(() => {
	dirs.cleanup();
});

test("打包后的 CLI 用真实模型在沙盒里做完一个任务：事件流、退出码和工作区里的结果", {
	tags: ["model"],
}, async (context) => {
	// 内置清单里的条目，只把地址换成中转服务
	dirs.writeConfig(`
model = "claude-haiku-5-5"
reasoning_effort = "off"

[models.claude-haiku-5-5]
base_url = ${JSON.stringify(inject("modelBaseUrl"))}
max_output_tokens = 2000
`);
	const sandboxed = process.platform === "darwin";
	const result = await runCli(
		[
			"exec",
			"--json",
			"--credential-file",
			`anthropic=${join(inject("modelKeysDir"), "anthropic")}`,
			"--sandbox",
			// Linux 的 CI 机器不一定装了 bubblewrap，那里不启用系统隔离
			sandboxed ? "workspace-write" : "danger-full-access",
			"--max-cost",
			String(testRunLimits.maxCostUsd),
			"--max-requests",
			String(testRunLimits.maxRequests),
			"--timeout",
			"5m",
			"Use the shell tool to create a file named hello.txt in the workspace whose content is exactly the word osprey. Then reply with the single word: done.",
		],
		{ cwd: dirs.workspace, env: dirs.env },
	);

	const events = parseEvents(result.stdout);
	const ended = events.find((event) => event.type === "task.ended");
	if (ended?.type !== "task.ended") {
		throw new Error(`没有 task.ended：${result.stderr}`);
	}
	charge(ended.usage);
	throwIfTransient(ended);
	context.annotate(`费用 $${ended.usage.cost_usd}`);

	expect(result.code).toBe(0);
	expect(events.at(0)?.type).toBe("session.started");
	expect(events.at(-1)).toMatchObject({
		type: "session.ended",
		outcome: "completed",
		exit_code: 0,
	});
	expect(readFileSync(join(dirs.workspace, "hello.txt"), "utf8").trim()).toBe(
		"osprey",
	);
	// 模型的第一次尝试不一定成功（比如先用了不存在的命令）：看的是有命令在沙盒里做成了
	const statuses = events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result.status] : [],
	);
	expect(statuses).toContain("succeeded");
});
