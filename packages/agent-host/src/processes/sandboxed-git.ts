import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
	checkSandboxSupport,
	type SandboxPolicy,
	sandboxFilesystem,
	startSandboxHelper,
} from "@ospreycode/sandbox/backends";
import { ConfigError } from "../config/errors.js";
import type { GitResult } from "../extensions/plugins.js";
import { findBash, sandboxEnvironment } from "./environment.js";
import { ReaperPipe } from "./reaper.js";

/** 收尾进程管道所在的文件描述符。 */
const reaperFd = 3;

/** git 的输出最多留这么多：commit 和报错都很短，多出来的是异常情况。 */
const maxOutputBytes = 64 * 1024;

/** `createHost` 里和沙盒有关的部分。 */
export interface SandboxedGitHost {
	root: string;
	env: Readonly<Record<string, string | undefined>>;
	helperEntry: string;
	hostEntries: string[];
	install: string[];
}

function shellQuote(words: readonly string[]): string {
	return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

function collect(stream: Readable): () => string {
	const chunks: Buffer[] = [];
	let size = 0;
	stream.on("data", (chunk: Buffer) => {
		if (size >= maxOutputBytes) return;
		chunks.push(chunk);
		size += chunk.length;
	});
	return () => Buffer.concat(chunks).toString("utf8").slice(0, maxOutputBytes);
}

/**
 * 在沙盒里运行一次 git（安装插件时克隆仓库）：只能写 `directory`（Host 根目录的 `tmp/` 下、
 * 这次安装专用的目录），只能访问 `host`，不给时不能联网。用户的 git 配置不起作用，也不提示输入凭据。
 * 当前平台没有沙盒后端时抛出 `SandboxUnavailableError`。
 */
export async function runGitInSandbox(
	args: readonly string[],
	options: { directory: string; host?: string },
	host: SandboxedGitHost,
): Promise<GitResult> {
	const capabilities = checkSandboxSupport(process.platform);
	const { directory } = options;
	const bash = findBash(host.env.PATH);
	// 工作区给一个空目录：写权限只来自临时目录，克隆出来的 `.git` 不在受保护的工作区里
	const workspace = join(directory, "cwd");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	const env: Record<string, string> = {
		...sandboxEnvironment(host.env, {
			tmpdir: directory,
			cache: directory,
			workspace,
			bash,
			extra: {},
		}),
		// 用户配置里的凭据助手和地址改写不参与安装；要凭据的仓库直接失败，不停在提示上
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	const home = env.HOME;
	if (home === undefined) {
		throw new ConfigError(
			"Host 的环境变量里没有 HOME，找不到要禁止读取的密钥位置",
		);
	}
	const policy: SandboxPolicy = {
		mode: "read-only",
		workspace,
		tmpdir: directory,
		cache: directory,
		readOnly: [],
		denyRead: [host.root],
		denyWrite: [],
		home,
		hostRoot: host.root,
		hostEntries: host.hostEntries,
		install: host.install,
	};
	const helper = await startSandboxHelper({
		entry: host.helperEntry,
		workspace,
		tmpdir: directory,
		env,
		scope:
			options.host === undefined
				? {}
				: {
						network: { allowedDomains: [options.host], deniedDomains: [] },
					},
	});
	try {
		// 占位都落在这次安装专用的目录里，随它一起删掉，不用登记
		const filesystem = await sandboxFilesystem(
			policy,
			{ kind: "command", read: [], write: [], escalated: false },
			capabilities.platform,
		);
		const reaper = capabilities.process_cleanup === "reaper";
		const [file, ...rest] = await helper.wrap(
			shellQuote(["git", ...args]),
			bash,
			filesystem.rules,
			reaper ? { fd: reaperFd, close: [] } : undefined,
		);
		if (file === undefined) throw new Error("沙盒的启动命令是空的");
		const child = spawn(file, rest, {
			cwd: workspace,
			env,
			stdio: ["ignore", "pipe", "pipe", ...(reaper ? ["pipe" as const] : [])],
		});
		const pipe = reaper
			? new ReaperPipe(child.stdio[reaperFd] as Socket)
			: undefined;
		const stdout = collect(child.stdio[1] as Readable);
		const stderr = collect(child.stdio[2] as Readable);
		const closed = once(child, "close");
		try {
			const [exitCode] = (await once(child, "exit")) as [number | null];
			// 收尾进程还拿着输出管道：先让它结束实例里剩下的进程，管道才会关
			await pipe?.reap();
			await closed;
			return { exitCode, stdout: stdout(), stderr: stderr() };
		} finally {
			await pipe?.reap();
			if (capabilities.platform === "linux") await helper.cleanup();
		}
	} finally {
		await helper.stop();
	}
}
