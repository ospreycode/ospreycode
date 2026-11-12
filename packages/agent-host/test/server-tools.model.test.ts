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
	// Host 发出的每个事件都要符合对外事件的 schema，带着不透明块的回复也一样
	expect(log.invalid).toEqual([]);
});

/** 这个 task 结束的事件；费用先记进账本，模型服务的临时故障抛出可以重跑的错误。 */
async function ended(taskId: string) {
	const event = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	charge(event.usage);
	throwIfTransient(event);
	return event;
}

test("用户级配置打开联网搜索后，真实模型在模型服务一侧搜索：结果留在回复里、按次计费，下一个 task 带着它们照常完成", {
	tags: ["model"],
}, async () => {
	// 用户级配置要在创建 Host 之前写好：Host 根目录只对当前用户可读写
	mkdirSync(dirs.root, { mode: 0o700 });
	writeFileSync(
		join(dirs.root, "config.toml"),
		"[server_tools.anthropic]\nweb_search = true\n",
	);
	session = await createHost({ root: dirs.root, env: dirs.env }).openSession({
		workspace: dirs.workspace,
		model,
		models: {
			[model]: { base_url: inject("modelBaseUrl"), max_output_tokens: 2_000 },
		},
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		budget: testRunLimits,
		onEvent: log.push,
	});

	const first = await ended(
		await session.submit(
			"Search the web for the current Node.js LTS version and tell me the version number in one short sentence.",
		),
	);
	expect(first.outcome).toBe("completed");
	const kinds = log.events.flatMap((event) =>
		event.type === "message.completed"
			? event.message.content.flatMap((block) =>
					block.type === "opaque" ? [block.kind] : [],
				)
			: [],
	);
	expect(kinds).toContain("server_tool_use");
	expect(kinds).toContain("web_search_tool_result");
	// 搜索由模型服务执行，Host 这边没有工具调用
	expect(log.events.some((event) => event.type === "tool_call.started")).toBe(
		false,
	);
	const searches = first.usage.server_tools?.web_search ?? 0;
	expect(searches).toBeGreaterThan(0);
	// 每千次 10 美元，加在 token 的费用上
	expect(first.usage.cost_usd).toBeGreaterThan(searches * 0.01);

	const second = await ended(await session.submit("Thanks. Reply with OK."));
	expect(second.outcome).toBe("completed");
});
