import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BackendCapabilities } from "../contracts/backend.js";
import {
	type HelperCall,
	type HelperMessage,
	type HelperRequest,
	lines,
} from "./helper-protocol.js";
import {
	type FilesystemRules,
	type HelperScope,
	runtimeConfig,
} from "./policy.js";
import { type ReaperOptions, withReaper } from "./reaper.js";

/** 关闭 stdin 之后等辅助进程退出的时间。 */
const exitGraceMs = 5_000;

/** 保留的辅助进程 stderr 的长度，诊断用。 */
const diagnosticsBytes = 8 * 1024;

/** Unix socket 路径的字节上限（macOS 的 `sun_path` 是 104 字节，含结尾的 0）。 */
const maxSocketPathBytes = 103;

/** sandbox-runtime 在辅助进程的 `TMPDIR` 里建的 socket 中最长的文件名。 */
const longestSocketName = "srt-mux-4194304-99.sock";

/** 沙盒后端做不到要求的隔离，或者当前平台没有后端：报告不支持并停止，不降级运行。 */
export class SandboxUnavailableError extends Error {
	override name = "SandboxUnavailableError";
}

/**
 * 当前平台的沙盒后端的能力：macOS 用 Seatbelt，Linux 用 bubblewrap 和 seccomp（只支持 x64 和 arm64）。
 * 没有后端的平台抛 `SandboxUnavailableError`。后端的依赖（bubblewrap、socat、ripgrep、seccomp 组件）
 * 在辅助进程初始化时检查，缺一项同样报不支持。
 */
export function checkSandboxSupport(
	platform: NodeJS.Platform,
): BackendCapabilities {
	if (platform === "darwin") {
		return {
			platform,
			unix_sockets: true,
			local_binding: true,
			process_cleanup: "reaper",
		};
	}
	if (
		platform === "linux" &&
		(process.arch === "x64" || process.arch === "arm64")
	) {
		return {
			platform,
			// seccomp 不能按路径放行 Unix socket；每个命令沙盒有自己的网络命名空间，申请本地端口不改变什么
			unix_sockets: false,
			local_binding: false,
			process_cleanup: "pid_namespace",
		};
	}
	throw new SandboxUnavailableError(
		`${platform}（${process.arch}）上没有沙盒后端；要不启用沙盒，显式指定 danger-full-access`,
	);
}

type CallWithoutId = HelperCall extends infer T
	? T extends unknown
		? Omit<T, "id">
		: never
	: never;

/** Host 对一次网络询问的回答。`reason` 交给沙盒里发起连接的程序。 */
export type NetworkAnswer = { allow: true } | { allow: false; reason: string };

/** 启动辅助进程的方式。 */
export interface SandboxHelperOptions {
	/** 辅助进程的入口文件（`@ospreycode/sandbox/helper`）。 */
	entry: string;
	/** 工作区：辅助进程的当前目录，sandbox-runtime 的强制保护以它为根。 */
	workspace: string;
	/** session 的临时目录：沙盒里的 `TMPDIR`，sandbox-runtime 的 socket 也建在这里。 */
	tmpdir: string;
	/** 辅助进程的环境变量，也是它生成的沙盒的环境变量。 */
	env: Record<string, string>;
	/** 这个辅助进程生成的沙盒共用、只能按进程设置的部分。 */
	scope: HelperScope;
	/**
	 * 沙盒里的程序连接名单之外的域名时调用，连接挂起到它返回为止。只在 `scope.network` 给出时有用；
	 * 不给时名单之外的域名全部拒绝。
	 */
	ask?: (request: { host: string; port: number }) => Promise<NetworkAnswer>;
	/** 辅助进程不是因为 `stop()` 而退出时调用：它的代理随之失效，之后的沙盒要换一个辅助进程。 */
	onExit?: (reason: string) => void;
}

/** 辅助进程退出的方式：退出码，或者结束它的信号。 */
export interface HelperExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** 一个运行中的辅助进程。 */
export interface SandboxHelper {
	/** 辅助进程的 pid，也是它的进程组编号。 */
	readonly pid: number;
	/** 辅助进程退出时兑现，不论是不是因为 `stop()`。 */
	readonly exited: Promise<HelperExit>;
	/** 辅助进程自己启动的子进程（Linux 上的 socat 桥接），和它一起记进进程登记表。 */
	readonly children: readonly number[];
	/**
	 * 为一个沙盒生成完整的启动命令。`reaper` 给出时（macOS）在实例里加上收尾进程，
	 * 调用方启动命令时要在这个文件描述符上传入管道。
	 */
	wrap(
		command: string,
		bash: string,
		filesystem: FilesystemRules,
		reaper?: Omit<ReaperOptions, "hostPid">,
	): Promise<string[]>;
	/** 一个沙盒里的命令结束之后调用：Linux 上删掉 sandbox-runtime 为它放的占位。 */
	cleanup(): Promise<void>;
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
	const socket = join(options.tmpdir, longestSocketName);
	if (Buffer.byteLength(socket) > maxSocketPathBytes) {
		throw new SandboxUnavailableError(
			`临时目录的路径太长，放不下沙盒后端的 Unix socket（上限 ${maxSocketPathBytes} 字节）：${socket}`,
		);
	}
	const child = spawn(process.execPath, [options.entry], {
		// sandbox-runtime 的强制保护以辅助进程的当前目录为根，wrap 也不接受工作目录参数
		cwd: options.workspace,
		// sandbox-runtime 把沙盒里的 TMPDIR 设成这个变量，不设时是本机所有沙盒共用的 /tmp/claude
		env: { ...options.env, CLAUDE_CODE_TMPDIR: options.tmpdir },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("启动沙盒的辅助进程失败");
	let stderr = Buffer.alloc(0);
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = Buffer.concat([stderr, chunk]).subarray(-diagnosticsBytes);
	});
	type Result = Extract<HelperMessage, { result: unknown }>["result"];
	const pending = new Map<
		number,
		{ resolve: (result: Result) => void; reject: (error: Error) => void }
	>();
	let stopping = false;
	const exited = new Promise<HelperExit>((resolve) => {
		child.once("exit", (code, signal) => {
			const reason = `沙盒的辅助进程退出了（${signal ?? code}）：${stderr.toString("utf8")}`;
			const error = new SandboxUnavailableError(reason);
			for (const { reject } of pending.values()) reject(error);
			pending.clear();
			if (!stopping) options.onExit?.(reason);
			resolve({ code, signal });
		});
	});
	const write = (message: HelperRequest) => {
		// 辅助进程已经退出时写不进去：等待回复的调用由上面的 exit 处理拒绝
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	const answerAsk = async ({
		id,
		host,
		port,
	}: Extract<HelperMessage, { ask: unknown }>["ask"]) => {
		const answer: NetworkAnswer =
			options.ask === undefined
				? { allow: false, reason: "network access is not available" }
				: await options.ask({ host, port });
		write({
			method: "answer",
			params: {
				ask: id,
				allow: answer.allow,
				...(answer.allow ? {} : { reason: answer.reason }),
			},
		});
	};
	void (async () => {
		for await (const line of lines(child.stdout)) {
			const message = JSON.parse(line) as HelperMessage;
			if ("ask" in message) {
				// 不在这里等回答：用户可能几分钟后才回答，其间还要收其他请求的回复
				void answerAsk(message.ask);
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter === undefined) {
				throw new Error(`辅助进程回复了不存在的请求 ${message.id}`);
			}
			pending.delete(message.id);
			if ("error" in message) waiter.reject(new Error(message.error));
			else waiter.resolve(message.result);
		}
	})();
	let nextId = 0;
	const request = (message: CallWithoutId) =>
		new Promise<Result>((resolve, reject) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				reject(new SandboxUnavailableError("沙盒的辅助进程已经退出"));
				return;
			}
			const id = nextId++;
			pending.set(id, { resolve, reject });
			write({ ...message, id } as HelperCall);
		});
	let children: number[];
	try {
		const result = await request({
			method: "initialize",
			params: {
				config: runtimeConfig(options.scope),
				ask: options.scope.network !== undefined && options.ask !== undefined,
			},
		});
		children = result.children ?? [];
	} catch (error) {
		stopping = true;
		child.kill("SIGKILL");
		throw new SandboxUnavailableError(
			`沙盒后端初始化失败：${(error as Error).message}`,
			{ cause: error },
		);
	}
	return {
		pid,
		exited,
		children,
		async wrap(command, bash, filesystem, reaper) {
			const { argv } = await request({
				method: "wrap",
				params: {
					command:
						reaper === undefined
							? command
							: withReaper(command, bash, { ...reaper, hostPid: process.pid }),
					bash,
					filesystem,
				},
			});
			if (argv === undefined) throw new Error("辅助进程没有给出启动命令");
			return argv;
		},
		async cleanup() {
			await request({ method: "cleanup" });
		},
		async stop() {
			stopping = true;
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

/**
 * 在沙盒里实际运行一条空命令，确认后端启动得了命令。Linux 上 AppArmor 限制了 user namespace，
 * 或者加载了 `bwrap-userns-restrict` 配置时，依赖检查都能通过，但任何命令都运行不了。
 */
export async function verifySandboxBackend(
	helper: SandboxHelper,
	bash: string,
	filesystem: FilesystemRules,
	env: Record<string, string>,
): Promise<void> {
	const [command, ...args] = await helper.wrap("true", bash, filesystem);
	if (command === undefined) throw new Error("辅助进程给出的启动命令是空的");
	const result = spawnSync(command, args, { env, encoding: "utf8" });
	await helper.cleanup();
	if (result.status !== 0) {
		throw new SandboxUnavailableError(
			`沙盒后端启动不了命令（${result.signal ?? result.status}）：${result.stderr}`,
		);
	}
}
