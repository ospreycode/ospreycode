import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	fixtureServer,
	writeHookScript,
	writeHooks,
	writeMcpConfig,
	writeSkill,
} from "./extension-fixture.js";
import { shellCallReply, textReply } from "./harness.js";
import {
	interactiveFixture,
	selectFirstChoice,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";

const fixture = interactiveFixture();

/** 用户级配置一个本地 MCP server，标签是 `tools`。 */
function userServer(): void {
	writeMcpConfig(join(fixture.dirs.root, "mcp.json"), { tools: fixtureServer });
}

/** 权限规则放行 `tools` 的工具：测试看的是调用之后的事，不是工具调用的询问。 */
function allowTools(): void {
	const rules = join(fixture.dirs.root, "rules");
	mkdirSync(rules, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(rules, "mcp.toml"),
		'[[mcp_rules]]\nserver = "tools"\ndecision = "allow"\n',
	);
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
	toolCallsReply([{ name: `tools__${name}`, arguments: args }]);

/** 第 `index` 次模型请求的全文。 */
const requestText = (requests: unknown[], index: number) =>
	JSON.stringify(requests[index]);

describe("扩展的确认", () => {
	test("仓库自带的 skill 没确认时不启用，启动时提示；/extensions 里确认，/reload 之后模型看得到", async () => {
		writeSkill(
			join(fixture.dirs.workspace, ".agents", "skills"),
			"review",
			"审阅改动",
		);
		const server = await fixture.useModel(() => textReply("好的"));
		const { terminal } = await fixture.start();
		await terminal.waitFor("仓库自带的 skill review 还没有确认，没有启用");

		await terminal.type("/extensions confirm 1");
		await terminal.press(key.enter);
		await terminal.waitFor("先用 /extensions 列出扩展，再按序号引用");

		await terminal.type("/extensions");
		await terminal.press(key.enter);
		await terminal.waitFor("[1] skill review（仓库自带）  未确认");
		// 要确认的扩展连内容摘要一起列出来：确认的就是看到的这一份
		expect(terminal.text()).toContain("审阅改动");
		expect(terminal.text()).toContain("/extensions confirm N 确认");

		await terminal.type("/extensions confirm 1");
		await terminal.press(key.enter);
		await terminal.waitFor("已确认 review，/reload 之后生效");
		await terminal.type("/reload");
		await terminal.press(key.enter);
		await terminal.waitFor("已重新读取配置、权限规则、规则文件和扩展");

		await terminal.type("/extensions");
		await terminal.press(key.enter);
		await terminal.waitFor("[1] skill review（仓库自带）  已启用");
		await terminal.type("看看改动");
		await terminal.press(key.enter);
		await terminal.waitFor("好的");
		expect(requestText(server.requests, 0)).toContain("审阅改动");
	});

	test("/extensions 停用一个用户级的 MCP server：/reload 之后它的工具不再给模型", async () => {
		userServer();
		const server = await fixture.useModel(() => textReply("好的"));
		const { terminal } = await fixture.start();
		await terminal.type("/extensions");
		await terminal.press(key.enter);
		await terminal.waitFor(
			"[1] MCP server tools（用户级）  已启用 · 已连接，3 个工具",
		);
		await terminal.type("/extensions show 1");
		await terminal.press(key.enter);
		await terminal.waitFor(`位置：${join(fixture.dirs.root, "mcp.json")}`);

		await terminal.type("/extensions disable 1");
		await terminal.press(key.enter);
		await terminal.waitFor("已停用 tools，/reload 之后生效");
		await terminal.type("/reload");
		await terminal.press(key.enter);
		await terminal.waitFor("已重新读取配置");
		await terminal.type("/extensions");
		await terminal.press(key.enter);
		await terminal.waitFor("[1] MCP server tools（用户级）  已停用");

		await terminal.type("你好");
		await terminal.press(key.enter);
		await terminal.waitFor("好的");
		expect(requestText(server.requests, 0)).not.toContain("tools__echo");
	});

	test("/extensions 写得不对时给出用法", async () => {
		await fixture.useModel(() => textReply("好的"));
		const { terminal } = await fixture.start();
		await terminal.type("/extensions");
		await terminal.press(key.enter);
		await terminal.waitFor("没有找到扩展");
		await terminal.type("/extensions remove 1");
		await terminal.press(key.enter);
		await terminal.waitFor("/extensions 没有 remove 这个用法");
		await terminal.waitFor("/extensions show N");
	});
});

describe("MCP 工具", () => {
	test("调用 MCP 工具之前问用户：显示 server、工具和参数，批准后结果交给模型", async () => {
		userServer();
		const server = await fixture.useModel((call) =>
			call === 0 ? callTool("echo", { text: "你好 MCP" }) : textReply("做完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("打个招呼");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");
		const asked = terminal.visible();
		expect(asked).toContain("需要确认：调用 MCP 工具");
		expect(asked).toContain("tools 的 echo");
		expect(asked).toContain('参数：{"text":"你好 MCP"}');
		expect(server.requests).toHaveLength(1);

		await terminal.press(key.enter);
		await terminal.waitFor("做完了");
		expect(requestText(server.requests, 1)).toContain("你好 MCP");
	});

	test("server 的提问显示成表单：逐项填写、校验，核对之后才提交", async () => {
		userServer();
		allowTools();
		const server = await fixture.useModel((call) =>
			call === 0 ? callTool("ask") : textReply("做完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("部署");
		await terminal.press(key.enter);
		await terminal.waitForVisible(
			"MCP server tools 在提问：部署之前要几项信息",
		);
		// 面板出现时没有选中的选项：正要按下的 Enter 不会变成一次同意
		await terminal.press(key.enter);
		expect(terminal.visible()).not.toContain("→");
		await terminal.press(key.down);
		await terminal.waitForVisible("→ 填写");
		await terminal.press(key.enter);

		await terminal.waitForVisible("第 1/4 项：名字（必填）");
		expect(terminal.visible()).toContain("怎么称呼你");
		await terminal.press(key.enter);
		await terminal.waitForVisible("这一项必填");
		await terminal.type("小明");
		await terminal.press(key.enter);

		await terminal.waitForVisible("第 2/4 项：级别（必填）");
		await terminal.press(key.down);
		await terminal.waitForVisible("→ 高");
		await terminal.press(key.enter);

		await terminal.waitForVisible("第 3/4 项：数量（选填）");
		await terminal.type("9");
		await terminal.press(key.enter);
		await terminal.waitForVisible("不能大于 5");
		await terminal.press(key.backspace);
		await terminal.type("3");
		await terminal.press(key.enter);

		await terminal.waitForVisible("第 4/4 项：同意（选填）");
		await terminal.press(key.enter);

		await terminal.waitForVisible("要提交的内容：");
		const review = terminal.visible();
		expect(review).toContain("名字：小明");
		expect(review).toContain("级别：高");
		expect(review).toContain("数量：3");
		expect(review).toContain("同意：是");
		expect(review).toContain("→ 提交给 tools");
		// 核对之前什么都没有交给 server
		expect(server.requests).toHaveLength(1);
		await terminal.press(key.enter);

		await terminal.waitFor("做完了");
		expect(terminal.text()).toContain("MCP server tools 的提问：已回答");
		expect(requestText(server.requests, 1)).toContain(
			JSON.stringify(
				JSON.stringify({
					action: "accept",
					content: { name: "小明", level: "high", count: 3, agree: true },
				}),
			).slice(1, -1),
		);
	});

	test("提问可以拒绝；按 Esc 关掉是不回答", async () => {
		userServer();
		allowTools();
		const server = await fixture.useModel(
			(call) => [callTool("ask"), callTool("ask")][call] ?? textReply("做完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("部署");
		await terminal.press(key.enter);
		await terminal.waitForVisible("MCP server tools 在提问");
		await terminal.press(key.up);
		await terminal.waitForVisible("→ 拒绝");
		await terminal.press(key.enter);
		await terminal.waitFor("MCP server tools 的提问：已拒绝");

		await terminal.waitForVisible("MCP server tools 在提问");
		await terminal.press(key.escape);
		await terminal.waitFor("MCP server tools 的提问：没有回答");
		await terminal.waitFor("做完了");
		expect(requestText(server.requests, 1)).toContain("decline");
		expect(requestText(server.requests, 2)).toContain("cancel");
	});

	// 询问来自真实的沙盒：server 在自己的沙盒里连一个没放行的域名
	test.runIf(process.platform === "darwin")(
		"server 要访问没放行的域名时按 server 问用户，拒绝后连不上",
		async () => {
			userServer();
			allowTools();
			const server = await fixture.useModel((call) =>
				call === 0
					? callTool("fetch", { url: "http://denied.example.invalid:8080/" })
					: textReply("做完了"),
			);
			const { terminal } = await fixture.start({
				sandboxMode: "workspace-write",
			});
			await terminal.type("取一下");
			await terminal.press(key.enter);
			await terminal.waitForVisible("MCP server tools 访问网络", 20_000);
			const asked = terminal.visible();
			expect(asked).toContain("主机：denied.example.invalid:8080");
			expect(asked).toContain("先按 ↑↓ 选择，再按 Enter 确认 · Esc 拒绝");
			await terminal.press(key.up);
			await terminal.waitForVisible("→ 拒绝");
			expect(terminal.visible()).toContain(
				"这个 session 内允许这个 server 访问这个域名",
			);
			await terminal.press(key.enter);

			await terminal.waitFor(
				"MCP server tools 访问 denied.example.invalid：已拒绝",
			);
			await terminal.waitFor("做完了");
			expect(requestText(server.requests, 1)).toContain("status 403");
		},
	);
});

describe("hooks", () => {
	test("UserPromptSubmit 的 hook 拦下输入时显示原因，不发给模型，输入回到输入框；hook 给用户的话显示出来", async () => {
		writeHookScript(
			join(fixture.dirs.root, "hooks", "check.cjs"),
			'(input) => input.prompt.includes("机密") ? { decision: "block", reason: "输入里有机密" } : { system_message: "输入检查过了" }',
		);
		writeHooks(join(fixture.dirs.root, "hooks.json"), {
			UserPromptSubmit: [
				{
					hooks: [
						{
							command: "./check.cjs",
							onFailure: "continue",
							permissions: "read-only",
						},
					],
				},
			],
		});
		const server = await fixture.useModel(() => textReply("收到"));
		const { terminal } = await fixture.start();
		await terminal.type("这是机密");
		await terminal.press(key.enter);
		await terminal.waitFor("hook 拦下了这条输入：输入里有机密");
		expect(server.requests).toEqual([]);

		// 被拦下的输入回到输入框：删掉惹事的两个字再发
		await terminal.press(key.backspace);
		await terminal.press(key.backspace);
		await terminal.type("一句话");
		await terminal.press(key.enter);
		await terminal.waitFor("收到");
		expect(terminal.text()).toContain("hook（UserPromptSubmit）：输入检查过了");
		expect(server.requests).toHaveLength(1);
		expect(requestText(server.requests, 0)).toContain("这是一句话");
	});

	test("任务运行中发的 steering 被 hook 拦下时不排队，回到输入框", async () => {
		writeHookScript(
			join(fixture.dirs.root, "hooks", "check.cjs"),
			'(input) => input.prompt.includes("机密") ? { decision: "block", reason: "输入里有机密" } : {}',
		);
		writeHooks(join(fixture.dirs.root, "hooks.json"), {
			UserPromptSubmit: [
				{
					hooks: [
						{
							command: "./check.cjs",
							onFailure: "continue",
							permissions: "read-only",
						},
					],
				},
			],
		});
		const server = await fixture.useModel((call) =>
			call === 0 ? shellCallReply("sleep 3") : textReply("做完了"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("开始");
		await terminal.press(key.enter);
		await terminal.waitFor("sleep 3");
		await terminal.type("顺便看看机密");
		await terminal.press(key.enter);
		await terminal.waitFor("hook 拦下了这条输入：输入里有机密");
		await terminal.waitFor("做完了");
		await terminal.waitForVisible("顺便看看机密");
		expect(server.requests).toHaveLength(2);
		expect(JSON.stringify(server.requests)).not.toContain("顺便看看机密");
	});
});
