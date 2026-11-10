import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type ApprovalRequestedEvent,
	createHost,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ApprovalAnswer, ResolvedProfile } from "@ospreycode/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	coversPrevious,
	type SandboxReach,
} from "../src/sessions/sandbox-change.js";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 怎样回答这个 session 的询问；不设时不回答。 */
let answer: ((event: ApprovalRequestedEvent) => ApprovalAnswer) | undefined;
/** 主目录下的几个位置。 */
let notes: string;
let tools: string;
let scratch: string;

/**
 * 用户级配置里的命名权限配置：测试目录整个禁止读（主目录、Host 根目录和工作区都在里面），
 * 只放开工具目录（读）和草稿目录（写，其中一个子目录只读）。
 */
function profile(inherits: "read-only" | "workspace-write"): string {
	return `
[permissions.strict]
extends = "${inherits}"

[permissions.strict.paths]
"${dirname(dirs.home)}" = "deny"
"~/tools" = "read"
"~/scratch" = "write"
"~/scratch/frozen" = "read"

[permissions.strict.domains]
"allowed.example.invalid" = "allow"
"blocked.example.invalid" = "deny"
`;
}

function userConfig(text: string): void {
	// Host 根目录要求权限为 700
	mkdirSync(dirs.root, { recursive: true, mode: 0o700 });
	writeFileSync(join(dirs.root, "config.toml"), text);
}

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
	answer = undefined;
	notes = join(dirs.home, "notes");
	tools = join(dirs.home, "tools");
	scratch = join(dirs.home, "scratch");
	for (const dir of [notes, tools, join(scratch, "frozen")]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(notes, "private.txt"), "private notes\n");
	writeFileSync(join(tools, "hello.txt"), "hello from tools\n");
	writeFileSync(join(scratch, "frozen", "keep.txt"), "keep\n");
	writeFileSync(join(dirs.workspace, "readme.txt"), "workspace file\n");
	userConfig(profile("workspace-write"));
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

/** 经沙盒的代理请求一个解析不了的域名：代理在连接之前先按名单判断。只看状态码，不看 curl 的退出码。 */
const fetch = (host: string) =>
	shell(
		`curl -s -o /dev/null -w '%{http_code}' --max-time 20 'http://${host}:8080/' || true`,
	);

const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };

/** 打开 session：模型依次给出 `turns` 里的回复，用完之后回复一句话。 */
async function open(
	turns: ScriptedTurn[],
	options: Partial<SessionOptions> = {},
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((_request, index) => turns[index] ?? done),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "strict",
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

function output(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

const approveOnce = (): ApprovalAnswer => ({
	decision: "approve",
	scope: "once",
});

test("新旧设置的比较：命名权限配置多了 deny 或只读的路径、少了重新放开的路径时按更窄处理", () => {
	const resolved: ResolvedProfile = {
		mode: "workspace-write",
		write: ["/data"],
		deny: ["/home"],
		reopened: ["/home/work"],
		readOnly: ["/data/frozen"],
		sealed: [],
		hollow: ["/home"],
		domains: { allow: [], deny: [] },
	};
	const reach = (changed?: Partial<ResolvedProfile>): SandboxReach => ({
		writableRoots: ["/home/work", "/tmp/session", "/data"],
		denied: { read: [], write: [] },
		network: { allowedDomains: [], deniedDomains: [] },
		...(changed === undefined ? {} : { profile: { ...resolved, ...changed } }),
	});

	expect(coversPrevious(reach({}), reach({}))).toBe(true);
	// 内置模式换到命名权限配置：多了禁止读和禁止写的路径
	expect(coversPrevious(reach(), reach({}))).toBe(false);
	expect(coversPrevious(reach({ deny: [] }), reach({}))).toBe(false);
	expect(coversPrevious(reach({ readOnly: [] }), reach({}))).toBe(false);
	// 少了重新放开读的路径
	expect(coversPrevious(reach({}), reach({ reopened: [] }))).toBe(false);
	// 更宽：少了 deny 和只读的路径，多了重新放开的路径
	expect(
		coversPrevious(
			reach({}),
			reach({ deny: [], readOnly: [], reopened: ["/home/work", "/home/x"] }),
		),
	).toBe(true);
});

// 真实沙盒的测试每个都要启动几个进程，机器忙的时候（CI 的 runner、同时在跑别的测试）默认的 5 秒不够
describe.runIf(process.platform === "darwin")(
	"命名权限配置作为沙盒模式（macOS 真实沙盒，脚本模型）",
	{ timeout: 30_000 },
	() => {
		test("打开 session：能读、能写、能联网的位置按配置，命令沙盒和文件工具一致", async () => {
			await open([
				shell(`cat '${join(notes, "private.txt")}'`),
				shell(`cat '${join(tools, "hello.txt")}'`),
				shell(`echo x > '${join(tools, "new.txt")}'`),
				shell(`echo x > '${join(scratch, "a.txt")}' && cat readme.txt`),
				shell(`echo x > '${join(scratch, "frozen", "a.txt")}'`),
				shell(`echo x > '${join(scratch, ".envrc")}'`),
				shell("echo x > made.txt"),
				call("read", { path: join(notes, "private.txt") }),
				call("read", { path: join(tools, "hello.txt") }),
				call("write", { path: join(scratch, "b.txt"), content: "b\n" }),
				call("write", {
					path: join(scratch, "frozen", "b.txt"),
					content: "b\n",
				}),
				call("write", { path: join(scratch, ".envrc"), content: "b\n" }),
				call("write", { path: join(notes, "b.txt"), content: "b\n" }),
				fetch("allowed.example.invalid"),
				fetch("blocked.example.invalid"),
			]);
			await runTask("各处读写");

			expect(session?.config()).toMatchObject({
				sandboxMode: "strict",
				baseSandboxMode: "workspace-write",
			});
			expect(
				log.events.find((event) => event.type === "session.started"),
			).toMatchObject({ sandbox_mode: "strict" });
			expect(results().map((result) => result.status)).toEqual([
				// 命令沙盒
				"failed",
				"succeeded",
				"failed",
				"succeeded",
				"failed",
				"failed",
				"succeeded",
				// 文件工具：agent 沙盒读不到 deny 的目录；可写路径里只读的位置、受保护的名字和
				// deny 的目录都不拿去问用户
				"failed",
				"succeeded",
				"succeeded",
				"denied",
				"denied",
				"denied",
				// 域名
				"succeeded",
				"succeeded",
			]);
			expect(output(results()[1])).toContain("hello from tools");
			expect(output(results()[3])).toContain("workspace file");
			expect(output(results()[7])).not.toContain("private notes");
			expect(output(results()[8])).toContain("hello from tools");
			expect(readFileSync(join(scratch, "b.txt"), "utf8")).toBe("b\n");
			for (const path of [
				join(tools, "new.txt"),
				join(scratch, "frozen", "a.txt"),
				join(scratch, "frozen", "b.txt"),
				join(scratch, ".envrc"),
				join(notes, "b.txt"),
			]) {
				expect(existsSync(path), path).toBe(false);
			}
			expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(true);
			expect(output(results()[10])).toContain("permission profile `strict`");
			expect(output(results()[11])).toContain("protected path");
			expect(output(results()[12])).toContain("permission profile `strict`");
			// 放行的域名由代理去连（解析不了），禁止的由代理拒绝；都不询问
			expect(output(results()[13])).not.toContain("403");
			expect(output(results()[14])).toContain("403");
			expect(asked()).toEqual([]);
		});

		test("继承 read-only：工作区只读，write 的路径仍然可写", async () => {
			userConfig(profile("read-only"));
			await open([
				shell("cat readme.txt && echo x > made.txt"),
				shell(`echo x > '${join(scratch, "a.txt")}'`),
				call("write", { path: join(scratch, "b.txt"), content: "b\n" }),
			]);
			await runTask("只读的工作区");

			expect(session?.config().baseSandboxMode).toBe("read-only");
			expect(results().map((result) => result.status)).toEqual([
				"failed",
				"succeeded",
				"succeeded",
			]);
			expect(output(results()[0])).toContain("workspace file");
			expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(false);
			expect(existsSync(join(scratch, "b.txt"))).toBe(true);
		});

		test("deny 的路径、可写路径里只读的位置和禁止的域名不拿去问用户；其余位置照常申请和批准", async () => {
			answer = approveOnce;
			const additional = (command: string, permissions: object) =>
				shell(command, {
					sandbox_permissions: "with_additional_permissions",
					additional_permissions: { file_system: permissions },
				});
			await open([
				call("request_permissions", { file_system: { read: [notes] } }),
				additional(`cat '${join(notes, "private.txt")}'`, { read: [notes] }),
				call("request_permissions", {
					file_system: { write: [join(scratch, "frozen")] },
				}),
				call("request_permissions", {
					network: ["blocked.example.invalid"],
				}),
				// 越界执行也读不到 deny 的路径，写不进设成只读的目录
				shell(
					`cat '${join(notes, "private.txt")}'; echo x > '${join(scratch, "frozen", "a.txt")}'`,
					{ sandbox_permissions: "require_escalated" },
				),
				// 重新放开读的目录没有被禁止：可以申请写
				additional(`echo x > '${join(tools, "new.txt")}'`, { write: [tools] }),
			]);
			await runTask("申请");

			expect(results()).toMatchObject([
				{ status: "denied", reason: "forbidden_rule" },
				{ status: "denied", reason: "forbidden_rule" },
				{ status: "denied", reason: "forbidden_rule" },
				{ status: "denied", reason: "forbidden_rule" },
				{ status: "failed" },
				{ status: "succeeded" },
			]);
			expect(output(results()[0])).toContain("permission profile `strict`");
			expect(output(results()[4])).not.toContain("private notes");
			expect(existsSync(join(scratch, "frozen", "a.txt"))).toBe(false);
			expect(existsSync(join(tools, "new.txt"))).toBe(true);
			expect(
				asked().map((event) => (event.kind === "budget" ? [] : event.reasons)),
			).toEqual([
				["申请在沙盒的文件限制之外运行这条命令"],
				[`申请写入 ${tools}`],
			]);
		});

		test("会话中切换：换到命名权限配置和换回内置模式都按新模式生效，记下 sandbox_mode.changed", async () => {
			answer = () => ({ decision: "deny", scope: "once" });
			const probe = [
				shell(`cat '${join(notes, "private.txt")}'`),
				shell(`echo x >> '${join(scratch, "a.txt")}'`),
				fetch("allowed.example.invalid"),
				done,
			];
			const current = await open([...probe, ...probe, ...probe], {
				sandboxMode: "workspace-write",
			});
			await runTask("内置模式");
			await current.setSandboxMode("strict");
			await runTask("命名权限配置");
			await current.setSandboxMode("workspace-write");
			await runTask("换回内置模式");

			expect(
				log.events.filter((event) => event.type === "sandbox_mode.changed"),
			).toMatchObject([
				{ from: "workspace-write", to: "strict" },
				{ from: "strict", to: "workspace-write" },
			]);
			expect(current.config().sandboxMode).toBe("workspace-write");
			expect(current.config().permissionProfile).toBeUndefined();
			expect(results().map((result) => result.status)).toEqual([
				// workspace-write：主目录里的普通文件能读，工作区之外不能写
				"succeeded",
				"failed",
				"succeeded",
				// strict
				"failed",
				"succeeded",
				"succeeded",
				// 换回来
				"succeeded",
				"failed",
				"succeeded",
			]);
			// 内置模式下这个域名要问（这里答了拒绝），命名权限配置下放行
			expect(output(results()[2])).toContain("403");
			expect(output(results()[5])).not.toContain("403");
			expect(output(results()[8])).toContain("403");
			expect(asked().map((event) => event.kind)).toEqual([
				"network",
				"network",
			]);
		});
	},
);

describe.runIf(process.platform === "darwin")(
	"runInSandbox 用命名权限配置（macOS 真实沙盒）",
	{ timeout: 30_000 },
	() => {
		/**
		 * 在沙盒里运行一条 shell 命令，标准输出接到文件上读回来。文件放在工作区里：接到禁止读的
		 * 目录里的文件上时，沙盒里的程序不一定写得进去。
		 */
		async function run(script: string, permissions?: string) {
			const outPath = join(dirs.workspace, "stdout.txt");
			const out = openSync(outPath, "w");
			try {
				const result = await createHost({
					root: dirs.root,
					env: dirs.env,
					credentialStore: null,
				}).runInSandbox({
					workspace: dirs.workspace,
					command: ["sh", "-c", script],
					stdio: ["ignore", out, "ignore"],
					onWarning: () => {},
					...(permissions === undefined ? {} : { permissions }),
				});
				return { ...result, stdout: readFileSync(outPath, "utf8") };
			} finally {
				closeSync(out);
			}
		}

		beforeEach(() => {
			// 配置要能解析出选用的模型；这里不会发模型请求
			userConfig(`model = "scripted"
sandbox_mode = "strict"

[models.scripted]
protocol = "${testModel.protocol}"
service = "${testModel.service}"
base_url = "${testModel.base_url}"
model = "${testModel.model}"
context_window = ${testModel.context_window}
max_output_tokens = ${testModel.max_output_tokens}
${profile("workspace-write")}`);
		});

		test("读写范围和域名按命名权限配置，--permissions 和配置里的 sandbox_mode 都能选用", async () => {
			const script = [
				`cat '${join(notes, "private.txt")}'`,
				`cat '${join(tools, "hello.txt")}'`,
				`echo x > '${join(scratch, "a.txt")}' && echo scratch`,
				`echo x > '${join(scratch, "frozen", "a.txt")}' || echo frozen`,
				"echo x > made.txt && echo workspace",
				"curl -s -o /dev/null -w 'allowed %{http_code}\\n' --max-time 20 'http://allowed.example.invalid:8080/'",
				"curl -s -o /dev/null -w 'blocked %{http_code}\\n' --max-time 20 'http://blocked.example.invalid:8080/'",
				"curl -s -o /dev/null -w 'other %{http_code}\\n' --max-time 20 'http://other.example.invalid:8080/'",
			].join("; ");
			for (const permissions of [undefined, "strict"]) {
				const { stdout } = await run(script, permissions);
				expect(stdout).not.toContain("private notes");
				expect(stdout).toContain(
					"hello from tools\nscratch\nfrozen\nworkspace\n",
				);
				expect(stdout).not.toContain("allowed 403");
				expect(stdout).toContain("blocked 403");
				expect(stdout).toContain("other 403");
			}
			expect(existsSync(join(scratch, "frozen", "a.txt"))).toBe(false);

			// 内置模式照旧：主目录里的普通文件能读，草稿目录不能写
			const builtin = await run(
				`cat '${join(notes, "private.txt")}'; echo x > '${join(scratch, "c.txt")}'`,
				"workspace-write",
			);
			expect(builtin.stdout).toBe("private notes\n");
			expect(existsSync(join(scratch, "c.txt"))).toBe(false);
		});
	},
);
