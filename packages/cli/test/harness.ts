import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { type HostEvent, isHostEvent } from "@ospreycode/agent-host";

/** 构建出来的 CLI 入口：测试运行的是打包后的文件，和安装后运行的是同一个。 */
export const cliEntry = fileURLToPath(
	new URL("../dist/bundle/ospreycode.js", import.meta.url),
);

/** 一次测试用的目录：临时的 HOME（Host 根目录在它里面）、工作区和一个 0600 的凭据文件，互不包含。 */
export interface TestDirectories {
	home: string;
	/** Host 根目录 `<HOME>/.ospreycode`，已经建好。 */
	root: string;
	workspace: string;
	credentialFile: string;
	/** 传给 CLI 的环境变量：只有 PATH 和临时的 HOME。 */
	env: Record<string, string>;
	/** 写用户级的 `config.toml`。 */
	writeConfig(text: string): void;
	cleanup(): void;
}

export function testDirectories(): TestDirectories {
	// macOS 的 TMPDIR 很深，沙盒后端在 session 临时目录里建的 socket 会超出路径上限
	const base = realpathSync(mkdtempSync("/tmp/osp-cli-"));
	const home = join(base, "home");
	const root = join(home, ".ospreycode");
	const workspace = join(base, "workspace");
	const secrets = join(base, "secrets");
	for (const dir of [home, workspace, secrets]) mkdirSync(dir);
	mkdirSync(root, { mode: 0o700 });
	const credentialFile = join(secrets, "fake");
	writeFileSync(credentialFile, "test-key\n", { mode: 0o600 });
	const path = process.env.PATH;
	if (path === undefined) throw new Error("测试进程的环境变量里没有 PATH");
	return {
		home,
		root,
		workspace,
		credentialFile,
		env: { PATH: path, HOME: home },
		writeConfig: (content) =>
			writeFileSync(join(root, "config.toml"), content, { mode: 0o600 }),
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

/** 一次运行的结果。 */
export interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** 正在运行的 CLI 进程。 */
export interface RunningCli {
	child: ChildProcess;
	/** 到目前为止的标准输出。 */
	stdout(): string;
	/** 等标准输出里出现这段文字。 */
	waitForOutput(fragment: string): Promise<void>;
	result: Promise<CliResult>;
}

/** 运行 CLI 的方式。 */
export interface CliOptions {
	cwd: string;
	env: Record<string, string>;
	/** 写进标准输入的内容；不给时标准输入是空的。 */
	input?: string;
}

/** 启动 CLI 进程，不等它结束。 */
export function startCli(
	args: readonly string[],
	options: CliOptions,
): RunningCli {
	const child = spawn(process.execPath, [cliEntry, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end(options.input ?? "");
	let stdout = "";
	let waiters: { fragment: string; resolve: () => void }[] = [];
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
		for (const waiter of waiters) {
			if (stdout.includes(waiter.fragment)) waiter.resolve();
		}
		waiters = waiters.filter((waiter) => !stdout.includes(waiter.fragment));
	});
	const stderr = text(child.stderr);
	const result = (async (): Promise<CliResult> => {
		const [code, signal] = (await once(child, "close")) as [
			number | null,
			NodeJS.Signals | null,
		];
		return { code, signal, stdout, stderr: await stderr };
	})();
	return {
		child,
		stdout: () => stdout,
		waitForOutput: (fragment) =>
			new Promise((resolve) => {
				if (stdout.includes(fragment)) resolve();
				else waiters.push({ fragment, resolve });
			}),
		result,
	};
}

/** 运行 CLI 到结束。 */
export function runCli(
	args: readonly string[],
	options: CliOptions,
): Promise<CliResult> {
	return startCli(args, options).result;
}

/** `--json` 的输出按行解析成事件；有一行不是合法的 Host 事件就报错。 */
export function parseEvents(stdout: string): HostEvent[] {
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const event: unknown = JSON.parse(line);
			if (!isHostEvent(event)) {
				throw new Error(`这一行不是合法的 Host 事件：${line}`);
			}
			return event;
		});
}

/** 模型服务对一次请求的回应：脚本里写好的响应，或者一直不回应。 */
export type ModelReply =
	| {
			status: number;
			body: string;
			contentType: string;
			/** 写出这些内容之后不结束响应：流式的回复停在半路，连接留到测试结束。 */
			stalled?: true;
	  }
	| "hang";

function sse(chunks: readonly unknown[]): ModelReply {
	return {
		status: 200,
		contentType: "text/event-stream",
		body: `${[...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
			.map((data) => `data: ${data}\n\n`)
			.join("")}`,
	};
}

const usage = {
	choices: [],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/** Chat Completions 的流式响应：一段文字，然后结束。 */
export function textReply(content: string): ModelReply {
	return sse([
		{ choices: [{ index: 0, delta: { role: "assistant", content } }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		usage,
	]);
}

/** Chat Completions 的流式响应：调用一次 shell 工具；`rest` 是 `command` 之外的参数。 */
export function shellCallReply(
	command: string,
	rest: Record<string, unknown> = {},
): ModelReply {
	return sse([
		{
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call_${crypto.randomUUID()}`,
								type: "function",
								function: {
									name: "shell",
									arguments: JSON.stringify({ command, ...rest }),
								},
							},
						],
					},
				},
			],
		},
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		usage,
	]);
}

/** 模型服务返回的错误。 */
export function errorReply(status: number, message: string): ModelReply {
	return {
		status,
		contentType: "application/json",
		body: JSON.stringify({ error: { message, type: "invalid_request_error" } }),
	};
}

/** 本机上按脚本回应的模型服务，说 `openai.chat` 协议。 */
export interface FakeModelServer {
	/** 写进用户级配置的内容：把它登记成模型 `fake` 并选用。 */
	config: string;
	/** 收到的请求体，按收到的顺序。 */
	requests: unknown[];
	close(): Promise<void>;
}

/** 启动模型服务；`script` 按第几次请求（从 0 起）给出回应。 */
export async function fakeModelServer(
	script: (call: number, request: unknown) => ModelReply,
): Promise<FakeModelServer> {
	const requests: unknown[] = [];
	const server = createServer(
		(request: IncomingMessage, response: ServerResponse) => {
			void (async () => {
				const body: unknown = JSON.parse(await text(request));
				if (
					request.method !== "POST" ||
					request.url !== "/v1/chat/completions"
				) {
					response.writeHead(404).end();
					return;
				}
				const reply = script(requests.length, body);
				requests.push(body);
				// 不回应：连接留到测试结束时由 close() 断开
				if (reply === "hang") return;
				response.writeHead(reply.status, {
					"content-type": reply.contentType,
				});
				if (reply.stalled === true) response.write(reply.body);
				else response.end(reply.body);
			})();
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		config: `
model = "fake"

[models.fake]
protocol = "openai.chat"
service = "fake"
base_url = "http://127.0.0.1:${port}/v1"
model = "fake-model"
context_window = 100000
max_output_tokens = 4000

[models.fake.price]
input = 1
output = 5
cache_read = 0.1
cache_write = 1.25
`,
		requests,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, "close");
		},
	};
}
