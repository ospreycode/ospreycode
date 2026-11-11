import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionSandbox } from "../processes/extension-sandbox.js";
import { killGroup } from "../processes/group.js";
import { ReaperPipe } from "../processes/reaper.js";
import type { ProcessTracker } from "../processes/registry.js";
import type { ProcessEvent } from "../sessions/events.js";
import type { HookEvent, HookHandler, HookSource } from "./config.js";

/** 交给 hooks 的输入的格式版本，和 session 记录的存储格式分开。 */
export const hookInputVersion = 1;

/** 输入里一个字段内嵌内容的上限：超过就截断，并在输入里加 `truncated: true`。 */
const maxInlineBytes = 64 * 1024;

/** `additional_context` 的上限，字符。 */
const maxContextCharacters = 10_000;

/** handler 的 stdout 和 stderr 各自最多读这么多，其余丢弃。 */
const maxOutputBytes = 1024 * 1024;

/** handler 退出之后等它的输出管道关闭的时间。 */
const drainGraceMs = 2_000;

/** 收尾进程的管道所在的文件描述符。 */
const reaperFd = 3;

/** 每次运行都带的公共字段。 */
export interface HookCommonInput {
	session_id: string;
	/** 工作区。 */
	cwd: string;
	model: string;
	sandbox_mode: string;
	approval_policy: string;
}

/** 一次触发的内容：属于哪个 task 和 run，matcher 匹配的值，以及事件自己的字段。 */
export interface HookTrigger {
	event: HookEvent;
	task_id?: string;
	run_id?: string;
	/** matcher 匹配的值：工具名、`source` 或 `trigger`；没有 matcher 的事件不给。 */
	match?: string;
	/** 事件字段，snake_case。 */
	fields: Record<string, unknown>;
	/** 中止时结束还在运行的 handler，按失败处理。 */
	signal?: AbortSignal;
}

/** 同一时机的 handler 合并后的结果。 */
export interface HookOutcome {
	blocked: boolean;
	/** 阻止的原因，按配置顺序拼接。 */
	reason?: string;
	/** 补充给模型的信息，按配置顺序拼接；被阻止时没有。 */
	additionalContext?: string;
	/** 只给用户看的话。 */
	systemMessages: string[];
	/** 运行了几个 handler。 */
	ran: number;
}

/** 运行 hooks 用到的依赖。 */
export interface HookEngineOptions {
	handlers: readonly HookHandler[];
	/** handler 的环境变量里的 `PATH`、`HOME`、`TMPDIR`。 */
	env: { PATH?: string; HOME?: string; TMPDIR: string };
	workspace: string;
	common: () => HookCommonInput;
	/**
	 * 这个 handler 的沙盒；不启用沙盒（`danger-full-access`）时返回空，handler 直接运行。
	 * 每个 handler 每次运行都要一个新的沙盒实例。
	 */
	sandbox: (handler: HookHandler) => Promise<ExtensionSandbox | undefined>;
	/**
	 * 运行前核对这份 hooks 的内容还是不是确认过的那一份：不是时返回原因，这份 hooks 在这个 session
	 * 里停用。
	 */
	verify: (source: HookSource) => string | undefined;
	tracker: ProcessTracker;
	onProcess: (event: ProcessEvent) => void;
	onWarning: (message: string) => void;
}

interface HandlerResult {
	blocked: boolean;
	reason?: string;
	additionalContext?: string;
	systemMessage?: string;
}

function shellQuote(words: readonly string[]): string {
	return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/** 截到上限以内的最长 UTF-8 前缀，不留半个字符。 */
function clip(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxInlineBytes) return text;
	let end = maxInlineBytes;
	while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

/**
 * 交给 handler 的输入：公共字段加事件字段。hooks 在沙盒里读不到按引用保存的大内容，所以都内嵌；
 * 一个字段超过 64 KiB 时换成它的文字（对象取 JSON 文本）的前 64 KiB，并加上 `truncated: true`。
 */
export function hookInput(
	common: HookCommonInput,
	trigger: HookTrigger,
): Record<string, unknown> {
	let truncated = false;
	const fields = Object.fromEntries(
		Object.entries(trigger.fields).map(([key, value]) => {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			if (Buffer.byteLength(text, "utf8") <= maxInlineBytes) {
				return [key, value];
			}
			truncated = true;
			return [key, clip(text)];
		}),
	);
	return {
		schema_version: hookInputVersion,
		hook_event_name: trigger.event,
		session_id: common.session_id,
		task_id: trigger.task_id ?? null,
		run_id: trigger.run_id ?? null,
		cwd: common.cwd,
		model: common.model,
		sandbox_mode: common.sandbox_mode,
		approval_policy: common.approval_policy,
		...fields,
		...(truncated ? { truncated: true } : {}),
	};
}

function describe(handler: HookHandler): string {
	return `${handler.event} hook ${[handler.command, ...handler.args].join(" ")}（${handler.source.file}）`;
}

/** 读一个流，最多留 `maxOutputBytes`。 */
function collect(stream: NodeJS.ReadableStream): () => string {
	const chunks: Buffer[] = [];
	let bytes = 0;
	stream.on("data", (chunk: Buffer) => {
		if (bytes >= maxOutputBytes) return;
		const part = chunk.subarray(0, maxOutputBytes - bytes);
		chunks.push(part);
		bytes += part.length;
	});
	return () => Buffer.concat(chunks).toString("utf8");
}

/**
 * 在固定时机运行配置的 hooks。每个 handler 每次一个新进程，在按来源固定权限的沙盒里运行；
 * 同一时机的 handler 并行启动，全部结束后合并结果。
 */
export class HookEngine {
	#options: HookEngineOptions;
	/** 内容和确认时不一样、已经在这个 session 里停用的 hooks 文件。 */
	#disabled = new Set<string>();

	constructor(options: HookEngineOptions) {
		this.#options = options;
	}

	/** 这个时机配了 handler。 */
	has(event: HookEvent): boolean {
		return this.#options.handlers.some((handler) => handler.event === event);
	}

	/** 这次触发要运行的 handler：matcher 匹配，命令和参数都相同的只留第一个。 */
	#matching(trigger: HookTrigger): HookHandler[] {
		const seen = new Set<string>();
		return this.#options.handlers.filter((handler) => {
			if (handler.event !== trigger.event) return false;
			if (this.#disabled.has(handler.source.file)) return false;
			if (
				handler.matcher !== undefined &&
				trigger.match !== undefined &&
				!handler.matcher.test(trigger.match)
			) {
				return false;
			}
			const key = JSON.stringify([handler.command, ...handler.args]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	/** 运行这个时机的 hooks，返回合并后的结果。没有匹配的 handler 时什么也不做。 */
	async run(trigger: HookTrigger): Promise<HookOutcome> {
		const { onWarning } = this.#options;
		const handlers = this.#matching(trigger).filter((handler) => {
			const changed = this.#options.verify(handler.source);
			if (changed === undefined) return true;
			this.#disabled.add(handler.source.file);
			onWarning(
				`${handler.source.file} 的 hooks 已停用：${changed}。用 /extensions 或 ospreycode trust review 重新确认。`,
			);
			return false;
		});
		const outcome: HookOutcome = {
			blocked: false,
			systemMessages: [],
			ran: handlers.length,
		};
		if (handlers.length === 0) return outcome;
		const input = JSON.stringify(hookInput(this.#options.common(), trigger));
		const results = await Promise.all(
			handlers.map(async (handler): Promise<HandlerResult> => {
				let failure: string;
				try {
					const result = await this.#runHandler(handler, input, trigger.signal);
					if (typeof result !== "string") return result;
					failure = result;
				} catch (error) {
					failure = `启动失败：${(error as Error).message}`;
				}
				onWarning(`${describe(handler)} 失败了：${failure}`);
				return handler.onFailure === "block"
					? {
							blocked: true,
							reason: `The ${handler.event} hook \`${handler.command}\` failed and is configured to block on failure: ${failure}`,
						}
					: { blocked: false };
			}),
		);
		const reasons: string[] = [];
		const contexts: string[] = [];
		for (const result of results) {
			if (result.blocked) {
				outcome.blocked = true;
				if (result.reason !== undefined) reasons.push(result.reason);
			}
			if (result.additionalContext !== undefined) {
				contexts.push(result.additionalContext);
			}
			if (result.systemMessage !== undefined) {
				outcome.systemMessages.push(result.systemMessage);
			}
		}
		if (outcome.blocked) {
			outcome.reason = reasons.join("\n");
		} else if (contexts.length > 0) {
			outcome.additionalContext = contexts.join("\n");
		}
		return outcome;
	}

	/** 运行一个 handler：返回它的结果，失败时返回原因。 */
	async #runHandler(
		handler: HookHandler,
		input: string,
		signal: AbortSignal | undefined,
	): Promise<HandlerResult | string> {
		const { tracker, onProcess } = this.#options;
		const { source } = handler;
		const env: Record<string, string> = {
			...(this.#options.env.PATH === undefined
				? {}
				: { PATH: this.#options.env.PATH }),
			...(this.#options.env.HOME === undefined
				? {}
				: { HOME: this.#options.env.HOME }),
			TMPDIR: this.#options.env.TMPDIR,
			OSPREYCODE_WORKSPACE: this.#options.workspace,
			PLUGIN_ROOT: source.pluginRoot ?? source.directory,
			...(source.pluginData === undefined
				? {}
				: { PLUGIN_DATA: source.pluginData }),
		};
		const sandbox = await this.#options.sandbox(handler);
		const argv =
			sandbox === undefined
				? [handler.command, ...handler.args]
				: await sandbox.wrap(
						`exec ${shellQuote([handler.command, ...handler.args])}`,
						reaperFd,
					);
		const withReaper = sandbox?.reaper === true;
		const [file, ...args] = argv as [string, ...string[]];
		const child = spawn(file, args, {
			cwd: source.directory,
			env,
			stdio: ["pipe", "pipe", "pipe", ...(withReaper ? ["pipe" as const] : [])],
			detached: true,
		});
		const spawned = await Promise.race([
			once(child, "spawn").then(() => undefined),
			once(child, "error").then(([error]) => error as Error),
		]);
		if (spawned !== undefined) {
			await sandbox?.cleanup();
			return `启动失败：${spawned.message}`;
		}
		const pid = child.pid as number;
		const reaper = withReaper
			? new ReaperPipe(child.stdio[reaperFd] as Socket)
			: undefined;
		const end = async () => {
			await reaper?.reap();
			killGroup(pid);
		};
		const exited = once(child, "exit") as Promise<
			[number | null, NodeJS.Signals | null]
		>;
		const closed = once(child, "close");
		const stdout = collect(child.stdout as NodeJS.ReadableStream);
		const stderr = collect(child.stderr as NodeJS.ReadableStream);
		await tracker.add(pid, "hook");
		onProcess({ type: "process.started", kind: "hook", pid });
		// handler 不读 stdin 就退出时写入会报 EPIPE：它的结果照常按退出码和输出判断
		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") throw error;
		});
		child.stdin?.end(input);
		let timedOut = false;
		let aborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void end();
		}, handler.timeoutMs);
		const onAbort = () => {
			aborted = true;
			void end();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted === true) onAbort();
		const [exitCode, exitSignal] = await exited;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		await end();
		// 脱离了进程组的进程还占着输出的管道时不等它：没有沙盒时 Host 结束不了它
		const drain = new AbortController();
		const held = await Promise.race([
			closed.then(() => false),
			sleep(drainGraceMs, true, { signal: drain.signal }),
		]);
		drain.abort();
		if (held) {
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
		await tracker.remove(pid);
		onProcess({
			type: "process.exited",
			kind: "hook",
			pid,
			exit_code: exitCode,
			signal: exitSignal,
		});
		await sandbox?.cleanup();
		if (timedOut) return `超过了 ${handler.timeoutMs / 1000} 秒的时限`;
		if (aborted) return "被取消了";
		const errors = stderr().trim();
		if (exitCode === 2) {
			return errors === ""
				? "以退出码 2 结束，但 stderr 是空的"
				: { blocked: true, reason: errors };
		}
		if (exitCode !== 0) {
			return `以${exitCode === null ? `信号 ${exitSignal}` : `退出码 ${exitCode}`} 结束${errors === "" ? "" : `：${errors.slice(0, 500)}`}`;
		}
		const output = stdout().trim();
		if (output === "") return { blocked: false };
		let parsed: unknown;
		try {
			parsed = JSON.parse(output);
		} catch {
			return "stdout 不是 JSON";
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return "stdout 不是一个 JSON 对象";
		}
		const { decision, reason, additional_context, system_message } =
			parsed as Record<string, unknown>;
		if (decision !== undefined && decision !== "block") {
			return 'decision 只能是 "block"';
		}
		if (
			(reason !== undefined && typeof reason !== "string") ||
			(additional_context !== undefined &&
				typeof additional_context !== "string") ||
			(system_message !== undefined && typeof system_message !== "string")
		) {
			return "reason、additional_context 和 system_message 要是字符串";
		}
		if (decision === "block" && (reason === undefined || reason === "")) {
			return "decision 为 block 时必须写 reason";
		}
		if (
			additional_context !== undefined &&
			additional_context.length > maxContextCharacters
		) {
			return `additional_context 超过了 ${maxContextCharacters} 个字符`;
		}
		return {
			blocked: decision === "block",
			...(decision === "block" && reason !== undefined ? { reason } : {}),
			...(additional_context === undefined || additional_context === ""
				? {}
				: { additionalContext: additional_context }),
			...(system_message === undefined || system_message === ""
				? {}
				: { systemMessage: system_message }),
		};
	}
}
