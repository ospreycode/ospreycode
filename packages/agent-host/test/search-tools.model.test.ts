import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function put(path: string, content: string): void {
	const target = join(dirs.workspace, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

/** 用真实模型打开 session：内置清单里的条目，只把地址换成中转服务；用户级配置打开了 `grep` 和 `ls`。 */
async function open(model: string): Promise<Session> {
	mkdirSync(dirs.root, { mode: 0o700 });
	writeFileSync(
		join(dirs.root, "config.toml"),
		"[tools]\ngrep = true\nls = true\n",
	);
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

test("真实模型会调用打开的 grep 和 ls，并用它们的结果回答", {
	tags: ["model"],
}, async () => {
	put("README.md", "# demo\n");
	put("src/main.ts", 'import { run } from "./lib/run.js";\nrun();\n');
	put("src/lib/run.ts", "export function run() {}\n");
	put(
		"src/lib/checksum.ts",
		"// checksums\n\nexport function computeKestrelChecksum(input: string) {\n\treturn input.length;\n}\n",
	);
	put("src/lib/zebra-notes.txt", "nothing here\n");
	const session = await open("claude-haiku-5-5");

	await session.submit(
		"Find the file in this workspace that defines the function `computeKestrelChecksum`, then list the directory that file is in. Use the grep and ls tools for this, not the shell. Reply with the path of the file and the names of the other entries in its directory.",
	);
	const ended = await log.waitFor("task.ended");
	charge(ended.usage);
	throwIfTransient(ended);

	expect(ended.outcome).toBe("completed");
	const searches = resultsOf("grep");
	expect(searches.length).toBeGreaterThan(0);
	expect(searches.map((result) => result.status)).toEqual(
		searches.map(() => "succeeded"),
	);
	expect(searches.map((result) => result.text).join("\n")).toContain(
		"src/lib/checksum.ts:3:export function computeKestrelChecksum(input: string) {",
	);
	expect(resultsOf("ls")).toContainEqual({
		status: "succeeded",
		text: "checksum.ts\nrun.ts\nzebra-notes.txt",
	});
	expect(resultsOf("shell")).toEqual([]);
	expect(lastReply()).toContain("src/lib/checksum.ts");
	// 这个名字只出现在 ls 的结果里
	expect(lastReply()).toContain("zebra-notes.txt");
	expect(log.invalid).toEqual([]);
});
