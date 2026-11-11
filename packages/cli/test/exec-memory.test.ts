import { afterEach, beforeEach, expect, test } from "vitest";
import {
	type CliResult,
	type FakeModelServer,
	fakeModelServer,
	parseEvents,
	runCli,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";
import { toolCallsReply } from "./interactive-fixture.js";

let dirs: TestDirectories;
let model: FakeModelServer;

beforeEach(async () => {
	dirs = testDirectories();
	// 每次运行里模型先提议一条记忆，再回复一句
	model = await fakeModelServer((call) =>
		call % 2 === 0
			? toolCallsReply([
					{
						name: "memory_propose",
						arguments: {
							scope: "project",
							kind: "fact",
							title: `测试用 npm run test:unit（第 ${call / 2 + 1} 次运行）`,
							body: "实际运行验证过。",
						},
					},
				])
			: textReply("做完了"),
	);
	dirs.writeConfig(model.config);
});

afterEach(async () => {
	await model.close();
	dirs.cleanup();
});

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

test("非交互运行时模型提议的候选保持待确认：过程里提示一行，下一次运行里模型看不到它", async () => {
	const first = await exec("跑一下测试");
	expect(first.code).toBe(0);
	expect(first.stdout).toBe("做完了\n");
	expect(first.stderr).toContain(
		"有 1 条记忆候选待确认，没有生效：在交互模式里用 /memory 处理",
	);

	const second = await exec("--json", "再跑一下");
	expect(second.code).toBe(0);
	const events = parseEvents(second.stdout);
	const listed = events.flatMap((event) =>
		event.type === "memory.candidates" ? event.candidates : [],
	);
	// 上一次运行留下的候选还待确认，和这一次的一起列出
	expect(listed.map((candidate) => candidate.title)).toEqual([
		"测试用 npm run test:unit（第 1 次运行）",
		"测试用 npm run test:unit（第 2 次运行）",
	]);
	expect(events.map((event) => event.type)).not.toContain("memory.updated");
	// 第二次运行的第一个请求：上一次的候选不在上下文里
	expect(JSON.stringify(model.requests[2])).not.toContain("第 1 次运行");
});
