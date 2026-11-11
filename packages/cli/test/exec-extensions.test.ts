import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	fixtureServer,
	writeHookScript,
	writeHooks,
	writeMcpConfig,
	writeSkill,
} from "./extension-fixture.js";
import {
	type CliResult,
	type FakeModelServer,
	fakeModelServer,
	type ModelReply,
	parseEvents,
	runCli,
	shellCallReply,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";
import { toolCallsReply } from "./interactive-fixture.js";

vi.setConfig({ testTimeout: 30_000 });

let dirs: TestDirectories;
let model: FakeModelServer | undefined;

beforeEach(() => {
	dirs = testDirectories();
	model = undefined;
});

afterEach(async () => {
	await model?.close();
	dirs.cleanup();
});

async function useModel(
	script: (call: number) => ModelReply,
): Promise<FakeModelServer> {
	model = await fakeModelServer(script);
	dirs.writeConfig(model.config);
	return model;
}

/** 不启用系统隔离的 `exec`：凭据从文件读。 */
function exec(...rest: string[]): Promise<CliResult> {
	return runCli(
		[
			"exec",
			"--credential-file",
			`fake=${dirs.credentialFile}`,
			"--sandbox",
			"danger-full-access",
			...rest,
		],
		{ cwd: dirs.workspace, env: dirs.env },
	);
}

/** 配一个用户级的 hook，脚本的输出由 `output`（函数的源码）从输入算出来。 */
function userHook(event: string, output: string, matcher?: string): void {
	writeHookScript(join(dirs.root, "hooks", "hook.cjs"), output);
	writeHooks(join(dirs.root, "hooks.json"), {
		[event]: [
			{
				...(matcher === undefined ? {} : { matcher }),
				hooks: [
					{
						command: "./hook.cjs",
						onFailure: "continue",
						permissions: "read-only",
					},
				],
			},
		],
	});
}

interface Completed {
	type: string;
	result: {
		status: string;
		reason?: string;
		content?: { type: string; text: string }[];
	};
}

/** `--json` 输出里各个工具调用的结果。 */
function toolResults(stdout: string): Completed["result"][] {
	return (parseEvents(stdout) as unknown as Completed[])
		.filter((event) => event.type === "tool_call.completed")
		.map((event) => event.result);
}

describe("MCP 工具", () => {
	test("没有人回答询问：权限规则放行的工具能调用，其余的按审批策略拒绝", async () => {
		writeMcpConfig(join(dirs.root, "mcp.json"), { tools: fixtureServer });
		const rules = join(dirs.root, "rules");
		mkdirSync(rules, { mode: 0o700 });
		writeFileSync(
			join(rules, "mcp.toml"),
			'[[mcp_rules]]\nserver = "tools"\ntool = "echo"\ndecision = "allow"\n',
		);
		const server = await useModel(
			(call) =>
				[
					toolCallsReply([
						{ name: "tools__echo", arguments: { text: "你好 MCP" } },
					]),
					toolCallsReply([{ name: "tools__ask", arguments: {} }]),
				][call] ?? textReply("做完了"),
		);
		const result = await exec("--json", "打个招呼");
		expect(result.code).toBe(0);
		const [echoed, asked] = toolResults(result.stdout);
		expect(echoed).toMatchObject({
			status: "succeeded",
			content: [{ type: "text", text: "你好 MCP" }],
		});
		expect(asked).toMatchObject({ status: "denied", reason: "policy" });
		expect(JSON.stringify(server.requests[0])).toContain("tools__echo");
	});

	test("仓库自带的扩展没确认时不启用，只在 stderr 上提示", async () => {
		writeSkill(join(dirs.workspace, ".agents", "skills"), "review", "审阅改动");
		writeMcpConfig(join(dirs.workspace, ".ospreycode", "mcp.json"), {
			tools: fixtureServer,
		});
		const server = await useModel(() => textReply("做完了"));
		const result = await exec("你好");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("做完了\n");
		expect(result.stderr).toContain(
			"警告：仓库自带的 skill review 还没有确认，没有启用",
		);
		expect(result.stderr).toContain(
			"警告：仓库自带的 MCP server tools 还没有确认，没有启用",
		);
		const request = JSON.stringify(server.requests[0]);
		expect(request).not.toContain("审阅改动");
		expect(request).not.toContain("tools__echo");
	});
});

describe("hooks", () => {
	test("UserPromptSubmit 的 hook 拦下输入：不发给模型，写出原因，退出码 1", async () => {
		userHook(
			"UserPromptSubmit",
			'(input) => input.prompt.includes("机密") ? { decision: "block", reason: "输入里有机密" } : { system_message: "输入检查过了" }',
		);
		const server = await useModel(() => textReply("收到"));
		const blocked = await exec("这是机密");
		expect(blocked.code).toBe(1);
		expect(blocked.stdout).toBe("");
		expect(blocked.stderr).toContain(
			"ospreycode: hook 拦下了这条输入：输入里有机密",
		);
		// 不是程序出错：没有调用栈
		expect(blocked.stderr).not.toMatch(/^\s+at /m);
		expect(server.requests).toEqual([]);

		const passed = await exec("你好");
		expect(passed.code).toBe(0);
		expect(passed.stdout).toBe("收到\n");
		expect(passed.stderr).toContain("hook（UserPromptSubmit）：输入检查过了");
	});

	test("SessionStart 的 hook 阻止时 session 打不开，退出码 1", async () => {
		userHook(
			"SessionStart",
			'() => ({ decision: "block", reason: "今天不开工" })',
		);
		const server = await useModel(() => textReply("收到"));
		const result = await exec("你好");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("今天不开工");
		expect(result.stderr).not.toMatch(/^\s+at /m);
		expect(server.requests).toEqual([]);
	});

	test("PreToolUse 的 hook 拒绝工具调用：命令不运行，结果是被 hook 拒绝", async () => {
		userHook(
			"PreToolUse",
			'() => ({ decision: "block", reason: "不许动文件" })',
			"shell",
		);
		const marker = join(dirs.workspace, "made.txt");
		const server = await useModel((call) =>
			call === 0 ? shellCallReply(`touch '${marker}'`) : textReply("没做成"),
		);
		const result = await exec("--json", "建个文件");
		expect(result.code).toBe(0);
		expect(toolResults(result.stdout)).toMatchObject([
			{ status: "denied", reason: "hook" },
		]);
		expect(JSON.stringify(server.requests[1])).toContain("不许动文件");
		expect(
			parseEvents(result.stdout).some(
				(event) =>
					event.type === "hooks.ran" &&
					(event as unknown as { blocked: boolean }).blocked,
			),
		).toBe(true);
	});
});
