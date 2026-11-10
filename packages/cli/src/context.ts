import type { Readable, Writable } from "node:stream";

/** 标准输入：管道、文件或终端。是终端时可以关掉回显。 */
export interface CliInput extends Readable {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
}

/** 标准输出和标准错误。 */
export interface CliOutput extends Writable {
	isTTY?: boolean;
}

/** CLI 处理的信号。 */
export type CliSignal = "SIGINT" | "SIGTERM";

/** 打包后各个进程入口的文件，交给 Host 用 `process.execPath` 运行。 */
export interface ProcessEntries {
	agent: string;
	applyEdits: string;
	sandboxHelper: string;
}

/**
 * CLI 运行的环境，全部由进程入口传入：CLI 的其余部分不读 `process.argv`、`process.env` 和
 * `process.cwd()`，测试和嵌入它的程序可以换成自己的。
 */
export interface CliContext {
	/** 命令行参数，不含 Node 和入口文件。 */
	argv: readonly string[];
	/** 进程启动时的环境变量。 */
	env: Readonly<Record<string, string | undefined>>;
	/** 进程启动时的当前目录。 */
	cwd: string;
	platform: NodeJS.Platform;
	stdin: CliInput;
	stdout: CliOutput;
	stderr: CliOutput;
	/** 订阅 SIGINT 和 SIGTERM，返回取消订阅的函数；没有订阅时信号照系统默认的方式结束进程。 */
	onSignal(listener: (signal: CliSignal) => void): () => void;
	/**
	 * 开启访问模型服务的代理：`proxy` 是配置里的 `proxy`，没有配置时为空，由入口改用启动环境里的
	 * `HTTPS_PROXY`。开启代理会改变整个进程的状态，所以交给进程的拥有者做。
	 */
	useProxy(proxy: string | undefined): void;
	/** 打包后各个进程入口的文件；不给时 Host 从依赖包的 exports 找。 */
	entries?: ProcessEntries;
}
