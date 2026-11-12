import { spawnSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type ModelReply,
	runCli,
	shellCallReply,
	type TestDirectories,
	textReply,
} from "./harness.js";
import {
	interactiveFixture,
	lastUserMessage,
	requestedModel,
	selectFirstChoice,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key, type TestTerminal } from "./interactive-terminal.js";

const fixture = interactiveFixture();

/** 说明里有 session 的标识和完整的路径：终端宽一些，它们不折行。 */
const wide = { columns: 240 };

/** 测试里启动的长命令：时长是个别处不会有的数，测试结束时按它清理。 */
const longCommand = "sleep 96.41";

afterEach(() => {
	spawnSync("pkill", ["-f", longCommand]);
});

/**
 * 按输入做事的模型：输入里有"写 <文件> <内容>"时用 write 工具写这个文件，写完回复"写好了 <文件>"；
 * 别的输入回复"回复<第几次请求>"，每次的回复都不一样。
 */
function worker(call: number, request: unknown): ModelReply {
	const { messages } = request as { messages: { role: string }[] };
	const write = /写 (\S+) (\S+)/.exec(lastUserMessage(request));
	if (write === null) return textReply(`回复${call}`);
	const [, path, content] = write;
	return messages.at(-1)?.role === "tool"
		? textReply(`写好了 ${path}`)
		: toolCallsReply([
				{ name: "write", arguments: { path, content: `${content}\n` } },
			]);
}

/** 输入一行并提交，等 `shown` 出现在终端上。 */
async function enter(
	terminal: TestTerminal,
	line: string,
	shown: string | RegExp,
): Promise<void> {
	await terminal.type(line);
	await terminal.press(key.enter);
	await terminal.waitFor(shown);
}

/**
 * 不带参数的 `/undo`、`/rewind`、`/branch`：等列表出来（`shown` 是其中的一项），按 Esc 关掉它、
 * 什么都不选。列表记成了"上次列出的"，之后的命令按它的序号引用。
 */
async function list(
	terminal: TestTerminal,
	command: string,
	shown: string,
): Promise<void> {
	await enter(terminal, command, shown);
	await terminal.press(key.escape);
	await terminal.waitForVisible("Enter 发送");
}

/** 回退之后输入框里是放回来的那次输入：等它出现，再用 Ctrl+C 清掉。 */
async function clearEditor(
	terminal: TestTerminal,
	returned: string,
): Promise<void> {
	await terminal.waitForVisible(returned);
	await terminal.press(key.ctrlC);
	await terminal.waitForGone(returned);
}

/** 等终端上有 `count` 个任务结束的那一行。 */
async function finished(terminal: TestTerminal, count: number): Promise<void> {
	await terminal.waitFor(new RegExp(`(— 完成[\\s\\S]*){${count}}`));
}

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

/** 分叉成功的说明里的两个 session：来源和分叉出来的。 */
function forked(terminal: TestTerminal): { source: string; fork: string } {
	const match = /已从 session (\S+) 分叉，现在是 session (\S+)：/.exec(
		terminal.text(),
	);
	if (match === null) {
		throw new Error(`终端上没有分叉成功的说明：\n${terminal.text()}`);
	}
	return { source: match[1], fork: match[2] };
}

/** 一个 session 导出的内容。 */
async function exported(
	dirs: TestDirectories,
	sessionId: string,
): Promise<string> {
	const result = await runCli(["session", "export", sessionId], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	expect(result.stderr).toBe("");
	return result.stdout;
}

/** 这个工作区的 session 的标识。 */
async function sessionIds(dirs: TestDirectories): Promise<string[]> {
	const result = await runCli(["session", "list", "--json"], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	expect(result.stderr).toBe("");
	return (JSON.parse(result.stdout) as { session_id: string }[]).map(
		(session) => session.session_id,
	);
}

/** Host 根目录里 session 开着时才有的东西：工作区和 session 的锁、登记着的进程。 */
function leftBehind(dirs: TestDirectories): {
	locks: string[];
	processes: unknown[];
} {
	const data = join(dirs.root, "data");
	const { processes } = JSON.parse(
		readFileSync(join(data, "processes.json"), "utf8"),
	) as { processes: unknown[] };
	return { locks: readdirSync(join(data, "locks")), processes };
}

describe("/diff", () => {
	test("没有改动时说明；改过之后显示文件数和 unified diff；/diff N 只显示第 N 个检查点以来的改动", async () => {
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "/diff", "本 session 没有改动");

		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await enter(terminal, "写 b.txt 乙", "写好了 b.txt");
		await finished(terminal, 2);
		await enter(terminal, "/diff", "本 session 的改动：2 个文件");
		await terminal.waitFor(/^\s+\+乙$/m);
		const whole = terminal
			.text()
			.slice(terminal.text().indexOf("本 session 的改动"));
		expect(whole).toMatch(/^\s+diff --git a\/a\.txt b\/a\.txt$/m);
		expect(whole).toMatch(/^\s+\+甲$/m);

		// 序号指上次列出的检查点：还没有列出过时不能用
		await enter(
			terminal,
			"/diff 2",
			"先用 /undo 或 /rewind 列出检查点，再按序号引用",
		);
		await list(terminal, "/undo", "[2]");
		await enter(terminal, "/diff 2", "第 2 个检查点以来的改动：1 个文件");
		await terminal.waitFor(/第 2 个检查点以来的改动[\s\S]*^\s+\+乙$/m);
		const since = terminal
			.text()
			.slice(terminal.text().indexOf("第 2 个检查点以来的改动"));
		expect(since).not.toContain("a.txt");

		await enter(terminal, "/diff 2 3", "/diff 的写法");
	});

	test("很长的 diff 只显示开头的 200 行，其余写出行数", async () => {
		const content = Array.from(
			{ length: 300 },
			(_, index) => `行${index + 1}\n`,
		);
		await fixture.useModel(
			(call) =>
				[
					toolCallsReply([
						{
							name: "write",
							arguments: { path: "long.txt", content: content.join("") },
						},
					]),
					textReply("写好了"),
				][call] ?? textReply("好"),
		);
		// 两百行的 diff 比屏幕长：在主缓冲区里从终端的滚动历史看全
		const { terminal } = await fixture.start({ tuiMode: "regular" });
		await enter(terminal, "写一个长文件", "写好了");
		await finished(terminal, 1);

		// diff 的开头有 6 行说明是哪个文件
		await enter(terminal, "/diff", "… 还有 106 行");
		const shown = terminal
			.text()
			.slice(terminal.text().indexOf("本 session 的改动：1 个文件"));
		expect(shown).toMatch(/^\s+\+行194$/m);
		expect(shown).not.toMatch(/^\s+\+行195$/m);
	});
});

describe("/undo", () => {
	test("不带参数时列出检查点供选择，Esc 关掉列表不还原；/undo N 把文件还原到第 N 个检查点，对话不动，结果里列出还原的文件", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "/undo", "还没有检查点");

		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await enter(terminal, "写 b.txt 乙", "写好了 b.txt");
		await finished(terminal, 2);
		await enter(terminal, "/undo", "[2]");
		// 最近的一次输入选中着
		expect(terminal.visible()).toMatch(
			/ {2}\[1\] \d{4}-\S+ +写 a\.txt 甲\n→ \[2\] \d{4}-\S+ +写 b\.txt 乙\n/,
		);
		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");
		expect(existsSync(join(workspace, "b.txt"))).toBe(true);
		expect(terminal.text()).not.toContain("已把代码还原");

		await enter(
			terminal,
			"/undo 2",
			"已把代码还原到第 2 个检查点，对话没有动：",
		);
		await terminal.waitFor(/还原了 1 个文件：\n\s+b\.txt/);
		expect(existsSync(join(workspace, "b.txt"))).toBe(false);
		expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("甲\n");
		expect(terminal.text()).toContain("写好了 b.txt");
		// Host 告诉模型文件已还原的那条通知不是后台命令产生的
		expect(terminal.text()).toContain(
			"给模型的通知：The user restored these files",
		);
		expect(terminal.text()).not.toContain("后台通知");

		await enter(terminal, "/undo 1", "已把代码还原到第 1 个检查点");
		await terminal.waitFor(/还原了 1 个文件：\n\s+a\.txt/);
		expect(existsSync(join(workspace, "a.txt"))).toBe(false);

		await enter(terminal, "/undo 3", "序号要在 1 到 2 之间：3");
		await enter(terminal, "/undo 1 force", "/undo 的写法");
	});

	test("/undo 从列表里选：↑↓ 选一个检查点，Enter 把代码还原到它，和 /undo N 一样", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await enter(terminal, "写 b.txt 乙", "写好了 b.txt");
		await finished(terminal, 2);

		await enter(terminal, "/undo", "把代码还原到哪次输入之前");
		await terminal.waitForVisible("→ [2]");
		await terminal.press(key.up);
		await terminal.waitForVisible("→ [1]");
		await terminal.press(key.enter);
		await terminal.waitFor("已把代码还原到第 1 个检查点，对话没有动：");
		await terminal.waitFor(/还原了 2 个文件：\n\s+a\.txt\n\s+b\.txt/);
		expect(existsSync(join(workspace, "a.txt"))).toBe(false);
		expect(existsSync(join(workspace, "b.txt"))).toBe(false);
		// 列表关掉了，输入框回来
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.visible()).not.toContain("把代码还原到哪次输入之前");
		expect(terminal.text()).toContain("写好了 b.txt");
	});

	test("文件在 agent 改过之后又被别处改过：列为冲突、不还原；/undo N overwrite 连它一起还原", async () => {
		const { workspace } = fixture.dirs;
		const file = join(workspace, "a.txt");
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await finished(terminal, 1);
		writeFileSync(file, "别处改的\n");

		await list(terminal, "/undo", "[1]");
		await enter(
			terminal,
			"/undo 1",
			/1 个文件在 agent 改过之后又被别处改过，没有还原；\/undo 1 overwrite 连它们一起还原：\n\s+a\.txt/,
		);
		expect(readFileSync(file, "utf8")).toBe("别处改的\n");

		await enter(terminal, "/undo 1 overwrite", /还原了 1 个文件：\n\s+a\.txt/);
		expect(existsSync(file)).toBe(false);
	});

	test("太大而没有保存进快照的文件：/diff 和 /undo 的结果里单独列出，它还原不了", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel(
			(call) =>
				[
					// 单个文件超过 10 MB 的不进快照
					shellCallReply(
						"head -c 11000000 /dev/zero > big.bin; echo 小文件 > small.txt",
					),
					textReply("写好了"),
				][call] ?? textReply("好"),
		);
		const { terminal } = await fixture.start();
		await enter(terminal, "写两个文件", "写好了");
		await finished(terminal, 1);

		await enter(
			terminal,
			"/diff",
			/本 session 的改动：1 个文件\n\s+改过但没有快照、看不到差异：\n\s+big\.bin\n\s+diff --git a\/small\.txt b\/small\.txt/,
		);
		await list(terminal, "/undo", "[1]");
		await enter(
			terminal,
			"/undo 1",
			/还原了 1 个文件：\n\s+small\.txt\n\s+没有快照、还原不了：\n\s+big\.bin/,
		);
		expect(existsSync(join(workspace, "small.txt"))).toBe(false);
		expect(existsSync(join(workspace, "big.bin"))).toBe(true);
	});

	// 写工作区之外的文件要经过批准：询问来自真实的沙盒
	test.runIf(process.platform === "darwin")(
		"经批准写到工作区之外的文件撤销不了：结果里列出来",
		async () => {
			const { workspace, home } = fixture.dirs;
			const outside = join(home, "outside.txt");
			await fixture.useModel(
				(call) =>
					[
						toolCallsReply([
							{
								name: "write",
								arguments: { path: "inside.txt", content: "里面\n" },
							},
							{
								name: "write",
								arguments: { path: outside, content: "外面\n" },
							},
						]),
						textReply("写好了"),
					][call] ?? textReply("好"),
			);
			const { terminal } = await fixture.start({
				...wide,
				sandboxMode: "workspace-write",
			});
			await terminal.type("写两个文件");
			await terminal.press(key.enter);
			await selectFirstChoice(terminal, "批准这一次");
			await terminal.press(key.enter);
			await terminal.waitFor("写好了");
			await finished(terminal, 1);

			await list(terminal, "/undo", "[1]");
			await enter(
				terminal,
				"/undo 1",
				new RegExp(
					`还原了 1 个文件：\\n\\s+inside\\.txt\\n\\s+写在工作区之外、撤销不了：\\n\\s+${outside}`,
				),
			);
			expect(existsSync(join(workspace, "inside.txt"))).toBe(false);
			expect(readFileSync(outside, "utf8")).toBe("外面\n");
		},
	);

	test("还在运行的后台命令先结束，再还原", async () => {
		await fixture.useModel(
			(call) =>
				[
					shellCallReply(longCommand, { background: true }),
					textReply("在后台跑着"),
				][call] ?? textReply("好"),
		);
		const { terminal } = await fixture.start();
		await enter(terminal, "跑一条后台命令", "在后台跑着");
		await finished(terminal, 1);

		await list(terminal, "/undo", "[1]");
		await enter(terminal, "/undo 1", "已把代码还原到第 1 个检查点");
		expect(terminal.text()).toMatch(
			/后台命令 \S+ 结束了（被停止）：sleep 96\.41[\s\S]*已把代码还原到第 1 个检查点/,
		);
		await enter(terminal, "/bg", "没有在运行的后台命令");
	});
});

describe("/rewind", () => {
	test("/rewind N：对话重画到第 N 次输入之前，那次输入回到输入框；接着输入时模型收到的历史只到那里；被放弃的检查点不能再回退到", async () => {
		const server = await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "第一件事", "回复0");
		await enter(terminal, "第二件事", "回复1");
		await finished(terminal, 2);

		await list(terminal, "/rewind", "[2]");
		await enter(
			terminal,
			"/rewind 2",
			"已把对话回退到第 2 个检查点的输入之前，那次输入放回了输入框；代码没有动",
		);
		const shown = terminal.text();
		expectInOrder(shown, [
			"› 第一件事",
			"回复0",
			"— 完成",
			"agent 进程已重启",
			"已把对话回退到第 2 个检查点",
		]);
		expect(count(shown, "› 第一件事")).toBe(1);
		expect(shown).not.toContain("回复1");
		expect(shown).not.toContain("› 第二件事");
		// 输入框里是那次输入：接着写几个字再发出去
		await terminal.waitForVisible("第二件事");
		await enter(terminal, "，换个做法", "回复2");
		await finished(terminal, 2);
		expect(terminal.text()).toContain("› 第二件事，换个做法");

		const request = JSON.stringify(server.requests[2]);
		expect(request).toContain("第一件事");
		expect(request).toContain("回复0");
		expect(request).not.toContain("回复1");
		expect(lastUserMessage(server.requests[2])).toContain("第二件事，换个做法");

		// 回退之后要重新列出：被放弃的那次输入不在当前路径上了
		await enter(
			terminal,
			"/rewind 2",
			"先用 /undo 或 /rewind 列出检查点，再按序号引用",
		);
		await enter(terminal, "/rewind", "[3]");
		expect(terminal.visible()).toMatch(
			/ {2}\[2\] \S+ +第二件事 · 不在当前对话路径上（只能还原代码）\n→ \[3\] \S+ +第二件事，换个做法\n/,
		);
		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");
		await enter(
			terminal,
			"/rewind 2",
			"这个检查点不在当前的对话路径上，不能回退到它",
		);
		// 没有回退：对话还在
		expect(terminal.text()).toContain("回复2");
	});

	test("回退的这一会儿里输入框里打了字：那次输入接在后面，不覆盖已经打的字", async () => {
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "第一件事", "回复0");
		await enter(terminal, "第二件事", "回复1");
		await finished(terminal, 2);
		await list(terminal, "/rewind", "[2]");

		await terminal.type("/rewind 2");
		await terminal.press(key.enter);
		await terminal.type("草稿");
		await terminal.waitFor("已把对话回退到第 2 个检查点");
		await terminal.waitForVisible("第二件事");
		expect(terminal.visible()).toMatch(/草稿\s*\n\s*第二件事/);
	});

	test("/rewind N code：同时把代码还原到那个检查点，结果里列出还原的文件；不带 code 时代码不动", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await enter(terminal, "写 b.txt 乙", "写好了 b.txt");
		await enter(terminal, "写 c.txt 丙", "写好了 c.txt");
		await finished(terminal, 3);

		await list(terminal, "/rewind", "[3]");
		await enter(terminal, "/rewind 3 overwrite", "/rewind 的写法");
		await enter(terminal, "/rewind 3", "代码没有动");
		expect(existsSync(join(workspace, "c.txt"))).toBe(true);
		expect(terminal.text()).not.toContain("写好了 c.txt");
		await clearEditor(terminal, "写 c.txt 丙");

		await list(terminal, "/rewind", "[3]");
		await enter(terminal, "/rewind 2 code", "代码还原到那时：");
		// 被放弃的那一段改过的文件也算在内
		await terminal.waitFor(/还原了 2 个文件：\n\s+b\.txt\n\s+c\.txt/);
		expect(existsSync(join(workspace, "b.txt"))).toBe(false);
		expect(existsSync(join(workspace, "c.txt"))).toBe(false);
		expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("甲\n");
		const shown = terminal.text();
		expect(shown).toContain("写好了 a.txt");
		expect(shown).not.toContain("写好了 b.txt");
	});

	test("/rewind 从列表里选：先选检查点，再选只回退对话还是连代码一起还原；Esc 关掉列表不回退", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await enter(terminal, "写 b.txt 乙", "写好了 b.txt");
		await finished(terminal, 2);

		// 第二步按 Esc：什么都没有动
		await enter(terminal, "/rewind", "把对话回退到哪次输入之前");
		await terminal.waitForVisible("→ [2]");
		await terminal.press(key.enter);
		await terminal.waitForVisible("回退到第 2 个检查点的输入之前");
		expect(terminal.visible()).toMatch(/→ 只回退对话 +代码不动\n/);
		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.text()).toContain("写好了 b.txt");
		expect(terminal.text()).not.toContain("已把对话回退");

		await enter(terminal, "/rewind", "把对话回退到哪次输入之前");
		await terminal.waitForVisible("→ [2]");
		await terminal.press(key.enter);
		await terminal.waitForVisible("回退到第 2 个检查点的输入之前");
		await terminal.press(key.down);
		await terminal.waitForVisible("→ 回退对话并还原代码");
		await terminal.press(key.enter);
		await terminal.waitFor("已把对话回退到第 2 个检查点的输入之前");
		await terminal.waitFor(/代码还原到那时：\n\s+还原了 1 个文件：\n\s+b\.txt/);
		expect(existsSync(join(workspace, "b.txt"))).toBe(false);
		expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("甲\n");
		expect(terminal.text()).not.toContain("写好了 b.txt");
		// 那次输入回到输入框
		await terminal.waitForVisible("写 b.txt 乙");
	});

	test("回退结束那次输入之后启动的后台命令：结束的说明显示在重画的对话之后", async () => {
		await fixture.useModel(
			(call) =>
				[
					textReply("回复0"),
					shellCallReply(longCommand, { background: true }),
					textReply("在后台跑着"),
				][call] ?? textReply("好"),
		);
		const { terminal } = await fixture.start();
		await enter(terminal, "第一件事", "回复0");
		await enter(terminal, "跑一条后台命令", "在后台跑着");
		await finished(terminal, 2);

		await list(terminal, "/rewind", "[2]");
		await enter(terminal, "/rewind 2", "已把对话回退到第 2 个检查点");
		expectInOrder(terminal.text(), [
			"回复0",
			"结束了（被停止）：sleep 96.41",
			"已把对话回退到第 2 个检查点",
		]);
		expect(terminal.text()).not.toContain("在后台跑着");
		await clearEditor(terminal, "跑一条后台命令");
		await enter(terminal, "/bg", "没有在运行的后台命令");
	});
});

describe("/branch", () => {
	test("/branch 列出回退时放弃的分支供选择；/branch N 切回去：对话重画成那一段，模型收到的历史也是那一段，刚才这一段成为被放弃的分支", async () => {
		const server = await fixture.useModel(worker);
		const { terminal } = await fixture.start();
		await enter(terminal, "/branch", "没有被放弃的分支");
		await enter(
			terminal,
			"/branch 1",
			"先用 /branch 列出被放弃的分支，再按序号引用",
		);
		await enter(terminal, "第一件事", "回复0");
		await enter(terminal, "第二件事", "回复1");
		await finished(terminal, 2);

		await list(terminal, "/rewind", "[2]");
		await enter(terminal, "/rewind 2", "/branch 列出，可以切回去");
		await clearEditor(terminal, "第二件事");
		await enter(terminal, "另一件事", "回复2");
		await finished(terminal, 2);

		await enter(terminal, "/branch", "被放弃的分支");
		expect(terminal.visible()).toMatch(/→ \[1\] \S+ +第二件事\n/);
		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");
		await enter(terminal, "/branch 1 2", "/branch 的写法");
		await enter(terminal, "/branch 2", "序号要在 1 到 1 之间：2");
		await enter(terminal, "/branch 1", "已切回第 1 个分支");
		const shown = terminal.text();
		expectInOrder(shown, [
			"› 第一件事",
			"回复0",
			"› 第二件事",
			"回复1",
			"agent 进程已重启",
			"已切回第 1 个分支",
		]);
		expect(count(shown, "› 第二件事")).toBe(1);
		expect(shown).not.toContain("另一件事");
		expect(shown).not.toContain("回复2");

		await enter(terminal, "接着做", "回复3");
		await finished(terminal, 3);
		const request = JSON.stringify(server.requests[3]);
		expect(request).toContain("第二件事");
		expect(request).toContain("回复1");
		expect(request).not.toContain("另一件事");
		expect(request).not.toContain("回复2");

		// 切换之后要重新列出：刚才那一段成了被放弃的分支，切回来的这一段不再列
		await enter(
			terminal,
			"/branch 1",
			"先用 /branch 列出被放弃的分支，再按序号引用",
		);
		await enter(terminal, "/branch", "被放弃的分支");
		expect(terminal.visible()).toMatch(/→ \[1\] \S+ +另一件事\n/);
		expect(terminal.visible()).not.toMatch(/\[2\]/);
	});

	test("/branch 从列表里选一个分支切回去；切换分支结束不在那个分支上的后台命令，代码不动", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel((call, request) => {
			if (!lastUserMessage(request).includes("后台")) {
				return worker(call, request);
			}
			const { messages } = request as { messages: { role: string }[] };
			return messages.at(-1)?.role === "tool"
				? textReply("在后台跑着")
				: shellCallReply(longCommand, { background: true });
		});
		const { terminal } = await fixture.start();
		await enter(terminal, "写 a.txt 甲", "写好了 a.txt");
		await finished(terminal, 1);
		await list(terminal, "/rewind", "[1]");
		await enter(terminal, "/rewind 1", "/branch 列出，可以切回去");
		await clearEditor(terminal, "写 a.txt 甲");
		await enter(terminal, "跑一条后台命令", "在后台跑着");
		await finished(terminal, 1);

		await enter(terminal, "/branch", "切回哪个被放弃的分支");
		await terminal.waitForVisible("→ [1]");
		await terminal.press(key.enter);
		await terminal.waitFor("已切回第 1 个分支");
		expectInOrder(terminal.text(), [
			"写好了 a.txt",
			"结束了（被停止）：sleep 96.41",
			"已切回第 1 个分支",
		]);
		expect(terminal.text()).not.toContain("在后台跑着");
		await enter(terminal, "/bg", "没有在运行的后台命令");
		expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("甲\n");
	});
});

describe("/fork", () => {
	test("/fork：从当前位置分叉，界面换到新的 session；之后的输入写在分叉里，原来的 session 不变、还能恢复", async () => {
		const { dirs } = fixture;
		const server = await fixture.useModel(worker);
		const { terminal } = await fixture.start(wide);
		await enter(terminal, "/fork", "还没有对话，没有可以分叉的内容");
		await enter(terminal, "第一件事", "回复0");
		await finished(terminal, 1);

		await enter(terminal, "/fork", "已从 session");
		await terminal.waitForVisible("Enter 发送");
		const { source, fork } = forked(terminal);
		expect(fork).not.toBe(source);
		const shown = terminal.text();
		expectInOrder(shown, [
			"› 第一件事",
			"回复0",
			"— 完成",
			`已从 session ${source} 分叉，现在是 session ${fork}`,
		]);
		expect(count(shown, "› 第一件事")).toBe(1);

		await enter(terminal, "分叉里的事", "回复1");
		await finished(terminal, 2);
		const request = JSON.stringify(server.requests[1]);
		expect(request).toContain("第一件事");
		expect(request).toContain("回复0");
		await terminal.type("/quit");
		await terminal.press(key.enter);
		expect(await fixture.exitCode()).toBe(0);
		// 退出时关的是分叉出来的 session
		expect(leftBehind(dirs)).toEqual({ locks: [], processes: [] });

		expect((await sessionIds(dirs)).sort()).toEqual([source, fork].sort());
		expect(await exported(dirs, source)).not.toContain("分叉里的事");
		const forkRecord = await exported(dirs, fork);
		expect(forkRecord).toContain("第一件事");
		expect(forkRecord).toContain("分叉里的事");

		const again = await fixture.start({
			resume: { kind: "id", sessionId: source },
		});
		await again.terminal.waitForVisible("Enter 发送");
		expect(again.terminal.text()).toContain("回复0");
		expect(again.terminal.text()).not.toContain("分叉里的事");
	});

	test("/fork N：从第 N 个检查点的输入之前分叉，分叉里只有那之前的对话；第一次输入之前不能分叉", async () => {
		const { dirs } = fixture;
		const server = await fixture.useModel(worker);
		const { terminal } = await fixture.start(wide);
		await enter(terminal, "第一件事", "回复0");
		await enter(terminal, "第二件事", "回复1");
		await finished(terminal, 2);

		await enter(
			terminal,
			"/fork 2",
			"先用 /undo 或 /rewind 列出检查点，再按序号引用",
		);
		await list(terminal, "/undo", "[2]");
		await enter(
			terminal,
			"/fork 1",
			"第 1 个检查点之前还没有对话：从这里分叉就是新建一个 session",
		);
		await enter(terminal, "/fork 2 3", "/fork 的写法");
		// 没有分叉：session 没有关
		expect(await sessionIds(dirs)).toHaveLength(1);

		await enter(terminal, "/fork 2", "已从 session");
		await terminal.waitForVisible("Enter 发送");
		const { source, fork } = forked(terminal);
		const shown = terminal.text();
		expect(shown).toContain("回复0");
		expect(shown).not.toContain("回复1");
		expect(shown).not.toContain("第二件事");

		await enter(terminal, "分叉里的事", "回复2");
		const request = JSON.stringify(server.requests[2]);
		expect(request).toContain("回复0");
		expect(request).not.toContain("回复1");
		expect(request).not.toContain("第二件事");
		await finished(terminal, 2);

		// 分叉沿用来源 session 的检查点：分叉位置之后的那些不在分叉的对话里，没有输入可显示
		await enter(
			terminal,
			"/undo",
			/ {2}\[1\] \S+ +第一件事\n {2}\[2\] +（来源 session 的检查点） · 不在当前对话路径上（只能还原代码）\n→ \[3\] \S+ +分叉里的事\n/,
		);
		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");
		await terminal.type("/quit");
		await terminal.press(key.enter);
		expect(await fixture.exitCode()).toBe(0);

		const sourceRecord = await exported(dirs, source);
		expect(sourceRecord).toContain("第二件事");
		expect(sourceRecord).not.toContain("分叉里的事");
		expect(await exported(dirs, fork)).toContain("分叉里的事");
	});

	test("会话中换过的审批策略和模型带到 /fork 出来的 session；/fork N 的模型按分叉位置的记录", async () => {
		const server = await fixture.useModel(worker, { models: ["other"] });
		const { terminal } = await fixture.start(wide);
		await enter(terminal, "第一件事", "回复0");
		await finished(terminal, 1);
		await terminal.type("/model other");
		await terminal.press(key.enter);
		await terminal.waitForVisible("other · 推理");
		await terminal.type("/approval never");
		await terminal.press(key.enter);
		await terminal.waitForVisible("审批 never");

		// 换了模型还没有用过：分叉接着用现在的设置，不是记录里上一次请求用的
		await enter(terminal, "/fork", "已从 session");
		await terminal.waitForVisible("Enter 发送");
		const first = forked(terminal);
		expect(terminal.visible()).toMatch(/other · 推理 .* 审批 never/);
		await enter(terminal, "第二件事", "回复1");
		await finished(terminal, 2);
		expect(requestedModel(server.requests[1])).toBe("other-model");

		// 第二次输入之前最后一次请求用的是 fake
		await list(terminal, "/undo", "[2]");
		await enter(terminal, "/fork 2", `已从 session ${first.fork} 分叉`);
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.visible()).toMatch(/fake · 推理 .* 审批 never/);
		await enter(terminal, "另一件事", "回复2");
		expect(requestedModel(server.requests[2])).toBe("fake-model");
	});

	test("分叉没有成功：重新打开原来的 session，说明原因，接着能用", async () => {
		const { dirs } = fixture;
		const server = await fixture.useModel(worker, {
			models: ["other"],
			selected: "other",
		});
		const { terminal } = await fixture.start(wide);
		await enter(terminal, "第一件事", "回复0");
		await finished(terminal, 1);
		await terminal.type("/model fake");
		await terminal.press(key.enter);
		await terminal.waitForVisible("fake · 推理");
		await enter(terminal, "第二件事", "回复1");
		await finished(terminal, 2);
		const [source] = await sessionIds(dirs);

		// 第二次输入之前用的模型从清单里去掉了：从那里分叉时 Host 按记录选它，选不了
		fixture.configure({});
		await list(terminal, "/undo", "[2]");
		await enter(terminal, "/fork 2", "分叉没有成功：");
		await terminal.waitFor(`已重新打开 session ${source}`);
		await terminal.waitForVisible("Enter 发送");
		const shown = terminal.text();
		expectInOrder(shown, [
			"› 第一件事",
			"回复0",
			"› 第二件事",
			"回复1",
			"分叉没有成功：",
			`已重新打开 session ${source}`,
		]);
		expect(await sessionIds(dirs)).toEqual([source]);

		await enter(terminal, "第三件事", "回复2");
		expect(requestedModel(server.requests[2])).toBe("fake-model");
		expect(JSON.stringify(server.requests[2])).toContain("回复1");
	});

	test("分叉没有成功、原来的 session 也打不开：说明原因和怎样回去，以退出码 1 退出", async () => {
		const { dirs } = fixture;
		const server = await fixture.useModel(worker);
		const { terminal } = await fixture.start(wide);
		await enter(terminal, "第一件事", "回复0");
		await finished(terminal, 1);
		const [source] = await sessionIds(dirs);

		dirs.writeConfig("这一行不是合法的配置\n");
		await terminal.type("/fork");
		await terminal.press(key.enter);
		expect(await fixture.exitCode()).toBe(1);
		const shown = terminal.text();
		expect(shown).toContain("分叉没有成功：");
		expect(shown).toContain(`也没能重新打开 session ${source}：`);
		expect(shown).toContain(`用 ospreycode resume ${source} 回到它`);

		// 原来的 session 正常关闭了，记录没有变：配置改好之后能恢复
		dirs.writeConfig(server.config);
		expect(leftBehind(dirs)).toEqual({ locks: [], processes: [] });
		expect(await sessionIds(dirs)).toEqual([source]);
		const again = await fixture.start({
			resume: { kind: "id", sessionId: source },
		});
		await again.terminal.waitForVisible("Enter 发送");
		expect(again.terminal.text()).toContain("回复0");
	});

	test("分叉还没换完时收到 SIGTERM：等它换完，关掉换上的 session 再退出，不留下锁和进程", async () => {
		const { dirs } = fixture;
		await fixture.useModel(worker);
		const run = await fixture.start();
		await enter(run.terminal, "第一件事", "回复0");
		await finished(run.terminal, 1);

		await run.terminal.type("/fork");
		await run.terminal.press(key.enter);
		await run.terminal.waitForVisible("正在分叉…");
		run.signal("SIGTERM");
		expect(await fixture.exitCode()).toBe(143);
		expect(leftBehind(dirs)).toEqual({ locks: [], processes: [] });
	});
});

describe("/export", () => {
	test("/export 把本 session 导出成当前目录下的 JSONL 文件，只对当前用户可读写；/export FILE 写到指定的文件", async () => {
		const { workspace } = fixture.dirs;
		await fixture.useModel(worker);
		const { terminal } = await fixture.start(wide);
		await enter(terminal, "第一件事", "回复0");
		await finished(terminal, 1);

		await enter(terminal, "/export", /已把 session \S+ 导出到 \S+（\d+ 行/);
		const [, sessionId, path, written] =
			/已把 session (\S+) 导出到 (\S+)（(\d+) 行/.exec(terminal.text()) ?? [];
		expect(path).toBe(join(workspace, `ospreycode-${sessionId}.jsonl`));
		const lines = readFileSync(path, "utf8").split("\n").slice(0, -1);
		expect(lines).toHaveLength(Number(written));
		const records = lines.map((line) => JSON.parse(line) as unknown);
		expect(records.length).toBeGreaterThan(1);
		expect(JSON.stringify(records)).toContain("第一件事");
		expect(statSync(path).mode & 0o777).toBe(0o600);

		// 已有的文件：内容换掉，权限收紧
		const existing = join(workspace, "旧的 导出.jsonl");
		writeFileSync(existing, "原来的内容\n", { mode: 0o644 });
		await enter(terminal, "/export 旧的 导出.jsonl", `导出到 ${existing}（`);
		expect(readFileSync(existing, "utf8")).toBe(readFileSync(path, "utf8"));
		expect(statSync(existing).mode & 0o777).toBe(0o600);

		await enter(
			terminal,
			"/export 没有的目录/x.jsonl",
			`写不了 ${join(workspace, "没有的目录/x.jsonl")}：ENOENT`,
		);
	});
});

describe("task 运行中", () => {
	test("/undo 不带参数只把检查点列在对话区；/undo N、/rewind N、/fork 被拒绝，任务照常进行；/diff 和 /export 照常可用", async () => {
		await fixture.useModel((call) =>
			call === 0 ? shellCallReply(longCommand) : textReply("做完了"),
		);
		const { terminal } = await fixture.start(wide);
		await terminal.type("跑一条长命令");
		await terminal.press(key.enter);
		await terminal.waitFor(`$ ${longCommand}`);

		// 现在选了也做不了：不弹出列表，输入框还在
		await enter(terminal, "/undo", /\[1\] \S+ 跑一条长命令\n/);
		expect(terminal.visible()).not.toContain("把代码还原到哪次输入之前");
		await enter(terminal, "/undo 1", "只能在 session 空闲时撤销改动");
		await enter(terminal, "/rewind 1", "只能在 session 空闲时回退会话");
		await enter(terminal, "/fork", "只能在 session 空闲时分叉");
		await enter(terminal, "/fork 1", "只能在 session 空闲时分叉");
		await enter(terminal, "/diff", "本 session 没有改动");
		await enter(terminal, "/export", /已把 session \S+ 导出到/);

		// 对话没有被重画，任务还在运行
		expect(terminal.text()).toContain("› 跑一条长命令");
		expect(terminal.visible()).toContain("运行中");
		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");
	});
});
