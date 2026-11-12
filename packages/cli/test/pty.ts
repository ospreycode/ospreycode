import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { cliEntry } from "./harness.js";

/** 在伪终端里运行的 CLI 进程。 */
export interface PtyCli {
	/** 到目前为止终端上收到的文字，去掉了控制序列。 */
	output(): string;
	/** 到目前为止终端上收到的原样内容，带着控制序列。 */
	raw(): string;
	/** 等终端上出现这段文字；等不到时报错并带上当时的输出。 */
	waitFor(fragment: string, timeoutMs?: number): Promise<void>;
	/** 送进终端的按键。 */
	write(data: string): void;
	/** 逐个字符地输入一段文字，和人打字一样分开送。 */
	type(text: string): Promise<void>;
	/** CLI 进程的 pid。 */
	pid: Promise<number>;
	/** 给 CLI 进程自己发信号：和 `kill <pid>` 一样，不经过终端。 */
	signal(signal: "SIGINT" | "SIGTERM"): Promise<void>;
	/** CLI 进程结束时的退出码；被 `kill()` 结束的没有退出码。 */
	exit: Promise<number | null>;
	/** 还在运行的话结束它：伪终端关掉，CLI 收到 SIGHUP。 */
	kill(): void;
}

/** 给 `sh -c` 的一个参数加引号。 */
function quote(argument: string): string {
	return `'${argument.replaceAll("'", "'\\''")}'`;
}

/**
 * 用系统的 `script` 命令给 CLI 一个伪终端，运行打包后的入口：标准输入输出都是终端，和用户在终端里
 * 运行一样。伪终端不报告大小，行列数经 COLUMNS 和 LINES 给出。
 */
export function startInPty(
	args: readonly string[],
	options: { cwd: string; env: Record<string, string> },
): PtyCli {
	const cli = [process.execPath, cliEntry, ...args].map(quote).join(" ");
	// 伪终端里先由 shell 把自己的 pid 写到 3 号描述符、关掉它，再 exec 成 CLI：pid 就是 CLI 的，
	// CLI 也不会多继承一个描述符
	const command = `echo "pid $$" >&3; exec 3>&-; exec ${cli}`;
	// macOS 和 Linux 的 script 参数不同：前者把命令写在后面，后者要 -c 带一整条命令
	const script =
		process.platform === "darwin"
			? `script -q /dev/null sh -c ${quote(command)}`
			: `script -qec ${quote(command)} /dev/null`;
	// Node 给子进程的"管道"在 macOS 上是 socket，script 对着它取终端属性会失败：中间隔一个 cat，
	// 让 script 的标准输入是 shell 建的真管道。这样 shell 要等 cat 结束才退出，CLI 的退出码也
	// 从 3 号描述符送回来
	const child = spawn(
		"sh",
		["-c", `cat | { ${script}; echo "exit $?" >&3; }`],
		{
			cwd: options.cwd,
			env: { ...options.env, COLUMNS: "100", LINES: "40" },
			stdio: ["pipe", "pipe", "inherit", "pipe"],
			// 自己一个进程组：结束时连 cat 和 script 一起结束
			detached: true,
		},
	);
	const { stdin, stdout } = child;
	const statusPipe = child.stdio[3];
	if (stdin === null || stdout === null || !(statusPipe instanceof Readable)) {
		throw new Error("子进程的管道没有建起来");
	}
	let raw = "";
	stdout.setEncoding("utf8").on("data", (chunk: string) => {
		raw += chunk;
	});
	const output = () => stripTerminalSequences(raw);
	let running = true;
	const closed = once(child, "close").then(() => {
		running = false;
	});
	// shell 和 cat 也拿着 3 号描述符，等不到它关：一行 `pid <pid>`，CLI 结束后一行 `exit <退出码>`
	const pid = Promise.withResolvers<number>();
	const status = new Promise<string | null>((resolve) => {
		let received = "";
		statusPipe
			.setEncoding("utf8")
			.on("data", (chunk: string) => {
				received += chunk;
				const started = /^pid (\d+)\n/m.exec(received);
				if (started !== null) pid.resolve(Number(started[1]));
				const exited = /^exit (\d+)\n/m.exec(received);
				if (exited !== null) resolve(exited[1] as string);
			})
			.on("end", () => resolve(null));
	});
	return {
		output,
		raw: () => raw,
		async waitFor(fragment, timeoutMs = 30_000) {
			const deadline = Date.now() + timeoutMs;
			while (!output().includes(fragment)) {
				if (Date.now() > deadline) {
					throw new Error(`终端上没有等到 ${fragment}：\n${output()}`);
				}
				await delay(20);
			}
		},
		write: (data) => {
			stdin.write(data);
		},
		async type(typed) {
			for (const character of typed) {
				stdin.write(character);
				await delay(5);
			}
		},
		pid: pid.promise,
		async signal(signal) {
			process.kill(await pid.promise, signal);
		},
		exit: (async () => {
			const code = await status;
			// 标准输入到了结尾，cat 才结束
			stdin.end();
			await closed;
			return code === null ? null : Number(code);
		})(),
		kill: () => {
			if (!running) return;
			if (child.pid === undefined) throw new Error("script 没有启动起来");
			process.kill(-child.pid, "SIGTERM");
		},
	};
}
