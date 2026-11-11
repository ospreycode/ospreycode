import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
	type ApprovalRequestedEvent,
	createHost,
	type Host,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	fixtureServer,
	writeFile,
	writeMcpConfig,
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
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;
let turns: ScriptedTurn[];
/** Host 进程的环境变量里多出来的项。 */
let hostEnv: Record<string, string>;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	requests = [];
	answer = undefined;
	turns = [];
	hostEnv = {};
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

const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };

/** 打开 session：模型依次给出 `turns` 里的回复，用完之后回复一句话。 */
async function open(options: Partial<SessionOptions> = {}): Promise<Session> {
	host = createHost({
		root: dirs.root,
		env: { ...dirs.env, ...hostEnv },
		credentialStore: null,
		streamModel: scriptedModel((request) => {
			requests.push(request);
			return turns.shift() ?? done;
		}),
	});
	session = await host.openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "on-request",
		...options,
		onEvent: (event) => {
			log.push(event);
			if (event.type === "approval.requested" && answer !== undefined) {
				session?.respond(event.request_id, answer(event));
			}
		},
	});
	return session;
}

/** 让模型依次给出这些回复，跑完一个 task。 */
async function runTask(...script: ScriptedTurn[]) {
	if (session === undefined) throw new Error("session 还没有打开");
	turns.push(...script);
	const taskId = await session.submit("开始");
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
		.join("");
}

function asked(): ApprovalRequestedEvent[] {
	return log.events.filter((event) => event.type === "approval.requested");
}

function warnings(): string[] {
	return log.events.flatMap((event) =>
		event.type === "warning" ? [event.message] : [],
	);
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

function toolNames(index: number): string[] {
	return (requests[index]?.tools ?? []).map((tool) => tool.name);
}

const approveOnce = (): ApprovalAnswer => ({
	decision: "approve",
	scope: "once",
});

const userSkills = () => join(dirs.home, ".agents", "skills");

describe("skills", () => {
	test("没有启用的 skill 时没有 skill_load 工具，也不提 skills", async () => {
		await open();
		await runTask();
		expect(toolNames(0)).not.toContain("skill_load");
		expect(userText(0)).not.toContain("<skills>");
	});

	test("启用的 skill 只把名字、说明和目录告诉模型，正文用 skill_load 加载", async () => {
		const directory = writeSkill(
			userSkills(),
			"release-notes",
			"写发布说明",
			"先看 git log，再按模板写。",
			{ "template.md": "# 模板\n" },
		);
		await open();
		await runTask(call("skill_load", { name: "release-notes" }));
		expect(toolNames(0)).toContain("skill_load");
		expect(userText(0)).toContain(
			`- release-notes: 写发布说明 (directory: ${directory})`,
		);
		expect(userText(0)).not.toContain("先看 git log");
		expect(results()).toMatchObject([{ status: "succeeded" }]);
		const content = output(results()[0]);
		expect(content).toContain('<skill_content name="release-notes">');
		expect(content).toContain("先看 git log，再按模板写。");
		expect(content).toContain(`Skill directory: ${directory}`);
		expect(content).toContain("<file>template.md</file>");
		// 内容没变：不询问
		expect(asked()).toEqual([]);
		expect(session?.extensions()).toMatchObject([
			{ kind: "skill", name: "release-notes", status: "enabled" },
		]);
	});

	test("没有这个名字的 skill 时如实告诉模型", async () => {
		writeSkill(userSkills(), "notes", "记笔记");
		await open();
		await runTask(call("skill_load", { name: "missing" }));
		expect(results()).toMatchObject([{ status: "failed" }]);
		expect(output(results()[0])).toContain(
			"There is no enabled skill named missing. Enabled skills: notes.",
		);
	});

	test("仓库自带的 skill 没确认时不启用，并提示用户", async () => {
		writeSkill(join(dirs.workspace, ".agents", "skills"), "deploy", "部署");
		await open();
		await runTask();
		expect(toolNames(0)).not.toContain("skill_load");
		expect(userText(0)).not.toContain("deploy");
		expect(warnings().join("\n")).toContain(
			"仓库自带的 skill deploy 还没有确认，没有启用",
		);
		expect(session?.extensions()).toMatchObject([
			{ kind: "skill", name: "deploy", status: "unconfirmed" },
		]);
	});

	test("确认之后用 reload 启用：下一个 task 告诉模型新的列表", async () => {
		writeSkill(join(dirs.workspace, ".agents", "skills"), "deploy", "部署");
		const current = await open();
		await runTask();
		const [skill] = current.extensions();
		await host.extensions.confirm(
			dirs.workspace,
			skill?.id as string,
			skill?.hash as string,
		);
		await current.reload();
		await runTask(call("skill_load", { name: "deploy" }));
		expect(toolNames(1)).toContain("skill_load");
		expect(userText(1)).toContain("<skills_update>");
		expect(userText(1)).toContain("- deploy: 部署");
		expect(results()).toMatchObject([{ status: "succeeded" }]);
	});

	describe("内容在 session 开始之后变了", () => {
		let directory: string;

		beforeEach(() => {
			directory = writeSkill(userSkills(), "notes", "记笔记", "第一版。", {
				"run.sh": "#!/bin/sh\necho v1\n",
			});
		});

		test("加载前问用户，批准后给出现在的内容；同一份内容本任务内不再问", async () => {
			await open();
			writeFile(
				join(directory, "SKILL.md"),
				"---\nname: notes\ndescription: 记笔记\n---\n\n第二版。\n",
			);
			answer = approveOnce;
			await runTask(
				call("skill_load", { name: "notes" }),
				call("skill_load", { name: "notes" }),
			);
			expect(asked()).toMatchObject([
				{
					kind: "extension_changed",
					skill: "notes",
					directory,
					action: "load",
					reasons: ["skill notes 的内容在这个 session 开始之后变了"],
				},
			]);
			expect(results()).toMatchObject([
				{ status: "succeeded" },
				{ status: "succeeded" },
			]);
			expect(output(results()[0])).toContain("第二版。");
		});

		test("用户拒绝时不加载", async () => {
			await open();
			writeFile(join(directory, "extra.md"), "x\n");
			answer = () => ({ decision: "deny", scope: "once", message: "先别用" });
			await runTask(call("skill_load", { name: "notes" }));
			expect(results()).toMatchObject([
				{ status: "denied", reason: "user", message: "先别用" },
			]);
			expect(output(results()[0])).not.toContain("第一版");
		});

		test("审批策略是 never 时直接拒绝，不问", async () => {
			await open({ approvalPolicy: "never" });
			writeFile(join(directory, "extra.md"), "x\n");
			await runTask(call("skill_load", { name: "notes" }));
			expect(asked()).toEqual([]);
			expect(results()).toMatchObject([{ status: "denied", reason: "policy" }]);
		});

		test("运行 skill 目录里的脚本前也核对：直接运行、交给解释器运行都算", async () => {
			await open();
			writeFile(join(directory, "run.sh"), "#!/bin/sh\necho v2\n", true);
			const seen: string[] = [];
			answer = (event) => {
				if (event.kind === "extension_changed") {
					seen.push(`${event.action}:${event.command}`);
					return approveOnce();
				}
				return approveOnce();
			};
			await runTask(
				call("shell", { command: `sh ${join(directory, "run.sh")}` }),
				call("shell", { command: `${join(directory, "run.sh")} && true` }),
			);
			// 同一份内容本任务内只问一次
			expect(seen).toEqual([`script:sh ${join(directory, "run.sh")}`]);
			expect(results().map((result) => result.status)).toEqual([
				"succeeded",
				"succeeded",
			]);
			expect(output(results()[0])).toContain("v2");
		});

		test("内容没变时运行脚本不多问", async () => {
			await open();
			answer = approveOnce;
			await runTask(
				call("shell", { command: `sh ${join(directory, "run.sh")}` }),
			);
			expect(
				asked().filter((event) => event.kind === "extension_changed"),
			).toEqual([]);
			expect(output(results()[0])).toContain("v1");
		});

		test("skill 被删掉之后加载不了", async () => {
			await open();
			writeFileSync(join(directory, "SKILL.md"), "不是 skill 了\n");
			await runTask(call("skill_load", { name: "notes" }));
			expect(results()).toMatchObject([{ status: "failed" }]);
			expect(output(results()[0])).toContain(
				"The skill notes can no longer be loaded",
			);
		});
	});
});

function userServer(env: Record<string, string> = {}): void {
	writeMcpConfig(join(dirs.root, "mcp.json"), { tools: fixtureServer(env) });
}

describe("MCP server", () => {
	test("启用的 server 的工具以 标签__工具名 交给模型", async () => {
		userServer();
		const current = await open();
		await runTask();
		expect(toolNames(0)).toEqual(
			expect.arrayContaining(["tools__echo", "tools__wipe", "tools__ask"]),
		);
		expect(current.mcpServers()).toMatchObject([
			{
				label: "tools",
				transport: "stdio",
				status: "connected",
				protocol_version: "2026-07-28",
			},
		]);
		expect(current.mcpServers()[0]?.tools).toContain("tools__echo");
		const started = log.events.filter(
			(event) => event.type === "process.started",
		);
		expect(started.map((event) => event.kind)).toContain("mcp_server");
	});

	test("仓库自带的 server 没确认时不启动", async () => {
		const marker = join(dirs.home, "started.log");
		writeMcpConfig(join(dirs.workspace, ".ospreycode", "mcp.json"), {
			tools: fixtureServer({ MCP_FIXTURE_LOG: marker }),
		});
		const current = await open();
		await runTask();
		expect(toolNames(0).filter((name) => name.includes("__"))).toEqual([]);
		expect(current.mcpServers()).toEqual([]);
		expect(existsSync(marker)).toBe(false);
		expect(warnings().join("\n")).toContain(
			"仓库自带的 MCP server tools 还没有确认，没有启用",
		);
	});

	test("每次调用都要批准：批准一次只管这一次，server 标的只读不算数", async () => {
		userServer();
		await open();
		answer = approveOnce;
		await runTask(
			call("tools__echo", { text: "一" }),
			call("tools__echo", { text: "二" }),
		);
		expect(asked()).toMatchObject([
			{
				kind: "tool_call",
				request: { kind: "mcp_tool", server: "tools", tool: "echo" },
			},
			{ kind: "tool_call", request: { kind: "mcp_tool" } },
		]);
		expect(results().map(output)).toEqual(["一", "二"]);
	});

	test("本任务内批准按 server 和工具记，下一个 task 重新问", async () => {
		userServer();
		await open();
		answer = () => ({ decision: "approve", scope: "task" });
		await runTask(
			call("tools__echo", { text: "一" }),
			call("tools__echo", { text: "二" }),
			call("tools__big", {}),
		);
		expect(
			asked().map((event) =>
				event.kind === "tool_call" && event.request.kind === "mcp_tool"
					? event.request.tool
					: undefined,
			),
		).toEqual(["echo", "big"]);
		await runTask(call("tools__echo", { text: "三" }));
		expect(asked()).toHaveLength(3);
	});

	test("server 标了破坏性的工具每次都问", async () => {
		userServer();
		await open();
		answer = () => ({ decision: "approve", scope: "task" });
		await runTask(call("tools__wipe", {}), call("tools__wipe", {}));
		expect(asked()).toHaveLength(2);
		expect(results().map(output)).toEqual(["wiped", "wiped"]);
	});

	test("用户拒绝、审批策略是 never 时不调用", async () => {
		userServer();
		await open();
		answer = () => ({ decision: "deny", scope: "once" });
		await runTask(call("tools__echo", { text: "一" }));
		expect(results()).toMatchObject([{ status: "denied", reason: "user" }]);
		await session?.close();
		expect(log.invalid).toEqual([]);

		log = new EventLog();
		await open({ approvalPolicy: "never" });
		await runTask(call("tools__echo", { text: "一" }));
		expect(asked()).toEqual([]);
		expect(results()).toMatchObject([{ status: "denied", reason: "policy" }]);
	});

	test("权限规则可以放行或禁止某个工具", async () => {
		userServer();
		const rules = join(dirs.root, "rules");
		mkdirSync(rules, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(rules, "mcp.toml"),
			[
				"[[mcp_rules]]",
				'server = "tools"',
				'tool = "echo"',
				'decision = "allow"',
				"",
				"[[mcp_rules]]",
				'server = "tools"',
				'tool = "wipe"',
				'decision = "forbidden"',
				"",
			].join("\n"),
		);
		await open();
		await runTask(call("tools__echo", { text: "一" }), call("tools__wipe", {}));
		expect(asked()).toEqual([]);
		expect(results()).toMatchObject([
			{ status: "succeeded" },
			{ status: "denied" },
		]);
	});

	test("超长的结果截断，完整的输出另存成文件", async () => {
		userServer();
		await open();
		answer = approveOnce;
		await runTask(call("tools__big", {}));
		const [result] = results();
		expect(result?.status).toBe("succeeded");
		const shown = output(result);
		expect(shown.length).toBeLessThan(40_000);
		// 开头和结尾各留一半
		expect(shown.startsWith("0123456789")).toBe(true);
		expect(shown.endsWith("END")).toBe(true);
		const file = /bytes omitted; the full output is in ([^\]]+)\]/.exec(
			shown,
		)?.[1];
		expect(file).toBeDefined();
		expect(readFileSync(file as string, "utf8")).toHaveLength(100_003);
	});

	test("server 的环境变量只有白名单、定义里的 env 和插件目录", async () => {
		hostEnv = { HOST_SECRET: "do-not-leak" };
		userServer({ FROM_CONFIG: "yes" });
		await open();
		answer = approveOnce;
		await runTask(call("tools__env", {}));
		const env = JSON.parse(output(results()[0])) as Record<string, string>;
		expect(env.FROM_CONFIG).toBe("yes");
		expect(env.HOST_SECRET).toBeUndefined();
		expect(env.OSPREYCODE_WORKSPACE).toBe(dirs.workspace);
		const data = join(dirs.root, "server-data", "user", "tools");
		expect(env.PLUGIN_ROOT).toBe(data);
		expect(env.PLUGIN_DATA).toBe(data);
		expect(existsSync(data)).toBe(true);
		// `npx`、`uvx` 这类启动方式写的缓存指到这个 server 自己的缓存目录里
		const cache = join(dirs.root, "server-cache", "user", "tools");
		expect(env.npm_config_cache).toBe(join(cache, "npm"));
		expect(env.UV_CACHE_DIR).toBe(join(cache, "uv"));
		expect(env.UV_TOOL_DIR).toBe(join(cache, "uv-tools"));
		expect(existsSync(cache)).toBe(true);
	});

	test("启动超过用户级配置的时限的 server 停掉，session 照常打开", async () => {
		writeFile(join(dirs.root, "config.toml"), "mcp_startup_timeout_sec = 1\n");
		userServer({ MCP_FIXTURE_START_DELAY_MS: "60000" });
		const started = Date.now();
		const current = await open();
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(current.mcpServers()).toMatchObject([
			{ label: "tools", status: "failed" },
		]);
		const detail = current.mcpServers()[0]?.detail;
		expect(detail).toContain("启动超过了 1 秒");
		expect(detail).toContain("mcp_startup_timeout_sec");
		await runTask();
		expect(toolNames(0).filter((name) => name.includes("__"))).toEqual([]);
	});

	test("启动时限写得不对时不打开 session", async () => {
		writeFile(join(dirs.root, "config.toml"), "mcp_startup_timeout_sec = 0\n");
		await expect(open()).rejects.toThrow(/mcp_startup_timeout_sec/);
	});

	test("server 的提问转给用户回答", async () => {
		userServer();
		const current = await open();
		answer = approveOnce;
		const task = runTask(call("tools__ask", {}));
		const question = await log.waitFor("elicitation.requested");
		expect(question).toMatchObject({
			server: "tools",
			message: "What is your name?",
			schema: { type: "object", required: ["name"] },
		});
		current.respond(question.request_id, {
			action: "accept",
			content: { name: "Ada" },
		});
		await task;
		expect(JSON.parse(output(results()[0]))).toEqual({
			action: "accept",
			content: { name: "Ada" },
		});
		expect(
			log.events.find((event) => event.type === "elicitation.answered"),
		).toMatchObject({ request_id: question.request_id, action: "accept" });
		// 用户填的内容不记进事件
		expect(
			JSON.stringify(
				log.events.filter((event) => event.type.startsWith("elicitation.")),
			),
		).not.toContain("Ada");
	});

	test("取消 task 时等着的提问答为取消", async () => {
		userServer();
		const current = await open();
		answer = approveOnce;
		const task = runTask(call("tools__ask", {}));
		const question = await log.waitFor("elicitation.requested");
		await current.cancel();
		expect(await task).toMatchObject({ outcome: "cancelled" });
		expect(
			await log.waitFor(
				"elicitation.answered",
				(event) => event.request_id === question.request_id,
			),
		).toMatchObject({ action: "cancel" });
	});

	test("审批策略是 never 时不声明能回答提问", async () => {
		userServer();
		const rules = join(dirs.root, "rules");
		mkdirSync(rules, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(rules, "mcp.toml"),
			'[[mcp_rules]]\nserver = "tools"\ntool = "ask"\ndecision = "allow"\n',
		);
		await open({ approvalPolicy: "never" });
		await runTask(call("tools__ask", {}));
		expect(
			log.events.filter((event) => event.type === "elicitation.requested"),
		).toEqual([]);
		expect(results()[0]?.status).toBe("failed");
	});

	test("server 中途退出：这次调用失败，下次调用时重启，最多三次", async () => {
		const marker = join(dirs.home, "started.log");
		userServer({ MCP_FIXTURE_LOG: marker });
		const current = await open();
		answer = approveOnce;
		await runTask(
			call("tools__exit", {}),
			call("tools__echo", { text: "回来了" }),
		);
		expect(results()).toMatchObject([
			{ status: "failed" },
			{ status: "succeeded" },
		]);
		expect(output(results()[0])).toContain("exited during the call");
		expect(output(results()[1])).toBe("回来了");
		expect(warnings().join("\n")).toContain("MCP server tools 退出了");
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);

		await runTask(
			call("tools__exit", {}),
			call("tools__exit", {}),
			call("tools__exit", {}),
			call("tools__echo", { text: "不行了" }),
		);
		expect(output(results().at(-1))).toContain(
			"has already been restarted 3 times",
		);
		expect(current.mcpServers()).toMatchObject([{ status: "exited" }]);
	});

	test("启动失败只影响这个 server：session 照常打开，状态里有原因", async () => {
		writeMcpConfig(join(dirs.root, "mcp.json"), {
			broken: {
				type: "stdio",
				command: "node",
				args: ["-e", "process.exit(3)"],
			},
			tools: fixtureServer(),
		});
		const current = await open();
		await runTask();
		const states = current.mcpServers();
		expect(states.map((state) => [state.label, state.status])).toEqual([
			["broken", "failed"],
			["tools", "connected"],
		]);
		expect(warnings().join("\n")).toContain("MCP server broken 没有启用");
		expect(toolNames(0)).toContain("tools__echo");
	});

	test("reload 之后停掉去掉的 server，工具列表随之更新", async () => {
		userServer();
		const current = await open();
		await runTask();
		expect(toolNames(0)).toContain("tools__echo");
		await host.extensions.removeMcpServer("tools");
		await current.reload();
		await runTask();
		expect(toolNames(1).filter((name) => name.includes("__"))).toEqual([]);
		expect(current.mcpServers()).toEqual([]);
	});

	test("协议版本的探测结果记下来，下次不为探测多启动一次", async () => {
		const marker = join(dirs.home, "started.log");
		userServer({ MCP_FIXTURE_LOG: marker });
		await open();
		await session?.close();
		// 第一次：探测用的进程和正式的进程各启动一次
		expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(2);
		log = new EventLog();
		await open();
		expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(3);
		expect(existsSync(join(dirs.root, "data", "mcp", "verdicts.json"))).toBe(
			true,
		);
	});

	test("关闭 session 时结束 server 进程", async () => {
		userServer();
		const current = await open();
		const pid = log.events.find(
			(event) =>
				event.type === "process.started" && event.kind === "mcp_server",
		);
		if (pid?.type !== "process.started") throw new Error("server 没有启动");
		await current.close();
		session = undefined;
		expect(() => process.kill(pid.pid, 0)).toThrow();
	});
});

describe("远程 MCP server 的地址", () => {
	test("连不上时 session 照常打开，状态是 failed", async () => {
		// 只接受 https：本地的测试 server 是 http，这里只验证失败不影响 session
		const server = createServer((_request, response) => {
			response.statusCode = 500;
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			writeMcpConfig(join(dirs.root, "mcp.json"), {
				remote: {
					type: "streamable-http",
					url: `https://127.0.0.1:${port}/mcp`,
				},
			});
			const current = await open();
			expect(current.mcpServers()).toMatchObject([
				{ label: "remote", transport: "streamable-http", status: "failed" },
			]);
		} finally {
			server.close();
		}
	});
});

describe.runIf(process.platform === "darwin")(
	"本地 MCP server 在沙盒里运行",
	() => {
		const sandboxed: Partial<SessionOptions> = {
			sandboxMode: "workspace-write",
		};

		test("和 session 的沙盒一样的范围，外加自己的数据目录；读不到 Host 的数据", async () => {
			userServer();
			writeFileSync(join(dirs.workspace, "note.txt"), "工作区里的文件\n");
			const current = await open(sandboxed);
			expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
			answer = approveOnce;
			const data = join(dirs.root, "server-data", "user", "tools");
			mkdirSync(join(dirs.workspace, ".git"));
			await runTask(
				call("tools__read", { path: join(dirs.workspace, "note.txt") }),
				call("tools__write", { path: join(dirs.workspace, "made.txt") }),
				call("tools__write", { path: join(dirs.workspace, ".git", "config") }),
				call("tools__write", { path: join(dirs.home, "outside.txt") }),
				call("tools__write", { path: join(data, "state.txt") }),
				call("tools__read", { path: join(dirs.root, "mcp.json") }),
				call("tools__write", { path: join(dirs.root, "mcp.json") }),
			);
			const [
				read,
				writeWorkspace,
				writeProtected,
				writeOutside,
				writeData,
				readRoot,
				writeRoot,
			] = results();
			expect(output(read)).toBe("工作区里的文件\n");
			expect(output(writeWorkspace)).toBe("written");
			expect(output(writeProtected)).toContain("EPERM");
			expect(output(writeOutside)).toContain("EPERM");
			expect(existsSync(join(dirs.home, "outside.txt"))).toBe(false);
			expect(output(writeData)).toBe("written");
			expect(existsSync(join(data, "state.txt"))).toBe(true);
			// Host 根目录整个读不到：server 改不了自己的定义，也看不到别的扩展的数据
			expect(output(readRoot)).toContain("EPERM");
			expect(output(writeRoot)).toContain("EPERM");
		});

		test("server 连没放行的域名时按 server 问用户，拒绝后连不上", async () => {
			userServer();
			const current = await open(sandboxed);
			answer = approveOnce;
			const task = runTask(
				call("tools__fetch", { url: "http://denied.example.invalid:8080/" }),
			);
			const question = await log.waitFor("server_approval.requested");
			expect(question).toMatchObject({
				kind: "network",
				server: "tools",
				request: { host: "denied.example.invalid", port: 8080 },
			});
			current.respond(question.request_id, { decision: "deny", scope: "once" });
			await task;
			expect(output(results()[0])).toBe("403");
			expect(
				log.events.find((event) => event.type === "server_approval.decided"),
			).toMatchObject({ request_id: question.request_id, decision: "denied" });
		});

		test("审批策略是 never 时 server 的联网请求直接拒绝", async () => {
			userServer();
			const rules = join(dirs.root, "rules");
			mkdirSync(rules, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(rules, "mcp.toml"),
				'[[mcp_rules]]\nserver = "tools"\ntool = "fetch"\ndecision = "allow"\n',
			);
			await open({ ...sandboxed, approvalPolicy: "never" });
			await runTask(
				call("tools__fetch", { url: "http://never.example.invalid:8080/" }),
			);
			expect(output(results()[0])).toBe("403");
			expect(
				log.events.filter(
					(event) => event.type === "server_approval.requested",
				),
			).toEqual([]);
		});

		test("第一次连接要探测协议版本：探测用的进程和正式的进程都在沙盒里跑完", async () => {
			userServer();
			expect(existsSync(join(dirs.root, "data", "mcp", "verdicts.json"))).toBe(
				false,
			);
			const current = await open(sandboxed);
			expect(current.mcpServers()).toMatchObject([
				{ status: "connected", protocol_version: "2026-07-28" },
			]);
		});

		test("server 能写自己的缓存目录，包管理器在里面建 .git 也行；项目的构建缓存它写不了", async () => {
			userServer();
			await open(sandboxed);
			answer = approveOnce;
			const cache = join(dirs.root, "server-cache", "user", "tools");
			const [project] = readdirSync(join(dirs.root, "cache"));
			const build = join(dirs.root, "cache", project as string, "poisoned");
			await runTask(
				call("tools__write", { path: join(cache, ".git") }),
				call("tools__write", { path: build }),
			);
			expect(output(results()[0])).toBe("written");
			expect(existsSync(join(cache, ".git"))).toBe(true);
			expect(output(results()[1])).toContain("EPERM");
			expect(existsSync(build)).toBe(false);
		});

		test("关闭 session 时结束 server 和它启动的进程", async () => {
			userServer();
			const current = await open(sandboxed);
			answer = approveOnce;
			await runTask(call("tools__env", {}));
			const started = log.events.flatMap((event) =>
				event.type === "process.started" && event.kind === "mcp_server"
					? [event.pid]
					: [],
			);
			expect(started).toHaveLength(1);
			await current.close();
			session = undefined;
			expect(() => process.kill(started[0] as number, 0)).toThrow();
		});
	},
);
