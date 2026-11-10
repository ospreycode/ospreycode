import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { scriptedModel } from "@ospreycode/api/testing";
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
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	log = new EventLog();
	requests = [];
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

async function open(): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request) => {
			requests.push(request);
			return { content: [{ type: "text", text: "ok" }] };
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

function texts(request: ModelRequest | undefined, index: number): string[] {
	return (request?.messages[index]?.content ?? []).map((block) =>
		block.type === "text" ? block.text : "",
	);
}

test("用户级规则文件由 Host 读出交给 runtime，排在仓库的规则文件前面，都在上下文消息里", async () => {
	mkdirSync(dirs.root, { mode: 0o700 });
	writeFileSync(join(dirs.root, "AGENTS.md"), "Reply in Chinese.\n");
	writeFileSync(join(dirs.workspace, "AGENTS.md"), "Run npm test first.\n");
	const current = await open();
	const taskId = await current.submit("hi");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });

	const [request] = requests;
	expect(request?.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
	]);
	const blocks = texts(request, 1);
	expect(blocks).toHaveLength(3);
	expect(blocks[0]).toBe(
		`<rule_file path="${join(dirs.root, "AGENTS.md")}" source="user">\nReply in Chinese.\n</rule_file>`,
	);
	expect(blocks[1]).toBe(
		`<rule_file path="${join(dirs.workspace, "AGENTS.md")}" source="repository">\nRun npm test first.\n</rule_file>`,
	);
	expect(blocks[2]).toContain("<environment>");
	// 规则文件的内容不进系统指令
	expect(texts(request, 0).join("\n")).not.toContain("Reply in Chinese");
	expect(texts(request, 2)).toEqual(["hi"]);
	expect(log.types()).not.toContain("warning");
});

test("超出总长度上限的规则文件整份不放，前端收到一次警告", async () => {
	const path = join(dirs.workspace, "AGENTS.md");
	writeFileSync(path, "x".repeat(33 * 1024));
	const current = await open();
	const first = await current.submit("hi");
	await log.waitFor("task.ended", (e) => e.task_id === first);
	const second = await current.submit("again");
	await log.waitFor("task.ended", (e) => e.task_id === second);

	const warnings = log.events.filter((event) => event.type === "warning");
	expect(warnings).toHaveLength(1);
	// 不比对消息里的路径：临时目录的随机路径会被对外事件的脱敏当成高熵字符串换掉
	expect(warnings[0]?.message).toContain("33792 字节");
	expect(warnings[0]?.message).toContain("超出总长度上限");
	const [block] = texts(requests[0], 1);
	expect(block).toContain(`path="${path}"`);
	expect(block).toContain('included="false"');
	expect(block).not.toContain("xxxx");
});
