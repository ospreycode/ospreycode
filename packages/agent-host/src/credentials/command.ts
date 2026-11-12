import { spawn } from "node:child_process";
import {
	type CommandSource,
	CredentialError,
	type LoadedCredential,
} from "./sources.js";

const defaultTimeoutMs = 5000;
const defaultRefreshIntervalMs = 300_000;
/** 凭据不会有这么长：超过就是配错了程序，不接着往内存里读。 */
const maxOutputBytes = 1024 * 1024;

/** 运行输出凭据的命令时用到的环境。 */
export interface CommandContext {
	/** 当前目录：Host 根目录。不在工作区里运行，仓库里的文件不该影响这个程序。 */
	cwd: string;
	/** Host 启动时的环境变量，原样交给程序。 */
	env: Readonly<Record<string, string | undefined>>;
	/** 每次取到凭据时登记，之后的日志和错误信息都去掉它。 */
	onSecret: (value: string) => void;
}

/**
 * 不经 shell 运行输出凭据的命令，返回标准输出去掉首尾空白后的内容。标准输入关闭，标准错误丢弃。
 * 运行不了、超时、退出码不是 0 或没有输出时抛出 `CredentialError`，错误信息不含程序的输出。
 */
export function runCredentialCommand(
	id: string,
	source: CommandSource,
	context: CommandContext,
): Promise<string> {
	const timeout = source.timeout_ms ?? defaultTimeoutMs;
	const fail = (reason: string) =>
		new CredentialError(`凭据 ${id} 的命令 ${source.command} ${reason}`);
	return new Promise((resolve, reject) => {
		const child = spawn(source.command, source.args ?? [], {
			cwd: context.cwd,
			env: { ...context.env },
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let stopped: string | undefined;
		// 程序的子进程可能还拿着管道：结束程序的同时关掉读的一端，不等它们
		const stop = (reason: string) => {
			stopped = reason;
			child.kill("SIGKILL");
			child.stdout.destroy();
		};
		const timer = setTimeout(
			() => stop(`超过 ${timeout} 毫秒没有结束`),
			timeout,
		);
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxOutputBytes) stop(`的输出超过了 ${maxOutputBytes} 字节`);
			else chunks.push(chunk);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(fail(`运行不了：${error.code ?? error.name}`));
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (stopped !== undefined) {
				reject(fail(stopped));
			} else if (code !== 0) {
				reject(
					fail(
						code === null ? `被信号 ${signal} 结束` : `以退出码 ${code} 结束`,
					),
				);
			} else {
				const value = Buffer.concat(chunks).toString("utf8").trim();
				if (value === "") reject(fail("没有输出"));
				else resolve(value);
			}
		});
	});
}

/**
 * 运行命令取一个凭据。之后服务返回 401 或过了 `staleAt` 时用 `rerun` 重新运行；
 * `refresh_interval_ms` 为 0 时只在 401 之后重新运行。
 */
export async function loadCommandCredential(
	id: string,
	source: CommandSource,
	context: CommandContext,
): Promise<LoadedCredential> {
	const interval = source.refresh_interval_ms ?? defaultRefreshIntervalMs;
	const staleAt = () =>
		interval === 0 ? {} : { staleAt: Date.now() + interval };
	const run = async () => {
		const value = await runCredentialCommand(id, source, context);
		context.onSecret(value);
		return value;
	};
	const credential: LoadedCredential = {
		id,
		value: await run(),
		...staleAt(),
		rerun: async () => {
			const value = await run();
			Object.assign(credential, staleAt());
			return value;
		},
	};
	return credential;
}

/**
 * 发请求之前取凭据的值：命令来源的过了 `staleAt` 就先重新运行命令。运行不了时抛出 `CredentialError`。
 */
export async function currentCredential(
	credential: LoadedCredential,
): Promise<string> {
	if (
		credential.rerun !== undefined &&
		credential.staleAt !== undefined &&
		Date.now() >= credential.staleAt
	) {
		credential.value = await credential.rerun();
	}
	return credential.value;
}
