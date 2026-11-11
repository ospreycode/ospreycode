import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type Host,
	type HostEvent,
	InputBlockedError,
	type Session,
	SessionBlockedError,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type HookScript,
	writeFile,
	writeHookScript,
	writeHooks,
	writeSkill,
} from "./extension-harness.js";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let host: Host;
let session: Session | undefined;
let log: EventLog;
let requests: ModelRequest[];
let turns: ScriptedTurn[];
/** hook 脚本把收到的输入记在这里。 */
let hookLog: string;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	requests = [];
	turns = [];
	hookLog = join(dirs.home, "hooks.log");
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

function call(name: string, args: object): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: `call_${crypto.randomUUID()}`,
				name,
				arguments: JSON.stringify(args),
			},
		],
	};
}

const shell = (command: string) => call("shell", { command });

const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };

function newHost(): Host {
	host = createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request) => {
			requests.push(request);
			return turns.shift() ?? done;
		}),
	});
	return host;
}

/** 打开 session：没有沙盒，命令不用批准。模型依次给出排好的回复，用完之后回复一句话。 */
async function open(options: Partial<SessionOptions> = {}): Promise<Session> {
	session = await newHost().openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: log.push,
	});
	return session;
}

async function runTask(input: string, ...script: ScriptedTurn[]) {
	if (session === undefined) throw new Error("session 还没有打开");
	turns.push(...script);
	const taskId = await session.submit(input);
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

function results(): ToolResult[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result] : [],
	);
}

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function warnings(): string[] {
	return log.events.flatMap((event) =>
		event.type === "warning" ? [event.message] : [],
	);
}

function ran(): Extract<HostEvent, { type: "hooks.ran" }>[] {
	return log.events.filter((event) => event.type === "hooks.ran");
}

function textOf(message: Message | undefined): string {
	return (message?.content ?? [])
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/** 第 `index` 次模型请求里 user 消息的全部文字。 */
function userText(index: number): string {
	return (requests[index]?.messages ?? [])
		.filter((message) => message.role === "user")
		.map(textOf)
		.join("\n");
}

interface Logged {
	input: Record<string, unknown>;
	env: Record<string, string>;
	cwd: string;
}

/** hook 脚本记下的每次运行。 */
function logged(): Logged[] {
	if (!existsSync(hookLog)) return [];
	return readFileSync(hookLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Logged);
}

const userHookDirectory = () => join(dirs.root, "hooks");

/**
 * 配一个用户级的 hook：脚本放在 `~/.ospreycode/hooks/` 里。同一个事件配几次时各是一个 handler。
 */
const configured: Record<string, object[]> = {};
function userHook(
	event: string,
	script: HookScript,
	options: { matcher?: string; onFailure?: string; timeout?: number } = {},
): void {
	const name = `${event}-${(configured[event] ?? []).length}.cjs`;
	writeHookScript(join(userHookDirectory(), name), {
		log: hookLog,
		...script,
	});
	configured[event] = [
		...(configured[event] ?? []),
		{
			...(options.matcher === undefined ? {} : { matcher: options.matcher }),
			hooks: [
				{
					command: `./${name}`,
					onFailure: options.onFailure ?? "continue",
					permissions: "workspace-write",
					...(options.timeout === undefined
						? {}
						: { timeout: options.timeout }),
				},
			],
		},
	];
	writeHooks(join(dirs.root, "hooks.json"), configured);
}

beforeEach(() => {
	for (const key of Object.keys(configured)) delete configured[key];
});

describe("SessionStart", () => {
	test("打开 session 时运行；补充的信息随第一个 task 的输入交给模型", async () => {
		userHook("SessionStart", {
			output: { additional_context: "今天是发布日", system_message: "已检查" },
		});
		const current = await open();
		expect(logged()).toHaveLength(1);
		const [{ input, env, cwd }] = logged() as [Logged];
		expect(input).toEqual({
			schema_version: 1,
			hook_event_name: "SessionStart",
			session_id: current.id,
			task_id: null,
			run_id: null,
			cwd: dirs.workspace,
			model: "scripted",
			sandbox_mode: "danger-full-access",
			approval_policy: "never",
			source: "startup",
		});
		expect(env.OSPREYCODE_WORKSPACE).toBe(dirs.workspace);
		expect(env.PLUGIN_ROOT).toBe(userHookDirectory());
		expect(env.PLUGIN_DATA).toBeUndefined();
		expect(cwd).toBe(userHookDirectory());
		expect(ran()).toMatchObject([
			{
				event: "SessionStart",
				blocked: false,
				additional_context: "今天是发布日",
				system_messages: ["已检查"],
			},
		]);

		await runTask("第一个任务");
		expect(userText(0)).toContain(
			'<hook_context event="SessionStart">\nA hook configured by the user added the following. It is not a message from the user.\n今天是发布日\n</hook_context>',
		);
		await runTask("第二个任务");
		const second = requests[1]?.messages.at(-1);
		expect(textOf(second)).not.toContain("今天是发布日");
	});

	test("matcher 按 source 筛选", async () => {
		userHook("SessionStart", {}, { matcher: "^resume$" });
		await open();
		expect(logged()).toEqual([]);
		expect(ran()).toEqual([]);
	});

	test("阻止时 session 不打开，工作区锁放掉", async () => {
		userHook("SessionStart", {
			output: { decision: "block", reason: "仓库还没初始化" },
		});
		const opening = open();
		await expect(opening).rejects.toThrow(SessionBlockedError);
		await expect(opening).rejects.toThrow("仓库还没初始化");
		// 去掉这个 hook 之后能再打开：锁没有留下
		writeHooks(join(dirs.root, "hooks.json"), {});
		log = new EventLog();
		await open();
		await runTask("任务");
	});
});

describe("UserPromptSubmit", () => {
	test("输入交给模型之前运行，补充的信息接在输入后面", async () => {
		userHook("UserPromptSubmit", {
			output:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: hook 脚本的源码，模板字符串在脚本里求值
				"(input) => ({ additional_context: `长度 ${input.prompt.length}` })",
		});
		await open();
		writeFileSync(join(dirs.workspace, "a.txt"), "x\n");
		const task = await runTask("看看 a.txt");
		const [{ input }] = logged() as [Logged];
		expect(input).toMatchObject({
			hook_event_name: "UserPromptSubmit",
			prompt: "看看 a.txt",
			mentioned_paths: [],
			task_id: null,
		});
		expect(task.outcome).toBe("completed");
		expect(userText(0)).toContain(
			'看看 a.txt\n<hook_context event="UserPromptSubmit">',
		);
		expect(userText(0)).toContain("长度 8");
	});

	test("阻止时 task 不开始，原因交还给调用方", async () => {
		userHook("UserPromptSubmit", {
			output:
				'(input) => input.prompt.includes("密码") ? { decision: "block", reason: "输入里像是有密码" } : {}',
		});
		const current = await open();
		const blocked = current.submit("我的密码是 123");
		await expect(blocked).rejects.toThrow(InputBlockedError);
		await expect(blocked).rejects.toThrow("输入里像是有密码");
		expect(log.types()).not.toContain("task.started");
		expect(ran()).toMatchObject([
			{ event: "UserPromptSubmit", blocked: true, reason: "输入里像是有密码" },
		]);
		expect(requests).toEqual([]);
		// session 还能用
		expect((await runTask("正常的输入")).outcome).toBe("completed");
	});

	test("task 运行中的输入也检查：被阻止的不排队，事件里带它的编号", async () => {
		userHook("UserPromptSubmit", {
			output:
				'(input) => input.prompt.includes("密码") ? { decision: "block", reason: "不行" } : { additional_context: "检查过了" }',
		});
		const current = await open();
		turns.push(shell("sleep 1"));
		const taskId = await current.submit("开始");
		await log.waitFor("tool_call.started");
		const blockedId = current.steer("密码是 123");
		const allowedId = current.steer("顺便看看 README");
		await log.waitFor("task.ended", (event) => event.task_id === taskId);
		const checks = ran().filter((event) => event.input_id !== undefined);
		expect(checks).toMatchObject([
			{ input_id: blockedId, blocked: true, reason: "不行", task_id: taskId },
			{ input_id: allowedId, blocked: false },
		]);
		expect(userText(1)).toContain("顺便看看 README");
		expect(userText(1)).toContain("检查过了");
		expect(userText(1)).not.toContain("密码是 123");
	});
});

describe("PreToolUse 和 PostToolUse", () => {
	test("PreToolUse 在批准之前运行，能阻止这次调用", async () => {
		userHook(
			"PreToolUse",
			{
				output:
					'(input) => input.tool_input.command.includes("rm ") ? { decision: "block", reason: "不许删文件" } : {}',
			},
			{ matcher: "^shell$" },
		);
		await open();
		writeFileSync(join(dirs.workspace, "keep.txt"), "x\n");
		await runTask(
			"开始",
			shell("rm keep.txt"),
			shell("echo ok"),
			call("read", { path: "keep.txt" }),
		);
		expect(results()).toMatchObject([
			{ status: "denied", reason: "hook", message: "不许删文件" },
			{ status: "succeeded" },
			{ status: "succeeded" },
		]);
		expect(output(results()[0])).toContain(
			"A PreToolUse hook configured by the user blocked this tool call before it ran. Its reason:\n不许删文件",
		);
		expect(existsSync(join(dirs.workspace, "keep.txt"))).toBe(true);
		// matcher 只匹配 shell：read 不触发
		expect(logged().map(({ input }) => input.tool_name)).toEqual([
			"shell",
			"shell",
		]);
		const [{ input }] = logged() as [Logged];
		expect(input).toMatchObject({
			hook_event_name: "PreToolUse",
			tool_name: "shell",
			tool_input: { command: "rm keep.txt" },
		});
		expect(typeof input.tool_call_id).toBe("string");
		expect(typeof input.task_id).toBe("string");
		expect(ran()[0]).toMatchObject({
			event: "PreToolUse",
			tool_call_id: input.tool_call_id,
			blocked: true,
		});
	});

	test("退出码 2 也是阻止，原因取 stderr", async () => {
		userHook("PreToolUse", { stderr: "脚本说不行", exitCode: 2 });
		await open();
		await runTask("开始", shell("echo hi"));
		expect(results()).toMatchObject([
			{ status: "denied", reason: "hook", message: "脚本说不行" },
		]);
	});

	test("补充的信息接在这次调用的结果后面，标明来源", async () => {
		userHook("PreToolUse", { output: { additional_context: "调用前的提示" } });
		userHook("PostToolUse", {
			output:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: hook 脚本的源码，模板字符串在脚本里求值
				"(input) => ({ additional_context: `结果是 ${input.tool_result.status}：${input.tool_result.text.trim()}` })",
		});
		await open();
		await runTask("开始", shell("echo hi"));
		const [result] = results();
		expect(result?.status).toBe("succeeded");
		const text = output(result);
		expect(text).toContain('<hook_context event="PreToolUse">');
		expect(text).toContain("调用前的提示");
		expect(text).toContain('<hook_context event="PostToolUse">');
		expect(text).toContain("结果是 succeeded：Exit code: 0\nhi");
		// 模型下一次请求里看到的就是补充之后的结果
		expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain(
			"调用前的提示",
		);
	});

	test("PostToolUse 的阻止不撤销已经做完的调用，只把原因告诉模型", async () => {
		userHook("PostToolUse", {
			output: { decision: "block", reason: "格式不对，重新来" },
		});
		await open();
		await runTask("开始", shell("echo made > made.txt"));
		expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(true);
		const [result] = results();
		expect(result?.status).toBe("succeeded");
		expect(output(result)).toContain(
			'<hook_feedback event="PostToolUse">\nA hook configured by the user objected after this tool call had already run. It is not a message from the user. Its reason:\n格式不对，重新来',
		);
	});

	test("没有执行的调用不运行 PostToolUse", async () => {
		userHook("PreToolUse", {
			output: { decision: "block", reason: "不行" },
		});
		userHook("PostToolUse", {});
		await open();
		await runTask("开始", shell("echo hi"));
		expect(logged().map(({ input }) => input.hook_event_name)).toEqual([
			"PreToolUse",
		]);
	});
});

describe("Stop", () => {
	test("要求接着做时，原因交给模型，再跑一轮", async () => {
		userHook("Stop", {
			output:
				'(input) => input.continuation_count === 0 ? { decision: "block", reason: "测试还没跑" } : {}',
		});
		await open();
		const task = await runTask(
			"开始",
			{ content: [{ type: "text", text: "做完了" }] },
			{ content: [{ type: "text", text: "测试也跑了" }] },
		);
		expect(task.outcome).toBe("completed");
		expect(requests).toHaveLength(2);
		expect(textOf(requests[1]?.messages.at(-1))).toBe(
			'<hook_feedback event="Stop">\nA hook configured by the user ran when you finished and asks you to continue. It is not a message from the user. Its reason:\n测试还没跑\n</hook_feedback>',
		);
		expect(logged().map(({ input }) => input)).toMatchObject([
			{
				hook_event_name: "Stop",
				last_assistant_message: "做完了",
				continuation_count: 0,
			},
			{ last_assistant_message: "测试也跑了", continuation_count: 1 },
		]);
		expect(ran().map((event) => event.blocked)).toEqual([true, false]);
	});

	test("一个 task 里最多接着做 8 轮", async () => {
		userHook("Stop", { output: { decision: "block", reason: "再来" } });
		await open();
		const task = await runTask("开始");
		expect(task.outcome).toBe("completed");
		expect(requests).toHaveLength(9);
		expect(logged()).toHaveLength(8);
	});
});

describe("PreCompact", () => {
	test("压缩之前运行，补充的信息交给写摘要的模型；阻止时不压缩", async () => {
		userHook("PreCompact", {
			output:
				'(input) => require("node:fs").existsSync(input.cwd + "/no-compact") ? { decision: "block", reason: "现在别压缩" } : { additional_context: "摘要里保留文件名" }',
		});
		const current = await open();
		await runTask("第一个任务");
		turns.push({ content: [{ type: "text", text: "这是摘要" }] });
		const first = await current.compact();
		expect(
			await log.waitFor("task.ended", (event) => event.task_id === first),
		).toMatchObject({ outcome: "completed" });
		expect(logged()[0]?.input).toMatchObject({
			hook_event_name: "PreCompact",
			trigger: "manual",
		});
		expect(textOf(requests[1]?.messages.at(-1))).toContain("摘要里保留文件名");

		writeFileSync(join(dirs.workspace, "no-compact"), "");
		await runTask("第二个任务");
		const second = await current.compact();
		const ended = await log.waitFor(
			"task.ended",
			(event) => event.task_id === second,
		);
		expect(ended.outcome).toBe("failed");
		expect(JSON.stringify(ended)).toContain("现在别压缩");
		expect(
			log.events.filter((event) => event.type === "context.compacted"),
		).toHaveLength(1);
	});
});

describe("SessionEnd", () => {
	test("关闭 session 时运行", async () => {
		userHook("SessionEnd", {});
		const current = await open();
		await runTask("任务");
		await current.close();
		session = undefined;
		expect(logged().map(({ input }) => input)).toMatchObject([
			{
				hook_event_name: "SessionEnd",
				reason: "closed",
				session_id: current.id,
			},
		]);
		// 记在 session.ended 之前
		const types = log.types();
		expect(types.lastIndexOf("hooks.ran")).toBeLessThan(
			types.indexOf("session.ended"),
		);
	});

	test("timeout 最多 5 秒：写多了整份文件不加载", async () => {
		userHook("SessionEnd", {}, { timeout: 30 });
		const current = await open();
		expect(warnings().join("\n")).toContain("SessionEnd 的 timeout 最多 5 秒");
		expect(current.extensions()).toMatchObject([
			{ kind: "hooks", status: "failed" },
		]);
	});
});

describe("handler 的失败", () => {
	test("onFailure 是 continue 时提示用户、照常继续", async () => {
		userHook("PreToolUse", { exitCode: 1, stderr: "脚本坏了" });
		await open();
		await runTask("开始", shell("echo hi"));
		expect(results()).toMatchObject([{ status: "succeeded" }]);
		expect(warnings().join("\n")).toMatch(
			/PreToolUse hook .*PreToolUse-0\.cjs（.*hooks\.json） 失败了：以退出码 1 结束：脚本坏了/,
		);
		expect(ran()).toMatchObject([{ blocked: false }]);
	});

	test("onFailure 是 block 时按阻止处理", async () => {
		userHook("PreToolUse", { exitCode: 1 }, { onFailure: "block" });
		await open();
		await runTask("开始", shell("echo hi"));
		expect(results()).toMatchObject([{ status: "denied", reason: "hook" }]);
		expect(output(results()[0])).toContain(
			"failed and is configured to block on failure",
		);
	});

	test("超时、输出不是 JSON、block 不写原因都算失败", async () => {
		userHook("PreToolUse", { delayMs: 5_000 }, { timeout: 0.3 });
		userHook("PreToolUse", { body: 'process.stdout.write("not json");' });
		userHook("PreToolUse", { output: { decision: "block" } });
		await open();
		await runTask("开始", shell("echo hi"));
		expect(results()).toMatchObject([{ status: "succeeded" }]);
		const text = warnings().join("\n");
		expect(text).toContain("超过了 0.3 秒的时限");
		expect(text).toContain("stdout 不是 JSON");
		expect(text).toContain("decision 为 block 时必须写 reason");
	});

	test("同一时机的几个 handler 都运行，结果按配置顺序合并", async () => {
		userHook("UserPromptSubmit", {
			output: { additional_context: "第一条" },
			delayMs: 200,
		});
		userHook("UserPromptSubmit", { output: { additional_context: "第二条" } });
		await open();
		await runTask("开始");
		expect(ran()).toMatchObject([{ additional_context: "第一条\n第二条" }]);
	});

	test("写了不支持的字段时整份文件不加载", async () => {
		writeHookScript(join(userHookDirectory(), "a.cjs"));
		writeHooks(join(dirs.root, "hooks.json"), {
			PreToolUse: [
				{
					hooks: [
						{
							command: "./a.cjs",
							onFailure: "continue",
							permissions: "read-only",
							async: true,
						},
					],
				},
			],
		});
		await open();
		expect(warnings().join("\n")).toContain(
			"不支持 async：hooks 都等结束后再继续",
		);
		await runTask("开始", shell("echo hi"));
		expect(ran()).toEqual([]);
	});
});

describe("仓库自带的 hooks", () => {
	const projectConfig = () => join(dirs.workspace, ".ospreycode");

	beforeEach(() => {
		writeHookScript(join(projectConfig(), "check.cjs"), {
			log: hookLog,
			output: { additional_context: "仓库的提示" },
		});
		writeHooks(join(projectConfig(), "hooks.json"), {
			UserPromptSubmit: [
				{ hooks: [{ command: "./check.cjs", onFailure: "continue" }] },
			],
		});
	});

	async function confirm(): Promise<void> {
		const { items } = await newHost().extensions.list(dirs.workspace);
		const hooks = items.find((item) => item.kind === "hooks");
		await host.extensions.confirm(
			dirs.workspace,
			hooks?.id as string,
			hooks?.hash as string,
		);
	}

	test("没确认时不运行", async () => {
		await open();
		await runTask("开始");
		expect(logged()).toEqual([]);
		expect(warnings().join("\n")).toContain("还没有确认，没有启用");
	});

	test("确认之后运行", async () => {
		await confirm();
		await open();
		await runTask("开始");
		expect(logged()).toHaveLength(1);
		expect(logged()[0]?.env.PLUGIN_ROOT).toBe(projectConfig());
		expect(userText(0)).toContain("仓库的提示");
	});

	test("确认之后内容又变了：运行前发现，在这个 session 里停用", async () => {
		await confirm();
		await open();
		await runTask("第一次");
		expect(logged()).toHaveLength(1);
		// agent（或别的程序）改了 hook 用到的脚本
		writeFile(
			join(projectConfig(), "check.cjs"),
			"#!/usr/bin/env node\nprocess.exit(0)\n",
			true,
		);
		await runTask("第二次");
		expect(logged()).toHaveLength(1);
		expect(warnings().join("\n")).toContain(
			"的 hooks 已停用：项目配置目录里的文件和确认时不一样",
		);
	});
});

describe("插件的 hooks", () => {
	test("PLUGIN_ROOT 是插件的版本目录，PLUGIN_DATA 是它的数据目录", async () => {
		const source = join(dirs.home, "src", "demo");
		writeFile(
			join(source, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "demo",
				version: "1.0.0",
			}),
		);
		writeSkill(join(source, "skills"), "review", "审阅改动");
		writeHookScript(join(source, "dev.ospreycode", "start.cjs"), {
			log: hookLog,
		});
		writeHooks(join(source, "dev.ospreycode", "hooks.json"), {
			SessionStart: [
				{
					hooks: [
						{
							command: "./start.cjs",
							// biome-ignore lint/suspicious/noTemplateCurlyInString: hooks.json 里占位符的写法
							args: ["${PLUGIN_ROOT}/skills", "${PLUGIN_DATA}/state"],
							onFailure: "continue",
						},
					],
				},
			],
		});
		const stage = await newHost().extensions.stagePlugin({
			type: "local",
			path: source,
		});
		await stage.commit();
		await open();
		const root = join(dirs.root, "plugins", "demo", stage.version);
		const data = join(dirs.root, "plugin-data", "demo");
		const [{ env, cwd }] = logged() as [Logged];
		expect(env.PLUGIN_ROOT).toBe(root);
		expect(env.PLUGIN_DATA).toBe(data);
		expect(cwd).toBe(join(root, "dev.ospreycode"));
	});
});

describe.runIf(process.platform === "darwin")("hooks 在沙盒里运行", () => {
	test("用户级的按它写的 permissions：read-only 写不了工作区", async () => {
		writeHookScript(join(userHookDirectory(), "write.cjs"), {
			body: 'try { require("node:fs").writeFileSync(input.cwd + "/from-hook.txt", "x"); } catch (error) { process.stderr.write(error.code); process.exit(2); }',
		});
		writeHooks(join(dirs.root, "hooks.json"), {
			UserPromptSubmit: [
				{
					hooks: [
						{
							command: "./write.cjs",
							onFailure: "continue",
							permissions: "read-only",
						},
					],
				},
			],
		});
		const current = await open({ sandboxMode: "workspace-write" });
		await expect(current.submit("开始")).rejects.toThrow("EPERM");
		expect(existsSync(join(dirs.workspace, "from-hook.txt"))).toBe(false);
	});

	test("用户级的写 workspace-write 时能写工作区，读不到 Host 的数据", async () => {
		writeHookScript(join(userHookDirectory(), "write.cjs"), {
			body: [
				'const fs = require("node:fs");',
				'fs.writeFileSync(input.cwd + "/from-hook.txt", "x");',
				`try { fs.readFileSync(${JSON.stringify(join(dirs.root, "config.toml"))}); process.stdout.write(JSON.stringify({ additional_context: "读到了" })); }`,
				"catch (error) { process.stdout.write(JSON.stringify({ additional_context: error.code })); }",
			].join(" "),
		});
		writeFile(join(dirs.root, "config.toml"), "");
		writeHooks(join(dirs.root, "hooks.json"), {
			UserPromptSubmit: [
				{
					hooks: [
						{
							command: "./write.cjs",
							onFailure: "continue",
							permissions: "workspace-write",
						},
					],
				},
			],
		});
		// 没有启用沙盒时 permissions 不生效，这里用 read-only 的 session：hook 的权限由它自己的声明定
		await open({ sandboxMode: "read-only" });
		await runTask("开始");
		expect(existsSync(join(dirs.workspace, "from-hook.txt"))).toBe(true);
		expect(ran()).toMatchObject([{ additional_context: "EPERM" }]);
	});

	test("仓库的 hooks 用 session 的沙盒模式，不能联网", async () => {
		const projectConfig = join(dirs.workspace, ".ospreycode");
		writeHookScript(join(projectConfig, "net.cjs"), {
			body: [
				'const { execFileSync } = require("node:child_process");',
				"let code;",
				'try { code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", "http://example.invalid:8080/"], { encoding: "utf8" }); }',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: hook 脚本的源码，模板字符串在脚本里求值
				"catch (error) { code = `curl 退出码 ${error.status}`; }",
				"process.stdout.write(JSON.stringify({ additional_context: code }));",
			].join(" "),
		});
		writeHooks(join(projectConfig, "hooks.json"), {
			UserPromptSubmit: [
				{ hooks: [{ command: "./net.cjs", onFailure: "continue" }] },
			],
		});
		const { items } = await newHost().extensions.list(dirs.workspace);
		const hooks = items.find((item) => item.kind === "hooks");
		await host.extensions.confirm(
			dirs.workspace,
			hooks?.id as string,
			hooks?.hash as string,
		);
		await open({ sandboxMode: "workspace-write" });
		await runTask("开始");
		const [event] = ran();
		expect(event?.blocked).toBe(false);
		// 连接被沙盒的代理拒绝，没有一条询问发给用户
		expect(event?.additional_context).toBe("403");
		expect(
			log.events.filter((each) => each.type === "approval.requested"),
		).toEqual([]);
	});
});
