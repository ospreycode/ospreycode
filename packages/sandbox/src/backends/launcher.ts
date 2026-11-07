import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type HelperRequest,
	type HelperResponse,
	lines,
} from "./helper-protocol.js";
import {
	type FilesystemRules,
	runtimeConfig,
	type SandboxPolicy,
} from "./policy.js";

/** 关闭 stdin 之后等辅助进程退出的时间。 */
const exitGraceMs = 5_000;

/** 保留的辅助进程 stderr 的长度，诊断用。 */
const diagnosticsBytes = 8 * 1024;

/** Unix socket 路径的字节上限（macOS 的 `sun_path` 是 104 字节，含结尾的 0）。 */
const maxSocketPathBytes = 103;

/** sandbox-runtime 在辅助进程的 `TMPDIR` 里建的 socket 中最长的文件名。 */
const longestSocketName = "srt-mux-4194304-99.sock";

/** 沙盒后端做不到要求的隔离，或者当前平台还没有后端：报告不支持并停止，不降级运行。 */
export class SandboxUnavailableError extends Error {
	override name = "SandboxUnavailableError";
}

/** 当前平台有没有沙盒后端。macOS 用 Seatbelt；Linux 的 bubblewrap 在 P1 加入。 */
export function checkSandboxSupport(platform: NodeJS.Platform): void {
	if (platform !== "darwin") {
		throw new SandboxUnavailableError(
			`${platform} 上还没有沙盒后端（Linux 的 bubblewrap 在 P1 加入）；要不启用沙盒，显式指定 danger-full-access`,
		);
	}
}

/** 启动辅助进程的方式。 */
export interface SandboxHelperOptions {
	/** 辅助进程的入口文件（`@ospreycode/sandbox/helper`）。 */
	entry: string;
	/** 这个辅助进程生成的沙盒共用的策略。 */
	policy: SandboxPolicy;
	/** 辅助进程的环境变量，也是它生成的沙盒的环境变量。 */
	env: Record<string, string>;
}

/** 一个运行中的辅助进程。 */
export interface SandboxHelper {
	/** 辅助进程的 pid，也是它的进程组编号。 */
	readonly pid: number;
	/** 为一个沙盒生成完整的启动命令，`filesystem` 是这个沙盒额外的读写范围。 */
	wrap(
		command: string,
		bash: string,
		filesystem?: Pick<FilesystemRules, "allowRead" | "allowWrite">,
	): Promise<string[]>;
	/** 关闭和辅助进程之间的管道，它随后退出；5 秒后还没退出就结束它的进程组。 */
	stop(): Promise<void>;
}

/**
 * 启动一个辅助进程并用给定的配置初始化。辅助进程在单独的进程组里，终端的 Ctrl+C 到不了它；
 * 它启动的沙盒由调用方自己启动和结束。
 */
export async function startSandboxHelper(
	options: SandboxHelperOptions,
): Promise<SandboxHelper> {
	const { policy } = options;
	const socket = join(policy.tmpdir, longestSocketName);
	if (Buffer.byteLength(socket) > maxSocketPathBytes) {
		throw new SandboxUnavailableError(
			`临时目录的路径太长，放不下沙盒后端的 Unix socket（上限 ${maxSocketPathBytes} 字节）：${socket}`,
		);
	}
	const child = spawn(process.execPath, [options.entry], {
		// sandbox-runtime 的强制保护以辅助进程的当前目录为根，wrap 也不接受工作目录参数
		cwd: policy.workspace,
		// sandbox-runtime 把沙盒里的 TMPDIR 设成这个变量，不设时是本机所有沙盒共用的 /tmp/claude
		env: { ...options.env, CLAUDE_CODE_TMPDIR: policy.tmpdir },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("启动沙盒的辅助进程失败");
	let stderr = Buffer.alloc(0);
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = Buffer.concat([stderr, chunk]).subarray(-diagnosticsBytes);
	});
	const pending = new Map<
		number,
		{
			resolve: (result: { argv?: string[] }) => void;
			reject: (error: Error) => void;
		}
	>();
	const exited = new Promise<void>((resolve) => {
		child.once("exit", (code, signal) => {
			const error = new SandboxUnavailableError(
				`沙盒的辅助进程退出了（${signal ?? code}）：${stderr.toString("utf8")}`,
			);
			for (const { reject } of pending.values()) reject(error);
			pending.clear();
			resolve();
		});
	});
	void (async () => {
		for await (const line of lines(child.stdout)) {
			const response = JSON.parse(line) as HelperResponse;
			const waiter = pending.get(response.id);
			if (waiter === undefined) {
				throw new Error(`辅助进程回复了不存在的请求 ${response.id}`);
			}
			pending.delete(response.id);
			if ("error" in response) waiter.reject(new Error(response.error));
			else waiter.resolve(response.result);
		}
	})();
	let nextId = 0;
	const request = (message: Omit<HelperRequest, "id">) =>
		new Promise<{ argv?: string[] }>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
		});
	try {
		await request({
			method: "initialize",
			params: { config: runtimeConfig(policy) },
		});
	} catch (error) {
		child.kill("SIGKILL");
		throw new SandboxUnavailableError(
			`沙盒后端初始化失败：${(error as Error).message}`,
			{ cause: error },
		);
	}
	return {
		pid,
		async wrap(command, bash, filesystem) {
			const { argv } = await request({
				method: "wrap",
				params: {
					command,
					bash,
					...(filesystem === undefined ? {} : { filesystem }),
				},
			});
			if (argv === undefined) throw new Error("辅助进程没有给出启动命令");
			return argv;
		},
		async stop() {
			child.stdin.end();
			await Promise.race([
				exited,
				sleep(exitGraceMs, undefined, { ref: false }),
			]);
			try {
				process.kill(-pid, "SIGKILL");
			} catch (error) {
				// 辅助进程已经退出，进程组里没有进程了（macOS 上只剩僵尸进程时报 EPERM）
				const { code } = error as NodeJS.ErrnoException;
				if (code !== "ESRCH" && code !== "EPERM") throw error;
			}
		},
	};
}
