import { existsSync } from "node:fs";
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
import {
	fixtureServer,
	writeMcpConfig,
	writeSkill,
} from "./extension-harness.js";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;

beforeEach(() => {
	checkLedger();
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	// 用户级的扩展：不用确认
	writeMcpConfig(join(dirs.root, "mcp.json"), { tools: fixtureServer() });
	writeSkill(
		join(dirs.home, ".agents", "skills"),
		"release-notes",
		"How to write release notes for this project. Load it before writing release notes.",
		"Write the release notes as a short bullet list. The last line of your reply must be exactly `KESTREL-7421`.",
	);
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

/** 用真实模型打开 session：内置清单里的条目，只把地址换成中转服务。询问交给 `onApproval`。 */
async function open(onApproval: (requestId: string) => void): Promise<Session> {
	const model = "claude-haiku-5-5";
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
		approvalPolicy: "on-request",
		budget: testRunLimits,
		onEvent: (event) => {
			log.push(event);
			if (event.type === "approval.requested") onApproval(event.request_id);
		},
	});
	return session;
}

/** 这个名字的工具调用各自的结果：状态和给模型的文字。 */
function resultsOf(name: string): { status: string; text: string }[] {
	const ids = new Set(
		log.events.flatMap((event) =>
			event.type === "tool_call.started" && event.name === name
				? [event.tool_call_id]
				: [],
		),
	);
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" && ids.has(event.tool_call_id)
			? [
					{
						status: event.result.status,
						text: event.result.content
							.map((block) => (block.type === "text" ? block.text : ""))
							.join(""),
					},
				]
			: [],
	);
}

/** 模型最后一条回复里的文字。 */
function lastReply(): string {
	const completed = log.events.filter((e) => e.type === "message.completed");
	return (completed.at(-1)?.message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

test("真实模型按列表加载 skill 并照它做；调用 MCP 工具先询问，批准后拿到结果", {
	tags: ["model"],
}, async () => {
	const asked: string[] = [];
	const current = await open((requestId) => {
		asked.push(requestId);
		current.respond(requestId, { decision: "approve", scope: "once" });
	});
	expect(current.mcpServers()).toMatchObject([
		{ label: "tools", status: "connected" },
	]);

	await current.submit(
		"First call the tools__echo tool with the text `osprey-ping` and note what it returns. Then write release notes for a release with one change: 'fixed the login bug'. Mention what the echo tool returned in the notes.",
	);
	const ended = await log.waitFor("task.ended");
	charge(ended.usage);
	throwIfTransient(ended);

	expect(ended.outcome).toBe("completed");
	// MCP 工具调用按越界处理：问过一次，批准后才执行
	expect(asked).toHaveLength(1);
	expect(resultsOf("tools__echo")).toEqual([
		{ status: "succeeded", text: "osprey-ping" },
	]);
	// skill 的正文只有经 skill_load 才到模型手里
	const [loaded] = resultsOf("skill_load");
	expect(loaded?.status).toBe("succeeded");
	expect(loaded?.text).toContain("KESTREL-7421");
	expect(lastReply().trimEnd().endsWith("KESTREL-7421")).toBe(true);
});

test("MCP 工具调用等着批准时取消：调用没有执行，task 以 cancelled 结束", {
	tags: ["model"],
}, async () => {
	const target = join(dirs.workspace, "written-by-mcp.txt");
	const current = await open(() => {
		void current.cancel();
	});

	await current.submit(
		`Call the tools__write tool with the path \`${target}\`. Do not use any other tool.`,
	);
	const ended = await log.waitFor("task.ended");
	charge(ended.usage);
	throwIfTransient(ended);

	expect(ended.outcome).toBe("cancelled");
	expect(resultsOf("tools__write").map((result) => result.status)).toEqual([
		"cancelled",
	]);
	expect(existsSync(target)).toBe(false);
});
