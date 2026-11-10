import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
	BackgroundEnded,
	BackgroundEndReason,
	BackgroundKind,
	BackgroundStarted,
} from "../sessions/events.js";
import { newId } from "../sessions/ids.js";
import { maxMonitorLines } from "../sessions/inputs.js";
import type { Run } from "../sessions/run.js";
import { type CommandRun, OutputCollector } from "./command.js";

/** 一条命令的运行方式：前台（到时限后转入后台）、放到后台、监视。 */
export type CommandMode = "foreground" | "background" | "monitor";

/** 后台命令的数量、输出和时限的上限。 */
export interface BackgroundLimits {
	/** 同时运行的后台命令的上限，监视也算。 */
	maxRunning: number;
	/** 每条后台命令输出的上限（字节），超出时结束这条命令。 */
	maxOutputBytes: number;
	/** 前台命令的时限（毫秒），到时转入后台。 */
	foreground: { defaultMs: number; maxMs: number };
	/** 后台命令在非交互运行里的时限；交互会话里不给就不限时。 */
	background: { nonInteractiveDefaultMs: number; nonInteractiveMaxMs: number };
	/** 监视的时限：必须有期限。 */
	monitor: { defaultMs: number; maxMs: number; nonInteractiveMaxMs: number };
}

/** 设计文档定下的上限。 */
export const defaultBackgroundLimits: BackgroundLimits = {
	maxRunning: 16,
	maxOutputBytes: 1024 ** 3,
	foreground: { defaultMs: 120_000, maxMs: 600_000 },
	background: {
		nonInteractiveDefaultMs: 600_000,
		nonInteractiveMaxMs: 7_200_000,
	},
	monitor: {
		defaultMs: 300_000,
		maxMs: 1_800_000,
		nonInteractiveMaxMs: 600_000,
	},
};

/**
 * 按运行方式检查模型给的时限，返回生效的时限（`undefined` 是不限时）；超出上限时返回给模型的说明。
 * `interactive` 为假是非交互运行：没有人会来停掉忘了停的命令，后台命令也要有时限。
 */
export function resolveTimeLimit(
	limits: BackgroundLimits,
	mode: CommandMode,
	interactive: boolean,
	timeoutMs: number | undefined,
): { limitMs: number | undefined } | { error: string } {
	const within = (max: number, fallback: number | undefined, what: string) =>
		timeoutMs !== undefined && timeoutMs > max
			? { error: `timeout_ms for ${what} is at most ${max}.` }
			: { limitMs: timeoutMs ?? fallback };
	switch (mode) {
		case "foreground":
			return within(
				limits.foreground.maxMs,
				limits.foreground.defaultMs,
				"a foreground command (use `background: true` for longer ones)",
			);
		case "background":
			return interactive
				? { limitMs: timeoutMs }
				: within(
						limits.background.nonInteractiveMaxMs,
						limits.background.nonInteractiveDefaultMs,
						"a background command in a non-interactive run",
					);
		case "monitor":
			return interactive
				? within(limits.monitor.maxMs, limits.monitor.defaultMs, "a monitor")
				: within(
						limits.monitor.nonInteractiveMaxMs,
						limits.monitor.defaultMs,
						"a monitor in a non-interactive run",
					);
	}
}

/** 命令结束时的结果，和沙盒之外发生、命令自己的输出里看不出原因的事（写给模型的话）。 */
export interface CommandEnd {
	command: CommandRun;
	notes: string[];
}

/** 启动命令时交给 `runCommand` 的几项：由后台命令的管理者决定什么时候结束它、输出交给谁。 */
export interface CommandHooks {
	signal: AbortSignal;
	stdin: boolean;
	onStart: (started: { stdin: Writable | null }) => void;
	onData: (chunk: Buffer) => void;
	onOutput: (text: string) => Promise<void>;
}

/** 要运行的一条 shell 命令。 */
export interface ShellCommand {
	toolCallId: string;
	/** 启动它的 task 的 run：转入后台的事件记在它里面。 */
	run: Run;
	/** 模型写的命令，用在列表和通知里。 */
	command: string;
	mode: CommandMode;
	/** 生效的时限，`resolveTimeLimit` 的结果。 */
	limitMs: number | undefined;
	/** 交互会话：前台命令转入后台之后不限时。 */
	interactive: boolean;
	/** 越界或带额外权限启动：之后向它的 stdin 写入要重新批准。 */
	elevated: boolean;
	outputFile: string;
	/** 前台运行期间取消它的信号：run 被取消，或者这次工具调用被取消。 */
	signal: AbortSignal;
	/** 前台运行期间上限以内的输出，流回 runtime。 */
	onOutput: (text: string) => Promise<void>;
	/**
	 * 启动命令：调用时就启动进程，命令结束、它的沙盒实例收尾之后兑现。没能启动时以错误结束。
	 */
	start: (hooks: CommandHooks) => Promise<CommandEnd>;
}

/**
 * 一条 shell 命令交回工具调用时的情况：已经结束；在后台运行（模型要求的，或前台到了时限转入的，
 * `output` 是到此为止的输出）；后台命令到了上限，没有启动。
 */
export type ShellOutcome =
	| ({
			state: "finished";
			ended: "exited" | "cancelled" | "timed_out";
	  } & CommandEnd)
	| {
			state: "background";
			backgroundId: string;
			transferred: boolean;
			output: string;
			/** 转入后台之后的时限（毫秒）；不限时为空。 */
			limitMs: number | undefined;
	  }
	| { state: "refused"; message: string };

/** 后台命令产生的一条通知，交给 session 的通知队列。 */
export interface BackgroundNotice {
	background_id: string;
	/** 交给模型的文字，不含固定前缀。 */
	text: string;
	/** 监视命令输出的行。 */
	monitor?: { lines: string[]; dropped: number };
	/** 用户操作导致的结束不唤醒 session。 */
	wake: boolean;
}

/** 后台命令的事件和通知交给谁：事件由 session 记录，通知进 session 的队列。 */
export interface BackgroundListener {
	/** 一条命令开始在后台运行，记在启动它的 task 的 run 里。 */
	started(run: Run, started: BackgroundStarted): void;
	ended(ended: BackgroundEnded): void;
	notify(notice: BackgroundNotice): void;
	/** 最后一条运行中的后台命令结束了。 */
	idle(): void;
}

/** 一条运行中的后台命令，给前端和 `/bg` 看。 */
export interface BackgroundCommandInfo {
	background_id: string;
	kind: BackgroundKind;
	command: string;
	/** 启动它的 task。 */
	task_id: string;
	/** 启动它的工具调用。 */
	tool_call_id: string;
	/** 命令开始运行的时刻（ISO 8601）。 */
	started_at: string;
	/** 到这个时刻还没结束就由 Host 结束；不限时为空。 */
	deadline: string | null;
	/** 输出文件。 */
	output_path: string;
	/** 到现在为止输出的字节数。 */
	output_bytes: number;
}

/** 向后台命令的 stdin 写入之前要知道的情况。 */
export interface BackgroundTarget {
	command: string;
	/** 启动它的 task。 */
	taskId: string;
	/** 越界或带额外权限启动。 */
	elevated: boolean;
}

/** 谁停掉的：模型（经 shell 工具）、用户（在前端）、切换到更窄的沙盒模式。 */
type StoppedBy = "model" | "user" | "sandbox_mode";

/** 运行中的一条命令：前台运行时还没有后台命令编号。 */
interface Job {
	spec: ShellCommand;
	startedAt: number;
	controller: AbortController;
	collector: OutputCollector;
	/** 输出还流回 runtime：前台运行期间。 */
	streaming: boolean;
	stdin: Writable | null;
	/** 命令关掉了 stdin，或者已经退出：写不进去了。 */
	stdinClosed: boolean;
	lines: LineSplitter | undefined;
	/** 登记成后台命令之前监视到的行。 */
	early: string[];
	entry: Entry | undefined;
}

/** 一条后台命令，结束之后也留着：模型之后还会查询它。 */
interface Entry {
	id: string;
	kind: BackgroundKind;
	job: Job;
	limitMs: number | undefined;
	deadline: number | null;
	timer: NodeJS.Timeout | undefined;
	/** Host 决定结束它的原因；自己退出的没有。 */
	stop: { reason: BackgroundEndReason; by: StoppedBy | undefined } | undefined;
	end:
		| {
				reason: BackgroundEndReason;
				exitCode: number | null;
				signal: string | null;
				outputBytes: number;
		  }
		| undefined;
	done: PromiseWithResolvers<void>;
}

/** 监视交给模型的每一行最多这么多字符，多出的截掉。 */
const maxLineChars = 1000;

function clip(line: string): string {
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	return text.length > maxLineChars
		? `${text.slice(0, maxLineChars)}… [line truncated]`
		: text;
}

/** 把输出切成行：不完整的最后一行留到下一块。 */
class LineSplitter {
	#decoder = new StringDecoder("utf8");
	#partial = "";

	push(chunk: Buffer): string[] {
		const text = this.#partial + this.#decoder.write(chunk);
		const end = text.lastIndexOf("\n");
		// 一直不换行的输出只留开头：这一行反正要截断
		this.#partial = text.slice(end + 1, end + 1 + maxLineChars + 1);
		return end === -1 ? [] : text.slice(0, end).split("\n").map(clip);
	}

	flush(): string[] {
		const rest = this.#partial + this.#decoder.end();
		this.#partial = "";
		return rest === "" ? [] : [clip(rest)];
	}
}

/** 能暂停的倒计时：前台命令等待网络批准期间不计时。 */
class Countdown {
	#remaining: number;
	#since = Date.now();
	#timer: NodeJS.Timeout | undefined;
	#holds = 0;
	#stopped = false;
	#fire: () => void;

	constructor(ms: number, fire: () => void) {
		this.#remaining = ms;
		this.#fire = fire;
		this.#timer = setTimeout(fire, ms);
	}

	/** 暂停计时，调用返回的函数后继续。几处同时暂停时，都放开了才继续。 */
	hold(): () => void {
		if (this.#holds === 0) {
			clearTimeout(this.#timer);
			this.#remaining -= Date.now() - this.#since;
		}
		this.#holds += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#holds -= 1;
			if (this.#holds === 0 && !this.#stopped) {
				this.#since = Date.now();
				this.#timer = setTimeout(this.#fire, Math.max(0, this.#remaining));
			}
		};
	}

	/** 不再计时，之后放开暂停也一样。 */
	stop(): void {
		clearTimeout(this.#timer);
		this.#stopped = true;
	}
}

function label(entry: Entry): string {
	return entry.kind === "monitor"
		? `Monitor ${entry.id}`
		: `Background command ${entry.id}`;
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))} s`;
}

function outputLine(entry: Entry, bytes: number): string {
	return `Output: ${bytes} bytes in ${entry.job.spec.outputFile}`;
}

/** 模型给的编号对不上任何后台命令时的说明。 */
export function unknownId(backgroundId: string): string {
	return `No background command has the id ${backgroundId}. Use \`action: "status"\` without an id to list the running ones.`;
}

/** 结束的后台命令一句话的说明。 */
function endSentence(entry: Entry, limits: BackgroundLimits): string {
	const { end, stop } = entry;
	if (end === undefined) throw new Error("后台命令还没有结束");
	const name = label(entry);
	switch (end.reason) {
		case "exited":
			if (end.signal !== null) {
				return `${name} was terminated by signal ${end.signal}.`;
			}
			return end.exitCode === null
				? `${name} ended; its exit status is unknown.`
				: `${name} exited with code ${end.exitCode}.`;
		case "time_limit":
			return `${name} reached its time limit of ${entry.limitMs} ms and was stopped.${
				entry.kind === "monitor" ? " Start it again if you still need it." : ""
			}`;
		case "output_limit":
			return `${name} was stopped because its output passed the limit of ${limits.maxOutputBytes} bytes.`;
		case "stopped":
			if (stop?.by === "sandbox_mode") {
				return `${name} was stopped because the user switched to a narrower sandbox mode.`;
			}
			return stop?.by === "user"
				? `${name} was stopped by the user.`
				: `${name} was stopped.`;
		case "session_closed":
			return `${name} was stopped because the session closed.`;
	}
}

/**
 * 一个 session 的后台命令：前台命令到时限后转入后台、模型要求放到后台的命令和监视。它决定每条命令
 * 什么时候结束（时限、输出上限、停止、session 关闭），把监视到的行和命令的结束变成通知。进程由调用方
 * 经 `ShellCommand.start` 启动，每条命令有自己的沙盒实例；编号和状态只在 Host 的内存里，agent 进程
 * 重启不影响它们。
 */
export class BackgroundCommands {
	readonly limits: BackgroundLimits;
	#listener: BackgroundListener;
	#entries = new Map<string, Entry>();
	/** 前台运行中的命令的倒计时，按工具调用。 */
	#countdowns = new Map<string, Countdown>();
	/** 等后台命令全部结束的调用方。 */
	#idleWaiters: (() => void)[] = [];

	constructor(limits: BackgroundLimits, listener: BackgroundListener) {
		this.limits = limits;
		this.#listener = listener;
	}

	#running(): Entry[] {
		return [...this.#entries.values()].filter(
			(entry) => entry.end === undefined,
		);
	}

	/**
	 * 后台命令到了上限时，返回给模型的说明，列出正在运行的命令让它先停掉不需要的。不自动结束最久
	 * 没用的：那可能是用户还要用的开发服务器。
	 */
	refusal(): string | undefined {
		const running = this.#running();
		if (running.length < this.limits.maxRunning) return undefined;
		return [
			`${running.length} background commands are running, which is the limit. Stop the ones you no longer need with \`action: "stop"\`, then start this one again:`,
			...running.map((entry) => this.#listLine(entry)),
		].join("\n");
	}

	/**
	 * 运行一条命令。前台命令结束时返回它的结果；到了时限还没结束就转入后台，返回后台命令编号和到此为止
	 * 的输出，后台命令已经到上限时按超时结束它。放到后台的命令和监视启动后马上返回编号。
	 */
	async run(spec: ShellCommand): Promise<ShellOutcome> {
		const foreground = spec.mode === "foreground";
		if (!foreground) {
			const message = this.refusal();
			if (message !== undefined) return { state: "refused", message };
		}
		const job: Job = {
			spec,
			startedAt: Date.now(),
			controller: new AbortController(),
			collector: new OutputCollector(),
			streaming: foreground,
			stdin: null,
			stdinClosed: false,
			lines: spec.mode === "monitor" ? new LineSplitter() : undefined,
			early: [],
			entry: undefined,
		};
		const started = Promise.withResolvers<void>();
		const finished = spec.start({
			signal: job.controller.signal,
			// 前台命令的 stdin 接 /dev/null，转入后台之后也写不进去
			stdin: !foreground,
			onStart: ({ stdin }) => {
				job.stdin = stdin;
				// 命令不读 stdin 就退出时，写入报 EPIPE：记下来，之后的写入告诉模型已经关闭
				stdin?.on("error", () => {
					job.stdinClosed = true;
				});
				started.resolve();
			},
			onData: (chunk) => this.#onData(job, chunk),
			onOutput: (text) =>
				job.streaming ? spec.onOutput(text) : Promise.resolve(),
		});
		// 没能启动时 `finished` 先以错误结束，照原样抛给调用方
		await Promise.race([started.promise, finished]);
		if (foreground) return this.#foreground(job, finished);
		const entry = this.#register(job, finished, spec.limitMs);
		return {
			state: "background",
			backgroundId: entry.id,
			transferred: false,
			output: "",
			limitMs: entry.limitMs,
		};
	}

	async #foreground(
		job: Job,
		finished: Promise<CommandEnd>,
	): Promise<ShellOutcome> {
		const { spec } = job;
		if (spec.limitMs === undefined) throw new Error("前台命令要有时限");
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			job.controller.abort();
		};
		spec.signal.addEventListener("abort", onAbort, { once: true });
		if (spec.signal.aborted) onAbort();
		const timeout = Promise.withResolvers<"timeout">();
		const countdown = new Countdown(spec.limitMs, () =>
			timeout.resolve("timeout"),
		);
		this.#countdowns.set(spec.toolCallId, countdown);
		try {
			const first = await Promise.race([finished, timeout.promise]);
			if (first !== "timeout") {
				return {
					state: "finished",
					ended: cancelled ? "cancelled" : "exited",
					...first,
				};
			}
			if (cancelled || this.#running().length >= this.limits.maxRunning) {
				// 后台命令已经到了上限：不能再转入后台，按超时结束它
				job.controller.abort();
				return {
					state: "finished",
					ended: cancelled ? "cancelled" : "timed_out",
					...(await finished),
				};
			}
			job.streaming = false;
			// 转入后台之后重新算时限：交互会话里不限时，非交互运行按后台命令的默认值
			const entry = this.#register(
				job,
				finished,
				spec.interactive
					? undefined
					: this.limits.background.nonInteractiveDefaultMs,
			);
			return {
				state: "background",
				backgroundId: entry.id,
				transferred: true,
				output: job.collector.text(spec.outputFile),
				limitMs: entry.limitMs,
			};
		} finally {
			countdown.stop();
			this.#countdowns.delete(spec.toolCallId);
			spec.signal.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * 暂停一个前台命令的超时计时，调用返回的函数后继续：等待网络批准期间不计时。这次工具调用没有
	 * 前台运行中的命令时什么都不做。
	 */
	pauseTimeout(toolCallId: string): () => void {
		return this.#countdowns.get(toolCallId)?.hold() ?? (() => {});
	}

	/** 登记成后台命令：分配编号，开始计它的时限，命令结束时产生通知。 */
	#register(
		job: Job,
		finished: Promise<CommandEnd>,
		limitMs: number | undefined,
	): Entry {
		const { spec } = job;
		const entry: Entry = {
			id: newId(),
			kind: spec.mode === "monitor" ? "monitor" : "command",
			job,
			limitMs,
			deadline: limitMs === undefined ? null : Date.now() + limitMs,
			timer: undefined,
			stop: undefined,
			end: undefined,
			done: Promise.withResolvers<void>(),
		};
		if (limitMs !== undefined) {
			entry.timer = setTimeout(() => this.#end(entry, "time_limit"), limitMs);
		}
		this.#entries.set(entry.id, entry);
		job.entry = entry;
		this.#listener.started(spec.run, {
			background_id: entry.id,
			tool_call_id: spec.toolCallId,
			kind: entry.kind,
			command: spec.command,
			output_path: spec.outputFile,
			deadline:
				entry.deadline === null ? null : new Date(entry.deadline).toISOString(),
		});
		if (job.early.length > 0) this.#monitorLines(entry, job.early);
		job.early = [];
		finished.then(
			(end) => this.#ended(entry, end),
			// 命令没能正常收尾（输出文件写不进去、沙盒实例释放失败）：按结束处理，原因告诉模型
			(error: unknown) =>
				this.#ended(entry, {
					command: {
						exitCode: null,
						signal: null,
						timedOut: false,
						cancelled: false,
						output: "",
						outputBytes: job.collector.bytes,
						reaperExitedEarly: false,
						outputHeld: false,
					},
					notes: [
						`The Host could not finish this command cleanly: ${(error as Error).message}`,
					],
				}),
		);
		return entry;
	}

	#onData(job: Job, chunk: Buffer): void {
		job.collector.add(chunk);
		const lines = job.lines?.push(chunk) ?? [];
		const { entry } = job;
		if (entry === undefined) {
			job.early.push(...lines);
			return;
		}
		if (lines.length > 0) this.#monitorLines(entry, lines);
		if (job.collector.bytes > this.limits.maxOutputBytes) {
			this.#end(entry, "output_limit");
		}
	}

	/** 监视到的行作为一条通知：一次到的行太多时只留最近的，其余只记行数。 */
	#monitorLines(entry: Entry, lines: readonly string[]): void {
		const dropped = Math.max(0, lines.length - maxMonitorLines);
		this.#listener.notify({
			background_id: entry.id,
			text: `${label(entry)} printed:`,
			monitor: { lines: lines.slice(dropped), dropped },
			wake: true,
		});
	}

	/** Host 决定结束一条后台命令：先记下原因，进程结束后再记事件、产生通知。 */
	#end(entry: Entry, reason: BackgroundEndReason, by?: StoppedBy): void {
		if (entry.end !== undefined || entry.stop !== undefined) return;
		entry.stop = { reason, by };
		entry.job.controller.abort();
	}

	#ended(entry: Entry, end: CommandEnd): void {
		clearTimeout(entry.timer);
		const { job } = entry;
		job.stdin = null;
		const rest = job.lines?.flush() ?? [];
		if (rest.length > 0) this.#monitorLines(entry, rest);
		const reason = entry.stop?.reason ?? "exited";
		const { command } = end;
		entry.end = {
			reason,
			exitCode: command.exitCode,
			signal: command.signal,
			outputBytes: command.outputBytes,
		};
		this.#listener.ended({
			background_id: entry.id,
			reason,
			exit_code: command.exitCode,
			signal: command.signal,
			output_bytes: command.outputBytes,
		});
		// 模型自己停掉的，结果已经在那次工具调用里；session 关闭之后没有人再读通知
		const silent =
			reason === "session_closed" ||
			(reason === "stopped" && entry.stop?.by === "model");
		if (!silent) {
			this.#listener.notify({
				background_id: entry.id,
				text: [
					endSentence(entry, this.limits),
					`Command: ${job.spec.command}`,
					outputLine(entry, command.outputBytes),
					...end.notes,
				].join("\n"),
				// 用户操作导致的结束（在前端停止、切换沙盒模式）不唤醒 session
				wake: reason !== "stopped",
			});
		}
		entry.done.resolve();
		if (this.#running().length === 0) {
			this.#listener.idle();
			for (const resolve of this.#idleWaiters.splice(0)) resolve();
		}
	}

	#listLine(entry: Entry): string {
		const { spec, startedAt } = entry.job;
		const limit =
			entry.deadline === null
				? "no time limit"
				: `stops in ${seconds(entry.deadline - Date.now())}`;
		return `- ${entry.id} (${entry.kind}, running for ${seconds(Date.now() - startedAt)}, ${limit}): ${spec.command}`;
	}

	/**
	 * 给模型看的情况。给了编号时是那一条的状态、命令和输出文件，没有这个编号时返回 `undefined`；
	 * 不给编号时列出运行中的全部后台命令。
	 */
	status(): string;
	status(backgroundId: string): string | undefined;
	status(backgroundId?: string): string | undefined {
		if (backgroundId === undefined) {
			const running = this.#running();
			return running.length === 0
				? "No background commands are running."
				: [
						`${running.length} background commands are running:`,
						...running.flatMap((entry) => [
							this.#listLine(entry),
							`  ${outputLine(entry, entry.job.collector.bytes)}`,
						]),
					].join("\n");
		}
		const entry = this.#entries.get(backgroundId);
		if (entry === undefined) return undefined;
		const { job, end } = entry;
		if (end !== undefined) {
			return [
				endSentence(entry, this.limits),
				`Command: ${job.spec.command}`,
				outputLine(entry, end.outputBytes),
			].join("\n");
		}
		const limit =
			entry.deadline === null
				? "It has no time limit."
				: `It stops in ${seconds(entry.deadline - Date.now())}.`;
		return [
			`${label(entry)} is running, started ${seconds(Date.now() - job.startedAt)} ago. ${limit}`,
			`Command: ${job.spec.command}`,
			outputLine(entry, job.collector.bytes),
		].join("\n");
	}

	/** 一条运行中的后台命令的命令行和来历；没有这个编号或已经结束时返回 `undefined`。 */
	target(backgroundId: string): BackgroundTarget | undefined {
		const entry = this.#entries.get(backgroundId);
		if (entry === undefined || entry.end !== undefined) return undefined;
		const { spec } = entry.job;
		return {
			command: spec.command,
			taskId: spec.run.taskId,
			elevated: spec.elevated,
		};
	}

	/**
	 * 向一条后台命令的 stdin 写入。写进去了返回 `undefined`，否则返回给模型的说明：没有这个编号、
	 * 命令已经结束、没有 stdin（前台启动后转入后台的）或已经关掉 stdin。`signal` 中止时不再等：命令
	 * 一直不读、管道满了的时候写入不会结束。
	 */
	async writeStdin(
		backgroundId: string,
		input: string,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const entry = this.#entries.get(backgroundId);
		if (entry === undefined) return unknownId(backgroundId);
		if (entry.end !== undefined) return endSentence(entry, this.limits);
		const { job } = entry;
		const { stdin } = job;
		if (stdin === null) {
			return `${label(entry)} has no stdin: it started in the foreground. Only commands started with \`background: true\` can be written to.`;
		}
		if (job.stdinClosed) return `${label(entry)} has closed its stdin.`;
		const written = new Promise<string | undefined>((resolve) => {
			stdin.write(input, (error) =>
				resolve(
					error === null || error === undefined
						? undefined
						: `${label(entry)} has closed its stdin: ${error.message}`,
				),
			);
		});
		const aborted = Promise.withResolvers<string>();
		const onAbort = () => aborted.resolve("The write was cancelled.");
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			return await Promise.race([
				written,
				aborted.promise,
				entry.done.promise.then(
					() => `${label(entry)} ended before it read the input.`,
				),
			]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * 停止一条后台命令，等它和它的子孙进程结束。没有这个编号或已经结束时返回 false。模型停掉的不产生
	 * 通知；用户停掉的产生一条不唤醒 session 的通知，下一次开始 task 时告诉模型。
	 */
	async stop(backgroundId: string, by: "model" | "user"): Promise<boolean> {
		const entry = this.#entries.get(backgroundId);
		if (entry === undefined || entry.end !== undefined) return false;
		this.#end(entry, "stopped", by);
		await entry.done.promise;
		return true;
	}

	/**
	 * 结束全部运行中的后台命令，等它们结束：session 关闭，或者用户换到了更窄的沙盒模式（已经撤销的
	 * 权限不能继续生效；产生不唤醒 session 的通知）。
	 */
	async stopAll(cause: "session_closed" | "sandbox_mode"): Promise<void> {
		const running = this.#running();
		for (const entry of running) {
			if (cause === "session_closed") this.#end(entry, "session_closed");
			else this.#end(entry, "stopped", "sandbox_mode");
		}
		await Promise.all(running.map((entry) => entry.done.promise));
	}

	/** 运行中的后台命令，按开始的顺序。 */
	list(): BackgroundCommandInfo[] {
		return this.#running().map((entry) => {
			const { spec, startedAt, collector } = entry.job;
			return {
				background_id: entry.id,
				kind: entry.kind,
				command: spec.command,
				task_id: spec.run.taskId,
				tool_call_id: spec.toolCallId,
				started_at: new Date(startedAt).toISOString(),
				deadline:
					entry.deadline === null
						? null
						: new Date(entry.deadline).toISOString(),
				output_path: spec.outputFile,
				output_bytes: collector.bytes,
			};
		});
	}

	/** 这个 task 启动的后台命令里还有没有在运行的：它批准的域名在这期间继续放行。 */
	runningFor(taskId: string): boolean {
		return this.#running().some(
			(entry) => entry.job.spec.run.taskId === taskId,
		);
	}

	/** 运行中的后台命令全部结束时兑现；现在就没有时马上兑现。 */
	whenIdle(): Promise<void> {
		if (this.#running().length === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.#idleWaiters.push(resolve);
		});
	}
}
