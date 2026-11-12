import { afterEach, beforeEach, expect, test } from "vitest";
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

const agents = `
[agents.explorer]
description = "Looks things up in the repository."
`;

/** 子 agent 的系统指令里写着它是谁启动的。 */
function fromSubagent(request: unknown): boolean {
	const [system] = (request as { messages: unknown[] }).messages;
	return JSON.stringify(system).includes("You are running as the subagent");
}

/** 启动模型服务：主 agent 和子 agent 的请求分开数，各按自己的脚本回应；配置里定义了子 agent。 */
async function useModel(
	main: readonly ModelReply[],
	child: readonly ModelReply[],
): Promise<void> {
	let mainCalls = 0;
	let childCalls = 0;
	model = await fakeModelServer((_call, request) => {
		const reply = fromSubagent(request)
			? child[childCalls++]
			: main[mainCalls++];
		return reply ?? textReply("没有别的了");
	});
	dirs.writeConfig(`${model.config}\n${agents}`);
}

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

const spawnExplorer = toolCallsReply([
	{
		name: "spawn_agent",
		arguments: { agent: "explorer", prompt: "Find the entry point." },
	},
]);

test("文本模式下标准输出只有主 agent 的最后一条回复，子 agent 的起止和工具调用写在过程里", async () => {
	await useModel(
		[spawnExplorer, textReply("等它"), textReply("主 agent 的结论")],
		[shellCallReply("echo from-child"), textReply("子 agent 的回复")],
	);
	const result = await exec("找入口");

	expect(result.code).toBe(0);
	expect(result.stdout).toBe("主 agent 的结论\n");
	// 启动它的调用写着交给它的任务；它的工具调用前面写明是它的
	expect(result.stderr).toMatch(
		/^• Spawning explorer: Find the entry point\.\n/m,
	);
	expect(result.stderr).toContain(
		"• 子 agent explorer 开始运行（模型 fake，沙盒模式 danger-full-access）",
	);
	expect(result.stderr).toMatch(
		/^• \[explorer\] Ran echo from-child · ✓ 退出码 0 · \d+\.\ds\n {2}from-child$/m,
	);
	expect(result.stderr).toMatch(
		/^• 子 agent explorer 完成 · 输入 \d+ · 输出 \d+ token/m,
	);
	// 子 agent 的回复不逐条写出来
	expect(result.stderr).not.toMatch(/^• 子 agent 的回复$/m);
});

test("--json 里子 agent 的事件带着它自己的 agent_id，起止各有一个事件", async () => {
	await useModel(
		[spawnExplorer, textReply("等它"), textReply("主 agent 的结论")],
		[textReply("子 agent 的回复")],
	);
	const result = await exec("--json", "找入口");

	expect(result.code).toBe(0);
	const events = parseEvents(result.stdout);
	const started = events.find((event) => event.type === "subagent.started");
	const task = events.find((event) => event.type === "task.started");
	if (started === undefined || task === undefined) {
		throw new Error("没有子 agent 开始的事件");
	}
	expect(started).toMatchObject({ name: "explorer", model: "fake" });
	expect(started.agent_id).not.toBe(task.agent_id);
	expect(
		events
			.filter((event) => event.type === "run.started")
			.map((event) => [event.agent_id, event.parent_agent_id]),
	).toEqual([
		[task.agent_id, undefined],
		[started.agent_id, task.agent_id],
	]);
	expect(
		events
			.filter((event) => event.type === "message.completed")
			.filter((event) => event.agent_id === started.agent_id),
	).toHaveLength(1);
	expect(
		events.filter((event) => event.type === "subagent.ended"),
	).toMatchObject([{ agent_id: started.agent_id, outcome: "completed" }]);
	expect(events.at(-1)).toMatchObject({
		type: "session.ended",
		outcome: "completed",
		exit_code: 0,
	});
});

test("任务在子 agent 回复之后停下时，输出的仍是主 agent 的最后一条回复", async () => {
	// 第三次请求之后超出上限：主 agent 拿到子 agent 的结果时已经不能再请求模型
	await useModel(
		[spawnExplorer, textReply("主 agent 的回复")],
		[textReply("子 agent 的回复")],
	);
	const result = await exec("--max-requests", "3", "找入口");

	expect(result.code).not.toBe(0);
	expect(result.stderr).toMatch(/^— 超出预算（模型请求次数），任务已停止 · /m);
	expect(result.stdout).toBe("主 agent 的回复\n");
});
