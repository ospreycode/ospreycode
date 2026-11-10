import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ConfigError,
	createHost,
	type HostOptions,
	type Session,
	SessionCommandError,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 脚本模型收到的每次请求。 */
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	requests = [];
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	expect(log.invalid).toEqual([]);
});

async function open(
	script: Script,
	host: Partial<HostOptions> = {},
	options: Partial<SessionOptions> = {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(request);
			return script(request, call);
		}),
		...host,
	}).openSession({
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

function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function reply(text: string): ScriptedTurn {
	return { content: [{ type: "text", text }] };
}

const hanging: ScriptedTurn = {
	content: [{ type: "text", text: "写到一半" }],
	hang: true,
};

/** 启动过的 agent 进程，按启动的顺序。 */
function agentPids(): number[] {
	return log.events.flatMap((event) =>
		event.type === "process.started" && event.kind === "agent"
			? [event.pid]
			: [],
	);
}

function killAgent(): number {
	const pid = agentPids().at(-1);
	if (pid === undefined) throw new Error("还没有 agent 进程");
	process.kill(pid, "SIGKILL");
	return pid;
}

async function ended(taskId: string) {
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/** 开始一个 task，等模型开始回复后杀掉 agent 进程，返回这个 task 的结果。 */
async function crashDuringTask(current: Session, input: string) {
	const taskId = await current.submit(input);
	await log.waitFor("model.delta", (event) => event.task_id === taskId);
	killAgent();
	return ended(taskId);
}

function indexOf(match: (event: EventLog["events"][number]) => boolean) {
	return log.events.findIndex(match);
}

describe("agent 进程异常退出", () => {
	test("task 中途被杀：run 记 failed 并带信号，session 保留；下一次输入起新的进程，模型请求以原来的历史为前缀", async () => {
		const current = await open((_request, call) =>
			call === 1 ? hanging : reply(`第 ${call} 次回答`),
		);
		await ended(await current.submit("第一个任务"));
		const second = await current.submit("第二个任务");
		await log.waitFor("model.delta", (event) => event.task_id === second);
		const killed = killAgent();

		expect(await ended(second)).toMatchObject({
			outcome: "failed",
			error: expect.stringContaining("SIGKILL"),
		});
		expect(await log.waitFor("process.exited")).toMatchObject({
			kind: "agent",
			pid: killed,
			signal: "SIGKILL",
		});
		expect((await log.waitFor("error")).message).toContain("SIGKILL");
		// 被中止的模型请求的结果和用量记在 task.ended 之前
		const cancelled = indexOf(
			(event) =>
				event.type === "message.completed" &&
				event.task_id === second &&
				event.message.stop_reason === "cancelled",
		);
		expect(cancelled).toBeGreaterThan(-1);
		expect(cancelled).toBeLessThan(
			indexOf(
				(event) => event.type === "task.ended" && event.task_id === second,
			),
		);

		const third = await current.submit("第三个任务");
		expect(await ended(third)).toMatchObject({ outcome: "completed" });
		const pids = agentPids();
		expect(pids).toHaveLength(2);
		expect(pids[1]).not.toBe(killed);
		expect(log.types()).not.toContain("session.ended");
		// 被打断的那次请求的消息原样在重启后第一次请求的开头，后面只多了新的输入
		const [, interrupted, resumed] = requests as [
			ModelRequest,
			ModelRequest,
			ModelRequest,
		];
		expect(resumed.messages.slice(0, interrupted.messages.length)).toEqual(
			interrupted.messages,
		);
		expect(resumed.messages.slice(interrupted.messages.length)).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "第三个任务" }] },
		]);
	});

	test("命令执行中被杀：Host 给这次调用补上结果，记在 task.ended 之前；重启后的历史里带着这条结果", async () => {
		const current = await open((_request, call) =>
			call === 0
				? {
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "shell",
								arguments: JSON.stringify({ command: "sleep 30" }),
							},
						],
					}
				: reply("完成"),
		);
		const first = await current.submit("等一会");
		const started = await log.waitFor("tool_call.started");
		killAgent();
		expect(await ended(first)).toMatchObject({ outcome: "failed" });
		const completed = await log.waitFor("tool_call.completed");
		expect(completed).toMatchObject({
			tool_call_id: started.tool_call_id,
			result: { status: "cancelled" },
		});
		expect(log.events.indexOf(completed)).toBeLessThan(
			indexOf((event) => event.type === "task.ended"),
		);

		expect(await ended(await current.submit("继续"))).toMatchObject({
			outcome: "completed",
		});
		const [before, after] = requests as [ModelRequest, ModelRequest];
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);
		expect(after.messages.slice(before.messages.length)).toMatchObject([
			{ role: "assistant", stop_reason: "tool_use" },
			{
				role: "tool_result",
				call_id: "call_1",
				tool_call_id: started.tool_call_id,
				content: completed.result.content,
				is_error: true,
			},
			{ role: "user", content: [{ type: "text", text: "继续" }] },
		]);
	});

	test("空闲时退出只发 warning，下一次输入照常开始 task", async () => {
		const current = await open((_request, call) => reply(`第 ${call} 次回答`));
		await ended(await current.submit("第一个任务"));
		killAgent();
		expect((await log.waitFor("warning")).message).toContain("SIGKILL");
		await log.waitFor("process.exited");

		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
		expect(agentPids()).toHaveLength(2);
		const [before, after] = requests as [ModelRequest, ModelRequest];
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);
		expect(after.messages.slice(before.messages.length)).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "第 0 次回答" }] },
			{ role: "user", content: [{ type: "text", text: "第二个任务" }] },
		]);
	});

	test("连续 3 次异常退出、中间没有正常结束的 task 才关闭 session；正常结束的 task 让计数重新开始", async () => {
		const turns = [hanging, hanging, reply("好"), hanging, hanging, hanging];
		const current = await open((_request, call) => turns[call] as ScriptedTurn);
		for (const input of ["一", "二"]) {
			expect(await crashDuringTask(current, input)).toMatchObject({
				outcome: "failed",
			});
		}
		expect(await ended(await current.submit("三"))).toMatchObject({
			outcome: "completed",
		});
		for (const input of ["四", "五"]) {
			expect(await crashDuringTask(current, input)).toMatchObject({
				outcome: "failed",
			});
		}
		expect(log.types()).not.toContain("session.ended");

		expect(await crashDuringTask(current, "六")).toMatchObject({
			outcome: "failed",
		});
		expect(await log.waitFor("session.ended")).toMatchObject({
			reason: "agent_exited",
		});
		await current.ended;
		expect(
			log.events.some(
				(event) =>
					event.type === "error" && event.message.includes("连续 3 次"),
			),
		).toBe(true);
		// 六个 task 里五个各杀掉一个进程，"三"正常结束后的进程接着跑"四"
		expect(agentPids()).toHaveLength(5);
		await expect(current.submit("七")).rejects.toThrow("session 已关闭");
	});

	test("发来不合规的消息：结束 agent 进程，run 记 failed；连续 3 次后 session 以 error 关闭", async () => {
		const current = await open(() => reply("不会用到"), {
			agentEntry: fixture("garbage-agent.mjs"),
		});
		const first = await current.submit("你好");
		expect(await ended(first)).toMatchObject({
			outcome: "failed",
			error: expect.stringContaining("JSON"),
		});
		expect((await log.waitFor("error")).message).toContain("JSON");
		expect(log.types()).not.toContain("session.ended");

		for (const input of ["再来", "最后一次"]) {
			expect(await ended(await current.submit(input))).toMatchObject({
				outcome: "failed",
			});
		}
		expect(await log.waitFor("session.ended")).toMatchObject({
			reason: "error",
		});
		await current.ended;
	});
});

describe("取消超时", () => {
	test("取消后 runtime 5 秒内没有结束 task：run 记 cancelled，重启 agent 进程；重启期间的输入等新进程握手完成后开始", {
		timeout: 20_000,
	}, async () => {
		const current = await open(() => reply("不会用到"), {
			agentEntry: fixture("stuck-agent.mjs"),
		});
		const first = await current.submit("你好");
		const [stuck] = agentPids();
		await current.cancel();
		expect(await ended(first)).toMatchObject({ outcome: "cancelled" });
		// 这时旧进程已经结束、新进程还没有握手
		expect(agentPids()).toEqual([stuck]);
		const second = await current.submit("再来");
		const pids = agentPids();
		expect(pids).toHaveLength(2);
		expect(pids[1]).not.toBe(stuck);
		expect(await log.waitFor("process.exited")).toMatchObject({ pid: stuck });
		expect(
			indexOf(
				(event) => event.type === "process.started" && event.pid === pids[1],
			),
		).toBeLessThan(
			indexOf(
				(event) => event.type === "task.started" && event.task_id === second,
			),
		);
		expect(log.types()).not.toContain("session.ended");
	});
});

describe("重新加载配置", () => {
	function userConfig(text: string): void {
		writeFileSync(join(dirs.root, "config.toml"), text);
	}

	test("重新读取配置并重启 agent 进程：新的配置在下一个 task 生效，历史照旧", async () => {
		const current = await open((_request, call) => reply(`第 ${call} 次回答`));
		await ended(await current.submit("第一个任务"));
		const [before] = requests as [ModelRequest];

		userConfig('reasoning_effort = "high"\n');
		await current.reload();
		expect(agentPids()).toHaveLength(2);
		await ended(await current.submit("第二个任务"));

		const after = requests[1] as ModelRequest;
		expect(before.reasoning_effort).not.toBe("high");
		expect(after.reasoning_effort).toBe("high");
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);
	});

	test("task 一开始就被取消：runtime 那时报告的系统指令照样记下，之后重启能重建历史", async () => {
		const current = await open((_request, call) => reply(`第 ${call} 次回答`));
		const cancelled = await current.submit("马上取消的任务");
		await current.cancel();
		expect(await ended(cancelled)).toMatchObject({ outcome: "cancelled" });
		await ended(await current.submit("第二个任务"));
		const [before] = requests as [ModelRequest];

		await current.reload();
		expect(await ended(await current.submit("第三个任务"))).toMatchObject({
			outcome: "completed",
		});
		const after = requests[1] as ModelRequest;
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);
		expect(log.types()).not.toContain("warning");
	});

	test("config() 是当前生效的配置：会话中换的设置马上并进来，配置文件的改动到重新加载才进来", async () => {
		const current = await open(() => reply("好"));
		expect(current.config()).toMatchObject({
			sandboxMode: "danger-full-access",
			approvalPolicy: "never",
		});

		userConfig('reasoning_effort = "high"\n');
		current.setApprovalPolicy("on-request");
		expect(current.config().approvalPolicy).toBe("on-request");
		expect(current.config().reasoningEffort).not.toBe("high");

		await current.reload();
		expect(current.config()).toMatchObject({
			approvalPolicy: "on-request",
			reasoningEffort: "high",
		});
	});

	test("配置有错时抛出 ConfigError，session 照旧用原来的配置", async () => {
		const current = await open((_request, call) => reply(`第 ${call} 次回答`));
		await ended(await current.submit("第一个任务"));

		userConfig("no_such_key = 1\n");
		await expect(current.reload()).rejects.toBeInstanceOf(ConfigError);
		expect(agentPids()).toHaveLength(1);
		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
	});

	test("task 运行时不能重新加载", async () => {
		const current = await open(() => hanging);
		const task = await current.submit("写一首长诗");
		await log.waitFor("model.delta");
		await expect(current.reload()).rejects.toBeInstanceOf(SessionCommandError);
		expect(agentPids()).toHaveLength(1);
		await current.cancel();
		expect(await ended(task)).toMatchObject({ outcome: "cancelled" });
	});
});

describe("切换沙盒模式", () => {
	test("danger-full-access 只能在启动时指定，运行中不能切换过去", async () => {
		const current = await open(
			() => reply("好"),
			{},
			{
				sandboxMode: "danger-full-access",
			},
		);
		// 已经在这个模式下：什么都不做
		await current.setSandboxMode("danger-full-access");
		await expect(current.setSandboxMode("no-such-mode")).rejects.toBeInstanceOf(
			ConfigError,
		);
		expect(agentPids()).toHaveLength(1);
		expect(log.types()).not.toContain("sandbox_mode.changed");
	});

	describe.runIf(process.platform === "darwin")("macOS 真实沙盒", () => {
		test("空闲时切换：按新模式重启 agent 进程，记下 sandbox_mode.changed，历史照旧；不能切到 danger-full-access", async () => {
			const current = await open(
				(_request, call) => reply(`第 ${call} 次回答`),
				{},
				{ sandboxMode: "workspace-write", approvalPolicy: "on-request" },
			);
			await ended(await current.submit("第一个任务"));
			const [before] = requests as [ModelRequest];

			await expect(
				current.setSandboxMode("danger-full-access"),
			).rejects.toBeInstanceOf(SessionCommandError);
			await current.setSandboxMode("read-only");
			expect(await log.waitFor("sandbox_mode.changed")).toMatchObject({
				from: "workspace-write",
				to: "read-only",
			});
			expect(agentPids()).toHaveLength(2);

			expect(await ended(await current.submit("第二个任务"))).toMatchObject({
				outcome: "completed",
			});
			const after = requests[1] as ModelRequest;
			expect(after.messages.slice(0, before.messages.length)).toEqual(
				before.messages,
			);
			// 系统指令里写着沙盒模式：变化作为补丁追加，不改写已经发出的消息
			expect(
				JSON.stringify(after.messages.slice(before.messages.length)),
			).toContain("read-only");
		});

		test("验收：切换后新进程的第一次请求原样带着之前发过的全部消息（系统指令、规则文件、工具调用和结果）和最后一条回复，只多出新的输入和沙盒模式的补丁；工具声明和请求参数不变", async () => {
			writeFileSync(
				join(dirs.workspace, "AGENTS.md"),
				"# 规则\n\n回答用中文。\n",
			);
			const shell = (command: string): ScriptedTurn => ({
				content: [
					{
						type: "tool_call",
						call_id: `call_${requests.length}`,
						name: "shell",
						arguments: JSON.stringify({ command }),
					},
				],
			});
			const turns = [
				shell("echo one > a.txt; cat a.txt"),
				reply("第一次做完"),
				shell("ls"),
				reply("第二次做完"),
			];
			const current = await open(
				(_request, call) => turns[call] ?? reply(`第 ${call} 次回答`),
				{},
				{ sandboxMode: "workspace-write", approvalPolicy: "on-request" },
			);
			await ended(await current.submit("第一个任务"));
			await ended(await current.submit("第二个任务"));
			expect(requests.at(-1)?.messages.map((message) => message.role)).toEqual([
				"system",
				// 规则文件
				"user",
				"user",
				"assistant",
				"tool_result",
				"assistant",
				"user",
				"assistant",
				"tool_result",
			]);

			for (const [mode, input] of [
				["read-only", "第三个任务"],
				["workspace-write", "第四个任务"],
			] as const) {
				const before = requests.at(-1) as ModelRequest;
				const lastReply = log.events.findLast(
					(event) => event.type === "message.completed",
				);
				await current.setSandboxMode(mode);
				expect(await ended(await current.submit(input))).toMatchObject({
					outcome: "completed",
				});

				const after = requests.at(-1) as ModelRequest;
				const sent = before.messages.length;
				// 消息的标识也一样：是从 session 记录重建的同一批消息，不是重新生成的
				expect(after.messages.slice(0, sent)).toEqual(before.messages);
				expect(after.messages[sent]).toEqual(lastReply?.message);
				expect(after.messages.slice(sent + 1)).toMatchObject([
					{ role: "user", content: [{ type: "text", text: input }] },
					{
						role: "system",
						content: [
							{
								type: "text",
								text: expect.stringContaining(`Sandbox mode: ${mode}`),
							},
						],
					},
				]);
				expect({ ...after, messages: [] }).toEqual({ ...before, messages: [] });
			}
			expect(agentPids()).toHaveLength(3);
		});

		test("task 运行时不能切换", async () => {
			const current = await open(
				() => hanging,
				{},
				{ sandboxMode: "workspace-write", approvalPolicy: "on-request" },
			);
			const task = await current.submit("写一首长诗");
			await log.waitFor("model.delta");
			await expect(current.setSandboxMode("read-only")).rejects.toBeInstanceOf(
				SessionCommandError,
			);
			expect(log.types()).not.toContain("sandbox_mode.changed");
			await current.cancel();
			expect(await ended(task)).toMatchObject({ outcome: "cancelled" });
		});
	});
});

// Linux 上 agent 沙盒的保护停在它启动的时刻：task 里新建的仓库要靠 task 结束时的扫描发现
describe.runIf(process.platform === "linux")("Linux 上发现新仓库", () => {
	function shell(command: string): ScriptedTurn {
		return {
			content: [
				{
					type: "tool_call",
					call_id: "call_1",
					name: "shell",
					arguments: JSON.stringify({ command }),
				},
			],
		};
	}

	const sandboxed = {
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
	} as const;

	test("task 里新建了仓库：task 结束后重启 agent 进程，下一个 task 等它做完，历史照旧", async () => {
		const current = await open(
			(_request, call) =>
				call === 0 ? shell("git init -q sub") : reply(`第 ${call} 次回答`),
			{},
			sandboxed,
		);
		await ended(await current.submit("建一个仓库"));
		const before = requests[1] as ModelRequest;

		// 紧接着的输入等扫描和重启做完，由新的进程处理
		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
		expect(agentPids()).toHaveLength(2);
		const after = requests[2] as ModelRequest;
		expect(after.messages.slice(0, before.messages.length)).toEqual(
			before.messages,
		);

		// 仓库的集合没有再变：不再重启
		await ended(await current.submit("第三个任务"));
		expect(agentPids()).toHaveLength(2);
	});

	test("task 结束后马上切换沙盒模式：等扫描做完再切换，不当成 session 在忙", async () => {
		const current = await open(() => reply("好了"), {}, sandboxed);
		await ended(await current.submit("第一个任务"));

		await current.setSandboxMode("read-only");

		expect(await log.waitFor("sandbox_mode.changed")).toMatchObject({
			from: "workspace-write",
			to: "read-only",
		});
		expect(await ended(await current.submit("第二个任务"))).toMatchObject({
			outcome: "completed",
		});
	});

	test("新出现的其他受保护路径只提醒，不重启", async () => {
		const current = await open(
			(_request, call) =>
				call === 0 ? shell("mkdir sub && touch sub/.envrc") : reply("好了"),
			{},
			sandboxed,
		);
		await ended(await current.submit("建一个 .envrc"));
		const warning = await log.waitFor("warning", (event) =>
			event.message.includes("新出现了受保护的路径"),
		);
		expect(warning.message).toContain(join(dirs.workspace, "sub", ".envrc"));
		await ended(await current.submit("第二个任务"));
		expect(agentPids()).toHaveLength(1);
	});
});
