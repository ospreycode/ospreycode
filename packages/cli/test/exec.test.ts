import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CliResult,
	errorReply,
	type FakeModelServer,
	fakeModelServer,
	type ModelReply,
	parseEvents,
	runCli,
	shellCallReply,
	startCli,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";
import { streamReply, toolCallsReply } from "./interactive-fixture.js";

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

/** 启动模型服务并把它写进用户级配置。 */
async function useModel(
	script: (call: number) => ModelReply,
): Promise<FakeModelServer> {
	model = await fakeModelServer(script);
	dirs.writeConfig(model.config);
	return model;
}

/** `exec` 的参数：凭据从文件读，不启用系统隔离。 */
function execArgs(...rest: string[]): string[] {
	return [
		"exec",
		"--credential-file",
		`fake=${dirs.credentialFile}`,
		"--sandbox",
		"danger-full-access",
		...rest,
	];
}

function exec(...rest: string[]): Promise<CliResult> {
	return runCli(execArgs(...rest), { cwd: dirs.workspace, env: dirs.env });
}

describe("完成的任务", () => {
	test("--json 每行一个事件，以 session.started 开头、session.ended 结尾，退出码 0", async () => {
		await useModel((call) =>
			call === 0 ? shellCallReply("echo from-shell") : textReply("做完了"),
		);
		const replyFile = join(dirs.workspace, "reply.txt");
		const result = await exec("--json", "-o", replyFile, "跑一下 echo");

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const events = parseEvents(result.stdout);
		const types = events.map((event) => event.type);
		expect(types.at(0)).toBe("session.started");
		expect(types.at(-1)).toBe("session.ended");
		expect(types).toContain("tool_call.completed");
		// 流式增量不在 JSON 输出里
		expect(types).not.toContain("model.delta");
		expect(types).not.toContain("tool_call.output");
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "completed",
			exit_code: 0,
		});
		expect(types.filter((type) => type === "task.ended")).toHaveLength(1);
		expect(readFileSync(replyFile, "utf8")).toBe("做完了");
		expect(model?.requests).toHaveLength(2);
	});

	test("文本模式下标准输出只有最后的回复；stderr 上先是这次运行的配置和任务，再是每一步的结果和耗时，最后是结果、用时、用量和费用", async () => {
		await useModel(
			(call) =>
				[
					streamReply(
						[
							{ role: "assistant", content: "先看一下" },
							{
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: {
											name: "shell",
											arguments: JSON.stringify({ command: "seq 1 12" }),
										},
									},
								],
							},
						],
						"tool_calls",
					),
					toolCallsReply([
						{
							name: "write",
							arguments: { path: "note.txt", content: "一\n二\n" },
						},
					]),
					shellCallReply("exit 3"),
				][call] ?? textReply("做完了"),
		);
		const result = await exec("跑一下\n再写个文件");

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("做完了\n");
		const [sessionId] = (
			JSON.parse(
				(
					await runCli(["session", "list", "--json"], {
						cwd: dirs.workspace,
						env: dirs.env,
					})
				).stdout,
			) as { session_id: string }[]
		).map((session) => session.session_id);
		// 输出不是终端：没有颜色的控制序列
		expect(result.stderr).not.toContain("\x1b");
		const seconds = String.raw`\d+\.\ds`;
		expect(result.stderr).toMatch(
			new RegExp(
				[
					String.raw`^Osprey Code \S+`,
					`工作目录：${dirs.workspace}`,
					String.raw`模型：fake · 推理 \w+`,
					"沙盒：danger-full-access · 审批 never",
					`session：${sessionId}`,
					"─+",
					"› 跑一下",
					"  再写个文件",
					// 中间一轮的回复写在过程里
					"• 先看一下",
					"• Running seq 1 12",
					`• Ran seq 1 12 · ✓ 退出码 0 · ${seconds}`,
					"  1",
					"  2",
					"  3",
					String.raw`  … \+4 行`,
					"  8",
					"  9",
					"  10",
					"  11",
					"  12",
					String.raw`• Added note\.txt \(\+2 -0\) · ✓ ${seconds}`,
					"• Running exit 3",
					`• Ran exit 3 · ✗ 失败 · 退出码 3 · ${seconds}`,
					"  （没有输出）",
					String.raw`— 完成 · 用时 ${seconds} · 输入 40 · 输出 20 token · \$0\.\d+`,
					"$",
				].join("\n"),
			),
		);
		// 最后一条回复只在 stdout 上
		expect(result.stderr).not.toContain("做完了");
	});

	test("模型的推理内容按 [ui] show_reasoning 写在过程里，不进标准输出", async () => {
		const server = await useModel(() =>
			streamReply([
				{ role: "assistant", reasoning_content: "先想一想" },
				{ content: "想好了" },
			]),
		);
		const compat =
			'\n[models.fake.compat]\nreasoning_field = "reasoning_content"\n';
		dirs.writeConfig(`${server.config}${compat}`);
		const shown = await exec("想");
		expect(shown.stdout).toBe("想好了\n");
		expect(shown.stderr).toMatch(/^ {2}先想一想$/m);

		dirs.writeConfig(
			`${server.config}${compat}\n[ui]\nshow_reasoning = false\n`,
		);
		const hidden = await exec("想");
		expect(hidden.stdout).toBe("想好了\n");
		expect(hidden.stderr).not.toContain("先想一想");
	});

	test("上下文接近模型的上限时自动压缩：过程里有一行说明，任务从摘要接着做完", async () => {
		// 配置里上下文是 100,000 token：第一次回复报告的用量已经超过它的 85%
		const usage = { prompt_tokens: 90_000, completion_tokens: 5 };
		const chunks = [
			{
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: {
										name: "shell",
										arguments: JSON.stringify({ command: "echo from-shell" }),
									},
								},
							],
						},
					},
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			{ choices: [], usage: { ...usage, total_tokens: 90_005 } },
		];
		const server = await useModel((call) =>
			call === 0
				? {
						status: 200,
						contentType: "text/event-stream",
						body: [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
							.map((data) => `data: ${data}\n\n`)
							.join(""),
					}
				: textReply(call === 1 ? "这是摘要" : "做完了"),
		);
		const result = await exec("跑一下 echo");

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("做完了\n");
		expect(result.stderr).toMatch(
			/上下文接近模型的上限，已自动压缩（压缩前约 \d+ token）\n/,
		);
		expect(server.requests).toHaveLength(3);
		expect(JSON.stringify(server.requests[1])).toContain(
			"<compaction_request>",
		);
		const after = JSON.stringify(server.requests[2]);
		expect(after).toContain("这是摘要");
		expect(after).not.toContain("跑一下 echo");
	});

	test("[tools] 打开的 grep 和 ls：文本模式下调用写到 stderr，结果交回模型", async () => {
		writeFileSync(
			join(dirs.workspace, "main.ts"),
			"export const answer = 42;\n",
		);
		const server = await useModel(
			(call) =>
				[
					toolCallsReply([
						{ name: "grep", arguments: { pattern: "answer", glob: "*.ts" } },
					]),
					toolCallsReply([{ name: "ls", arguments: {} }]),
					textReply("找到了"),
				][call] as ModelReply,
		);
		dirs.writeConfig(`${server.config}\n[tools]\ngrep = true\nls = true\n`);
		const result = await exec("找一找");

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("找到了\n");
		expect(result.stderr).toMatch(
			/\n• Search \/answer\/ in \. \(\*\.ts\) · ✓ \d+\.\ds\n• List \. · ✓ \d+\.\ds\n— 完成 · /,
		);
		// 参数的原文不写出来
		expect(result.stderr).not.toContain('{"pattern"');
		const last = JSON.stringify(server.requests.at(-1));
		expect(last).toContain("main.ts:1:export const answer = 42;");
	});

	test("PROMPT 写 - 时从标准输入读", async () => {
		const server = await useModel(() => textReply("收到"));
		const result = await runCli(execArgs("-"), {
			cwd: dirs.workspace,
			env: dirs.env,
			input: "标准输入里的任务",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("收到\n");
		expect(JSON.stringify(server.requests[0])).toContain("标准输入里的任务");
	});

	test("-C 指定工作区", async () => {
		await useModel(() => textReply("好"));
		const result = await runCli(
			execArgs("--json", "-C", dirs.workspace, "任务"),
			{ cwd: dirs.home.replace(/home$/, "secrets"), env: dirs.env },
		);

		expect(result.code).toBe(0);
		expect(parseEvents(result.stdout)[0]).toMatchObject({
			type: "session.started",
			workspace: dirs.workspace,
		});
	});
});

const sandboxed = process.platform === "darwin" || process.platform === "linux";

describe.runIf(sandboxed)("真实沙盒", () => {
	test("workspace-write 下 agent 进程和命令都由打包后的入口在沙盒里运行", async () => {
		const outside = join(dirs.home, "outside.txt");
		await useModel((call) =>
			call === 0
				? shellCallReply(`echo inside > made.txt; echo leaked > '${outside}'`)
				: textReply("做完了"),
		);
		const result = await runCli(
			[
				"exec",
				"--json",
				"--credential-file",
				`fake=${dirs.credentialFile}`,
				"--sandbox",
				"workspace-write",
				"写个文件",
			],
			{ cwd: dirs.workspace, env: dirs.env },
		);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(parseEvents(result.stdout)[0]).toMatchObject({
			type: "session.started",
			sandbox_mode: "workspace-write",
		});
		expect(readFileSync(join(dirs.workspace, "made.txt"), "utf8")).toBe(
			"inside\n",
		);
		expect(existsSync(outside)).toBe(false);
	});

	test("--sandbox 写命名权限配置的名字：session 按它启动，命令按它的路径读写", async () => {
		const notes = join(dirs.home, "notes");
		const scratch = join(dirs.home, "scratch");
		mkdirSync(notes);
		mkdirSync(scratch);
		writeFileSync(join(notes, "private.txt"), "private notes\n");
		const server = await fakeModelServer((call) =>
			call === 0
				? shellCallReply(
						`echo x > '${join(scratch, "made.txt")}'; cat '${join(notes, "private.txt")}'; echo x > made.txt`,
					)
				: textReply("做完了"),
		);
		model = server;
		// 照 read-only，主目录下的 notes 读不到，scratch 可写
		dirs.writeConfig(`${server.config}
[permissions.strict]
extends = "read-only"

[permissions.strict.paths]
"~/notes" = "deny"
"~/scratch" = "write"
`);
		const result = await runCli(
			[
				"exec",
				"--json",
				"--credential-file",
				`fake=${dirs.credentialFile}`,
				"--sandbox",
				"strict",
				"试一下",
			],
			{ cwd: dirs.workspace, env: dirs.env },
		);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(parseEvents(result.stdout)[0]).toMatchObject({
			type: "session.started",
			sandbox_mode: "strict",
		});
		expect(existsSync(join(scratch, "made.txt"))).toBe(true);
		expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(false);
		expect(result.stdout).not.toContain("private notes");
	});

	test("--sandbox 写了配置里没有的名字：退出码 2", async () => {
		await useModel(() => textReply("不会用到"));
		const result = await runCli(
			[
				"exec",
				"--credential-file",
				`fake=${dirs.credentialFile}`,
				"--sandbox",
				"no-such-profile",
				"试一下",
			],
			{ cwd: dirs.workspace, env: dirs.env },
		);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("no-such-profile");
		expect(model?.requests).toHaveLength(0);
	});
});

describe("没有完成的任务", () => {
	test("模型服务报错时退出码 1", async () => {
		await useModel(() => errorReply(400, "bad request from fake"));
		const result = await exec("--json", "任务");

		expect(result.code).toBe(1);
		const events = parseEvents(result.stdout);
		expect(events.find((event) => event.type === "task.ended")).toMatchObject({
			outcome: "failed",
		});
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "failed",
			exit_code: 1,
		});
	});

	test("超出模型请求次数的上限时退出码 3", async () => {
		const server = await useModel(() => shellCallReply("true"));
		const result = await exec("--json", "--max-requests", "2", "任务");

		expect(result.code).toBe(3);
		const events = parseEvents(result.stdout);
		expect(events.find((event) => event.type === "task.ended")).toMatchObject({
			outcome: "budget_exceeded",
		});
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "budget_exceeded",
			exit_code: 3,
		});
		expect(server.requests).toHaveLength(2);
	});

	test("--timeout 到时取消任务，以超出预算结束，退出码 3", async () => {
		await useModel(() => "hang");
		const result = await exec("--json", "--timeout", "1s", "任务");

		expect(result.code).toBe(3);
		const events = parseEvents(result.stdout);
		expect(events.find((event) => event.type === "task.ended")).toMatchObject({
			outcome: "budget_exceeded",
		});
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			exit_code: 3,
		});
	});

	test("SIGINT 取消任务，仍然写出 task.ended 和 session.ended，退出码 130", async () => {
		await useModel(() => "hang");
		const cli = startCli(execArgs("--json", "任务"), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		await cli.waitForOutput('"type":"task.started"');
		cli.child.kill("SIGINT");
		const result = await cli.result;

		expect(result.code).toBe(130);
		const events = parseEvents(result.stdout);
		expect(events.find((event) => event.type === "task.ended")).toMatchObject({
			outcome: "cancelled",
		});
		expect(events.at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "cancelled",
			exit_code: 130,
		});
	});

	test("任务中途 agent 进程被杀：文本模式下原因在 stderr 上只写一次，退出码 1", async () => {
		const server = await useModel(() => "hang");
		const cli = startCli(execArgs("任务"), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		await vi.waitFor(() => expect(server.requests).toHaveLength(1), {
			timeout: 20_000,
		});
		const { processes } = JSON.parse(
			readFileSync(join(dirs.root, "data", "processes.json"), "utf8"),
		) as { processes: { pid: number; kind: string }[] };
		const agent = processes.find(({ kind }) => kind === "agent");
		if (agent === undefined) throw new Error("没有登记着的 agent 进程");
		process.kill(agent.pid, "SIGKILL");
		const result = await cli.result;

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr.split("agent 进程意外退出")).toHaveLength(2);
		expect(result.stderr).toMatch(/^— 失败：agent 进程意外退出.* · 用时 /m);
	});

	test("SIGTERM 取消任务，退出码 143", async () => {
		await useModel(() => "hang");
		const cli = startCli(execArgs("--json", "任务"), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		await cli.waitForOutput('"type":"task.started"');
		cli.child.kill("SIGTERM");
		const result = await cli.result;

		expect(result.code).toBe(143);
		expect(parseEvents(result.stdout).at(-1)).toMatchObject({
			type: "session.ended",
			exit_code: 143,
		});
	});
});

describe("参数和配置的错误", () => {
	/** `--json` 下 session 打开之前的失败：标准输出只有一条不带 session_id 的 error 事件。 */
	function expectStartupError(result: CliResult): void {
		expect(result.code).toBe(2);
		const lines = result.stdout.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		const event = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(event.type).toBe("error");
		expect(event).not.toHaveProperty("session_id");
		expect(typeof event.message).toBe("string");
		expect(result.stderr).toContain(event.message);
	}

	test("未知的选项：退出码 2，--json 下输出一条 error 事件", async () => {
		await useModel(() => textReply("不会用到"));
		const result = await exec("--json", "--no-such-option", "任务");

		expectStartupError(result);
		expect(result.stderr).toContain("--no-such-option");
		expect(model?.requests).toHaveLength(0);
	});

	test("配置里没有的模型：退出码 2，--json 下输出一条 error 事件", async () => {
		await useModel(() => textReply("不会用到"));
		const result = await exec("--json", "-m", "no-such-model", "任务");

		expectStartupError(result);
		expect(result.stderr).toContain("no-such-model");
	});

	test("配置文件写错：退出码 2，错误只写到 stderr", async () => {
		dirs.writeConfig("model = [");
		const result = await exec("任务");

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("config.toml");
	});

	test("--timeout 写得不对：退出码 2", async () => {
		await useModel(() => textReply("不会用到"));
		const result = await exec("--timeout", "soon", "任务");

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--timeout");
	});

	test("PROMPT 是空的：退出码 2", async () => {
		await useModel(() => textReply("不会用到"));
		const result = await exec();

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("PROMPT");
	});

	test("--rules 指定的文件不存在：退出码 2；相对路径相对 -C 之后的工作区", async () => {
		await useModel(() => textReply("好"));
		const missing = await exec("--rules", "extra.toml", "任务");
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain(join(dirs.workspace, "extra.toml"));

		writeFileSync(join(dirs.workspace, "extra.toml"), "");
		const loaded = await runCli(
			execArgs("-C", dirs.workspace, "--rules", "extra.toml", "任务"),
			{ cwd: dirs.home.replace(/home$/, "secrets"), env: dirs.env },
		);
		// 文件找到了：过程里没有警告和错误
		expect(loaded.stderr).not.toContain("extra.toml");
		expect(loaded.stderr).not.toMatch(/警告|错误|ospreycode:/);
		expect(loaded.code).toBe(0);
	});

	test("凭据文件里的密钥不出现在输出里", async () => {
		writeFileSync(dirs.credentialFile, "sk-very-secret-value\n", {
			mode: 0o600,
		});
		await useModel(() => errorReply(401, "invalid api key"));
		const result = await exec("--json", "任务");

		expect(result.code).toBe(1);
		expect(result.stdout).not.toContain("sk-very-secret-value");
		expect(result.stderr).not.toContain("sk-very-secret-value");
	});
});
