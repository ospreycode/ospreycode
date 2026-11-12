import { describe, expect, test } from "vitest";
import { textReply } from "./harness.js";
import { interactiveFixture } from "./interactive-fixture.js";
import { key, type TestTerminal } from "./interactive-terminal.js";

const fixture = interactiveFixture();

/** 比 20 行的屏幕长得多的一条回复：三十段，每段一行，段落之间空一行。 */
const paragraphs = Array.from(
	{ length: 30 },
	(_, index) => `第${String(index + 1).padStart(2, "0")}段`,
);
const longReply = () => textReply(paragraphs.join("\n\n"));

const short = { rows: 20 };

/** 屏幕最底下的一行：状态行。 */
function lastRow(terminal: TestTerminal): string {
	return terminal.visible().split("\n").at(-1) ?? "";
}

async function askForLongReply(terminal: TestTerminal): Promise<void> {
	await terminal.type("写三十段");
	await terminal.press(key.enter);
	await terminal.waitForVisible("— 完成");
}

describe("全屏模式", () => {
	test("默认占着备用缓冲区：对话比屏幕长时输入框和状态行留在底部，滚轮和翻页键回看之前的对话", async () => {
		await fixture.useModel(longReply);
		const { terminal } = await fixture.start(short);
		expect(terminal.alternate).toBe(true);
		await askForLongReply(terminal);

		// 屏幕只有终端那么高，跟着最新的内容；滚出去的开头不在终端上
		expect(terminal.text().split("\n")).toHaveLength(short.rows);
		expect(terminal.visible()).toContain("第30段");
		expect(terminal.text()).not.toContain("第01段");
		expect(terminal.visible()).toContain("Enter 发送");
		expect(lastRow(terminal)).toMatch(/^fake · 推理 \w+ · 沙盒 /);

		await terminal.wheel(-100);
		await terminal.waitForVisible("第01段");
		expect(terminal.visible()).toContain("› 写三十段");
		expect(terminal.visible()).not.toContain("第30段");
		expect(terminal.visible()).toContain("回到最新的内容");
		expect(terminal.visible()).toContain("Enter 发送");
		expect(lastRow(terminal)).toMatch(/^fake · 推理 \w+ · 沙盒 /);

		await terminal.wheel(100);
		await terminal.waitForVisible("第30段");
		await terminal.waitForGone("回到最新的内容");

		await terminal.press(key.pageUp);
		await terminal.waitForGone("第30段");
		await terminal.press(key.ctrlEnd);
		await terminal.waitForVisible("第30段");
	});

	test("对话区滚上去之后输入照常：打的字进输入框，提交之后回到最新的内容", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? longReply() : textReply("第二次的回复"),
		);
		const { terminal } = await fixture.start(short);
		await askForLongReply(terminal);
		await terminal.wheel(-100);
		await terminal.waitForVisible("第01段");

		await terminal.type("接着问");
		await terminal.waitForVisible("接着问");
		expect(terminal.visible()).toContain("第01段");
		await terminal.press(key.enter);
		await terminal.waitForVisible("第二次的回复");
		expect(server.requests).toHaveLength(2);
	});

	test("退出后回到主缓冲区：原来的终端内容还在，后面是这次会话的完整对话", async () => {
		await fixture.useModel(longReply);
		const { terminal } = await fixture.start({
			...short,
			before: "$ ospreycode\n",
		});
		await askForLongReply(terminal);

		await terminal.press(key.ctrlD);
		expect(await fixture.exitCode()).toBe(0);
		expect(terminal.alternate).toBe(false);
		const shown = terminal.text();
		expect(shown.startsWith("$ ospreycode\n")).toBe(true);
		const positions = ["› 写三十段", ...paragraphs, "— 完成"].map((fragment) =>
			shown.indexOf(fragment),
		);
		expect(positions).not.toContain(-1);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		for (const paragraph of paragraphs) {
			expect(shown.split(paragraph)).toHaveLength(2);
		}
	});
});

describe("主缓冲区模式", () => {
	test("--tui-mode regular：界面写在主缓冲区里，滚出屏幕的对话留在终端的滚动历史里", async () => {
		await fixture.useModel(longReply);
		const { terminal } = await fixture.start({ ...short, tuiMode: "regular" });
		expect(terminal.alternate).toBe(false);
		await askForLongReply(terminal);

		expect(terminal.visible()).not.toContain("第01段");
		expect(terminal.text()).toContain("第01段");
		expect(terminal.visible()).toContain("Enter 发送");
		expect(lastRow(terminal)).toMatch(/^fake · 推理 \w+ · 沙盒 /);
	});

	test('[ui] tui_mode = "regular" 和 --tui-mode regular 一样；启动参数优先于配置', async () => {
		await fixture.useModel(longReply, {
			extra: '[ui]\ntui_mode = "regular"\n',
		});
		const configured = await fixture.start(short);
		expect(configured.terminal.alternate).toBe(false);
		await askForLongReply(configured.terminal);
		expect(configured.terminal.text()).toContain("第01段");
		await configured.terminal.press(key.ctrlD);
		expect(await fixture.exitCode()).toBe(0);

		const overridden = await fixture.start({
			...short,
			tuiMode: "fullscreen",
		});
		expect(overridden.terminal.alternate).toBe(true);
	});
});
