import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
	type McpConnection,
	type McpConnectOptions,
	openConnection,
} from "../client/connection.js";

/** 启动本地 server 的最终命令行：Host 已经把它包进沙盒。 */
export interface StdioLaunch {
	/** 可执行文件：绝对路径，或交给 PATH 查找的命令名。 */
	command: string;
	args: readonly string[];
	/**
	 * 给 server 进程的环境变量。除此之外进程只继承 `HOME`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、
	 * `USER`（Windows 上是对应的一组），同名时以这里的为准。
	 */
	env: Readonly<Record<string, string>>;
	cwd: string;
	/** server 写到 stderr 的内容，诊断用。 */
	onStderr?: (text: string) => void;
}

/** server 进程退出之后，等其他还拿着它输出管道的进程多久（毫秒），过后强行关闭管道。 */
const pipeGraceMs = 1000;

/**
 * SDK 的 stdio 传输启动的进程。SDK 不公开它，这里读的是 2.4.0 的内部字段 `_process`；
 * 升级 SDK 时要重新核对，字段没了就在连接时报错。
 */
function serverProcess(transport: StdioClientTransport): {
	child: ChildProcess;
	stdout: Socket;
	stderr: Socket;
} {
	const { _process: child } = transport as unknown as {
		_process?: ChildProcess;
	};
	if (child === undefined) {
		throw new Error("SDK 的 stdio 传输启动之后没有给出 server 进程");
	}
	const { stdout, stderr } = child;
	if (!(stdout instanceof Socket) || !(stderr instanceof Socket)) {
		throw new Error("server 进程的 stdout 和 stderr 不是管道");
	}
	return { child, stdout, stderr };
}

/**
 * server 进程退出之后放开它的输出管道。
 *
 * SDK 要等进程的三个标准流都关闭才算连接断了，自己也从不关闭 stdout 和 stderr 这一端。
 * 只要还有别的进程拿着这些管道（server 启动的后台进程；沙盒里读着 stderr、等 Host 关闭连接的
 * 收尾进程），server 退出了连接也不算断：调用只能等到超时，`close()` 之后收尾进程也等不到关闭。
 */
function releasePipesAfterExit(transport: StdioClientTransport): void {
	const { child, stdout, stderr } = serverProcess(transport);
	child.once("exit", () => {
		// 先只关掉 stderr 的写方向：读着它的收尾进程读到 EOF 就结束实例里剩下的进程，
		// 管道随之关闭；这一端还能把 server 最后写的内容读完
		stderr.end();
		// 拿着管道的进程不理会的话，不再等它：到这时 server 写的内容早就读完了
		const timer = setTimeout(() => {
			stdout.destroy();
			stderr.destroy();
		}, pipeGraceMs);
		// 不为这次等待拖住进程退出
		timer.unref();
		child.once("close", () => clearTimeout(timer));
	});
}

/**
 * 启动本地 server 并经 stdio 连接它。
 *
 * 没有给 `options.prior` 时，SDK 先另起一个同样的进程探测协议版本，探测完就结束它，
 * 所以第一次连接这条命令会运行两次；探测用的进程的 stderr 是 `/dev/null`，不是管道。
 */
export async function connectStdio(
	launch: StdioLaunch,
	options: McpConnectOptions,
): Promise<McpConnection> {
	const transport = new StdioClientTransport({
		command: launch.command,
		args: [...launch.args],
		env: { ...launch.env },
		cwd: launch.cwd,
		// 不让 server 的输出直接写到本进程的 stderr 上
		stderr: "pipe",
	});
	const stderr = transport.stderr;
	if (stderr === null) throw new Error("SDK 没有给出 server 的 stderr");
	// SDK 启动进程后马上把它的 stderr 接到这个流上：借这个时机拿到进程，赶在它可能退出之前。
	// 不能改用子类：SDK 只对自己的这个类用兄弟进程探测协议版本
	stderr.once("pipe", () => releasePipesAfterExit(transport));
	const { onStderr } = launch;
	// 一个字符的几个字节可能分在两块数据里
	const decoder = new StringDecoder("utf8");
	// 即使调用方不要这些内容也得读走，否则管道写满后 server 会卡在写 stderr 上
	stderr.on("data", (chunk: Buffer) => {
		const text = decoder.write(chunk);
		if (text !== "") onStderr?.(text);
	});
	// 进程在握手完成前自己退出了的话，SDK 已经给不出 pid
	return await openConnection(
		transport,
		options,
		() => transport.pid ?? undefined,
	);
}
