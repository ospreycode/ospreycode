import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
	type ApprovalRequestedEvent,
	ConfigError,
	createHost,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
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
/** 工作区之外的一个目录。 */
let outside: string;
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;
/** Host 进程的环境变量里多出来的项。 */
let hostEnv: Record<string, string>;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	answer = undefined;
	hostEnv = {};
	outside = join(dirs.home, "outside");
	mkdirSync(outside);
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

const shell = (command: string, extra: object = {}) =>
	call("shell", { command, ...extra });

const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };

/** 打开 session：模型依次给出 `turns` 里的回复，用完之后回复一句话。 */
async function open(
	turns: ScriptedTurn[],
	options: Partial<SessionOptions> = {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: { ...dirs.env, ...hostEnv },
		credentialStore: null,
		streamModel: scriptedModel((_request, index) => turns[index] ?? done),
	}).openSession({
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

async function runTask(input: string) {
	if (session === undefined) throw new Error("session 还没有打开");
	const taskId = await session.submit(input);
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

function results(): ToolResult[] {
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result] : [],
	);
}

function asked(): ApprovalRequestedEvent[] {
	return log.events.filter((event) => event.type === "approval.requested");
}

/** 每次询问列出的理由；预算的询问没有理由。 */
function reasons(): string[][] {
	return asked().map((event) => (event.kind === "budget" ? [] : event.reasons));
}

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/** 写一份用户级的权限规则文件。 */
function userRules(name: string, content: string): string {
	const dir = join(dirs.root, "rules");
	// Host 根目录要求权限为 700
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

const approveOnce = (): ApprovalAnswer => ({
	decision: "approve",
	scope: "once",
});

describe("权限规则（没有沙盒也照常起作用）", () => {
	test("forbidden 直接拒绝并带上理由，prompt 每次询问，没有规则的命令直接执行", async () => {
		userRules(
			"team.toml",
			`
[[rules]]
pattern = ["echo", "deploy"]
decision = "forbidden"
justification = "Use the release script instead."

[[rules]]
pattern = ["echo", "review"]
decision = "prompt"
justification = "Reviews go out to the whole team."
`,
		);
		answer = approveOnce;
		await open([
			shell("echo deploy now"),
			shell("echo review please"),
			shell("echo review again"),
			shell("echo plain"),
		]);
		await runTask("按规则判断");

		expect(results()).toMatchObject([
			{ status: "denied", reason: "forbidden_rule" },
			{ status: "succeeded" },
			{ status: "succeeded" },
			{ status: "succeeded" },
		]);
		expect(output(results()[0])).toContain("Use the release script instead.");
		expect(asked()).toMatchObject([
			{
				kind: "tool_call",
				request: { kind: "command", command: "echo review please" },
				reasons: ["Reviews go out to the whole team."],
			},
			{ request: { command: "echo review again" } },
		]);
	});

	test("强制删除先询问；用户级的 allow 规则盖过它", async () => {
		mkdirSync(join(dirs.workspace, "build"));
		mkdirSync(join(dirs.workspace, "dist"));
		answer = () => ({ decision: "deny", scope: "once" });
		await open([shell("rm -rf build")]);
		await runTask("没有规则");
		expect(results()).toMatchObject([{ status: "denied", reason: "user" }]);
		expect(asked()).toMatchObject([{ reasons: ["强制删除：rm -rf build"] }]);
		expect(existsSync(join(dirs.workspace, "build"))).toBe(true);
		await session?.close();

		userRules(
			"allow.toml",
			'[[rules]]\npattern = ["rm"]\ndecision = "allow"\n',
		);
		log = new EventLog();
		await open([shell("rm -rf dist")]);
		await runTask("有 allow 规则");
		expect(results()).toMatchObject([{ status: "succeeded" }]);
		expect(asked()).toEqual([]);
		expect(existsSync(join(dirs.workspace, "dist"))).toBe(false);
	});

	test("被审批策略拒绝的结果写明要询问的类别：prompt 规则和危险命令判断分得开", async () => {
		userRules(
			"prompt.toml",
			'[[rules]]\npattern = ["echo", "review"]\ndecision = "prompt"\n',
		);
		mkdirSync(join(dirs.workspace, "build"));
		await open(
			[
				shell("echo review please"),
				shell("rm -rf build"),
				shell("rm -rf build && echo review"),
			],
			{ approvalPolicy: "never" },
		);
		await runTask("都不询问");

		expect(results()).toMatchObject([
			{ status: "denied", reason: "policy", categories: ["rules"] },
			{ status: "denied", reason: "policy", categories: ["dangerous_command"] },
			{
				status: "denied",
				reason: "policy",
				categories: ["rules", "dangerous_command"],
			},
		]);
		expect(asked()).toEqual([]);
		expect(existsSync(join(dirs.workspace, "build"))).toBe(true);
	});

	test("内置的 forbidden 任何模式下都拒绝：提权、碰 Host 根目录和凭据文件", async () => {
		await open(
			[
				shell("sudo ls"),
				shell(`cat '${join(dirs.root, "config.toml")}'`),
				shell(`cat '${dirs.credentialFile}'`),
			],
			{ approvalPolicy: "never" },
		);
		await runTask("内置规则");

		expect(results()).toMatchObject(
			Array.from({ length: 3 }, () => ({
				status: "denied",
				reason: "forbidden_rule",
			})),
		);
		expect(output(results()[2])).not.toContain("test-key");
	});

	test("启动参数指定的权限规则文件生效；仓库里的规则只能收紧，写了 allow 就打不开 session", async () => {
		const startup = join(dirs.home, "startup.toml");
		writeFileSync(
			startup,
			'[[rules]]\npattern = ["echo", "startup"]\ndecision = "forbidden"\n',
		);
		const repoRules = join(dirs.workspace, ".ospreycode", "rules");
		mkdirSync(repoRules, { recursive: true });
		writeFileSync(
			join(repoRules, "repo.toml"),
			'[[rules]]\npattern = ["echo", "repo"]\ndecision = "forbidden"\n',
		);
		await open([shell("echo startup"), shell("echo repo")], {
			rules: [startup],
		});
		await runTask("两处的规则");
		expect(results()).toMatchObject([
			{ status: "denied", reason: "forbidden_rule" },
			{ status: "denied", reason: "forbidden_rule" },
		]);
		await session?.close();
		session = undefined;

		writeFileSync(
			join(repoRules, "repo.toml"),
			'[[rules]]\npattern = ["echo"]\ndecision = "allow"\n',
		);
		await expect(open([])).rejects.toThrow(ConfigError);
		await expect(
			open([], { rules: [join(dirs.home, "missing.toml")] }),
		).rejects.toThrow("不存在");
	});
});

describe("切换审批策略", () => {
	test("挂起的询问在新策略下不该再问时立即拒绝，之后的申请不再询问", async () => {
		mkdirSync(join(dirs.workspace, "build"));
		const current = await open([shell("rm -rf build"), shell("rm -rf build")]);
		const taskId = await current.submit("强制删除");
		const question = await log.waitFor("approval.requested");

		current.setApprovalPolicy("never");

		await log.waitFor("task.ended", (event) => event.task_id === taskId);
		expect(
			log.events.filter((event) => event.type === "approval.decided"),
		).toMatchObject([
			{ request_id: question.request_id, decision: "denied_by_policy" },
		]);
		expect(
			log.events.filter((event) => event.type === "approval_policy.changed"),
		).toMatchObject([{ from: "on-request", to: "never" }]);
		// 等着回答时被新策略拒绝的那一次，和之后直接拒绝的一样写明类别
		expect(results()).toMatchObject([
			{ status: "denied", reason: "policy", categories: ["dangerous_command"] },
			{ status: "denied", reason: "policy", categories: ["dangerous_command"] },
		]);
		expect(asked()).toHaveLength(1);
		expect(existsSync(join(dirs.workspace, "build"))).toBe(true);
		// 已经有了结果的询问不能再回答
		expect(current.respond(question.request_id, approveOnce())).toBe(false);
	});

	test("granular 关掉的类别不询问，其余类别照常询问；类别没写全时报错", async () => {
		userRules(
			"prompt.toml",
			'[[rules]]\npattern = ["echo", "review"]\ndecision = "prompt"\n',
		);
		mkdirSync(join(dirs.workspace, "build"));
		answer = approveOnce;
		const current = await open([shell("rm -rf build"), shell("echo review")]);
		expect(() =>
			current.setApprovalPolicy("granular", { sandbox_approval: false }),
		).toThrow(ConfigError);
		current.setApprovalPolicy("granular", {
			sandbox_approval: false,
			rules: true,
			request_permissions: true,
			skill_approval: true,
			mcp_elicitations: true,
			mcp_tools: true,
			network: true,
		});
		await runTask("按类别");

		expect(results()).toMatchObject([
			{ status: "denied", reason: "policy", categories: ["dangerous_command"] },
			{ status: "succeeded" },
		]);
		expect(asked()).toMatchObject([{ request: { command: "echo review" } }]);
	});
});

test("Host 的环境变量里没有 HOME 时打不开 session：密钥位置和权限规则都相对它", async () => {
	const host = createHost({
		root: dirs.root,
		env: { PATH: dirs.env.PATH },
		credentialStore: null,
		streamModel: scriptedModel(() => done),
	});

	await expect(
		host.openSession({
			workspace: dirs.workspace,
			model: "scripted",
			models: { scripted: testModel },
			credentials: { test: { file: dirs.credentialFile } },
			sandboxMode: "danger-full-access",
			approvalPolicy: "on-request",
			onEvent: (event) => log.push(event),
		}),
	).rejects.toThrow(/没有 HOME/);
});

// 真实沙盒的测试每个都要启动几个进程，机器忙的时候（CI 的 runner、同时在跑别的测试）默认的 5 秒不够
describe.runIf(process.platform === "darwin")(
	"沙盒模式下（macOS 真实沙盒，脚本模型）",
	{ timeout: 20_000 },
	() => {
		const sandboxed = {
			sandboxMode: "workspace-write",
			approvalPolicy: "on-request",
		} as const;
		const networkAsks = () =>
			asked().filter((event) => event.kind === "network");
		/** 经沙盒的代理请求一个解析不了的域名：代理在连接之前先问。 */
		const fetch = (host: string) =>
			shell(
				`curl -s -o /dev/null -w '%{http_code}' --max-time 20 'http://${host}:8080/'`,
			);

		describe("网络访问的审批", () => {
			test("名单之外的域名询问用户：拒绝的原因写进命令的结果，本任务内允许后不再问，下一个任务重新问", async () => {
				const answers: ApprovalAnswer[] = [
					{ decision: "deny", scope: "once", message: "not this one" },
					{ decision: "approve", scope: "task" },
					{ decision: "deny", scope: "once" },
				];
				answer = () => answers.shift() as ApprovalAnswer;
				await open(
					[
						fetch("denied.example.invalid"),
						fetch("allowed.example.invalid"),
						fetch("allowed.example.invalid"),
						done,
						fetch("allowed.example.invalid"),
					],
					sandboxed,
				);
				await runTask("第一个任务");

				expect(networkAsks()).toMatchObject([
					{
						kind: "network",
						request: {
							kind: "network",
							host: "denied.example.invalid",
							port: 8080,
						},
						tool_call_id: expect.any(String),
					},
					{ request: { host: "allowed.example.invalid" } },
				]);
				expect(output(results()[0])).toContain("403");
				expect(output(results()[0])).toContain(
					"Network access to denied.example.invalid was denied: The user denied it and said: not this one",
				);
				// 放行之后由代理去连，域名解析不了，但不再是代理自己拒绝的 403
				expect(output(results()[1])).not.toContain("403");
				expect(output(results()[1])).not.toContain("was denied");
				expect(output(results()[2])).not.toContain("403");

				await runTask("第二个任务");
				expect(networkAsks()).toHaveLength(3);
				expect(output(results()[3])).toContain(
					"Network access to allowed.example.invalid was denied: The user denied it.",
				);
			});

			test("有后台命令在运行时分不出连接是谁发起的：不记到前台调用名下，列出两边供参考，拒绝作为警告告诉用户", async () => {
				answer = () => ({ decision: "deny", scope: "once" });
				await open(
					[
						shell("sleep 30", { background: true }),
						fetch("shared.example.invalid"),
					],
					sandboxed,
				);
				await runTask("后台有命令在跑");

				const [started] = log.events.filter(
					(event) => event.type === "background.started",
				);
				const calls = log.events.filter(
					(event) => event.type === "tool_call.started",
				);
				const [ask] = networkAsks();
				expect(ask).toMatchObject({
					kind: "network",
					request: { host: "shared.example.invalid", port: 8080 },
					running_tool_calls: [calls[1]?.tool_call_id],
					running_background: [started?.background_id],
					reasons: [
						"申请访问 shared.example.invalid:8080",
						expect.stringContaining("命令沙盒"),
					],
				});
				expect(ask).not.toHaveProperty("tool_call_id");
				// 归属不明的拒绝不写进哪一个工具调用的结果
				expect(output(results()[1])).not.toContain("was denied");
				expect(
					log.events
						.filter((event) => event.type === "warning")
						.map((event) => event.message),
				).toContainEqual(
					expect.stringContaining(
						"Network access to shared.example.invalid was denied",
					),
				);
			});

			test("保存为规则：域名规则追加到用户级的 rules/default.toml，之后的任务和新的 session 都不再问", async () => {
				answer = () => ({ decision: "approve", scope: "rule" });
				const turns = [
					fetch("saved.example.invalid"),
					done,
					fetch("saved.example.invalid"),
				];
				await open(turns, sandboxed);
				await runTask("第一个任务");
				await runTask("第二个任务");

				expect(networkAsks()).toHaveLength(1);
				const saved = readFileSync(
					join(dirs.root, "rules", "default.toml"),
					"utf8",
				);
				expect(saved).toContain("[[network_rules]]");
				expect(saved).toContain('host = "saved.example.invalid"');
				expect(saved).toContain('decision = "allow"');
				await session?.close();

				log = new EventLog();
				await open([fetch("saved.example.invalid")], sandboxed);
				await runTask("新的 session");
				expect(asked()).toEqual([]);
				expect(output(results()[0])).not.toContain("403");
			});

			test("拒绝并保存为禁止的规则：域名规则追加到用户级的 rules/default.toml，之后不再询问，request_permissions 也放不开", async () => {
				answer = () => ({ decision: "deny", scope: "rule" });
				await open(
					[
						fetch("banned.example.invalid"),
						done,
						fetch("banned.example.invalid"),
						call("request_permissions", {
							network: ["banned.example.invalid"],
						}),
					],
					sandboxed,
				);
				await runTask("第一个任务");
				await runTask("第二个任务");

				expect(asked()).toHaveLength(1);
				const saved = readFileSync(
					join(dirs.root, "rules", "default.toml"),
					"utf8",
				);
				expect(saved).toContain("[[network_rules]]");
				expect(saved).toContain('host = "banned.example.invalid"');
				expect(saved).toContain('decision = "forbidden"');
				expect(output(results()[0])).toContain("403");
				expect(output(results()[1])).toContain("403");
				expect(results()[2]).toMatchObject({
					status: "denied",
					reason: "forbidden_rule",
				});
			});

			test("同一个域名同时有几个连接在等时只问一次，回答对它们都生效", async () => {
				const curl = `curl -s -o /dev/null -w '%{http_code}\\n' --max-time 20 'http://twice.example.invalid:8080/'`;
				await open([shell(`${curl} & ${curl} & wait`)], sandboxed);
				const task = runTask("两个连接");
				const ask = await log.waitFor("approval.requested");
				// 留出时间让第二个连接也到代理：没有合并的话它会再问一次
				await new Promise((resolve) => setTimeout(resolve, 1000));
				session?.respond(ask.request_id, { decision: "deny", scope: "once" });
				await task;

				expect(networkAsks()).toHaveLength(1);
				expect(output(results()[0]).match(/403/g)).toHaveLength(2);
			});

			test("审批策略为 never 时不询问直接拒绝；forbidden 的域名规则在 on-request 下也不询问", async () => {
				await open([fetch("never.example.invalid")], {
					...sandboxed,
					approvalPolicy: "never",
				});
				await runTask("不询问");
				expect(asked()).toEqual([]);
				expect(output(results()[0])).toContain(
					"Network access to never.example.invalid was denied",
				);
				await session?.close();

				userRules(
					"network.toml",
					'[[network_rules]]\nhost = "*.blocked.example.invalid"\ndecision = "forbidden"\n',
				);
				log = new EventLog();
				answer = approveOnce;
				await open(
					[
						fetch("api.blocked.example.invalid"),
						call("request_permissions", {
							network: ["api.blocked.example.invalid"],
						}),
					],
					sandboxed,
				);
				await runTask("规则禁止");
				expect(asked()).toEqual([]);
				expect(output(results()[0])).toContain("403");
				expect(results()[1]).toMatchObject({
					status: "denied",
					reason: "forbidden_rule",
				});
			});

			test("request_permissions 申请的域名批下来后本任务内不再问；用户可以只批其中一部分", async () => {
				answer = (event) =>
					event.kind === "network"
						? { decision: "deny", scope: "once" }
						: {
								decision: "approve",
								scope: "task",
								granted: { network: ["one.example.invalid"] },
							};
				await open(
					[
						call("request_permissions", {
							network: ["One.Example.invalid", "two.example.invalid"],
							justification: "The install downloads from both.",
						}),
						fetch("one.example.invalid"),
						fetch("two.example.invalid"),
					],
					sandboxed,
				);
				await runTask("申请域名");

				expect(asked()[0]).toMatchObject({
					kind: "tool_call",
					request: {
						kind: "permissions",
						network: ["one.example.invalid", "two.example.invalid"],
					},
					reasons: [
						"申请在本任务内访问 one.example.invalid",
						"申请在本任务内访问 two.example.invalid",
					],
				});
				expect(output(results()[0])).toContain(
					"- network: one.example.invalid",
				);
				expect(output(results()[0])).toContain(
					"Not granted:\n- network: two.example.invalid",
				);
				// 批下来的不再问，没批的照常问
				expect(networkAsks()).toMatchObject([
					{ request: { host: "two.example.invalid" } },
				]);
				expect(output(results()[1])).not.toContain("403");
				expect(output(results()[2])).toContain("403");
			});
		});

		describe("越界申请", () => {
			test("require_escalated 批准后能写工作区之外；Host 根目录、shell 初始化文件和受保护的路径仍然写不了", async () => {
				answer = approveOnce;
				const escalated = (command: string) =>
					shell(command, { sandbox_permissions: "require_escalated" });
				const denied = [
					join(dirs.root, "config.toml"),
					join(dirs.home, ".zshenv"),
					join(dirs.workspace, ".vscode", "tasks.json"),
				];
				await open(
					[
						shell(`echo x > '${join(outside, "plain.txt")}'`),
						escalated(`echo x > '${join(outside, "escalated.txt")}'`),
						...denied.map((path) =>
							escalated(`mkdir -p "$(dirname '${path}')"; echo x > '${path}'`),
						),
					],
					sandboxed,
				);
				await runTask("越界执行");

				expect(results().map((result) => result.status)).toEqual([
					"failed",
					"succeeded",
					// Host 根目录里的路径不拿去问用户，按内置规则拒绝
					"denied",
					"failed",
					"failed",
				]);
				expect(asked()[0]).toMatchObject({
					request: { sandbox_permissions: "require_escalated" },
					reasons: ["申请在沙盒的文件限制之外运行这条命令"],
				});
				expect(existsSync(join(outside, "plain.txt"))).toBe(false);
				expect(existsSync(join(outside, "escalated.txt"))).toBe(true);
				for (const path of denied) expect(existsSync(path), path).toBe(false);
			});

			test("require_escalated 的询问不能保存为规则，附了 prefix_rule 也一样：规则声明不了这项权限", async () => {
				answer = approveOnce;
				await open(
					[
						shell(`touch '${join(outside, "escalated.txt")}'`, {
							sandbox_permissions: "require_escalated",
							prefix_rule: ["touch"],
						}),
					],
					sandboxed,
				);
				await runTask("越界执行");

				expect(results()).toMatchObject([{ status: "succeeded" }]);
				expect(asked()).toHaveLength(1);
				expect(asked()[0]).not.toHaveProperty("suggested_rule");
			});

			test("保存为规则：批准的命令前缀和权限一起存下来，之后同样的调用不再问；改用别的可执行文件照常问", async () => {
				answer = () => ({ decision: "approve", scope: "rule" });
				const write = (file: string, command = "touch") =>
					shell(`${command} '${join(outside, file)}'`, {
						sandbox_permissions: "with_additional_permissions",
						additional_permissions: { file_system: { write: [outside] } },
						prefix_rule: ["touch"],
					});
				writeFileSync(
					join(dirs.workspace, "touch"),
					'#!/bin/sh\n/usr/bin/touch "$@"\n',
					{ mode: 0o755 },
				);
				await open(
					[
						write("first.txt"),
						done,
						write("second.txt"),
						write("x", "./touch"),
					],
					sandboxed,
				);
				await runTask("第一个任务");

				expect(asked()).toMatchObject([
					{
						suggested_rule: {
							pattern: ["touch"],
							decision: "allow",
							permissions: { file_system: { write: [outside] } },
						},
					},
				]);
				const saved = readFileSync(
					join(dirs.root, "rules", "default.toml"),
					"utf8",
				);
				expect(saved).toContain("[[rules]]");
				expect(saved).toContain('pattern = [ "touch" ]');

				answer = () => ({ decision: "deny", scope: "once" });
				await runTask("第二个任务");
				expect(results().map((result) => result.status)).toEqual([
					"succeeded",
					"succeeded",
					"denied",
				]);
				expect(asked()).toHaveLength(2);
				expect(existsSync(join(outside, "second.txt"))).toBe(true);
			});

			test("unix_sockets 和 local_binding 各自询问，批准后只这一条命令能用", async () => {
				const socket = join(outside, "s.sock");
				const server: Server = createServer((connection) =>
					connection.end("hello from socket\n"),
				);
				await new Promise<void>((resolve) => server.listen(socket, resolve));
				answer = approveOnce;
				const connect = `nc -U '${socket}' < /dev/null`;
				const listen = `'${process.execPath}' -e "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log('listening'); this.close(); }).on('error', (error) => { console.log(error.code); process.exitCode = 1; })"`;
				try {
					await open(
						[
							shell(connect),
							shell(connect, {
								sandbox_permissions: "with_additional_permissions",
								additional_permissions: { unix_sockets: [socket] },
							}),
							shell(listen),
							shell(listen, {
								sandbox_permissions: "with_additional_permissions",
								additional_permissions: { local_binding: true },
							}),
							shell(connect),
						],
						sandboxed,
					);
					await runTask("本机服务");
				} finally {
					await new Promise((resolve) => server.close(resolve));
				}

				expect(results().map((result) => result.status)).toEqual([
					"failed",
					"succeeded",
					"failed",
					"succeeded",
					"failed",
				]);
				expect(output(results()[1])).toContain("hello from socket");
				expect(output(results()[3])).toContain("listening");
				expect(reasons()).toEqual([
					[`申请连接 Unix socket ${socket}`],
					[expect.stringContaining("本机所有端口")],
				]);
			});

			test("Docker 的 socket 只能逐条命令批准：询问说明后果、不带建议的规则，选了本任务内允许下一条照样问", async () => {
				const plain = join(outside, "s.sock");
				const docker = join(outside, "docker.sock");
				const servers = [plain, docker].map((path) => {
					const server = createHttpServer((_request, response) =>
						response.end("hello from socket\n"),
					);
					return new Promise<typeof server>((resolve) =>
						server.listen(path, () => resolve(server)),
					);
				});
				answer = () => ({ decision: "approve", scope: "task" });
				const connect = (socket: string) =>
					shell(`curl -s --unix-socket '${socket}' http://localhost/`, {
						sandbox_permissions: "with_additional_permissions",
						additional_permissions: { unix_sockets: [socket] },
						prefix_rule: ["curl"],
					});
				try {
					await open(
						[connect(plain), connect(docker), connect(docker)],
						sandboxed,
					);
					await runTask("连接 Docker");
				} finally {
					for (const server of await Promise.all(servers)) {
						await new Promise((resolve) => server.close(resolve));
					}
				}

				expect(results().map((result) => result.status)).toEqual([
					"succeeded",
					"succeeded",
					"succeeded",
				]);
				expect(asked()).toHaveLength(3);
				expect(asked()[0]).toHaveProperty("suggested_rule");
				expect(asked()[1]).not.toHaveProperty("suggested_rule");
				expect(asked()[2]).not.toHaveProperty("suggested_rule");
				expect(reasons()[1]).toEqual([
					expect.stringMatching(/Docker 的 socket.*完全访问这台机器/),
				]);
			});

			test("ssh-agent 换成 Host 环境里的 SSH_AUTH_SOCK，只设给批准的这条命令；Host 的环境里没有时不询问直接失败", async () => {
				const socket = join(outside, "agent.sock");
				const server: Server = createServer((connection) =>
					connection.end("hello from agent\n"),
				);
				await new Promise<void>((resolve) => server.listen(socket, resolve));
				answer = approveOnce;
				const connect = 'nc -U "$SSH_AUTH_SOCK" < /dev/null';
				const granted = {
					sandbox_permissions: "with_additional_permissions",
					additional_permissions: { unix_sockets: ["ssh-agent"] },
				};
				try {
					hostEnv = { SSH_AUTH_SOCK: socket };
					await open(
						[
							shell(connect, granted),
							// biome-ignore lint/suspicious/noTemplateCurlyInString: 是 shell 的变量展开
							shell('echo "[${SSH_AUTH_SOCK-unset}]"'),
						],
						sandboxed,
					);
					await runTask("用 ssh-agent");
				} finally {
					await new Promise((resolve) => server.close(resolve));
				}

				expect(results()).toMatchObject([
					{ status: "succeeded" },
					{ status: "succeeded" },
				]);
				expect(output(results()[0])).toContain("hello from agent");
				expect(output(results()[1])).toContain("[unset]");
				expect(asked()).toHaveLength(1);
				await session?.close();

				hostEnv = {};
				log = new EventLog();
				await open([shell(connect, granted)], sandboxed);
				await runTask("没有 ssh-agent");
				expect(asked()).toEqual([]);
				expect(results()).toMatchObject([{ status: "failed" }]);
				expect(output(results()[0])).toContain("SSH_AUTH_SOCK is not set");
			});

			test("写法不对的越界申请不询问：没有列出权限、权限和 sandbox_permissions 对不上、socket 给的是目录", async () => {
				await open(
					[
						shell("true", {
							sandbox_permissions: "with_additional_permissions",
						}),
						shell("true", {
							additional_permissions: { local_binding: true },
						}),
						shell("true", {
							sandbox_permissions: "with_additional_permissions",
							additional_permissions: { unix_sockets: [outside] },
						}),
					],
					sandboxed,
				);
				await runTask("写得不对");

				expect(results().map((result) => result.status)).toEqual([
					"failed",
					"failed",
					"failed",
				]);
				expect(asked()).toEqual([]);
			});
		});

		describe("受保护的路径", () => {
			test("编辑工具改不了工作区里受保护的路径，申请对它们的写入也不拿去问用户", async () => {
				mkdirSync(join(dirs.workspace, ".git", "hooks"), { recursive: true });
				answer = approveOnce;
				await open(
					[
						call("write", {
							path: ".git/hooks/pre-commit",
							content: "#!/bin/sh\n",
						}),
						call("write", { path: ".vscode/tasks.json", content: "{}" }),
						call("write", { path: "sub/.envrc", content: "x" }),
						call("write", { path: "notes.txt", content: "ok\n" }),
						shell("true", {
							sandbox_permissions: "with_additional_permissions",
							additional_permissions: {
								file_system: {
									write: [join(dirs.workspace, ".git", "hooks")],
								},
							},
						}),
						call("request_permissions", {
							file_system: { write: [join(dirs.workspace, ".git", "hooks")] },
						}),
					],
					sandboxed,
				);
				await runTask("改受保护的路径");

				expect(results()).toMatchObject([
					{ status: "denied", reason: "forbidden_rule" },
					{ status: "denied", reason: "forbidden_rule" },
					{ status: "denied", reason: "forbidden_rule" },
					{ status: "succeeded" },
					{ status: "denied", reason: "forbidden_rule" },
					{ status: "denied", reason: "forbidden_rule" },
				]);
				expect(asked()).toEqual([]);
				expect(
					existsSync(join(dirs.workspace, ".git", "hooks", "pre-commit")),
				).toBe(false);
				expect(existsSync(join(dirs.workspace, ".vscode"))).toBe(false);
				expect(readFileSync(join(dirs.workspace, "notes.txt"), "utf8")).toBe(
					"ok\n",
				);
			});

			test("声明了对 .git 的写入才能提交，hooks 仍然写不了", async () => {
				answer = approveOnce;
				const git = join(dirs.workspace, ".git");
				const withGit = (command: string) =>
					shell(command, {
						sandbox_permissions: "with_additional_permissions",
						additional_permissions: { file_system: { write: [git] } },
					});
				execFileSync("git", ["init", "-q", dirs.workspace]);
				rmSync(join(git, "hooks"), { recursive: true, force: true });
				const commit =
					"echo x > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.com commit -q -m first";
				await open(
					[
						shell(commit),
						withGit(commit),
						withGit(
							"mkdir -p .git/hooks; echo '#!/bin/sh' > .git/hooks/pre-commit",
						),
					],
					sandboxed,
				);
				await runTask("提交");

				expect(results().map((result) => result.status)).toEqual([
					"failed",
					"succeeded",
					"failed",
				]);
				expect(reasons()).toEqual(
					Array.from({ length: 2 }, () => [`申请写入 ${git}`]),
				);
				expect(
					execFileSync("git", ["log", "--format=%s"], {
						cwd: dirs.workspace,
						encoding: "utf8",
					}).trim(),
				).toBe("first");
				expect(existsSync(join(git, "hooks", "pre-commit"))).toBe(false);
			});
		});

		test("命令的环境变量只有白名单里的：Host 的环境变量进不来，构建缓存指向这个项目的缓存目录，缓存目录可写", async () => {
			hostEnv = { OSP_HOST_ONLY: "host-secret-value" };
			await open(
				[
					shell("env"),
					shell(
						'mkdir -p "$npm_config_cache" "$CARGO_HOME" && echo x > "$npm_config_cache/probe" && echo x > "$CARGO_HOME/probe"',
					),
				],
				sandboxed,
			);
			await runTask("环境变量");

			const env = output(results()[0]);
			expect(env).not.toContain("OSP_HOST_ONLY");
			expect(env).not.toContain("host-secret-value");
			const cache = join(dirs.root, "cache");
			expect(env).toMatch(
				new RegExp(`^npm_config_cache=${cache}/[^/]+/npm$`, "m"),
			);
			expect(env).toMatch(new RegExp(`^CARGO_HOME=${cache}/[^/]+/cargo$`, "m"));
			expect(env).toMatch(new RegExp(`^HOME=${dirs.home}$`, "m"));
			expect(results()[1]).toMatchObject({ status: "succeeded" });
		});

		test("用户级配置的 [environment] 和 SDK 传入的环境变量进到沙盒里，SDK 传入的优先；Host 自己设置的变量不能改", async () => {
			mkdirSync(dirs.root, { mode: 0o700 });
			writeFileSync(
				join(dirs.root, "config.toml"),
				'[environment]\nOSP_FROM_USER = "user"\nOSP_BOTH = "user"\n',
			);
			await open([shell("env")], {
				...sandboxed,
				environment: { OSP_FROM_SDK: "sdk", OSP_BOTH: "sdk" },
			});
			await runTask("环境变量");

			const env = output(results()[0]);
			expect(env).toMatch(/^OSP_FROM_USER=user$/m);
			expect(env).toMatch(/^OSP_FROM_SDK=sdk$/m);
			expect(env).toMatch(/^OSP_BOTH=sdk$/m);
			await session?.close();
			session = undefined;

			await expect(
				open([], { ...sandboxed, environment: { TMPDIR: "/tmp" } }),
			).rejects.toThrow(/TMPDIR 这个变量由 Host 设置/);
		});

		test("命令结束后它留下的进程都被结束，包括脱离了进程组的", async () => {
			const pidFile = join(dirs.workspace, "pid");
			await open(
				[
					shell(
						`perl -MPOSIX -e 'exit if fork; setsid(); open(my $f, ">", "pid"); print $f $$; close $f; sleep 300'; while [ ! -s pid ]; do sleep 0.1; done; echo started`,
					),
				],
				sandboxed,
			);
			await runTask("留下后台进程");

			expect(results()).toMatchObject([{ status: "succeeded" }]);
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(pid).toBeGreaterThan(1);
			expect(() => process.kill(pid, 0)).toThrow(
				expect.objectContaining({ code: "ESRCH" }),
			);
		});
	},
);
