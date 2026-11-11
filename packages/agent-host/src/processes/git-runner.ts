import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type {
	SandboxedRunOptions,
	SandboxedRunResult,
} from "../workspace/git.js";

/** 快照要求的最低 git 版本：`GIT_CONFIG_GLOBAL` 从 2.32 起才有。 */
const minGit = [2, 32] as const;

/** git 的报错只留末尾这么多：够看出原因，异常情况下不占内存。 */
const maxStderrBytes = 64 * 1024;

/**
 * 一条 git 命令最长运行这么久：10 万个文件的工作区第一次快照约 40 秒，留出余量。超时说明 git
 * 卡住了，结束它，这次快照按失败处理。
 */
const timeoutMs = 10 * 60_000;

/**
 * 按 Host 的 `PATH` 找到做快照用的 git，返回安装目录里 git 本身的真实路径；找不到或版本低于 2.32
 * 时返回原因：这时 session 不做快照。
 */
export function locateGit(
	path: string | undefined,
): { git: string } | { problem: string } {
	for (const dir of (path ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, "git");
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile() !== true) {
			continue;
		}
		try {
			accessSync(candidate, constants.X_OK);
		} catch {
			// 同名但不可执行的文件，接着找 PATH 里的下一个目录
			continue;
		}
		// 只问版本，不读任何仓库和配置
		const result = spawnSync(candidate, ["--version"], {
			env: {},
			encoding: "utf8",
		});
		if (result.error !== undefined || result.status !== 0) {
			return {
				problem: `运行不了 ${candidate} --version：${result.error?.message ?? result.stderr.trim()}`,
			};
		}
		const output = result.stdout.trim();
		const match = /^git version (\d+)\.(\d+)/.exec(output);
		if (match === null) {
			return { problem: `看不懂 git 的版本：${output}` };
		}
		const [major, minor] = [Number(match[1]), Number(match[2])];
		if (major < minGit[0] || (major === minGit[0] && minor < minGit[1])) {
			return { problem: `${output}，快照要求 ${minGit.join(".")} 以上` };
		}
		// PATH 里的可以是转发程序：macOS 的 /usr/bin/git 每次运行都先去找开发者工具，一次快照要运行好几条
		// git 命令，在沙盒里每条多花几十毫秒。git 安装时在 `--exec-path` 的目录里固定放一份它自己，用那一份
		const execPath = spawnSync(candidate, ["--exec-path"], {
			env: {},
			encoding: "utf8",
		});
		if (execPath.error !== undefined || execPath.status !== 0) {
			return {
				problem: `运行不了 ${candidate} --exec-path：${execPath.error?.message ?? execPath.stderr.trim()}`,
			};
		}
		const installed = join(execPath.stdout.trim(), "git");
		if (statSync(installed, { throwIfNoEntry: false })?.isFile() !== true) {
			return { problem: `git 的安装目录里没有 git 本身：${installed}` };
		}
		return { git: realpathSync(installed) };
	}
	return { problem: "PATH 里找不到 git" };
}

/**
 * 运行一条 git 命令（已经包装进沙盒，或者没有沙盒时直接运行），收集它的输出。环境变量只有调用方
 * 给的那些。
 */
export async function runGit(
	argv: readonly string[],
	options: Pick<SandboxedRunOptions, "env" | "cwd" | "stdin">,
): Promise<SandboxedRunResult> {
	const [file, ...args] = argv;
	if (file === undefined) throw new Error("git 的启动命令是空的");
	const child = spawn(file, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	const stdout: Buffer[] = [];
	let stderr = Buffer.alloc(0);
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = Buffer.concat([stderr, chunk]).subarray(-maxStderrBytes);
	});
	// 不读标准输入的命令提前退出时写入会报 EPIPE：结果按退出码判断
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
	child.stdin.end(options.stdin);
	const [code] = (await once(child, "close")) as [number | null];
	return {
		code,
		stdout: Buffer.concat(stdout),
		stderr: stderr.toString("utf8"),
	};
}
