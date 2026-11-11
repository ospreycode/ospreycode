import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CliOptions,
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
import { lastUserMessage } from "./interactive-fixture.js";
import {
	finishedSession,
	interruptedSession,
	sessionFlags,
} from "./sessions.js";

// 每个测试要先后运行两三次 CLI，每次都启动 Host 和 agent 进程
vi.setConfig({ testTimeout: 60_000 });

/** 中断时还在运行的命令：时长是个别处不会有的数，测试结束时按它清理。 */
const longCommand = "sleep 97.31";

let dirs: TestDirectories;
let model: FakeModelServer | undefined;

beforeEach(() => {
	dirs = testDirectories();
	model = undefined;
});

afterEach(async () => {
	spawnSync("pkill", ["-f", longCommand]);
	await model?.close();
	dirs.cleanup();
});

/** 启动模型服务并把它写进用户级配置。 */
async function useModel(
	script: (call: number) => ModelReply,
): Promise<FakeModelServer> {
	model = await fakeModelServer(script);
	dirs.writeConfig(model.config);
	return model;
}

function execResume(
	rest: string[],
	options: Partial<CliOptions> = {},
): Promise<CliResult> {
	return runCli(["exec", "resume", ...sessionFlags(dirs), ...rest], {
		cwd: dirs.workspace,
		env: dirs.env,
		...options,
	});
}

/** 这个工作区所在项目的 session 的个数。 */
async function sessionCount(): Promise<number> {
	const listed = await runCli(["session", "list", "--json"], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	return (JSON.parse(listed.stdout) as unknown[]).length;
}

describe("接着原来的对话", () => {
	test("exec resume <SESSION_ID>：模型请求里带着上一次的对话，事件流和 exec 一样，不新建 session", async () => {
		const server = await useModel((call) =>
			textReply(call === 0 ? "第一次的回复" : "第二次的回复"),
		);
		const sessionId = await finishedSession(dirs, "第一个任务");

		const result = await execResume(["--json", sessionId, "第二个任务"]);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const events = parseEvents(result.stdout);
		expect(events.at(0)).toMatchObject({
			type: "session.started",
			session_id: sessionId,
		});
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "completed",
			exit_code: 0,
		});
		expect(events.map((event) => event.type)).not.toContain("model.delta");
		// 只有这次的任务：上一次的事件不重新输出
		expect(
			events.filter((event) => event.type === "task.started"),
		).toHaveLength(1);
		expect(result.stdout).not.toContain("第一次的回复");

		expect(server.requests).toHaveLength(2);
		const resumed = JSON.stringify(server.requests[1]);
		expect(resumed).toContain("第一个任务");
		expect(resumed).toContain("第一次的回复");
		expect(lastUserMessage(server.requests[1])).toContain("第二个任务");
		expect(await sessionCount()).toBe(1);
	});

	test("exec resume --last：恢复最近写过的那个；PROMPT 从标准输入读，标准输出只有回复，-o 写进文件", async () => {
		const server = await useModel((call) =>
			textReply(["甲的回复", "乙的回复", "接着做完了"][call] ?? ""),
		);
		await finishedSession(dirs, "任务甲");
		await finishedSession(dirs, "任务乙");
		const replyFile = join(dirs.workspace, "reply.txt");

		const result = await execResume(["--last", "-o", replyFile], {
			input: "标准输入里的任务",
		});

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("接着做完了\n");
		expect(readFileSync(replyFile, "utf8")).toBe("接着做完了");
		const resumed = JSON.stringify(server.requests[2]);
		expect(resumed).toContain("任务乙");
		expect(resumed).toContain("乙的回复");
		expect(resumed).not.toContain("任务甲");
		expect(lastUserMessage(server.requests[2])).toContain("标准输入里的任务");
		expect(await sessionCount()).toBe(2);
	});

	test("resume 不在 exec 之后的第一个位置时是 PROMPT：新建 session 执行它", async () => {
		const server = await useModel(() => textReply("好"));
		const sessionId = await finishedSession(dirs, "第一个任务");

		const result = await runCli(
			["exec", ...sessionFlags(dirs), "--json", "resume"],
			{ cwd: dirs.workspace, env: dirs.env },
		);

		expect(result.code).toBe(0);
		const [started] = parseEvents(result.stdout);
		expect(started?.session_id).not.toBe(sessionId);
		expect(lastUserMessage(server.requests[1])).toContain("resume");
		expect(JSON.stringify(server.requests[1])).not.toContain("第一个任务");
	});
});

describe("上次没有正常关闭的 session", () => {
	test("中断的 task 先以 failed 结束，再执行这次的任务；退出码按这次的任务", async () => {
		const server = await useModel((call) =>
			call === 0 ? "hang" : textReply("接着做完了"),
		);
		// 模型的回复还没到的时候中断
		const sessionId = await interruptedSession(dirs, "中断的任务", () =>
			vi.waitFor(() => expect(server.requests).toHaveLength(1), {
				timeout: 20_000,
			}),
		);

		const result = await execResume(["--json", sessionId, "接着做"]);

		expect(result.code).toBe(0);
		const events = parseEvents(result.stdout);
		const ended = events.filter((event) => event.type === "task.ended");
		expect(ended).toMatchObject([
			{ outcome: "failed", error: expect.stringContaining("没有正常关闭") },
			{ outcome: "completed" },
		]);
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "completed",
			exit_code: 0,
		});
		const resumed = server.requests.at(-1);
		expect(JSON.stringify(resumed)).toContain("中断的任务");
		expect(lastUserMessage(resumed)).toContain("接着做");
	});

	test("中断时有命令不确定有没有执行：不询问就恢复不了，退出码 1，说明要在交互模式下恢复", async () => {
		const server = await useModel(() => shellCallReply(longCommand));
		const sessionId = await interruptedSession(dirs, "跑一条长命令", (cli) =>
			cli.waitForOutput('"type":"tool_call.started"'),
		);
		const requests = server.requests.length;

		const result = await execResume(["--json", sessionId, "接着做"]);

		expect(result.code).toBe(1);
		// session 没有打开：和 exec 一样，标准输出只有一条不带 session_id 的 error 事件
		const lines = result.stdout.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		const event = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(event.type).toBe("error");
		expect(event).not.toHaveProperty("session_id");
		expect(result.stderr).toContain("shell");
		expect(result.stderr).toContain("请在交互模式下恢复这个 session");
		// 是预料之中的失败：只有一句说明，没有调用栈
		expect(result.stderr).not.toMatch(/^\s+at /m);
		expect(server.requests).toHaveLength(requests);
	});
});

describe("找不到要恢复的 session", () => {
	test("没有这个 SESSION_ID：退出码 2，--json 下输出一条 error 事件", async () => {
		const server = await useModel(() => textReply("好"));
		await finishedSession(dirs, "第一个任务");

		const result = await execResume(["--json", "no-such-session", "接着做"]);

		expect(result.code).toBe(2);
		const lines = result.stdout.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "error" });
		expect(result.stderr).toContain("no-such-session");
		expect(server.requests).toHaveLength(1);
	});

	test("--last 而这个工作区还没有 session：退出码 2，写明原因", async () => {
		const server = await useModel(() => textReply("不会用到"));

		const result = await execResume(["--last", "接着做"]);

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(dirs.workspace);
		expect(result.stderr).toContain("没有可以恢复的 session");
		expect(server.requests).toHaveLength(0);
	});

	test("session 只在创建它的工作区恢复：同一个项目的另一个工作区里，--last 和写明标识都是退出码 2", async () => {
		const server = await useModel(() => textReply("好"));
		// 仓库的子目录作为工作区时，和仓库根目录属于同一个项目
		execFileSync("git", ["init", "-q", dirs.workspace]);
		const other = join(dirs.workspace, "sub");
		mkdirSync(other);
		const sessionId = await finishedSession(dirs, "第一个任务");

		const last = await execResume(["--last", "接着做"], { cwd: other });
		expect(last.code).toBe(2);
		expect(last.stderr).toContain("没有可以恢复的 session");

		const byId = await execResume([sessionId, "接着做"], { cwd: other });
		expect(byId.code).toBe(2);
		expect(byId.stderr).toContain(dirs.workspace);
		expect(server.requests).toHaveLength(1);
	});
});

describe("参数写错", () => {
	test.each([
		[[], "SESSION_ID"],
		[["--last", "任务", "多出来的"], "多出来的"],
		[["some-session", "任务", "多出来的"], "多出来的"],
		[["--approval", "never", "--last", "任务"], "--approval"],
	])("exec resume %j：退出码 2，提示查看帮助", async (rest, mentioned) => {
		await useModel(() => textReply("不会用到"));

		const result = await execResume(rest);

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(mentioned);
		expect(result.stderr).toContain("ospreycode exec resume --help");
		expect(model?.requests).toHaveLength(0);
	});
});
