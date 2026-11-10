import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

/** 构建出来的 CLI：评测把它当成外部程序运行，和任务容器里安装的是同一个文件。 */
const cliBundle = fileURLToPath(
	new URL("../../cli/dist/bundle/ospreycode.js", import.meta.url),
);

const fakePier = fileURLToPath(
	new URL("./fixtures/fake-pier.mjs", import.meta.url),
);

/** 夹具题目所在的目录，每道题一个子目录，布局和 SWE-bench Pro V2 的题目相同。 */
export const fixtureTasks = fileURLToPath(
	new URL("./fixtures/coding-tasks", import.meta.url),
);

/** 一次测试用的目录和程序。 */
export interface CodingDirectories {
	base: string;
	/** 临时的 HOME，里面的 `.ospreycode` 已经建好。 */
	home: string;
	/** 0600 的凭据文件。 */
	credentialFile: string;
	/** 运行 CLI 的可执行文件。 */
	cli: string;
	/** 测试用的 pier（`fixtures/fake-pier.mjs`）的可执行文件。 */
	pier: string;
	/** 只有 PATH 和临时的 HOME。 */
	env: Record<string, string>;
	/** 写用户级的 `config.toml`。 */
	writeConfig(content: string): void;
	cleanup(): void;
}

function executable(path: string, script: string): string {
	writeFileSync(
		path,
		`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
		{
			mode: 0o755,
		},
	);
	return path;
}

export function codingDirectories(): CodingDirectories {
	// macOS 的 TMPDIR 很深，放在 /tmp 下路径短一些
	const base = realpathSync(mkdtempSync("/tmp/osp-eval-"));
	const home = join(base, "home");
	const root = join(home, ".ospreycode");
	const secrets = join(base, "secrets");
	const bin = join(base, "bin");
	for (const directory of [home, secrets, bin]) mkdirSync(directory);
	mkdirSync(root, { mode: 0o700 });
	const credentialFile = join(secrets, "fake");
	writeFileSync(credentialFile, "test-key\n", { mode: 0o600 });
	const path = process.env.PATH;
	if (path === undefined) throw new Error("测试进程的环境变量里没有 PATH");
	return {
		base,
		home,
		credentialFile,
		cli: executable(join(bin, "ospreycode"), cliBundle),
		pier: executable(join(bin, "pier"), fakePier),
		env: { PATH: path, HOME: home },
		writeConfig: (content) =>
			writeFileSync(join(root, "config.toml"), content, { mode: 0o600 }),
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

/** 在 `cwd` 里运行 git，提交用固定的身份。 */
export function git(
	dirs: CodingDirectories,
	cwd: string,
	...args: string[]
): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.com",
			...args,
		],
		{ cwd, encoding: "utf8", env: dirs.env },
	).trim();
}

/** 题目仓库的检出：夹具题目放在 `v2/tasks` 下，提交一次。返回检出的目录和它的 commit。 */
export function fixtureCheckout(dirs: CodingDirectories): {
	checkout: string;
	commit: string;
} {
	const checkout = join(dirs.base, "checkout");
	mkdirSync(join(checkout, "v2"), { recursive: true });
	cpSync(fixtureTasks, join(checkout, "v2", "tasks"), { recursive: true });
	git(dirs, checkout, "init", "-q", "-b", "main");
	git(dirs, checkout, "add", "-A");
	git(dirs, checkout, "commit", "-q", "-m", "tasks");
	return { checkout, commit: git(dirs, checkout, "rev-parse", "HEAD") };
}

/** 模型的一次回应：一段文字，或者调用一次 shell 工具（`rest` 是 `command` 之外的参数）。 */
export type ModelReply =
	| { text: string }
	| { shell: string; rest?: Record<string, unknown> };

/** Chat Completions 的一条消息里测试用到的字段。 */
export interface ChatMessage {
	role: string;
	content: unknown;
}

/** 本机上按脚本回应的模型服务，说 `openai.chat` 协议。 */
export interface FakeModel {
	/** 写进用户级配置的内容：把它登记成模型 `fake` 并选用。 */
	config: string;
	/** 收到的每次请求里的消息，按收到的顺序。 */
	requests: ChatMessage[][];
	close(): Promise<void>;
}

const usage = {
	choices: [],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function chunks(reply: ModelReply): unknown[] {
	if ("text" in reply) {
		return [
			{
				choices: [
					{ index: 0, delta: { role: "assistant", content: reply.text } },
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			usage,
		];
	}
	return [
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
									arguments: JSON.stringify({
										command: reply.shell,
										...reply.rest,
									}),
								},
							},
						],
					},
				},
			],
		},
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		usage,
	];
}

/** 启动模型服务；`script` 按请求里的消息给出回应。 */
export async function fakeModel(
	script: (messages: ChatMessage[]) => ModelReply,
): Promise<FakeModel> {
	const requests: ChatMessage[][] = [];
	const server = createServer((request, response) => {
		void (async () => {
			const body = JSON.parse(await text(request)) as {
				messages: ChatMessage[];
			};
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			requests.push(body.messages);
			response
				.writeHead(200, { "content-type": "text/event-stream" })
				.end(
					[
						...chunks(script(body.messages)).map((chunk) =>
							JSON.stringify(chunk),
						),
						"[DONE]",
					]
						.map((data) => `data: ${data}\n\n`)
						.join(""),
				);
		})();
	});
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

/** 请求里有没有工具结果：没有就是这次运行的第一次请求。 */
export function hasToolResult(messages: readonly ChatMessage[]): boolean {
	return messages.some((message) => message.role === "tool");
}

/** 请求里的全部文字，用来按题目说明里的词分辨是哪道题。 */
export function prompt(messages: readonly ChatMessage[]): string {
	return JSON.stringify(messages);
}
