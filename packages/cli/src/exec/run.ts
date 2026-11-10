import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";
import {
	type BudgetOptions,
	type CancelSignal,
	exitCodeFor,
	type HostEvent,
	type TaskEndedEvent,
	type TaskOutcome,
} from "@ospreycode/agent-host";
import { flag, type ParsedArgs, value } from "../args/parse.js";
import { sessionArgs } from "../args/session.js";
import type { CliContext, CliInput } from "../context.js";
import { UsageError } from "../errors.js";
import { openHost } from "../host.js";
import { jsonOutput, replyText, textOutput } from "./output.js";

/** `--max-cost` 和 `--max-requests` 的取值：数，或 `none` 表示不设。范围由 Host 检查。 */
function limitArg(args: ParsedArgs, name: string): number | null | undefined {
	const written = value(args, name);
	if (written === undefined) return undefined;
	if (written === "none") return null;
	if (!/^\d+(\.\d+)?$/.test(written)) {
		throw new UsageError(`--${name} 要是数或 none：${written}`);
	}
	return Number(written);
}

const unitMs = { s: 1_000, m: 60_000, h: 3_600_000 };

/** `--timeout` 的取值换成毫秒，写法和配置里的 `max_duration` 相同。 */
function timeoutArg(args: ParsedArgs): number | undefined {
	const written = value(args, "timeout");
	if (written === undefined) return undefined;
	const match = /^([1-9]\d*)([smh])$/.exec(written);
	if (match === null) {
		throw new UsageError(
			`--timeout 要写成 90s、30m、2h 这样的时长：${written}`,
		);
	}
	return Number(match[1]) * unitMs[match[2] as keyof typeof unitMs];
}

/** 命令行里的 PROMPT；写 `-`，或者没有写而标准输入不是终端时，从标准输入读。 */
async function readPrompt(args: ParsedArgs, stdin: CliInput): Promise<string> {
	const written = args.positionals.at(0);
	if (written === undefined && stdin.isTTY === true) {
		throw new UsageError("没有 PROMPT：写在命令行里，或从标准输入传入");
	}
	const prompt =
		written === undefined || written === "-" ? await text(stdin) : written;
	if (prompt.trim() === "") throw new UsageError("PROMPT 是空的");
	return prompt;
}

/**
 * `-o` 的文件在打开 session 之前先清空：路径写错时在开始任务之前就报出来，上一次运行留下的内容
 * 也不会被当成这一次的回复。相对路径相对运行命令时的当前目录。
 */
function prepareReplyFile(args: ParsedArgs, cwd: string): string | undefined {
	const written = value(args, "output-last-message");
	if (written === undefined) return undefined;
	const path = resolve(cwd, written);
	try {
		writeFileSync(path, "");
	} catch (error) {
		throw new UsageError(
			`写不了 -o 指定的文件 ${path}：${(error as NodeJS.ErrnoException).code}`,
			{ cause: error },
		);
	}
	return path;
}

/** `session.ended` 在非交互模式下另带的字段。 */
interface ExecExit {
	/** 主任务的结果，等后台命令时被打断的是打断的原因；主任务没有结果时没有。 */
	outcome?: TaskOutcome;
	exit_code: number;
}

/**
 * `ospreycode exec`：执行一个任务后退出，返回退出码。审批策略固定为 `never`。session 打开之前的
 * 失败照常抛出，由调用方报告；打开之后的失败在这里处理，事件流总以 `session.ended` 结束。
 */
export async function runExec(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const options = sessionArgs(args, context.cwd);
	const timeoutMs = timeoutArg(args);
	const budget: BudgetOptions = {
		maxCostUsd: limitArg(args, "max-cost"),
		maxRequests: limitArg(args, "max-requests"),
	};
	const prompt = await readPrompt(args, context.stdin);
	const host = openHost(context);
	const config = host.resolveConfig({ ...options, budget });
	context.useProxy(config.proxy);
	const replyFile = prepareReplyFile(args, context.cwd);
	const output = flag(args, "json")
		? jsonOutput(context.stdout)
		: textOutput(context.stdout, context.stderr);

	const ended = new Map<string, TaskEndedEvent>();
	const replies = new Map<string, string>();
	let mainTask: string | undefined;
	/** 主任务完成之后 Host 为后台通知开始的 task：处理完这一轮就退出。 */
	let wakeTask: string | undefined;
	/** 主任务完成之后等后台命令和通知时被信号或 `--timeout` 打断：整个运行按打断的原因算。 */
	let cut: "cancelled" | "budget_exceeded" | undefined;
	let signal: CancelSignal | undefined;
	// 第二个信号之后立即退出，不再输出
	let stopped = false;
	// session 打开之后 CLI 自己出了错：退出码是 1，不看主任务的结果
	let crashed = false;
	let onTaskEnded = () => {};
	let onBackgroundChange = () => {};
	/** 主任务的结果和对应的退出码；session 结束时主任务还没有结果（agent 进程反复退出）算失败。 */
	const exit = (): ExecExit => {
		const result = mainTask === undefined ? undefined : ended.get(mainTask);
		if (result === undefined) return { exit_code: 1 };
		const outcome = cut ?? result.outcome;
		return {
			outcome,
			exit_code: crashed ? 1 : exitCodeFor(outcome, signal),
		};
	};
	const onEvent = (event: HostEvent) => {
		if (stopped) return;
		if (event.type === "message.completed") {
			replies.set(event.task_id, replyText(event.message));
		}
		if (event.type === "task.ended") {
			ended.set(event.task_id, event);
			onTaskEnded();
		}
		if (event.type === "task.started" && event.source === "notification") {
			wakeTask ??= event.task_id;
			onBackgroundChange();
		}
		if (event.type === "background.ended") onBackgroundChange();
		output.event(
			event.type === "session.ended" ? { ...event, ...exit() } : event,
		);
	};

	const session = await host.openSession({
		...options,
		approvalPolicy: "never",
		budget: {
			...budget,
			// 时限交给 Host 作为主任务的时间上限：到时由它取消，task.ended 记的就是 budget_exceeded
			...(timeoutMs === undefined
				? {}
				: {
						maxDurationMs: Math.min(
							timeoutMs,
							config.budget.maxDurationMs ?? timeoutMs,
						),
					}),
		},
		onEvent,
	});

	const forced = Promise.withResolvers<number>();
	const failed = Promise.withResolvers<never>();
	/** 等后台命令和通知时被打断。 */
	const interrupted = Promise.withResolvers<void>();
	let waiting = false;
	const interrupt = (reason: "cancelled" | "budget_exceeded") => {
		if (!waiting) return;
		cut = reason;
		interrupted.resolve();
	};
	const unsubscribe = context.onSignal((received) => {
		if (signal !== undefined) {
			stopped = true;
			forced.resolve(exitCodeFor("cancelled", received));
			return;
		}
		signal = received;
		interrupt("cancelled");
		session.cancel().catch(failed.reject);
	});
	/**
	 * 主任务完成之后：它启动的后台命令还在运行就等它们结束（各有时限，由 Host 结束），Host 为它们的
	 * 通知开始的 task 结束后不再等。剩下的后台命令在关闭 session 时结束。
	 */
	const settle = async (): Promise<void> => {
		let announced = false;
		for (;;) {
			// 后台命令结束时 Host 可能接着开始处理通知的 task：等它决定完再看
			await session.whenIdle();
			if (wakeTask !== undefined) return;
			const running = session.backgroundCommands();
			if (running.length === 0) return;
			if (!announced) output.waitingForBackground(running);
			announced = true;
			await new Promise<void>((changed) => {
				onBackgroundChange = changed;
			});
		}
	};
	const run = async (): Promise<number> => {
		// 时限从主任务开始时算起，等后台命令和处理通知的时间也在里面
		const deadline =
			timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		mainTask = await session.submit(prompt);
		const taskId = mainTask;
		const taskEnded = new Promise<void>((done) => {
			onTaskEnded = () => {
				if (ended.has(taskId)) done();
			};
			onTaskEnded();
		});
		await Promise.race([taskEnded, session.ended]);
		const result = ended.get(taskId);
		const reply = replies.get(taskId) ?? "";
		if (replyFile !== undefined) writeFileSync(replyFile, reply);
		if (result !== undefined) output.mainTaskEnded(result, reply);
		if (result?.outcome === "completed") {
			waiting = true;
			const timer =
				deadline === undefined
					? undefined
					: setTimeout(
							() => interrupt("budget_exceeded"),
							deadline - Date.now(),
						);
			await Promise.race([settle(), interrupted.promise, session.ended]);
			waiting = false;
			clearTimeout(timer);
			if (cut !== undefined) output.interrupted(cut);
		}
		await session.close();
		return exit().exit_code;
	};
	try {
		return await Promise.race([run(), forced.promise, failed.promise]);
	} catch (error) {
		// session 已经打开：照常关闭它，让事件流以 session.ended 结束，再把错误写到 stderr
		crashed = true;
		await session.close();
		context.stderr.write(`ospreycode: ${(error as Error).stack}\n`);
		return 1;
	} finally {
		unsubscribe();
	}
}
