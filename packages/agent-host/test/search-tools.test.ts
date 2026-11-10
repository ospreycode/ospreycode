import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
import type { SandboxMode } from "@ospreycode/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 脚本模型收到的每次请求：Host 发给模型的样子。 */
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	mkdirSync(dirs.root, { mode: 0o700 });
	log = new EventLog();
	requests = [];
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	expect(log.invalid).toEqual([]);
});

/** 用户级配置文件。 */
function userConfig(text: string): void {
	writeFileSync(join(dirs.root, "config.toml"), text);
}

const bothOn = "[tools]\ngrep = true\nls = true\n";

function put(path: string, content: string): void {
	const target = join(dirs.workspace, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

async function open(
	script: Script,
	sandboxMode: SandboxMode = "danger-full-access",
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(request);
			return script(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode,
		approvalPolicy: "on-request",
		onEvent: log.push,
	});
	return session;
}

const say = (text: string): ScriptedTurn => ({
	content: [{ type: "text", text }],
});

function call(
	name: string,
	args: Record<string, unknown>,
	callId = "call_1",
): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

/** 模型依次发出这些调用，每轮一个，然后结束。 */
function oneByOne(...turns: ScriptedTurn[]): Script {
	return (_request, index) => turns[index] ?? say("done");
}

async function ended(taskId: string) {
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/** 各次工具调用的结果，按完成的顺序：状态和给模型的文字。 */
function results(): { status: string; text: string }[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed"
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

function toolNames(request: ModelRequest | undefined): string[] {
	return (request?.tools ?? []).map((tool) => tool.name);
}

function textOf(message: Message | undefined): string {
	return (message?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

const defaults = ["read", "edit", "write", "shell", "request_permissions"];

describe("可选工具 grep 和 ls", () => {
	test("配置的 [tools] 打开后模型能用：在 agent 进程里执行，结果记进事件、交回模型；工具声明里排在默认工具之后", async () => {
		userConfig(bothOn);
		put("src/main.ts", "export function main() {}\n");
		put("src/util.ts", "// helper\nexport function helper() {}\n");
		put("README.md", "# demo\n");
		const current = await open(
			oneByOne(
				call("grep", { pattern: "export function \\w+", glob: "*.ts" }),
				call("ls", {}, "call_2"),
			),
		);

		expect(await ended(await current.submit("看看有什么"))).toMatchObject({
			outcome: "completed",
		});

		expect(current.config().tools).toEqual([...defaults, "grep", "ls"]);
		expect(toolNames(requests[0])).toEqual([...defaults, "grep", "ls"]);
		expect(
			log.events.flatMap((event) =>
				event.type === "tool_call.started"
					? [[event.name, event.executor]]
					: [],
			),
		).toEqual([
			["grep", "runtime"],
			["ls", "runtime"],
		]);
		expect(results()).toEqual([
			{
				status: "succeeded",
				text: "src/main.ts:1:export function main() {}\nsrc/util.ts:2:export function helper() {}",
			},
			{ status: "succeeded", text: "README.md\nsrc/" },
		]);
		expect(requests[2]?.messages.at(-1)).toMatchObject({
			role: "tool_result",
			call_id: "call_2",
			is_error: false,
			content: [{ type: "text", text: "README.md\nsrc/" }],
		});
		expect(log.types()).not.toContain("error");
	});

	test("没有打开时工具声明里没有它们，模型硬要调用会被拒绝", async () => {
		put("a.txt", "needle\n");
		const current = await open(
			oneByOne(call("grep", { pattern: "needle" }), call("ls", {}, "call_2")),
		);

		expect(await ended(await current.submit("找一找"))).toMatchObject({
			outcome: "completed",
		});

		expect(toolNames(requests[0])).toEqual(defaults);
		expect(
			requests[2]?.messages.filter((message) => message.role === "tool_result"),
		).toMatchObject([
			{
				call_id: "call_1",
				is_error: true,
				content: [{ type: "text", text: "Unknown tool: grep" }],
			},
			{
				call_id: "call_2",
				is_error: true,
				content: [{ type: "text", text: "Unknown tool: ls" }],
			},
		]);
	});

	test("改了 [tools] 之后重新加载配置：下一个 task 的工具声明跟着变，系统指令的 Tools 段落作为补丁追加，已发出的消息不变", async () => {
		const current = await open(() => say("好"));
		await ended(await current.submit("第一个任务"));

		userConfig(bothOn);
		await current.reload();
		await ended(await current.submit("第二个任务"));

		userConfig("[tools]\ngrep = true\n");
		await current.reload();
		await ended(await current.submit("第三个任务"));

		const [first, second, third] = requests as [
			ModelRequest,
			ModelRequest,
			ModelRequest,
		];
		expect(toolNames(first)).toEqual(defaults);
		expect(toolNames(second)).toEqual([...defaults, "grep", "ls"]);
		expect(toolNames(third)).toEqual([...defaults, "grep"]);
		// 前缀不变：后一次请求以前一次请求的全部消息开头
		expect(second.messages.slice(0, first.messages.length)).toEqual(
			first.messages,
		);
		expect(third.messages.slice(0, second.messages.length)).toEqual(
			second.messages,
		);
		const patches = third.messages
			.slice(1)
			.filter((message) => message.role === "system")
			.map(textOf);
		expect(patches).toHaveLength(2);
		expect(patches[0]).toMatch(
			/^The system instructions changed\. Each section below replaces the earlier section with the same heading\.\n\n# Tools\n- read: /,
		);
		expect(patches[0]).toContain("\n- grep: Search file contents");
		expect(patches[0]).toContain("\n- ls: List the entries of a directory");
		expect(patches[1]).toContain("\n- grep: Search file contents");
		expect(patches[1]).not.toContain("\n- ls: ");
		expect(log.types()).not.toContain("error");
	});

	describe.runIf(process.platform === "darwin")("macOS 真实沙盒", () => {
		test("工作区里照常能搜能列；沙盒不让读的路径读不到：直接指向它的调用失败，搜索途中遇到的列为没有搜", async () => {
			userConfig(bothOn);
			put("src/main.ts", "const token = 1;\n");
			writeFileSync(join(dirs.home, "notes.txt"), "token in notes\n");
			const current = await open(
				oneByOne(
					call("grep", { pattern: "token" }, "call_1"),
					call("ls", {}, "call_2"),
					// 凭据文件和 Host 根目录在沙盒里不可读
					call(
						"grep",
						{ pattern: "test", path: dirs.credentialFile },
						"call_3",
					),
					call("ls", { path: dirs.root }, "call_4"),
					// 它们的上级目录读得到：搜到它们时跳过并列出
					call(
						"grep",
						{ pattern: "test", path: dirname(dirs.credentialFile) },
						"call_5",
					),
					call("grep", { pattern: "token", path: dirs.home }, "call_6"),
				),
				"workspace-write",
			);

			expect(await ended(await current.submit("到处找找"))).toMatchObject({
				outcome: "completed",
			});

			expect(results()).toEqual([
				{ status: "succeeded", text: "src/main.ts:1:const token = 1;" },
				{ status: "succeeded", text: "src/" },
				{
					status: "failed",
					text: `EPERM: operation not permitted, realpath '${dirs.credentialFile}'`,
				},
				{
					status: "failed",
					text: `EPERM: operation not permitted, scandir '${dirs.root}'`,
				},
				{
					status: "succeeded",
					text: `No matches found.\n\n[Not searched: ${dirs.credentialFile} (EPERM).]`,
				},
				{
					status: "succeeded",
					text: `${join(dirs.home, "notes.txt")}:1:token in notes\n\n[Not searched: ${dirs.root} (EPERM).]`,
				},
			]);
			// 凭据的内容没有出现在任何结果里
			expect(JSON.stringify(log.events)).not.toContain("test-key");
		});
	});
});
