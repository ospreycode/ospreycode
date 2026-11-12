import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import type { CliContext, CliSignal } from "../src/context.js";
import { runInteractiveOn } from "../src/interactive/app.js";
import type { Clipboard } from "../src/interactive/clipboard.js";
import type { InteractiveOptions } from "../src/interactive/index.js";
import {
	type FakeModelServer,
	fakeModelServer,
	type ModelReply,
	type TestDirectories,
	testDirectories,
} from "./harness.js";
import { key, TestTerminal } from "./interactive-terminal.js";

/** 打包后的进程入口，和安装后运行时用的是同一批文件。 */
function bundled(name: string): string {
	return fileURLToPath(new URL(`../dist/bundle/${name}`, import.meta.url));
}

/** 在测试进程里运行的一次交互模式。 */
export interface InteractiveRun {
	terminal: TestTerminal;
	/** 交互模式结束时的退出码。 */
	exit: Promise<number>;
	/** 给它发一个信号。 */
	signal(signal: CliSignal): void;
}

/** 启动交互模式的参数，对应命令行上的选项。 */
export interface InteractiveArgs {
	sandboxMode: string;
	approvalPolicy?: InteractiveOptions["approvalPolicy"];
	prompt?: string;
	/** `ospreycode resume`：恢复这个工作区的一个 session，不新建。 */
	resume?: InteractiveOptions["resume"];
	/** `--tui-mode`；不给时按配置，默认全屏。要看滚出屏幕的内容的测试写 `regular`。 */
	tuiMode?: InteractiveOptions["tuiMode"];
	/** Ctrl+V 读到的图片；不给时剪贴板里没有图片。 */
	clipboardImage?: Uint8Array;
	/** 除了 `fake` 之外也从测试的凭据文件取凭据的模型服务。 */
	credentialServices?: readonly string[];
	columns?: number;
	rows?: number;
	/** 启动之前终端上已经有的内容，比如 shell 里敲的那一行命令。 */
	before?: string;
	/** 换掉 agent 进程的入口文件；不给时是打包好的 agent。 */
	agentEntry?: string;
}

/**
 * 在测试进程里启动交互模式：真的 Host 和 session，终端换成 `TestTerminal`。凭据从测试目录的文件读，
 * 环境变量只有 PATH 和临时的 HOME。
 */
export function startInteractive(
	dirs: TestDirectories,
	args: InteractiveArgs,
): InteractiveRun {
	const terminal = new TestTerminal(args.columns, args.rows);
	if (args.before !== undefined) terminal.write(args.before);
	const listeners = new Set<(signal: CliSignal) => void>();
	const context: CliContext = {
		argv: [],
		env: dirs.env,
		cwd: dirs.workspace,
		platform: process.platform,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		onSignal(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		useProxy() {},
		entries: {
			agent: args.agentEntry ?? bundled("agent.js"),
			applyEdits: bundled("apply-edits.js"),
			sandboxHelper: bundled("sandbox-helper.js"),
		},
	};
	const clipboard: Clipboard = {
		readImage: async () => args.clipboardImage,
	};
	const exit = runInteractiveOn(
		{
			session: {
				workspace: dirs.workspace,
				rules: [],
				credentials: Object.fromEntries(
					["fake", ...(args.credentialServices ?? [])].map((service) => [
						service,
						{ file: dirs.credentialFile },
					]),
				),
				sandboxMode: args.sandboxMode,
			},
			...(args.approvalPolicy === undefined
				? {}
				: { approvalPolicy: args.approvalPolicy }),
			...(args.prompt === undefined ? {} : { prompt: args.prompt }),
			...(args.resume === undefined ? {} : { resume: args.resume }),
			...(args.tuiMode === undefined ? {} : { tuiMode: args.tuiMode }),
			context,
		},
		terminal,
		clipboard,
	);
	return {
		terminal,
		exit,
		signal: (signal) => {
			for (const listener of listeners) listener(signal);
		},
	};
}

/** 在模型服务给的配置上再写的内容。 */
export interface ModelOptions {
	/** 写进 `[models.fake]` 这张表的几行，比如 `images = true`。 */
	fields?: string;
	/** 另外登记的模型：和 `fake` 用同一个服务、同样的价格，发给服务的模型名是 `<id>-model`。 */
	models?: string[];
	/** 默认选用的模型，不给时是 `fake`。 */
	selected?: string;
	/** 接在最后的配置。 */
	extra?: string;
}

/** 一个测试文件里各个测试共用的准备和清理。 */
export interface InteractiveFixture {
	/** 当前这个测试的目录。 */
	readonly dirs: TestDirectories;
	/** 启动按脚本回应的模型服务，把它写进用户级配置。 */
	useModel(
		script: (call: number, request: unknown) => ModelReply,
		options?: ModelOptions,
	): Promise<FakeModelServer>;
	/** 按新的内容重写用户级配置，模型服务还是原来那个。 */
	configure(options: ModelOptions): void;
	/** 断开模型服务：挂着的请求随之失败。 */
	dropModel(): Promise<void>;
	/** 启动交互模式，等界面出来（要选 session 时等列表出来）。不给沙盒模式时不启用系统隔离。 */
	start(args?: Partial<InteractiveArgs>): Promise<InteractiveRun>;
	/** 等交互模式自己退出，返回退出码。 */
	exitCode(): Promise<number>;
}

/**
 * 每个测试从临时的 HOME 和工作区开始；测试结束时还没退出的交互模式收到 SIGTERM，关掉 session
 * 之后再清理目录。
 */
export function interactiveFixture(): InteractiveFixture {
	// 等屏幕的时限（10 秒）先到：失败时报出来的是当时的屏幕，不是一句"测试超时"
	vi.setConfig({ testTimeout: 30_000 });
	let dirs: TestDirectories;
	let model: FakeModelServer | undefined;
	let run: InteractiveRun | undefined;

	beforeEach(() => {
		dirs = testDirectories();
		model = undefined;
		run = undefined;
	});

	afterEach(async () => {
		if (run !== undefined) {
			run.signal("SIGTERM");
			await run.exit;
		}
		await model?.close();
		dirs.cleanup();
	});

	function configure(options: ModelOptions): void {
		if (model === undefined) throw new Error("模型服务还没有启动");
		const table = /\[models\.fake\]\n[^[]*/.exec(model.config);
		const price = /\[models\.fake\.price\]\n[^[]*/.exec(model.config);
		const selected = 'model = "fake"\n';
		if (table === null || price === null || !model.config.includes(selected)) {
			throw new Error("模型服务的配置不是预期的写法，改不了");
		}
		const copies = (options.models ?? []).map((id) =>
			`${table[0]}${price[0]}`
				.replaceAll("[models.fake", `[models.${id}`)
				.replace('"fake-model"', `"${id}-model"`),
		);
		dirs.writeConfig(
			[
				model.config
					.replace(selected, `model = "${options.selected ?? "fake"}"\n`)
					.replace(
						table[0],
						`${table[0].trimEnd()}\n${options.fields ?? ""}\n\n`,
					),
				...copies,
				options.extra ?? "",
			].join("\n"),
		);
	}

	return {
		get dirs() {
			return dirs;
		},
		async useModel(script, options = {}) {
			model = await fakeModelServer(script);
			configure(options);
			return model;
		},
		configure,
		async dropModel() {
			if (model === undefined) throw new Error("模型服务还没有启动");
			await model.close();
			model = undefined;
		},
		async start(args = {}) {
			run = startInteractive(dirs, {
				sandboxMode: "danger-full-access",
				...args,
			});
			// session 没打开就失败时，报出来的是那个错误，不是等不到界面
			await Promise.race([
				run.terminal.waitFor(
					// 从列表里选要恢复的 session 时，先出来的是列表，session 还没有打开
					args.resume?.kind === "pick" ? "选择要恢复的 session" : "Osprey Code",
				),
				run.exit.then((code) => {
					throw new Error(`界面还没出来交互模式就退出了，退出码 ${code}`);
				}),
			]);
			return run;
		},
		async exitCode() {
			if (run === undefined) throw new Error("交互模式还没有启动");
			const code = await run.exit;
			run = undefined;
			return code;
		},
	};
}

const usage = {
	choices: [],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/** Chat Completions 的流式响应：`deltas` 依次是各个数据块里的 `delta`，最后以 `finishReason` 结束。 */
export function streamReply(
	deltas: readonly Record<string, unknown>[],
	finishReason: "stop" | "tool_calls" = "stop",
): ModelReply {
	const chunks = [
		...deltas.map((delta) => ({ choices: [{ index: 0, delta }] })),
		{ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
		usage,
	];
	return {
		status: 200,
		contentType: "text/event-stream",
		body: [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
			.map((data) => `data: ${data}\n\n`)
			.join(""),
	};
}

/** Chat Completions 的流式响应：一次回复里调用几个工具。 */
export function toolCallsReply(
	calls: readonly { name: string; arguments: Record<string, unknown> }[],
): ModelReply {
	return streamReply(
		[
			{
				role: "assistant",
				tool_calls: calls.map((call, index) => ({
					index,
					id: `call_${crypto.randomUUID()}`,
					type: "function",
					function: {
						name: call.name,
						arguments: JSON.stringify(call.arguments),
					},
				})),
			},
		],
		"tool_calls",
	);
}

/** Chat Completions 请求里 user 消息的一个部分。 */
interface UserPart {
	type: string;
	text?: string;
}

/** 模型收到的最后一条 user 消息的各个部分。 */
export function lastUserParts(request: unknown): UserPart[] {
	const { messages } = request as {
		messages: { role: string; content: string | UserPart[] }[];
	};
	const last = messages.findLast((message) => message.role === "user");
	if (last === undefined) throw new Error("请求里没有 user 消息");
	return typeof last.content === "string"
		? [{ type: "text", text: last.content }]
		: last.content;
}

/** 模型收到的最后一条 user 消息里的文字。 */
export function lastUserMessage(request: unknown): string {
	return lastUserParts(request)
		.map((part) => part.text ?? "")
		.join("");
}

/** 这次请求用的模型名（配置里 `model` 写的那个）。 */
export function requestedModel(request: unknown): string {
	return (request as { model: string }).model;
}

/** 等询问的面板出来，按 ↓ 选中第一个选项：面板出现时没有选中的选项。 */
export async function selectFirstChoice(
	terminal: TestTerminal,
	label: string,
): Promise<void> {
	await terminal.waitForVisible("先按 ↑↓ 选择");
	await terminal.press(key.down);
	await terminal.waitForVisible(`→ ${label}`);
}
