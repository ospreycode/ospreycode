import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ApplyEditsResult, FileEditOp } from "@ospreycode/agent-runtime";
import { killGroup } from "./group.js";
import type { ProcessTracker } from "./registry.js";

/** apply-edits 的时限：它只核对和写入几个文件。 */
const timeoutMs = 30_000;

/** 保留的 stderr 的长度，诊断用。 */
const diagnosticsBytes = 8 * 1024;

/** apply-edits 没有给出结果：沙盒没能启动它，它超时了，或者输出不是约定的格式。 */
export class ApplyEditsError extends Error {
	override name = "ApplyEditsError";
}

/** 运行 apply-edits 的方式。 */
export interface ApplyEditsOptions {
	/** 沙盒包装后的完整命令，写权限只给这次批准的文件。 */
	argv: readonly string[];
	cwd: string;
	env: Record<string, string>;
	/** 用户批准的文件改动。 */
	edits: readonly FileEditOp[];
	signal: AbortSignal;
	/** 进程记进进程登记表。 */
	tracker: ProcessTracker;
}

function parseResult(stdout: string): ApplyEditsResult {
	// 输出来自沙盒里的进程，按约定的格式检查
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch (error) {
		throw new ApplyEditsError("apply-edits 的输出不是 JSON", { cause: error });
	}
	const result = value as Partial<Record<string, unknown>> | null;
	if (result?.status === "succeeded") return { status: "succeeded" };
	if (
		result?.status === "failed" &&
		typeof result.message === "string" &&
		Array.isArray(result.written) &&
		result.written.every((path) => typeof path === "string")
	) {
		return {
			status: "failed",
			message: result.message,
			written: result.written,
		};
	}
	throw new ApplyEditsError("apply-edits 的输出不是约定的格式");
}

/**
 * 在给定的沙盒里运行 apply-edits：申请是 stdin 上的一份 JSON，结果是 stdout 上的一份 JSON。
 * 用单独的进程组启动，取消或超时时结束整个进程组；被取消时返回 `cancelled`。
 */
export async function runApplyEdits(
	options: ApplyEditsOptions,
): Promise<ApplyEditsResult | "cancelled"> {
	const [command, ...args] = options.argv;
	if (command === undefined) throw new Error("启动 apply-edits 的命令是空的");
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error(`启动 apply-edits 失败：${command}`);
	// 两个事件都在这里就开始等：close 可能紧跟着 exit 同步发出
	const exited = once(child, "exit") as Promise<
		[number | null, NodeJS.Signals | null]
	>;
	const closed = once(child, "close");
	const stdout: Buffer[] = [];
	let stderr = Buffer.alloc(0);
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = Buffer.concat([stderr, chunk]).subarray(-diagnosticsBytes);
	});
	// 进程提前退出时写 stdin 会报 EPIPE，这时按退出码报告；别的写入错误在进程退出后报告
	let stdinError: Error | undefined;
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") stdinError = error;
	});
	child.stdin.end(JSON.stringify({ edits: options.edits }));
	try {
		await options.tracker.add(pid, "apply_edits");
	} catch (error) {
		killGroup(pid);
		await closed;
		throw error;
	}

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(pid);
	}, timeoutMs);
	const onAbort = () => killGroup(pid);
	options.signal.addEventListener("abort", onAbort, { once: true });
	if (options.signal.aborted) onAbort();

	const [exitCode, signal] = await exited;
	clearTimeout(timer);
	options.signal.removeEventListener("abort", onAbort);
	killGroup(pid);
	await options.tracker.remove(pid);
	await closed;
	if (options.signal.aborted) return "cancelled";
	if (stdinError !== undefined) {
		throw new ApplyEditsError("没能把申请写给 apply-edits", {
			cause: stdinError,
		});
	}
	if (timedOut) {
		throw new ApplyEditsError(`apply-edits ${timeoutMs / 1000} 秒内没有结束`);
	}
	if (exitCode !== 0) {
		throw new ApplyEditsError(
			`apply-edits 没有正常结束（${signal ?? `退出码 ${exitCode}`}）：${stderr.toString("utf8")}`,
		);
	}
	return parseResult(Buffer.concat(stdout).toString("utf8"));
}
