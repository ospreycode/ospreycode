import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type HostChannel, openHostChannel } from "@ospreycode/agent-runtime";
import { killGroup } from "./group.js";
import { ReaperPipe } from "./reaper.js";

/** Host 关闭通道后等 agent 进程自己退出的时间。 */
const exitGraceMs = 5_000;

/** 保留的诊断输出的长度。 */
const diagnosticsBytes = 8 * 1024;

/** 进程退出的情况。 */
export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** 启动 agent 进程的方式。 */
export interface AgentProcessOptions {
	/** 完整的命令：`danger-full-access` 下是 Node 加入口文件，否则是沙盒包装后的命令。 */
	argv: readonly string[];
	env: Record<string, string>;
	cwd: string;
	/** 通道因协议错误失效，Host 随后结束这个进程。 */
	onChannelFailure: (error: Error) => void;
	/** 沙盒实例里有收尾进程（macOS）：在 fd 4 上传入它的管道。 */
	reaper: boolean;
}

/** 一个运行中的 agent 进程。 */
export interface AgentProcess {
	readonly pid: number;
	readonly channel: HostChannel;
	readonly exited: Promise<ProcessExit>;
	/** stdout 和 stderr 的末尾，只作诊断。 */
	diagnostics(): string;
	/** 关闭通道表示结束；agent 读到 EOF 后退出，5 秒后还没退出就结束整个进程组。 */
	stop(): Promise<ProcessExit>;
	/** 立即结束沙盒实例里的全部进程和整个进程组。 */
	kill(): void;
	/** 收尾进程在 Host 结束这个实例之前就退出了：不能确认实例里的进程都已结束。 */
	reaperExitedEarly(): boolean;
}

/**
 * 启动 agent 进程：fd 3 是只承载通道的 UNIX socketpair，stdout 和 stderr 只作诊断，
 * 用单独的进程组启动，终端的 Ctrl+C 只到 Host。macOS 上 fd 4 是收尾进程的管道。
 */
export function startAgentProcess(options: AgentProcessOptions): AgentProcess {
	const [command, ...args] = options.argv;
	if (command === undefined) throw new Error("启动 agent 进程的命令是空的");
	const child = spawn(command, args, {
		stdio: [
			"ignore",
			"pipe",
			"pipe",
			"pipe",
			...(options.reaper ? ["pipe" as const] : []),
		],
		env: options.env,
		cwd: options.cwd,
		detached: true,
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error(`启动 agent 进程失败：${command}`);
	let tail = Buffer.alloc(0);
	const keep = (chunk: Buffer) => {
		tail = Buffer.concat([tail, chunk]);
		if (tail.length > diagnosticsBytes) tail = tail.subarray(-diagnosticsBytes);
	};
	child.stdout?.on("data", keep);
	child.stderr?.on("data", keep);
	const exited = new Promise<ProcessExit>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const reaper = options.reaper
		? new ReaperPipe(child.stdio[4] as Socket)
		: undefined;
	// 先让收尾进程结束实例里的进程：直接结束进程组会连它一起结束，脱离进程组的进程就留下了
	const end = async () => {
		await reaper?.reap();
		killGroup(pid);
	};
	// agent 进程自己退出后，实例里剩下的进程（包括收尾进程）也要结束
	void exited.then(end);
	const channel = openHostChannel(
		child.stdio[3] as Socket,
		options.onChannelFailure,
	);
	return {
		pid,
		channel,
		exited,
		diagnostics: () => tail.toString("utf8"),
		kill: () => void end(),
		reaperExitedEarly: () => reaper?.exitedEarly === true,
		async stop() {
			channel.close();
			const exit = await Promise.race([
				exited,
				sleep(exitGraceMs, null, { ref: false }),
			]);
			await end();
			return exit ?? (await exited);
		},
	};
}
