import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { killGroup } from "./group.js";
import { ReaperPipe } from "./reaper.js";
import type { ProcessTracker } from "./registry.js";

/** 交给模型的输出上限（字节），超出时保留开头和结尾各一半，完整输出在输出文件里。 */
export const modelOutputLimit = 32 * 1024;

/** 经通道流回 runtime 的输出上限（字节）。 */
const streamedLimit = 32 * 1024;

/**
 * 命令退出、它的沙盒实例和进程组都结束之后，等输出的管道关闭的时间。写的一端这时通常都关了，剩下的
 * 输出一读完管道就关闭；到时还没关，是脱离了进程组的进程还占着它。
 */
const drainGraceMs = 2_000;

/** 运行一条命令的方式。 */
export interface RunCommandOptions {
	/** 完整的命令：`danger-full-access` 下是 `bash -c <命令>`，否则是沙盒包装后的命令。 */
	argv: readonly string[];
	cwd: string;
	env: Record<string, string>;
	/** 到时结束命令；不给时不计时，由调用方用 `signal` 结束（后台命令的时限由它的管理者计）。 */
	timeoutMs?: number;
	signal: AbortSignal;
	/** 完整输出写到这里，由 Host 写入。 */
	outputFile: string;
	/** 上限以内的输出，按收到的顺序交给调用方流回 runtime。 */
	onOutput: (text: string) => Promise<void>;
	/** 命令的进程记进进程登记表。 */
	tracker: ProcessTracker;
	/** 沙盒实例里有收尾进程（macOS）：在 fd 3 上传入它的管道。 */
	reaper: boolean;
	/** stdin 用管道，写入的一端经 `onStart` 交回（后台命令）；不给时 stdin 接 `/dev/null`。 */
	stdin?: boolean;
	/** 进程启动、记进进程登记表之后调用一次。 */
	onStart?: (started: { stdin: Writable | null }) => void;
	/** 每一块输出的原始数据，和写进输出文件的是同一份。 */
	onData?: (chunk: Buffer) => void;
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
	/** 收尾进程提前退出了：不能确认这个沙盒实例里的进程都已结束。 */
	reaperExitedEarly: boolean;
	/**
	 * 命令结束之后输出的管道还被它启动的进程占着，Host 不再读了：那个进程脱离了进程组，没有沙盒时
	 * Host 结束不了它。
	 */
	outputHeld: boolean;
}

/** 只保留开头和结尾各一半的输出。 */
export class OutputCollector {
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
 * 命令退出、超时或被取消时结束沙盒实例里的全部进程（macOS 上经收尾进程，再结束整个进程组），
 * 留在后台的进程不跟着这条命令继续运行。没有沙盒时只能结束进程组：脱离了进程组的进程留下来，
 * 它还占着输出的管道时不等它，过了 `drainGraceMs` 就关掉管道。
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
		stdio: [
			options.stdin === true ? "pipe" : "ignore",
			"pipe",
			"pipe",
			...(options.reaper ? ["pipe" as const] : []),
		],
		detached: true,
	});
	const { pid, stdout, stderr } = child;
	if (pid === undefined) throw new Error(`启动命令失败：${command}`);
	// 元素个数不定的 stdio 让类型把输出流算作可能为空
	if (stdout === null || stderr === null) {
		throw new Error("命令的 stdout 和 stderr 没有接上管道");
	}
	const reaper = options.reaper
		? new ReaperPipe(child.stdio[3] as Socket)
		: undefined;
	// 先让收尾进程结束实例里的进程：直接结束进程组会连它一起结束，脱离进程组的后台进程就留下了
	const end = async () => {
		await reaper?.reap();
		killGroup(pid);
	};
	// 两个事件都要在这里就开始等：输出的管道先关闭时，close 紧跟着 exit 同步发出，等 exit 之后再等就错过了
	const exited = once(child, "exit") as Promise<
		[number | null, NodeJS.Signals | null]
	>;
	const closed = once(child, "close");
	const collect = (chunk: Buffer) => {
		file.write(chunk);
		collector.add(chunk);
		options.onData?.(chunk);
		if (streamed < streamedLimit) {
			const part = chunk.subarray(0, streamedLimit - streamed);
			streamed += part.length;
			streaming = streaming.then(() => options.onOutput(part.toString("utf8")));
		}
	};
	stdout.on("data", collect);
	stderr.on("data", collect);
	try {
		await options.tracker.add(pid, "command");
	} catch (error) {
		await end();
		await closed;
		file.end();
		throw error;
	}
	options.onStart?.({ stdin: child.stdin });

	let timedOut = false;
	let cancelled = false;
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					void end();
				}, options.timeoutMs);
	const onAbort = () => {
		cancelled = true;
		void end();
	};
	options.signal.addEventListener("abort", onAbort, { once: true });
	if (options.signal.aborted) onAbort();

	const [exitCode, signal] = await exited;
	clearTimeout(timer);
	options.signal.removeEventListener("abort", onAbort);
	await end();
	await options.tracker.remove(pid);
	// 输出的管道可能还有没读完的数据，等它们关闭。脱离了进程组的进程还占着管道时等不到：命令已经
	// 结束，不让它拖住这次调用、后台命令的结束和 session 的关闭
	const drain = new AbortController();
	const outputHeld = await Promise.race([
		closed.then(() => false),
		sleep(drainGraceMs, true, { signal: drain.signal }),
	]);
	drain.abort();
	if (outputHeld) {
		stdout.destroy();
		stderr.destroy();
	}
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
		reaperExitedEarly: reaper?.exitedEarly === true,
		outputHeld,
	};
}
