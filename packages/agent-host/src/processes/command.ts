import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { killGroup } from "./group.js";
import type { ProcessTracker } from "./registry.js";

/** 交给模型的输出上限（字节），超出时保留开头和结尾各一半，完整输出在输出文件里。 */
export const modelOutputLimit = 32 * 1024;

/** 经通道流回 runtime 的输出上限（字节）。 */
const streamedLimit = 32 * 1024;

/** 运行一条命令的方式。 */
export interface RunCommandOptions {
	/** 完整的命令：`danger-full-access` 下是 `bash -c <命令>`，否则是沙盒包装后的命令。 */
	argv: readonly string[];
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	signal: AbortSignal;
	/** 完整输出写到这里，由 Host 写入。 */
	outputFile: string;
	/** 上限以内的输出，按收到的顺序交给调用方流回 runtime。 */
	onOutput: (text: string) => Promise<void>;
	/** 命令的进程记进进程登记表。 */
	tracker: ProcessTracker;
}

/** 命令的结果。 */
export interface CommandRun {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	cancelled: boolean;
	/** 交给模型的输出：超出上限时只有开头和结尾，中间写明省略了多少。 */
	output: string;
	/** 完整输出的字节数。 */
	outputBytes: number;
}

/** 只保留开头和结尾各一半的输出。 */
class OutputCollector {
	#head: Buffer[] = [];
	#headBytes = 0;
	#tail = Buffer.alloc(0);
	bytes = 0;

	add(chunk: Buffer): void {
		this.bytes += chunk.length;
		const half = modelOutputLimit / 2;
		const room = half - this.#headBytes;
		if (room > 0) {
			const head = chunk.subarray(0, room);
			this.#head.push(head);
			this.#headBytes += head.length;
			chunk = chunk.subarray(room);
		}
		if (chunk.length === 0) return;
		this.#tail = Buffer.concat([this.#tail, chunk]);
		if (this.#tail.length > half) this.#tail = this.#tail.subarray(-half);
	}

	text(outputFile: string): string {
		const head = Buffer.concat(this.#head).toString("utf8");
		const omitted = this.bytes - this.#headBytes - this.#tail.length;
		if (omitted === 0) return head + this.#tail.toString("utf8");
		return `${head}\n[... ${omitted} bytes omitted; the full output is in ${outputFile}]\n${this.#tail.toString("utf8")}`;
	}
}

/**
 * 运行一条命令：stdout 和 stderr 按收到的顺序合并写进输出文件，用单独的进程组启动。
 * 命令退出、超时或被取消时结束整个进程组，留在后台的进程不跟着这条命令继续运行。
 */
export async function runCommand(
	options: RunCommandOptions,
): Promise<CommandRun> {
	const [command, ...args] = options.argv;
	if (command === undefined) throw new Error("要运行的命令是空的");
	const file = createWriteStream(options.outputFile, { mode: 0o600 });
	const collector = new OutputCollector();
	let streamed = 0;
	let streaming = Promise.resolve();
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error(`启动命令失败：${command}`);
	// 两个事件都要在这里就开始等：输出的管道先关闭时，close 紧跟着 exit 同步发出，等 exit 之后再等就错过了
	const exited = once(child, "exit") as Promise<
		[number | null, NodeJS.Signals | null]
	>;
	const closed = once(child, "close");
	const collect = (chunk: Buffer) => {
		file.write(chunk);
		collector.add(chunk);
		if (streamed < streamedLimit) {
			const part = chunk.subarray(0, streamedLimit - streamed);
			streamed += part.length;
			streaming = streaming.then(() => options.onOutput(part.toString("utf8")));
		}
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	try {
		await options.tracker.add(pid, "command");
	} catch (error) {
		killGroup(pid);
		await closed;
		file.end();
		throw error;
	}

	let timedOut = false;
	let cancelled = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(pid);
	}, options.timeoutMs);
	const onAbort = () => {
		cancelled = true;
		killGroup(pid);
	};
	options.signal.addEventListener("abort", onAbort, { once: true });
	if (options.signal.aborted) onAbort();

	const [exitCode, signal] = await exited;
	clearTimeout(timer);
	options.signal.removeEventListener("abort", onAbort);
	killGroup(pid);
	await options.tracker.remove(pid);
	// 输出的管道可能还有没读完的数据，等它们关闭
	await closed;
	file.end();
	await once(file, "finish");
	await streaming;
	return {
		exitCode,
		signal,
		timedOut,
		cancelled,
		output: collector.text(options.outputFile),
		outputBytes: collector.bytes,
	};
}
