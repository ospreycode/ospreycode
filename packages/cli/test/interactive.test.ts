import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { errorReply, shellCallReply, textReply } from "./harness.js";
import {
	interactiveFixture,
	lastUserMessage,
	lastUserParts,
	selectFirstChoice,
	stalledReply,
	streamReply,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";

const fixture = interactiveFixture();

/** 1×1 像素的 PNG。 */
const pixel = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

describe("输入和回复", () => {
	test("输入一句话按 Enter，模型的回复显示在对话区，状态行写着模型、沙盒、审批和工作区", async () => {
		const server = await fixture.useModel(() => textReply("这是**回复**"));
		const { terminal } = await fixture.start();
		await terminal.type("你好");
		await terminal.press(key.enter);
		await terminal.waitFor("这是回复");
		await terminal.waitFor("完成");

		expect(terminal.text()).toContain("› 你好");
		expect(lastUserMessage(server.requests[0])).toContain("你好");
		expect(terminal.visible()).toMatch(
			/fake · 推理 \w+ · 沙盒 danger-full-access · 审批 on-request · .*workspace/,
		);
	});

	test("命令行里写的 PROMPT 作为第一条输入直接提交", async () => {
		const server = await fixture.useModel(() => textReply("收到"));
		const { terminal } = await fixture.start({ prompt: "第一条" });
		await terminal.waitFor("收到");

		expect(terminal.text()).toContain("› 第一条");
		expect(lastUserMessage(server.requests[0])).toContain("第一条");
	});

	test("Shift+Enter 之外的换行键 Ctrl+J 在输入框里换行，不提交", async () => {
		const server = await fixture.useModel(() => textReply("两行都到了"));
		const { terminal } = await fixture.start();
		await terminal.type("第一行");
		await terminal.press("\n");
		await terminal.type("第二行");
		expect(server.requests).toHaveLength(0);
		await terminal.press(key.enter);
		await terminal.waitFor("两行都到了");

		expect(lastUserMessage(server.requests[0])).toContain("第一行\n第二行");
	});
});

describe("对话区", () => {
	test("命令按做的事写标题：运行完写 Ran 和命令，下面是输出、退出码和耗时，没有输出时写明；任务结束显示结果、用时、用量和费用", async () => {
		await fixture.useModel(
			(call) =>
				[
					shellCallReply("echo from-shell; echo second >&2"),
					shellCallReply("exit 3"),
					textReply("做完了"),
				][call],
		);
		const { terminal } = await fixture.start();
		await terminal.type("干活");
		await terminal.press(key.enter);
		await terminal.waitFor("做完了");
		await terminal.waitFor("完成");

		const shown = terminal.text();
		expect(shown).toMatch(
			/^• Ran echo from-shell; echo second >&2\n {2}└ from-shell\n {4}second\n {4}✓ 退出码 0 · \d+\.\ds$/m,
		);
		expect(shown).toMatch(
			/^• Ran exit 3\n {2}└ （没有输出）\n {4}✗ 失败 · 退出码 3 · \d+\.\ds$/m,
		);
		// 模型的回复前面有圆点，和工具的块分得开
		expect(shown).toMatch(/^• 做完了$/m);
		expect(shown).toMatch(
			/^— 完成 · 用时 \d+\.\ds · 输入 30 · 输出 15 token · \$0\.\d+$/m,
		);
	});

	test("很长的命令输出留开头和末尾几行，中间写明省掉了多少行", async () => {
		await fixture.useModel((call) =>
			call === 0 ? shellCallReply("seq 1 40") : textReply("数完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("数数");
		await terminal.press(key.enter);
		await terminal.waitFor("数完了");

		expect(terminal.text()).toMatch(
			/^• Ran seq 1 40\n {2}└ 1\n {4}2\n {4}3\n {4}… \+32 行\n {4}36\n {4}37\n {4}38\n {4}39\n {4}40\n {4}✓ 退出码 0 · /m,
		);
	});

	test("连着的几次查看聚合成一组：运行中是 Exploring，做完是 Explored，连着读的文件合并成一行，不逐条占行", async () => {
		const { workspace } = fixture.dirs;
		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			writeFileSync(join(workspace, name), `// ${name}\n`);
		}
		const read = (name: string) => ({
			name: "read",
			arguments: { path: name },
		});
		const server = await fixture.useModel(
			(call) =>
				[
					toolCallsReply([read("a.ts")]),
					toolCallsReply([read(join(workspace, "b.ts"))]),
					toolCallsReply([
						{ name: "grep", arguments: { pattern: "//", glob: "*.ts" } },
					]),
					toolCallsReply([{ name: "ls", arguments: { path: "." } }]),
					toolCallsReply([read("c.ts")]),
					"hang" as const,
				][call] ?? textReply("好"),
			{ extra: "[tools]\ngrep = true\nls = true\n" },
		);
		const { terminal } = await fixture.start();
		await terminal.type("看一圈");
		await terminal.press(key.enter);
		await expect.poll(() => server.requests.length).toBe(6);
		// 任务还在进行：这一组还可能接着加调用。工作区里的绝对路径写成相对的
		await terminal.waitFor(
			/^• Exploring\n {2}└ Read a\.ts, b\.ts\n {4}Search \/\/\/\/ in \. \(\*\.ts\)\n {4}List \.\n {4}Read c\.ts$/m,
		);
		expect(terminal.text()).not.toContain("✓");

		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");
		expect(terminal.text()).toMatch(/^• Explored\n {2}└ Read a\.ts, b\.ts\n/m);
		expect(terminal.text()).not.toContain("Exploring");
	});

	test("文件改动的标题写新建还是修改、路径和增删的行数，下面是带行号和上下文的 diff；覆盖已有的文件只显示变了的行", async () => {
		const { workspace } = fixture.dirs;
		writeFileSync(join(workspace, "old.txt"), "甲\n乙\n丙\n");
		await fixture.useModel(
			(call) =>
				[
					toolCallsReply([{ name: "read", arguments: { path: "old.txt" } }]),
					toolCallsReply([
						{
							name: "edit",
							arguments: {
								path: "old.txt",
								edits: [{ old_text: "乙", new_text: "改过的乙" }],
							},
						},
					]),
					toolCallsReply([
						{
							name: "write",
							arguments: { path: "new.txt", content: "第一行\n第二行\n" },
						},
					]),
					toolCallsReply([
						{
							name: "write",
							arguments: { path: "old.txt", content: "甲\n改过的乙\n丁\n" },
						},
					]),
					textReply("改好了"),
				][call],
		);
		const { terminal } = await fixture.start();
		await terminal.type("改文件");
		await terminal.press(key.enter);
		await terminal.waitFor("改好了");

		const shown = terminal.text();
		expect(shown).toMatch(
			/^• Edited old\.txt \(\+1 -1\)\n {4}1 {3}甲\n {4}2 - 乙\n {4}2 \+ 改过的乙\n {4}3 {3}丙$/m,
		);
		expect(shown).toMatch(
			/^• Added new\.txt \(\+2 -0\)\n {4}1 \+ 第一行\n {4}2 \+ 第二行$/m,
		);
		// 用 write 覆盖已有的文件：不是整份标成新增
		expect(shown).toMatch(
			/^• Edited old\.txt \(\+1 -1\)\n {4}1 {3}甲\n {4}2 {3}改过的乙\n {4}3 - 丙\n {4}3 \+ 丁$/m,
		);
		expect(readFileSync(join(workspace, "old.txt"), "utf8")).toBe(
			"甲\n改过的乙\n丁\n",
		);
		expect(existsSync(join(workspace, "new.txt"))).toBe(true);
	});

	test("[tools] 打开的 grep 和 ls：调用显示搜索的模式、路径和 glob，ls 没写参数时列的是工作区；失败的后面写原因", async () => {
		const { workspace } = fixture.dirs;
		mkdirSync(join(workspace, "src"));
		writeFileSync(
			join(workspace, "src", "main.ts"),
			"export const answer = 42;\n",
		);
		const server = await fixture.useModel(
			(call) =>
				[
					toolCallsReply([
						{
							name: "grep",
							arguments: {
								pattern: "answer = \\d+",
								path: "src",
								glob: "*.ts",
							},
						},
					]),
					toolCallsReply([{ name: "ls", arguments: {} }]),
					toolCallsReply([
						{
							name: "grep",
							arguments: {
								pattern: "answer",
								path: "missing",
								ignore_case: true,
							},
						},
					]),
					textReply("找到了"),
				][call],
			{ extra: "[tools]\ngrep = true\nls = true\n" },
		);
		const { terminal } = await fixture.start();
		await terminal.type("找一找");
		await terminal.press(key.enter);
		await terminal.waitFor("找到了");
		await terminal.waitFor("完成");

		const shown = terminal.text();
		expect(shown).toMatch(
			/^• Explored\n {2}└ Search \/answer = \\d\+\/ in src \(\*\.ts\)\n {4}List \.\n {4}Search \/answer\/i in missing ✗ ENOENT: no such file or directory/m,
		);
		// 结果交回了模型
		const last = JSON.stringify(server.requests.at(-1));
		expect(last).toContain("src/main.ts:1:export const answer = 42;");
		expect(last).toContain("src/");
	});

	test("模型服务报错：原因显示在对话区，任务以失败结束，会话保留", async () => {
		const server = await fixture.useModel((call) =>
			call === 0
				? errorReply(400, "bad request from fake")
				: textReply("这次好了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("第一次");
		await terminal.press(key.enter);
		await terminal.waitFor("— 失败");
		expect(terminal.text()).toContain("bad request from fake");

		await terminal.type("第二次");
		await terminal.press(key.enter);
		await terminal.waitFor("这次好了");
		expect(server.requests).toHaveLength(2);
	});

	const reasoning = {
		extra: '\n[models.fake.compat]\nreasoning_field = "reasoning_content"\n',
	};
	const thinking = () =>
		streamReply([
			{ role: "assistant", reasoning_content: "先想一想" },
			{ content: "想好了" },
		]);

	test("模型的推理内容显示在回复前面", async () => {
		await fixture.useModel(thinking, reasoning);
		const { terminal } = await fixture.start();
		await terminal.type("想");
		await terminal.press(key.enter);
		await terminal.waitFor("想好了");

		expect(terminal.text()).toMatch(/^ {2}先想一想\n• 想好了$/m);
	});

	test("[ui] show_reasoning = false 时不显示推理内容", async () => {
		await fixture.useModel(thinking, {
			extra: `${reasoning.extra}\n[ui]\nshow_reasoning = false\n`,
		});
		const { terminal } = await fixture.start();
		await terminal.type("想");
		await terminal.press(key.enter);
		await terminal.waitFor("想好了");
		await terminal.waitFor("完成");

		expect(terminal.text()).not.toContain("先想一想");
	});

	test("任务运行时输入框上面是活动行：模型在想的时候写推理内容里最近的标题，不显示推理内容时也写；秒表在走，任务结束就撤掉", async () => {
		await fixture.useModel(
			(call) =>
				call === 0
					? stalledReply([
							{
								role: "assistant",
								reasoning_content: "**查资料**\n\n先看看有哪些文件",
							},
						])
					: textReply("好"),
			{ extra: `${reasoning.extra}\n[ui]\nshow_reasoning = false\n` },
		);
		const { terminal } = await fixture.start();
		await terminal.type("干活");
		await terminal.press(key.enter);
		await terminal.waitFor(/^. 查资料 \(\d+s · Ctrl\+C 取消\)$/m);
		expect(terminal.visible()).toContain(
			"Enter 插入当前任务 · Alt+Enter 排到之后 · Alt+↑ 管理排队的输入",
		);
		expect(terminal.text()).not.toContain("先看看有哪些文件");
		await terminal.waitFor(/查资料 \([1-9]\d*s · Ctrl\+C 取消\)/);

		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.visible()).not.toContain("Ctrl+C 取消");
		// 任务结束的那一行写着实际用了多久
		expect(terminal.text()).toMatch(/^— 已取消 · 用时 \d+\.\ds · /m);
	});

	test("工具在运行时活动行写它在做的事，后面是还在运行的后台命令的个数；模型还没有动静时写工作中", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					"hang" as const,
					shellCallReply("sleep 58.13", { background: true }),
					shellCallReply("sleep 57.29"),
				][call] ?? textReply("好"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("第一件事");
		await terminal.press(key.enter);
		await terminal.waitFor(/^. 工作中 \(\d+s · Ctrl\+C 取消\)$/m);
		await expect.poll(() => server.requests.length).toBe(1);
		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");

		await terminal.type("第二件事");
		await terminal.press(key.enter);
		await terminal.waitFor(
			/^. Running sleep 57\.29 \(\d+s · Ctrl\+C 取消\) · 1 条后台命令在运行，\/bg 查看$/m,
		);
		// 对话区里这条命令的标题也是进行中的写法，后台的那条已经启动
		expect(terminal.text()).toMatch(/^• Running sleep 57\.29$/m);
		expect(terminal.text()).toMatch(
			/^• Started sleep 58\.13\n {2}└ ↻ 转入后台运行：\S+$/m,
		);
		await terminal.press(key.ctrlC);
		await terminal.waitFor(/^• Ran sleep 57\.29\n {2}└ ✗ 已取消 · /m);
	});

	test("后台命令的开始、结束和通知都显示出来，通知交给模型处理", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					shellCallReply("sleep 0.3; echo bg-done", { background: true }),
					textReply("后台启动了"),
					textReply("收到通知了"),
				][call],
		);
		const { terminal } = await fixture.start();
		await terminal.type("启动");
		await terminal.press(key.enter);
		await terminal.waitFor("收到通知了");

		const shown = terminal.text();
		expect(shown).toMatch(
			/^• Started sleep 0\.3; echo bg-done\n {2}└ ↻ 转入后台运行：\S+$/m,
		);
		expect(shown).toMatch(/· 后台命令 \S+ 开始运行：sleep 0\.3; echo bg-done/);
		expect(shown).toMatch(/· 后台命令 \S+ 结束了（退出码 0）/);
		expect(shown).toMatch(/· 后台通知：.*exited with code 0/);
		expect(shown).toContain("› （后台通知）模型开始处理上面的通知");
		expect(lastUserMessage(server.requests[2])).toContain("exited with code 0");
	});
});

describe("agent 进程异常退出", () => {
	/** 登记表里的 agent 进程。 */
	function agentPid(): number {
		const { processes } = JSON.parse(
			readFileSync(join(fixture.dirs.root, "data", "processes.json"), "utf8"),
		) as { processes: { pid: number; kind: string }[] };
		const agent = processes.find(({ kind }) => kind === "agent");
		if (agent === undefined) throw new Error("没有登记着的 agent 进程");
		return agent.pid;
	}

	/** 任务运行到等模型回复时杀掉 agent 进程，等这个任务以失败结束。 */
	async function killDuringTask(
		terminal: Awaited<ReturnType<typeof fixture.start>>["terminal"],
		requests: readonly unknown[],
		round: number,
	): Promise<void> {
		await terminal.type(`第 ${round} 次`);
		await terminal.press(key.enter);
		await vi.waitFor(() => expect(requests).toHaveLength(round));
		process.kill(agentPid(), "SIGKILL");
		await vi.waitFor(() =>
			expect(terminal.text().split("— 失败")).toHaveLength(round + 1),
		);
	}

	const reason = "agent 进程意外退出";

	test("任务中途 agent 进程被杀：原因在对话区只显示一行，会话保留，下一条输入照常得到回复", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? "hang" : textReply("接着来"),
		);
		const { terminal } = await fixture.start();
		await killDuringTask(terminal, server.requests, 1);

		await terminal.type("继续");
		await terminal.press(key.enter);
		await terminal.waitFor("接着来");
		expect(terminal.text().split(reason)).toHaveLength(2);
		expect(terminal.text()).toContain(`— 失败：${reason}`);
	});

	test("连续三次在任务中途被杀：每次的原因各显示一行，session 关闭的原因只显示一行，退出码 1", async () => {
		const server = await fixture.useModel(() => "hang");
		const { terminal } = await fixture.start();
		for (const round of [1, 2, 3]) {
			await killDuringTask(terminal, server.requests, round);
		}

		expect(await fixture.exitCode()).toBe(1);
		expect(terminal.text().split(reason)).toHaveLength(4);
		expect(terminal.text().split("session 已关闭")).toHaveLength(2);
		expect(terminal.text()).toContain(
			"agent 进程连续 3 次异常退出，中间没有正常结束的 task，session 已关闭",
		);
	});

	test("agent 进程退出前有输出：原因显示在任务结束的那一行，输出另起一行，原因不重复", async () => {
		await fixture.useModel(() => textReply("好的"));
		const { terminal } = await fixture.start({
			agentEntry: fileURLToPath(
				new URL("./fixtures/crashing-agent.mjs", import.meta.url),
			),
		});
		await terminal.type("跑起来");
		await terminal.press(key.enter);

		await terminal.waitFor("✗ boom from the agent");
		expect(terminal.text()).toContain(`— 失败：${reason}（退出码 7）`);
		expect(terminal.text().split(reason)).toHaveLength(2);
	});

	test("空闲时 agent 进程被杀：显示一行警告，下一条输入照常得到回复", async () => {
		await fixture.useModel(() => textReply("好的"));
		const { terminal } = await fixture.start();
		await terminal.type("第一条");
		await terminal.press(key.enter);
		await terminal.waitFor("好的");
		await terminal.waitFor("— 完成");

		process.kill(agentPid(), "SIGKILL");
		await terminal.waitFor(`! ${reason}`);
		await terminal.type("第二条");
		await terminal.press(key.enter);
		await vi.waitFor(() =>
			expect(terminal.text().split("— 完成")).toHaveLength(3),
		);
		expect(terminal.text().split(reason)).toHaveLength(2);
	});
});

describe("窄终端", () => {
	test("30 列宽的终端里长的内容折行或截断，界面照常工作", async () => {
		await fixture.useModel(
			(call) =>
				[
					shellCallReply(
						"echo 一行很长很长很长很长很长很长很长很长很长很长很长很长的输出 with-some-ascii-words-too",
					),
					textReply(
						"这是一段比终端宽得多的回复，里面有中文也有 some English words，要折成好几行才放得下。",
					),
				][call],
		);
		const { terminal } = await fixture.start({ columns: 30, rows: 20 });
		await terminal.type("在很窄的终端里输入一句比一行长的话看看会怎样");
		await terminal.press(key.enter);
		await terminal.waitFor("才放得下");
		await terminal.waitFor("完成");

		for (const line of terminal.text().split("\n")) {
			expect(visibleWidth(line), line).toBeLessThanOrEqual(30);
		}
		await terminal.type("/quit");
		await terminal.press(key.enter);
		expect(await fixture.exitCode()).toBe(0);
	});
});

describe("预算", () => {
	const oneRequest = { extra: "\n[budget]\nmax_requests = 1\n" };
	const script = (call: number) =>
		call === 0 ? shellCallReply("echo hi") : textReply("接着做完了");

	test("超出预算时询问：显示上限和已用的量，追加额度后任务接着做", async () => {
		const server = await fixture.useModel(script, oneRequest);
		const { terminal } = await fixture.start();
		await terminal.type("干活");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "追加额度，接着做");
		expect(terminal.visible()).toContain("需要确认：超出预算");
		expect(terminal.visible()).toContain("模型请求到了上限 1 次（已用 1 次）");
		expect(server.requests).toHaveLength(1);

		await terminal.press(key.enter);
		await terminal.waitFor("接着做完了");
		await terminal.waitFor("— 完成");
	});

	test("超出预算时选择停止：任务以超出预算结束", async () => {
		const server = await fixture.useModel(script, oneRequest);
		const { terminal } = await fixture.start();
		await terminal.type("干活");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "追加额度，接着做");

		await terminal.press(key.down);
		await terminal.waitForVisible("→ 停止这个任务");
		await terminal.press(key.enter);
		await terminal.waitFor("— 超出预算（模型请求次数），任务已停止");
		expect(server.requests).toHaveLength(1);
	});
});

describe("@ 提及和图片", () => {
	test("提及存在的文件：模型收到文件的内容；不存在的 @xxx 原样是文字", async () => {
		writeFileSync(
			join(fixture.dirs.workspace, "notes.txt"),
			"文件里的暗号 4417\n",
		);
		const server = await fixture.useModel(() => textReply("看到了"));
		const { terminal } = await fixture.start();
		await terminal.type("读 @notes.txt 和 @nothing-here");
		await terminal.press(key.enter);
		await terminal.waitFor("看到了");

		const sent = lastUserMessage(server.requests[0]);
		expect(sent).toContain("文件里的暗号 4417");
		expect(sent).toContain("@nothing-here");
	});

	test("输入 @ 列出工作区里的文件，Tab 补全选中的路径", async () => {
		writeFileSync(join(fixture.dirs.workspace, "alpha.md"), "甲\n");
		writeFileSync(join(fixture.dirs.workspace, "beta.md"), "乙的内容 9052\n");
		const server = await fixture.useModel(() => textReply("读过了"));
		const { terminal } = await fixture.start();
		await terminal.type("看 @b");
		await terminal.waitForVisible("beta.md");
		expect(terminal.visible()).not.toContain("alpha.md");
		await terminal.press(key.tab, key.enter);
		await terminal.waitFor("读过了");

		expect(terminal.text()).toContain("› 看 @beta.md");
		expect(lastUserMessage(server.requests[0])).toContain("乙的内容 9052");
	});

	test("Ctrl+V 把剪贴板里的图片放进输入，占位标记被删掉的图片不提交", async () => {
		const server = await fixture.useModel(() => textReply("图收到了"), {
			fields: "images = true",
		});
		const { terminal } = await fixture.start({ clipboardImage: pixel });
		await terminal.press(key.ctrlV);
		await terminal.waitForVisible("[图片 #1]");
		await terminal.press(key.ctrlV);
		await terminal.waitForVisible("[图片 #2]");
		// 删掉第二个占位标记
		await terminal.press(...Array<string>(7).fill(key.backspace));
		await terminal.type(" 这是什么");
		await terminal.press(key.enter);
		await terminal.waitFor("图收到了");

		expect(terminal.text()).toContain("› [图片] 这是什么");
		expect(lastUserMessage(server.requests[0])).toContain("这是什么");
		expect(
			lastUserParts(server.requests[0]).filter(
				(part) => part.type === "image_url",
			),
		).toHaveLength(1);
	});

	test("拖进终端的图片路径换成提及，由 runtime 去读这个文件", async () => {
		const picture = join(fixture.dirs.home, "pic.png");
		writeFileSync(picture, pixel);
		const server = await fixture.useModel(() => textReply("收到了"));
		const { terminal } = await fixture.start();
		// 终端把拖进来的文件当作一次粘贴送来
		await terminal.paste(picture);
		await terminal.waitForVisible(`@${picture}`);
		await terminal.type("这是什么");
		await terminal.press(key.enter);
		await terminal.waitFor("收到了");

		expect(terminal.text()).toContain(`› @${picture} 这是什么`);
		// 模型收到的是展开后的提及，不是 @ 开头的一段文字
		const sent = lastUserMessage(server.requests[0]);
		expect(sent).toContain(`<file path="${picture}">`);
		expect(sent).not.toContain(`@${picture}`);
	});

	test("粘贴的不是图片路径时照常粘贴成文字", async () => {
		const server = await fixture.useModel(() => textReply("收到了"));
		const { terminal } = await fixture.start();
		await terminal.paste("/no/such/picture.png 和别的字");
		await terminal.press(key.enter);
		await terminal.waitFor("收到了");

		expect(lastUserMessage(server.requests[0])).toContain(
			"/no/such/picture.png 和别的字",
		);
	});

	test("剪贴板里的内容不是支持的图片格式时不粘贴，并说明原因", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start({
			clipboardImage: Buffer.from("BM 开头的位图"),
		});
		await terminal.press(key.ctrlV);
		await terminal.waitFor(
			"剪贴板里的图片不是 PNG、JPEG、GIF 或 WebP，没有粘贴",
		);

		expect(terminal.visible()).not.toContain("图片 #");
	});

	test("剪贴板里没有图片时 Ctrl+V 什么都不做", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("abc");
		await terminal.press(key.ctrlV);
		await terminal.type("def");
		await terminal.waitForVisible("abcdef");

		expect(terminal.visible()).not.toContain("图片 #");
	});
});

describe("运行中的输入", () => {
	test("任务运行时 Enter 排成 steering、Alt+Enter 排成 follow-up，两个列表分开显示，可以取回到输入框", async () => {
		const server = await fixture.useModel(() => "hang");
		const { terminal } = await fixture.start();
		await terminal.type("任务一");
		await terminal.press(key.enter);
		await terminal.waitForVisible("Ctrl+C 取消");
		await expect.poll(() => server.requests.length).toBe(1);

		await terminal.type("插进去的话");
		await terminal.press(key.enter);
		await terminal.type("之后再做的事");
		await terminal.press(key.altEnter);
		await terminal.waitForVisible("排在之后（follow-up）");
		const queued = terminal.visible();
		expect(queued).toMatch(/等待插入当前任务（steering）\n\s+1\. 插进去的话/);
		expect(queued).toMatch(/排在之后（follow-up）\n\s+1\. 之后再做的事/);
		// 都还排着，没有发给模型
		expect(server.requests).toHaveLength(1);

		// 打开列表，选中 follow-up 那一条，取回到输入框
		await terminal.press(key.altUp);
		await terminal.waitForVisible("排队的输入");
		await terminal.press(key.down, key.enter);
		await terminal.waitForVisible("Alt+Enter 排到之后");
		const after = terminal.visible();
		expect(after).not.toContain("排在之后（follow-up）");
		expect(after).toContain("1. 插进去的话");
		// 取回的内容在输入框里：两条边框之间
		expect(after).toMatch(/─+\n之后再做的事\s*\n─+/);
	});

	test("列表里的输入可以调整顺序和删除", async () => {
		await fixture.useModel(() => "hang");
		const { terminal } = await fixture.start();
		await terminal.type("任务一");
		await terminal.press(key.enter);
		await terminal.waitForVisible("Ctrl+C 取消");
		for (const text of ["甲", "乙", "丙"]) {
			await terminal.type(text);
			await terminal.press(key.altEnter);
		}
		await terminal.waitForVisible("3. 丙");

		await terminal.press(key.altUp);
		await terminal.waitForVisible("排队的输入");
		// 选中第三条，上移一位，再删掉现在的第三条
		await terminal.press(key.down, key.down, key.shiftUp);
		await terminal.waitForVisible("2. 丙");
		expect(terminal.visible()).toMatch(/1\. 甲\n\s+2\. 丙\n\s+3\. 乙/);
		await terminal.press(key.down, "d");
		await terminal.waitForVisible("→ follow-up  丙");

		expect(terminal.visible()).toMatch(/1\. 甲\n\s+2\. 丙\n(?!\s+3\.)/);
	});

	test("任务结束时还没插入的 steering 放回输入框，不自动发送", async () => {
		const server = await fixture.useModel(() => "hang");
		const { terminal } = await fixture.start();
		await terminal.type("任务一");
		await terminal.press(key.enter);
		await expect.poll(() => server.requests.length).toBe(1);
		await terminal.type("没来得及插入");
		await terminal.press(key.enter);
		await terminal.waitForVisible("1. 没来得及插入");

		// 模型服务断开，任务失败：steering 没有机会插入
		await fixture.dropModel();
		await terminal.waitFor("— 失败");

		expect(terminal.visible()).not.toContain("等待插入当前任务");
		expect(terminal.visible()).toMatch(/─+\n没来得及插入\s*\n─+/);
		expect(terminal.text()).not.toContain("› 没来得及插入");
	});

	test("任务被取消后 follow-up 列表暂停并有提示，在列表里按 R 继续", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? "hang" : textReply("排着的事做完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("任务一");
		await terminal.press(key.enter);
		await expect.poll(() => server.requests.length).toBe(1);
		await terminal.type("排着的事");
		await terminal.press(key.altEnter);
		await terminal.waitForVisible("1. 排着的事");

		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");
		await terminal.waitForVisible("已暂停");
		expect(server.requests).toHaveLength(1);

		await terminal.press(key.altUp);
		await terminal.waitForVisible("排队的输入");
		await terminal.press("r");
		await terminal.waitFor("排着的事做完了");
		await terminal.waitForVisible("Enter 发送");

		expect(terminal.text()).toContain("› （follow-up）排着的事");
		expect(terminal.visible()).not.toContain("已暂停");
		expect(lastUserMessage(server.requests[1])).toContain("排着的事");
	});
});

describe("取消和退出", () => {
	test("Ctrl+C 取消运行中的任务，会话保留；空闲时再按两次才退出", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? "hang" : textReply("第二个任务做完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("跑起来");
		await terminal.press(key.enter);
		await expect.poll(() => server.requests.length).toBe(1);

		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");
		// 会话还在：接着做下一个任务
		await terminal.type("再来一个");
		await terminal.press(key.enter);
		await terminal.waitFor("第二个任务做完了");
		expect(server.requests).toHaveLength(2);
		// 回复的文字先于任务结束显示出来：这时按 Ctrl+C 取消的是还没结束的任务，要等到空闲
		await terminal.waitForVisible("Enter 发送");

		await terminal.press(key.ctrlC);
		await terminal.waitForVisible("再按一次 Ctrl+C 退出");
		await terminal.press(key.ctrlC);
		expect(await fixture.exitCode()).toBe(0);
	});

	test("输入框里有内容时 Ctrl+C 先清空它；按了别的键之后要重新按两次", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("写了一半");
		await terminal.waitForVisible("写了一半");
		await terminal.press(key.ctrlC);
		await terminal.waitForGone("写了一半");
		// 清空输入不算"再按一次退出"的第一次
		expect(terminal.visible()).toContain("Enter 发送");

		await terminal.press(key.ctrlC);
		await terminal.waitForVisible("再按一次 Ctrl+C 退出");
		await terminal.type("x");
		await terminal.waitForVisible("Enter 发送");
		await terminal.press(key.backspace, key.ctrlC);
		await terminal.waitForVisible("再按一次 Ctrl+C 退出");
		await terminal.press(key.ctrlC);
		expect(await fixture.exitCode()).toBe(0);
	});

	test("/quit 关闭 session，退出码 0", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("/quit");
		await terminal.press(key.enter);

		expect(await fixture.exitCode()).toBe(0);
	});

	test("空输入框上 Ctrl+D 直接退出，退出码 0", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.press(key.ctrlD);

		expect(await fixture.exitCode()).toBe(0);
	});

	test("收到 SIGTERM 关闭 session，退出码 143；SIGINT 是 130", async () => {
		await fixture.useModel(() => "hang");
		const first = await fixture.start();
		await first.terminal.type("跑起来");
		await first.terminal.press(key.enter);
		await first.terminal.waitForVisible("Ctrl+C 取消");
		first.signal("SIGTERM");
		expect(await fixture.exitCode()).toBe(143);

		const second = await fixture.start();
		second.signal("SIGINT");
		expect(await fixture.exitCode()).toBe(130);
	});
});
