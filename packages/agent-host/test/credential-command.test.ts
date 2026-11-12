import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type CommandSource,
	CredentialError,
	createHost,
	type HostOptions,
	readCredential,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { StreamModel } from "@ospreycode/api";
import { scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
/** 输出凭据的程序和它每次运行留下的记录。 */
let program: string;
let runs: string;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	program = join(dirs.home, "print-token.mjs");
	runs = join(dirs.home, "runs");
	mkdirSync(runs);
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

/**
 * 一个输出凭据的程序：每运行一次在 `runs/` 下记一个文件（内容是当前目录、参数和有没有标准输入），
 * 然后执行 `body`。`n` 是这是第几次运行，从 1 开始。
 */
function writeProgram(body: string): void {
	writeFileSync(
		program,
		`#!${process.execPath}
import { readdirSync, writeFileSync } from "node:fs";
const n = readdirSync(${JSON.stringify(runs)}).length + 1;
writeFileSync(
	${JSON.stringify(runs)} + "/" + n,
	JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), stdin: process.stdin.isTTY }),
);
${body}
`,
	);
	chmodSync(program, 0o700);
}

function runCount(): number {
	return readdirSync(runs).length;
}

const reply = scriptedModel(() => ({
	content: [{ type: "text", text: "ok" }],
}));

const rejected = scriptedModel(() => ({
	content: [],
	error: { category: "authentication", message: "token expired" },
}));

async function open(
	host: Partial<HostOptions>,
	source: CommandSource,
	options: Partial<SessionOptions> = {},
): Promise<EventLog> {
	const log = new EventLog();
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		...host,
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: source },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: log.push,
	});
	return log;
}

async function submit(log: EventLog, input: string) {
	const taskId = await (session as Session).submit(input);
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/** 记下每次请求带的凭据。 */
function recording(
	keys: string[],
	model: StreamModel = reply,
): Pick<HostOptions, "streamModel"> {
	return {
		streamModel: (entry, request, options) => {
			keys.push(options.apiKey);
			return model(entry, request, options);
		},
	};
}

describe("输出凭据的命令", () => {
	test("不经 shell 运行程序加参数，当前目录是 Host 根目录，标准输出去掉首尾空白就是凭据", async () => {
		writeProgram(`process.stdout.write("\\n  token-" + n + "\\n");`);
		const keys: string[] = [];
		const log = await open(recording(keys), {
			command: program,
			args: ["--account", "a b; echo injected"],
		});
		expect((await submit(log, "hi")).outcome).toBe("completed");
		expect(keys).toEqual(["token-1"]);
		expect(JSON.parse(readFileSync(join(runs, "1"), "utf8"))).toMatchObject({
			cwd: dirs.root,
			args: ["--account", "a b; echo injected"],
		});
		// 没到刷新间隔，接着用内存里的值
		expect((await submit(log, "again")).outcome).toBe("completed");
		expect(keys).toEqual(["token-1", "token-1"]);
		expect(runCount()).toBe(1);
	});

	test("过了 refresh_interval_ms，下一次请求之前重新运行", async () => {
		writeProgram(`console.log("token-" + n);`);
		const keys: string[] = [];
		const log = await open(recording(keys), {
			command: program,
			refresh_interval_ms: 1,
		});
		await submit(log, "hi");
		const before = runCount();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await submit(log, "again");
		expect(runCount()).toBe(before + 1);
		expect(keys.at(-1)).toBe(`token-${before + 1}`);
	});

	test("服务返回 401 时重新运行一次，值变了才重发；refresh_interval_ms 为 0 时只在这时重新运行", async () => {
		writeProgram(`console.log("token-" + n);`);
		const keys: string[] = [];
		const log = await open(
			{
				streamModel: (entry, request, options) => {
					keys.push(options.apiKey);
					return (options.apiKey === "token-1" ? rejected : reply)(
						entry,
						request,
						options,
					);
				},
			},
			{ command: program, refresh_interval_ms: 0 },
		);
		expect((await submit(log, "hi")).outcome).toBe("completed");
		expect(keys).toEqual(["token-1", "token-2"]);
		expect((await submit(log, "again")).outcome).toBe("completed");
		expect(keys).toEqual(["token-1", "token-2", "token-2"]);
		expect(runCount()).toBe(2);
	});

	test("重新运行得到的值没变：不重发，这次请求按认证失败结束", async () => {
		writeProgram(`console.log("same-token");`);
		const keys: string[] = [];
		const log = await open(recording(keys, rejected), { command: program });
		const ended = await submit(log, "hi");
		expect(ended.outcome).toBe("failed");
		expect(keys).toEqual(["same-token"]);
		expect(runCount()).toBe(2);
	});

	test("打开 session 时程序运行不了：报错里只有程序名和退出码，没有它的输出", async () => {
		writeProgram(
			`console.log("PARTIAL-SECRET"); console.error("STDERR-SECRET"); process.exit(3);`,
		);
		const failure = await open({}, { command: program }).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(CredentialError);
		const { message } = failure as Error;
		expect(message).toContain(program);
		expect(message).toContain("退出码 3");
		expect(message).not.toContain("SECRET");

		writeProgram(`setTimeout(() => {}, 60_000);`);
		await expect(
			open({}, { command: program, timeout_ms: 200 }),
		).rejects.toThrow(/超过 200 毫秒没有结束/);

		writeProgram("");
		await expect(open({}, { command: program })).rejects.toThrow(/没有输出/);

		await expect(
			open({}, { command: join(dirs.home, "missing") }),
		).rejects.toThrow(/运行不了：ENOENT/);
	});

	test("会话中程序开始失败：请求没有发出，task 以认证失败结束，不占请求次数", async () => {
		const broken = join(dirs.home, "broken");
		writeProgram(
			`import { existsSync } from "node:fs";
if (existsSync(${JSON.stringify(broken)})) process.exit(1);
console.log("token-" + n);`,
		);
		const keys: string[] = [];
		const log = await open(recording(keys), {
			command: program,
			refresh_interval_ms: 1,
		});
		expect((await submit(log, "hi")).outcome).toBe("completed");
		const sent = keys.length;
		writeFileSync(broken, "");
		await new Promise((resolve) => setTimeout(resolve, 5));
		const ended = await submit(log, "again");
		expect(ended.outcome).toBe("failed");
		expect(ended.error).toContain("退出码 1");
		expect(keys).toHaveLength(sent);
	});

	test("程序输出的凭据登记为密钥：服务在错误信息里带回它时，事件和诊断日志里都去掉", async () => {
		writeProgram(`console.log("command-issued-token");`);
		const echoing: StreamModel = (entry, request, options) =>
			scriptedModel(() => ({
				content: [],
				error: {
					category: "invalid_request",
					message: `request rejected for key ${options.apiKey}`,
				},
			}))(entry, request, options);
		const log = await open({ streamModel: echoing }, { command: program });
		const ended = await submit(log, "hi");
		expect(ended.error).toContain("[REDACTED]");
		expect(JSON.stringify(log.events)).not.toContain("command-issued-token");
		const logs = join(dirs.root, "data", "logs");
		const written = readdirSync(logs)
			.map((file) => readFileSync(join(logs, file), "utf8"))
			.join("");
		expect(written).not.toContain("command-issued-token");
	});

	test("签名用的凭据：整个 JSON 之外，里面的密钥和会话令牌也登记为密钥", async () => {
		writeProgram(
			`console.log(JSON.stringify({ Version: 1, AccessKeyId: "AKIDEXAMPLE", SecretAccessKey: "wJalrXUtnFEMI-SECRET", SessionToken: "SESSION-TOKEN-SECRET" }));`,
		);
		const echoing: StreamModel = (entry, request, options) =>
			scriptedModel(() => ({
				content: [],
				error: {
					category: "invalid_request",
					message:
						"signature mismatch for wJalrXUtnFEMI-SECRET with SESSION-TOKEN-SECRET",
				},
			}))(entry, request, options);
		const log = await open(
			{ streamModel: echoing },
			{ command: program },
			{
				models: {
					scripted: {
						...testModel,
						auth: {
							scheme: "aws-sigv4",
							region: "us-east-1",
							service: "bedrock-mantle",
						},
					},
				},
			},
		);
		const ended = await submit(log, "hi");
		expect(ended.outcome).toBe("failed");
		expect(JSON.stringify(log.events)).not.toContain("SECRET");
	});
});

describe("配置", () => {
	function userConfig(text: string): void {
		writeFileSync(join(dirs.root, "config.toml"), text);
	}

	test("用户级配置的 [credentials] 可以写命令；login status 只列程序，不列参数", async () => {
		const host = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
		});
		userConfig(`
model = "scripted"

[credentials]
anthropic = { command = "gcloud", args = ["auth", "print-access-token", "--account=me@example.com"], timeout_ms = 10000, refresh_interval_ms = 0 }
`);
		const config = host.resolveConfig({
			workspace: dirs.workspace,
			models: { scripted: testModel },
		});
		expect(config.credentials).toEqual({
			anthropic: {
				command: "gcloud",
				args: ["auth", "print-access-token", "--account=me@example.com"],
				timeout_ms: 10000,
				refresh_interval_ms: 0,
			},
		});
		const statuses = await host.credentialStatus();
		expect(statuses.find((status) => status.id === "anthropic")).toEqual({
			id: "anthropic",
			source: "user_config",
			command: "gcloud",
		});
	});

	test("写错的命令在加载时报错：相对路径、不是数组的参数、不认识的键", () => {
		const host = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
		});
		const resolve = () =>
			host.resolveConfig({
				workspace: dirs.workspace,
				model: "scripted",
				models: { scripted: testModel },
			});
		userConfig(`[credentials]\ntest = { command = "./bin/token" }\n`);
		expect(resolve).toThrow(
			/credentials\.test\.command 要是绝对路径，或者不带路径分隔符、按 PATH 查找的程序名/,
		);
		userConfig(`[credentials]\ntest = { command = "gcloud", args = "auth" }\n`);
		expect(resolve).toThrow(/credentials\.test\.args 要是字符串的数组/);
		userConfig(`[credentials]\ntest = { command = "gcloud", shell = true }\n`);
		expect(resolve).toThrow(/credentials\.test\.shell 不认识的键/);
		// SDK 的调用方传入的同样检查
		userConfig("");
		expect(() =>
			host.resolveConfig({
				workspace: dirs.workspace,
				model: "scripted",
				models: { scripted: testModel },
				credentials: { test: { command: "gcloud", timeout_ms: 0 } },
			}),
		).toThrow(/credentials\.test\.timeout_ms 要是正整数/);
	});

	test("仓库配置里的命令不运行：[credentials] 只认用户级配置和启动参数", async () => {
		writeProgram(`console.log("from-repo");`);
		mkdirSync(join(dirs.workspace, ".git"));
		mkdirSync(join(dirs.workspace, ".ospreycode"));
		writeFileSync(
			join(dirs.workspace, ".ospreycode", "config.toml"),
			`[credentials]\ntest = { command = ${JSON.stringify(program)} }\n`,
		);
		const host = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
		});
		await expect(
			host.openSession({
				workspace: dirs.workspace,
				model: "scripted",
				models: { scripted: testModel },
				sandboxMode: "danger-full-access",
				approvalPolicy: "never",
				onEvent: () => {},
			}),
		).rejects.toThrow(CredentialError);
		expect(runCount()).toBe(0);
	});

	test("MCP 的凭据不能用命令取得：别处读凭据时遇到命令来源就报错，不运行它", () => {
		writeProgram(`console.log("token");`);
		expect(() =>
			readCredential(
				"mcp:docs",
				{ command: program },
				{ workspace: dirs.workspace, env: dirs.env, platform: "linux" },
			),
		).toThrow(/凭据 mcp:docs 的来源不能是命令/);
		expect(runCount()).toBe(0);
	});
});
