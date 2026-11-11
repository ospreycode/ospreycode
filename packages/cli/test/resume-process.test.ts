import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type FakeModelServer,
	fakeModelServer,
	runCli,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";
import { type PtyCli, startInPty } from "./pty.js";
import { finishedSession, sessionFlags } from "./sessions.js";

// 每个测试都要启动 CLI、Host 和 agent 三层进程，有的要先后启动两次
vi.setConfig({ testTimeout: 60_000 });

let dirs: TestDirectories;
let model: FakeModelServer;
let cli: PtyCli | undefined;

beforeEach(async () => {
	dirs = testDirectories();
	model = await fakeModelServer((call) =>
		textReply(call === 0 ? "第一次的回复" : "第二次的回复"),
	);
	dirs.writeConfig(model.config);
	cli = undefined;
});

afterEach(async () => {
	if (cli !== undefined) {
		cli.kill();
		await cli.exit;
	}
	await model.close();
	dirs.cleanup();
});

/** 在伪终端里运行 `ospreycode resume`。 */
function resume(...rest: string[]): PtyCli {
	cli = startInPty(["resume", ...sessionFlags(dirs), ...rest], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	return cli;
}

describe("在终端里运行 ospreycode resume", () => {
	test("--last：显示之前的对话，接着输入时模型请求里带着它，/quit 退出码 0", async () => {
		const sessionId = await finishedSession(dirs, "第一个任务");

		const terminal = resume("--last");
		await terminal.waitFor("› 第一个任务");
		await terminal.waitFor("第一次的回复");
		await terminal.waitFor(`已恢复 session ${sessionId}`);
		await terminal.waitFor("Enter 发送");

		await terminal.type("第二个任务");
		terminal.write("\r");
		await terminal.waitFor("第二次的回复");
		await terminal.type("/quit");
		terminal.write("\r");
		expect(await terminal.exit).toBe(0);
		expect(model.requests).toHaveLength(2);
		expect(JSON.stringify(model.requests[1])).toContain("第一次的回复");
	});

	test("不写 SESSION_ID 也不写 --last：从列表里选，Enter 恢复选中的那个", async () => {
		const sessionId = await finishedSession(dirs, "第一个任务");

		const terminal = resume();
		await terminal.waitFor("选择要恢复的 session");
		await terminal.waitFor("第一个任务");
		terminal.write("\r");
		await terminal.waitFor(`已恢复 session ${sessionId}`);
		await terminal.waitFor("Enter 发送");

		await terminal.type("/quit");
		terminal.write("\r");
		expect(await terminal.exit).toBe(0);
	});

	test("这个工作区还没有 session：退出码 2，写明原因，不进界面", async () => {
		const terminal = resume();

		expect(await terminal.exit).toBe(2);
		expect(terminal.output()).toContain("没有可以恢复的 session");
		expect(terminal.output()).not.toContain("Osprey Code");
	});

	test("没有这个 SESSION_ID：退出码 2", async () => {
		await finishedSession(dirs, "第一个任务");

		const terminal = resume("no-such-session");

		expect(await terminal.exit).toBe(2);
		expect(terminal.output()).toContain("no-such-session");
		expect(terminal.output()).not.toContain("Osprey Code");
	});
});

describe("不在终端里，或者参数写错", () => {
	test("标准输入不是终端时不进交互模式：退出码 2，提示改用 ospreycode exec", async () => {
		await finishedSession(dirs, "第一个任务");

		const result = await runCli(["resume", ...sessionFlags(dirs), "--last"], {
			cwd: dirs.workspace,
			env: dirs.env,
		});

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ospreycode exec");
		expect(model.requests).toHaveLength(1);
	});

	test.each([
		[["--last", "some-session"], "some-session"],
		[["some-session", "多出来的"], "多出来的"],
		[["--json", "--last"], "--json"],
	])("resume %j：退出码 2，提示查看帮助", async (rest, mentioned) => {
		const result = await runCli(["resume", ...rest], {
			cwd: dirs.workspace,
			env: dirs.env,
		});

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(mentioned);
		expect(result.stderr).toContain("ospreycode resume --help");
	});
});
