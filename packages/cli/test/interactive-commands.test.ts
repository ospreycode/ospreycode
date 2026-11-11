import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHost } from "@ospreycode/agent-host";
import { describe, expect, test } from "vitest";
import { cycle, usableModels } from "../src/interactive/models.js";
import { shellCallReply, textReply } from "./harness.js";
import {
	interactiveFixture,
	lastUserMessage,
	requestedModel,
} from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";

const fixture = interactiveFixture();

/** 三档推理强度，发给服务的写法和档位同名。 */
const efforts = `
[models.fake.thinking_level_map]
low = "low"
medium = "medium"
high = "high"
`;

describe("会话内命令", () => {
	test("输入 / 列出会话内命令，接着输入的字母筛选列表", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("/");
		await terminal.waitForVisible("(1/17)");
		// 列表一次显示五条
		for (const name of ["sandbox", "approval", "model", "effort", "bg"]) {
			expect(terminal.visible()).toMatch(
				new RegExp(`^(→|\\s) ${name}\\s`, "m"),
			);
		}

		await terminal.type("c");
		await terminal.waitForVisible("→ cache-clear");
		expect(terminal.visible()).not.toContain("sandbox ");
	});

	test("补全列表开着时，后面的字符和 Enter 成批到达：提交的是输入的命令，不套用还没刷新的列表里选中的那一项", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("/");
		await terminal.waitForVisible("→ sandbox");

		await terminal.pressTogether(..."approval", key.enter);
		await terminal.waitFor(/审批策略：on-request$/m);
		expect(terminal.text()).not.toContain("这个命令");

		// Tab 也一样：列表过时了就不补全，输入的内容原样留着
		await terminal.type("/");
		await terminal.waitForVisible("→ sandbox");
		await terminal.pressTogether(..."approval", key.tab);
		await terminal.press(key.enter);
		await terminal.waitFor(/(审批策略：on-request\n[\s\S]*){2}/);
		expect(terminal.text()).not.toContain("这个命令");
	});

	test("/approval 换审批策略，状态行跟着变；不带参数时显示当前的策略", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("/approval never");
		await terminal.press(key.enter);
		await terminal.waitFor("审批策略：on-request → never");
		expect(terminal.visible()).toContain(" · 审批 never · ");

		await terminal.type("/approval");
		await terminal.press(key.enter);
		await terminal.waitFor(/审批策略：never$/m);
	});

	test("/model 换模型：状态行跟着变，下一次模型请求用新的模型", async () => {
		const server = await fixture.useModel(
			(call) => textReply(call === 0 ? "第一次回复" : "换过了"),
			{ models: ["other"] },
		);
		const { terminal } = await fixture.start();
		await terminal.type("你好");
		await terminal.press(key.enter);
		await terminal.waitFor("第一次回复");
		await terminal.waitFor("完成");

		await terminal.type("/model other");
		await terminal.press(key.enter);
		await terminal.waitForVisible("other · 推理");

		await terminal.type("再来");
		await terminal.press(key.enter);
		await terminal.waitFor("换过了");
		expect(server.requests.map(requestedModel)).toEqual([
			"fake-model",
			"other-model",
		]);
		expect(terminal.text()).toContain(
			"从这次模型请求起使用 other（之前是 fake）",
		);
	});

	test("/model 不带参数时弹出模型列表，当前的模型选中着，Esc 关掉列表不换模型", async () => {
		await fixture.useModel(() => textReply("好"), { models: ["other"] });
		const { terminal } = await fixture.start();
		await terminal.type("/model");
		await terminal.press(key.enter);
		await terminal.waitForVisible("切换模型");
		expect(terminal.visible()).toContain("→ fake");

		await terminal.press(key.escape);
		await terminal.waitForVisible("Enter 发送");
		expect(terminal.visible()).toContain("fake · 推理");
	});

	test("/effort 换推理强度：状态行跟着变，下一次模型请求带上新的强度", async () => {
		const server = await fixture.useModel(() => textReply("想过了"), {
			extra: efforts,
		});
		const { terminal } = await fixture.start();
		await terminal.type("/effort high");
		await terminal.press(key.enter);
		await terminal.waitForVisible(" · 推理 high · ");

		await terminal.type("你好");
		await terminal.press(key.enter);
		await terminal.waitFor("想过了");
		expect(server.requests[0]).toMatchObject({ reasoning_effort: "high" });
	});

	test("状态行显示 session 当前生效的设置：配置文件改了、还没 /reload 时，换推理强度不带出没生效的改动", async () => {
		const server = await fixture.useModel(() => textReply("好"), {
			extra: efforts,
		});
		const { terminal } = await fixture.start();
		expect(terminal.visible()).toContain(" · 审批 on-request · ");

		fixture.dirs.writeConfig(
			`approval_policy = "never"\n${server.config}\n${efforts}`,
		);
		await terminal.type("/effort high");
		await terminal.press(key.enter);
		await terminal.waitForVisible(" · 推理 high · ");
		expect(terminal.visible()).toContain(" · 审批 on-request · ");

		await terminal.type("/reload");
		await terminal.press(key.enter);
		await terminal.waitForVisible(" · 审批 never · ");
		expect(terminal.visible()).toContain(" · 推理 high · ");
	});

	test("Shift+Tab 在当前模型支持的推理强度之间循环", async () => {
		await fixture.useModel(() => textReply("好"), { extra: efforts });
		const { terminal } = await fixture.start();
		expect(terminal.visible()).toContain(" · 推理 medium · ");

		await terminal.press(key.shiftTab);
		await terminal.waitForVisible(" · 推理 high · ");
		await terminal.press(key.shiftTab);
		await terminal.waitForVisible(" · 推理 low · ");
		await terminal.press(key.shiftTab);
		await terminal.waitForVisible(" · 推理 medium · ");
	});

	test("Ctrl+P 换到清单里的下一个模型，Shift+Ctrl+P 换回上一个", async () => {
		await fixture.useModel(() => textReply("好"), { models: ["other"] });
		// 每个服务都从凭据文件取凭据：切换时不用去读系统凭据库
		const { models } = createHost({
			root: fixture.dirs.root,
			env: fixture.dirs.env,
		}).resolveConfig({
			workspace: fixture.dirs.workspace,
			sandboxMode: "danger-full-access",
		});
		const priced = models
			.filter((model) => model.price !== undefined)
			.map((model) => model.id);
		const next = priced[(priced.indexOf("fake") + 1) % priced.length];
		const { terminal } = await fixture.start({
			credentialServices: models.map((model) => model.service),
		});

		await terminal.press(key.ctrlP);
		await terminal.waitForVisible(`${next} · 推理`);
		expect(terminal.text()).toContain(`模型换成 ${next}`);
		await terminal.press(key.shiftCtrlP);
		await terminal.waitForVisible("fake · 推理");
	});

	// 界面上按 Ctrl+P 时凭据的来源要问系统凭据库，测试不碰它：这里直接给出各个服务的凭据状态
	test("循环切换只在服务有凭据的模型之间进行；开着费用上限时还要有价格", async () => {
		const unpriced = `
[models.unpriced]
protocol = "openai.chat"
service = "fake"
base_url = "http://127.0.0.1:1/v1"
model = "unpriced-model"
context_window = 100000
max_output_tokens = 4000
`;
		await fixture.useModel(() => textReply("好"), {
			models: ["other"],
			extra: unpriced,
		});
		const host = createHost({ root: fixture.dirs.root, env: fixture.dirs.env });
		const usable = () => {
			const config = host.resolveConfig({
				workspace: fixture.dirs.workspace,
				sandboxMode: "danger-full-access",
			});
			// 只有 fake 这个服务有凭据
			const statuses = [
				...new Set(config.models.map((model) => model.service)),
			].map((id) =>
				id === "fake" ? { id, source: "startup" as const } : { id },
			);
			return usableModels(config, statuses).map((model) => model.id);
		};
		expect(usable()).toEqual(["fake", "other"]);
		expect(cycle(usable(), "fake", 1)).toBe("other");
		expect(cycle(usable(), "other", 1)).toBe("fake");
		expect(cycle(usable(), "fake", -1)).toBe("other");
		expect(cycle(["fake"], "fake", 1)).toBeUndefined();

		fixture.configure({
			models: ["other"],
			extra: `${unpriced}\n[budget]\nmax_cost_usd = "none"\n`,
		});
		expect(usable()).toEqual(["fake", "other", "unpriced"]);
	});

	test("/reload 重新读取配置：改过的默认模型从下一个任务起生效", async () => {
		const server = await fixture.useModel(() => textReply("读过了"), {
			models: ["other"],
		});
		const { terminal } = await fixture.start();
		expect(terminal.visible()).toContain("fake · 推理");

		fixture.configure({ models: ["other"], selected: "other" });
		await terminal.type("/reload");
		await terminal.press(key.enter);
		await terminal.waitFor("已重新读取配置");
		expect(terminal.visible()).toContain("other · 推理");

		await terminal.type("你好");
		await terminal.press(key.enter);
		await terminal.waitFor("读过了");
		expect(requestedModel(server.requests[0])).toBe("other-model");
	});

	test("/bg 列出在运行的后台命令，选中的那条被停掉", async () => {
		const marker = join(fixture.dirs.workspace, "started");
		await fixture.useModel((call) =>
			call === 0
				? shellCallReply(`touch '${marker}'; sleep 600`, { background: true })
				: textReply("后台跑着"),
		);
		const { terminal } = await fixture.start();
		await terminal.type("启动");
		await terminal.press(key.enter);
		await terminal.waitFor("后台跑着");
		await terminal.waitFor("完成");
		await expect.poll(() => existsSync(marker)).toBe(true);

		await terminal.type("/bg");
		await terminal.press(key.enter);
		await terminal.waitForVisible("后台命令");
		expect(terminal.visible()).toContain("sleep 600");
		await terminal.press(key.enter);
		await terminal.waitFor("已停止后台命令");

		await terminal.type("/bg");
		await terminal.press(key.enter);
		await terminal.waitFor("没有在运行的后台命令");
	});

	test("/cache-clear 清空这个项目的构建缓存", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await terminal.type("/cache-clear");
		await terminal.press(key.enter);
		await terminal.waitFor("已清空这个项目的构建缓存");
	});

	test("/compact 压缩上下文：对话区显示压缩完成，下一次模型请求从摘要接着做", async () => {
		const server = await fixture.useModel((call, request) =>
			textReply(
				lastUserMessage(request).startsWith("<compaction_request>")
					? "这是摘要"
					: `第 ${call} 次回复`,
			),
		);
		const { terminal } = await fixture.start();
		await terminal.type("最初的问题");
		await terminal.press(key.enter);
		await terminal.waitFor("第 0 次回复");
		await terminal.waitFor("完成");

		await terminal.type("/compact");
		await terminal.press(key.enter);
		await terminal.waitFor("正在压缩上下文");
		await terminal.waitFor(/上下文已压缩（压缩前约 \d+ token）/);

		await terminal.type("继续");
		await terminal.press(key.enter);
		await terminal.waitFor("第 2 次回复");
		const after = JSON.stringify(server.requests[2]);
		expect(after).toContain("这是摘要");
		expect(after).not.toContain("最初的问题");
		expect(lastUserMessage(server.requests[2])).toContain("继续");
	});

	test("/compact 只在空闲时可用：任务运行时原因显示在对话区；还没有模型的回复时说明没有可压缩的内容", async () => {
		const server = await fixture.useModel(() => "hang");
		const { terminal } = await fixture.start();
		await terminal.type("/compact");
		await terminal.press(key.enter);
		await terminal.waitFor("没有可压缩的内容");
		expect(server.requests).toHaveLength(0);

		await terminal.type("你好");
		await terminal.press(key.enter);
		await expect.poll(() => server.requests.length).toBe(1);
		await terminal.type("/compact");
		await terminal.press(key.enter);
		await terminal.waitFor("只能在 session 空闲时压缩上下文");
		expect(server.requests).toHaveLength(1);
	});

	test("命令失败时原因显示在对话区，session 继续", async () => {
		const server = await fixture.useModel(() => textReply("还在"));
		const { terminal } = await fixture.start();
		await terminal.type("/model no-such-model");
		await terminal.press(key.enter);
		await terminal.waitFor(/✗ .*no-such-model/);
		expect(terminal.visible()).toContain("fake · 推理");

		await terminal.type("/nope");
		await terminal.press(key.enter);
		await terminal.waitFor("没有 /nope 这个命令");

		await terminal.type("你好");
		await terminal.press(key.enter);
		await terminal.waitFor("还在");
		expect(requestedModel(server.requests[0])).toBe("fake-model");
	});

	test("/ 开头的路径不是命令，照常发给模型", async () => {
		const server = await fixture.useModel(() => textReply("收到路径"));
		const { terminal } = await fixture.start();
		await terminal.type("/usr/bin/env 是什么");
		await terminal.press(key.enter);
		await terminal.waitFor("收到路径");
		expect(server.requests).toHaveLength(1);
	});
});

describe.runIf(process.platform === "darwin")("真实沙盒里的 /sandbox", () => {
	test("/sandbox read-only 换沙盒模式：状态行跟着变，之后的命令写不了工作区", async () => {
		const first = join(fixture.dirs.workspace, "first.txt");
		const second = join(fixture.dirs.workspace, "second.txt");
		await fixture.useModel(
			(call) =>
				[
					shellCallReply(`touch '${first}'`),
					textReply("第一次做完"),
					shellCallReply(`touch '${second}'`),
					textReply("第二次做完"),
				][call],
		);
		const { terminal } = await fixture.start({
			sandboxMode: "workspace-write",
		});
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await terminal.waitFor("第一次做完");
		expect(existsSync(first)).toBe(true);

		await terminal.type("/sandbox read-only");
		await terminal.press(key.enter);
		await terminal.waitFor("沙盒模式：workspace-write → read-only");
		expect(terminal.visible()).toContain(" · 沙盒 read-only · ");
		// 换沙盒模式要重启 agent 进程
		expect(terminal.text()).toContain("agent 进程已重启");

		await terminal.type("再写");
		await terminal.press(key.enter);
		await terminal.waitFor("第二次做完");
		expect(existsSync(second)).toBe(false);
	});

	/**
	 * 用户级配置里的命名权限配置 `strict`：照 read-only，主目录下的 `notes` 读不到，`scratch` 可写。
	 * 返回一条命令，把这三处各试一遍：写 `scratch`、读 `notes`、写工作区。
	 */
	function strictProfile(): { config: string; probe: (tag: string) => string } {
		const notes = join(fixture.dirs.home, "notes");
		const scratch = join(fixture.dirs.home, "scratch");
		mkdirSync(notes);
		mkdirSync(scratch);
		writeFileSync(join(notes, "private.txt"), "private notes\n");
		return {
			config: `
[permissions.strict]
extends = "read-only"

[permissions.strict.paths]
"~/notes" = "deny"
"~/scratch" = "write"
`,
			probe: (tag) =>
				[
					`echo x > '${join(scratch, `${tag}.txt`)}'`,
					`cat '${join(notes, "private.txt")}'`,
					`echo x > '${join(fixture.dirs.workspace, `${tag}.txt`)}'`,
				].join("; "),
		};
	}

	/** `probe(tag)` 跑完之后三处的情况。 */
	function probed(tag: string, toolResult: string) {
		return {
			scratchWritten: existsSync(
				join(fixture.dirs.home, "scratch", `${tag}.txt`),
			),
			notesRead: toolResult.includes("private notes"),
			workspaceWritten: existsSync(join(fixture.dirs.workspace, `${tag}.txt`)),
		};
	}

	/** 模型收到的最后一条工具结果。 */
	function lastToolResult(request: unknown): string {
		const { messages } = request as {
			messages: { role: string; content: unknown }[];
		};
		const last = messages.findLast((message) => message.role === "tool");
		if (last === undefined) throw new Error("请求里没有工具结果");
		return JSON.stringify(last.content);
	}

	test("以命名权限配置启动：状态行显示它的名字，命令按它的路径读写", async () => {
		const { config, probe } = strictProfile();
		const server = await fixture.useModel(
			(call) =>
				call === 0 ? shellCallReply(probe("start")) : textReply("试过了"),
			{ extra: config },
		);
		const { terminal } = await fixture.start({ sandboxMode: "strict" });
		expect(terminal.visible()).toContain(" · 沙盒 strict · ");

		await terminal.type("试一下");
		await terminal.press(key.enter);
		await terminal.waitFor("试过了");
		expect(probed("start", lastToolResult(server.requests[1]))).toEqual({
			scratchWritten: true,
			notesRead: false,
			workspaceWritten: false,
		});

		await terminal.type("/sandbox");
		await terminal.press(key.enter);
		await terminal.waitFor(/沙盒模式：strict$/m);
	});

	test("/sandbox 换成命名权限配置：补全里有它的名字，状态行跟着变，之后的命令按它的路径读写；已经在用时不再换，不存在的名字报错", async () => {
		const { config, probe } = strictProfile();
		const server = await fixture.useModel(
			(call) =>
				[
					shellCallReply(probe("before")),
					textReply("第一次试过了"),
					shellCallReply(probe("after")),
					textReply("第二次试过了"),
				][call],
			{ extra: config },
		);
		const { terminal } = await fixture.start({
			sandboxMode: "workspace-write",
		});
		await terminal.type("试一下");
		await terminal.press(key.enter);
		await terminal.waitFor("第一次试过了");
		// workspace-write：工作区可写，主目录下别的位置读得到、写不了
		expect(probed("before", lastToolResult(server.requests[1]))).toEqual({
			scratchWritten: false,
			notesRead: true,
			workspaceWritten: true,
		});

		await terminal.type("/sandbox ");
		await terminal.waitForVisible("strict");
		for (const mode of ["read-only", "workspace-write", "strict"]) {
			expect(terminal.visible()).toMatch(
				new RegExp(`^(→|\\s) ${mode}\\s*$`, "m"),
			);
		}
		await terminal.type("strict");
		await terminal.press(key.enter);
		await terminal.waitFor("沙盒模式：workspace-write → strict");
		expect(terminal.visible()).toContain(" · 沙盒 strict · ");
		expect(terminal.text()).toContain("agent 进程已重启");

		await terminal.type("再试一下");
		await terminal.press(key.enter);
		await terminal.waitFor("第二次试过了");
		expect(probed("after", lastToolResult(server.requests[3]))).toEqual({
			scratchWritten: true,
			notesRead: false,
			workspaceWritten: false,
		});

		await terminal.type("/sandbox strict");
		await terminal.press(key.enter);
		await terminal.waitFor("沙盒模式已经是 strict");
		expect(terminal.text().match(/agent 进程已重启/g)).toHaveLength(1);

		await terminal.type("/sandbox no-such-profile");
		await terminal.press(key.enter);
		await terminal.waitFor(/✗ .*no-such-profile/);
		expect(terminal.visible()).toContain(" · 沙盒 strict · ");
	});

	test("/sandbox 不带参数时显示当前的模式；不能在运行中换成 danger-full-access", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start({
			sandboxMode: "workspace-write",
		});
		await terminal.type("/sandbox");
		await terminal.press(key.enter);
		await terminal.waitFor(/沙盒模式：workspace-write$/m);

		await terminal.type("/sandbox danger-full-access");
		await terminal.press(key.enter);
		await terminal.waitFor(/✗ .*danger-full-access/);
		expect(terminal.visible()).toContain(" · 沙盒 workspace-write · ");
	});
});
