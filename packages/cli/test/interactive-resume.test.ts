import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { shellCallReply, textReply } from "./harness.js";
import {
	interactiveFixture,
	lastUserMessage,
	requestedModel,
	selectFirstChoice,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";
import { finishedSession, interruptedSession } from "./sessions.js";

const fixture = interactiveFixture();

/** 中断时还在运行的命令：时长是个别处不会有的数，测试结束时按它清理。 */
const longCommand = "sleep 97.32";

afterEach(() => {
	spawnSync("pkill", ["-f", longCommand]);
});

/** `fragment` 在 `text` 里出现的次数。 */
function count(text: string, fragment: string): number {
	return text.split(fragment).length - 1;
}

/** 这几段文字都在 `text` 里，并且按给出的顺序先后出现。 */
function expectInOrder(text: string, fragments: readonly string[]): void {
	const positions = fragments.map((fragment) => text.indexOf(fragment));
	expect(positions).not.toContain(-1);
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("恢复之后的对话区", () => {
	test("resume <SESSION_ID>：先显示之前的对话，再说明之前的批准已失效；接着输入时模型请求里带着之前的对话", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					shellCallReply("echo from-shell"),
					textReply("第一次的回复"),
					textReply("第二次的回复"),
				][call],
		);
		const sessionId = await finishedSession(fixture.dirs, "第一个任务");

		const { terminal } = await fixture.start({
			resume: { kind: "id", sessionId },
		});
		await terminal.waitForVisible("Enter 发送");

		const shown = terminal.text();
		// 按记录重画的命令照样有输出、退出码和耗时，任务结束的那一行有当时的用时
		expect(shown).toMatch(
			/^• Ran echo from-shell\n {2}└ from-shell\n {4}✓ 退出码 0 · \d+\.\ds$/m,
		);
		expect(shown).toMatch(/^— 完成 · 用时 \d+\.\ds · 输入 /m);
		expectInOrder(shown, [
			"› 第一个任务",
			"• Ran echo from-shell",
			"第一次的回复",
			"— 完成",
			`已恢复 session ${sessionId}，上面是之前的对话`,
			"中断前给出的批准都已失效，需要时会重新询问",
			"Osprey Code",
		]);
		// 之前的每一项只显示一次
		for (const once of [
			"› 第一个任务",
			"• Ran echo from-shell",
			"第一次的回复",
			"— 完成",
		]) {
			expect(count(shown, once)).toBe(1);
		}
		expect(server.requests).toHaveLength(2);

		await terminal.type("第二个任务");
		await terminal.press(key.enter);
		await terminal.waitFor("第二次的回复");

		const resumed = JSON.stringify(server.requests[2]);
		expect(resumed).toContain("第一个任务");
		expect(resumed).toContain("from-shell");
		expect(resumed).toContain("第一次的回复");
		expect(lastUserMessage(server.requests[2])).toContain("第二个任务");
	});

	test("resume --last：恢复这个工作区最近写过的那个 session", async () => {
		await fixture.useModel((call) =>
			textReply(["甲的回复", "乙的回复"][call] ?? "好"),
		);
		await finishedSession(fixture.dirs, "任务甲");
		const latest = await finishedSession(fixture.dirs, "任务乙");

		const { terminal } = await fixture.start({ resume: { kind: "last" } });

		const shown = terminal.text();
		expectInOrder(shown, ["› 任务乙", "乙的回复", `已恢复 session ${latest}`]);
		expect(shown).not.toContain("任务甲");
	});

	test("恢复换过模型的 session：状态行和模型列表里是换过之后的模型，下一次模型请求用它", async () => {
		const server = await fixture.useModel(
			(call) => textReply(call === 0 ? "换过之后的回复" : "恢复之后的回复"),
			{ models: ["other"] },
		);
		const before = await fixture.start();
		await before.terminal.type("/model other");
		await before.terminal.press(key.enter);
		await before.terminal.waitForVisible("other · 推理");
		await before.terminal.type("第一个任务");
		await before.terminal.press(key.enter);
		await before.terminal.waitFor("换过之后的回复");
		await before.terminal.waitFor("完成");
		await before.terminal.type("/quit");
		await before.terminal.press(key.enter);
		expect(await fixture.exitCode()).toBe(0);

		const { terminal } = await fixture.start({ resume: { kind: "last" } });
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.visible()).toContain("other · 推理");

		await terminal.type("/model");
		await terminal.press(key.enter);
		await terminal.waitForVisible("切换模型");
		expect(terminal.visible()).toContain("→ other");
		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");

		await terminal.type("第二个任务");
		await terminal.press(key.enter);
		await terminal.waitFor("恢复之后的回复");
		expect(server.requests.map(requestedModel)).toEqual([
			"other-model",
			"other-model",
		]);
	});
});

describe("选择要恢复的 session", () => {
	test("没有指定时列出这个工作区的 session：最近写过的在前，每项是最后写入的时间和标题；选中的那个被恢复，列表不留在屏幕上", async () => {
		await fixture.useModel((call) =>
			textReply(["甲的回复", "乙的回复"][call] ?? "好"),
		);
		const first = await finishedSession(fixture.dirs, "任务甲\n第二行");
		await finishedSession(fixture.dirs, "任务乙");

		const { terminal } = await fixture.start({ resume: { kind: "pick" } });

		const time = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z`;
		expect(terminal.visible()).toMatch(
			new RegExp(
				`选择要恢复的 session\\n→ ${time} +任务乙\\n {2}${time} +任务甲\\n↑↓ 选择 · Enter 恢复 · Esc 取消`,
			),
		);

		await terminal.press(key.down);
		await terminal.waitFor(/→ \S+ +任务甲/);
		await terminal.press(key.enter);
		await terminal.waitFor("Osprey Code");

		const shown = terminal.text();
		expectInOrder(shown, ["› 任务甲", "甲的回复", `已恢复 session ${first}`]);
		expect(shown).not.toContain("选择要恢复的 session");
		expect(shown).not.toContain("任务乙");
	});

	test("在列表里按 Esc 取消：不恢复 session，退出码 0；收到 SIGTERM 时退出码 143", async () => {
		const server = await fixture.useModel(() => textReply("好"));
		await finishedSession(fixture.dirs, "第一个任务");

		const cancelled = await fixture.start({ resume: { kind: "pick" } });
		await cancelled.terminal.press(key.escape);
		expect(await fixture.exitCode()).toBe(0);
		expect(cancelled.terminal.text()).not.toContain("Osprey Code");
		expect(cancelled.terminal.text()).not.toContain("选择要恢复的 session");

		const signalled = await fixture.start({ resume: { kind: "pick" } });
		signalled.signal("SIGTERM");
		expect(await fixture.exitCode()).toBe(143);
		expect(server.requests).toHaveLength(1);
	});
});

describe("按记录重画的工具调用", () => {
	test("连着的查看聚合成一组，文件改动带着 diff 和增删的行数：和当时显示的一样", async () => {
		writeFileSync(join(fixture.dirs.workspace, "a.txt"), "甲\n丙\n");
		await fixture.useModel(
			(call) =>
				[
					toolCallsReply([{ name: "read", arguments: { path: "a.txt" } }]),
					toolCallsReply([
						{
							name: "edit",
							arguments: {
								path: "a.txt",
								edits: [{ old_text: "甲", new_text: "乙" }],
							},
						},
					]),
					textReply("改好了"),
				][call] ?? textReply("好"),
		);
		const sessionId = await finishedSession(fixture.dirs, "改一下");

		const { terminal } = await fixture.start({
			resume: { kind: "id", sessionId },
		});
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.text()).toMatch(
			/^• Explored\n {2}└ Read a\.txt\n\n• Edited a\.txt \(\+1 -1\)\n {4}1 - 甲\n {4}1 \+ 乙\n {4}2 {3}丙$/m,
		);
	});
});

describe("上次没有正常关闭的 session", () => {
	test("中断的任务以失败结束，接在之前的对话后面；恢复时记下的事件只显示一次", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? "hang" : textReply("接着做完了"),
		);
		// 模型的回复还没到的时候中断
		const sessionId = await interruptedSession(fixture.dirs, "中断的任务", () =>
			vi.waitFor(() => expect(server.requests).toHaveLength(1), {
				timeout: 20_000,
			}),
		);

		const { terminal } = await fixture.start({
			resume: { kind: "id", sessionId },
		});
		await terminal.waitFor("这个 task 中断了");
		// 恢复之后是空闲的，不自动接着做
		await terminal.waitForVisible("Enter 发送");

		const shown = terminal.text();
		expectInOrder(shown, [
			"› 中断的任务",
			`已恢复 session ${sessionId}`,
			"Osprey Code",
			"— 失败：上次运行时 session 没有正常关闭，这个 task 中断了",
		]);
		// 结束的事件既在 history() 里，也是恢复时实时发来的
		expect(count(shown, "这个 task 中断了")).toBe(1);
		expect(count(shown, "› 中断的任务")).toBe(1);
		expect(server.requests).toHaveLength(1);

		await terminal.type("接着做");
		await terminal.press(key.enter);
		await terminal.waitFor("接着做完了");
		const resumed = server.requests.at(-1);
		expect(JSON.stringify(resumed)).toContain("中断的任务");
		expect(lastUserMessage(resumed)).toContain("接着做");
	});

	test("中断时有命令不确定有没有执行：恢复后先问重新执行还是跳过；Esc 是跳过，结果记成中断，之后可以接着输入", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? shellCallReply(longCommand) : textReply("接着做完了"),
		);
		const sessionId = await interruptedSession(
			fixture.dirs,
			"跑一条长命令",
			(cli) => cli.waitForOutput('"type":"tool_call.started"'),
		);

		const { terminal } = await fixture.start({
			resume: { kind: "id", sessionId },
		});
		await terminal.waitForVisible("先按 ↑↓ 选择");

		const asked = terminal.visible();
		expect(asked).toContain("需要确认：上次中断时这次调用不确定有没有执行");
		expect(asked).toContain("工具：shell");
		expect(asked).toContain(longCommand);
		expect(asked).toMatch(
			/ {2}重新执行\n {2}跳过\n先按 ↑↓ 选择，再按 Enter 确认 · Esc 或 Ctrl\+C 跳过/,
		);
		// 之前的对话在询问之前已经显示出来
		expectInOrder(terminal.text(), [
			"› 跑一条长命令",
			// 上次中断时没有结果的调用现在没在运行
			`• Run ${longCommand}`,
			`已恢复 session ${sessionId}`,
			"需要确认：",
		]);

		await terminal.press(key.escape);
		await terminal.waitFor("→ 已跳过");
		await terminal.waitFor("✗ 中断，结果不确定");
		await terminal.waitFor("这个 task 中断了");
		await terminal.waitForVisible("Enter 发送");

		await terminal.type("接着做");
		await terminal.press(key.enter);
		await terminal.waitFor("接着做完了");
		// 跳过的调用没有重新执行：模型看到的是"结果不确定"
		expect(count(terminal.text(), `• Ran ${longCommand}`)).toBe(1);
		expect(terminal.text()).not.toContain(`• Running ${longCommand}`);
		expect(JSON.stringify(server.requests.at(-1))).toContain(
			"The user chose not to run it again",
		);
		expect(server.requests).toHaveLength(2);
	});

	test("选重新执行：下一个任务开始时这条命令再执行一次，结果交给模型", async () => {
		const marker = join(fixture.dirs.workspace, "ran-once");
		// 第一次执行留下标记后一直不结束，再执行时看到标记马上结束
		const command = `test -e ${marker} && echo ran-again || { touch ${marker}; ${longCommand}; }`;
		const server = await fixture.useModel((call) =>
			call === 0 ? shellCallReply(command) : textReply("接着做完了"),
		);
		const sessionId = await interruptedSession(
			fixture.dirs,
			"跑一条长命令",
			() =>
				vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
					timeout: 20_000,
				}),
		);

		const { terminal } = await fixture.start({
			resume: { kind: "id", sessionId },
		});
		await selectFirstChoice(terminal, "重新执行");
		await terminal.press(key.enter);
		await terminal.waitFor("→ 下一个任务开始时重新执行");
		await terminal.waitFor("这个 task 中断了");
		await terminal.waitForVisible("Enter 发送");
		expect(server.requests).toHaveLength(1);

		await terminal.type("接着做");
		await terminal.press(key.enter);
		await terminal.waitFor("接着做完了");
		expect(terminal.text()).toMatch(/^ {2}└ ran-again\n {4}✓ 退出码 0 · /m);
		expect(JSON.stringify(server.requests.at(-1))).toContain("ran-again");
	});
});
