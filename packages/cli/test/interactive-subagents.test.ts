import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ModelReply, shellCallReply, textReply } from "./harness.js";
import {
	interactiveFixture,
	selectFirstChoice,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";

const fixture = interactiveFixture();

const agents = `
[agents.explorer]
description = "Looks things up in the repository."
`;

/** 子 agent 的系统指令里写着它是谁启动的。 */
function fromSubagent(request: unknown): boolean {
	const [system] = (request as { messages: unknown[] }).messages;
	return JSON.stringify(system).includes("You are running as the subagent");
}

/** 主 agent 和子 agent 的请求分开数，各按自己的脚本回应；配置里定义了子 agent。 */
function useModel(main: readonly ModelReply[], child: readonly ModelReply[]) {
	let mainCalls = 0;
	let childCalls = 0;
	return fixture.useModel(
		(_call, request) =>
			(fromSubagent(request) ? child[childCalls++] : main[mainCalls++]) ??
			textReply("没有别的了"),
		{ extra: agents },
	);
}

const spawnExplorer = toolCallsReply([
	{
		name: "spawn_agent",
		arguments: { agent: "explorer", prompt: "Find the entry point." },
	},
]);

test("子 agent 的进展压成一项：不逐条显示它的回复和工具调用，结束后写结果和用量", async () => {
	await useModel(
		[spawnExplorer, textReply("等它"), textReply("主 agent 的结论")],
		[shellCallReply("echo from-child"), textReply("子 agent 的回复")],
	);
	const { terminal } = await fixture.start();
	await terminal.type("找入口");
	await terminal.press(key.enter);
	await terminal.waitFor("主 agent 的结论");

	const screen = terminal.text();
	// 启动它的那次调用写的是哪个子 agent；交给它的任务写在它自己的那一块里
	expect(screen).toMatch(/^• Spawned explorer$/m);
	expect(screen).toMatch(
		/^• 子 agent explorer（fake） 完成 · 1 次工具调用 · 输入 \d+ · 输出 \d+ token.*\n {2}└ 任务：Find the entry point\.$/m,
	);
	// 它的工具调用不占对话区的一项，结束之后那一行也不再写"最近"
	expect(screen).not.toContain("echo from-child");
	// 它的最终回复只在给模型的通知里出现一次
	expect(screen.match(/子 agent 的回复/g)).toHaveLength(1);
	expect(screen).toContain("finished. Its final reply:");
});

// 询问来自真实的沙盒：子 agent 的命令要到工作区之外写文件
describe.runIf(process.platform === "darwin")("子 agent 的询问", () => {
	test("写明是哪个子 agent 发起的，批准后它的命令在沙盒之外运行", async () => {
		const outside = join(fixture.dirs.home, "outside");
		mkdirSync(outside);
		const target = join(outside, "child.txt");
		await useModel(
			[spawnExplorer, textReply("等它"), textReply("主 agent 的结论")],
			[
				shellCallReply(`touch '${target}'`, {
					sandbox_permissions: "require_escalated",
				}),
				textReply("子 agent 的回复"),
			],
		);
		const { terminal } = await fixture.start({
			sandboxMode: "workspace-write",
		});
		await terminal.type("找入口");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");

		const asked = terminal.visible();
		expect(asked).toContain("需要确认：子 agent explorer · 在沙盒之外运行命令");
		expect(asked).toContain(`$ touch '${target}'`);
		expect(existsSync(target)).toBe(false);

		await terminal.press(key.enter);
		await terminal.waitFor("主 agent 的结论");
		expect(existsSync(target)).toBe(true);
		expect(terminal.text()).toContain("→ 已批准这一次");
	});
});
