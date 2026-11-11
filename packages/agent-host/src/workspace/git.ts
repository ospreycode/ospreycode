import { dirname } from "node:path";

/** 在沙盒里运行一条命令时的设置。 */
export interface SandboxedRunOptions {
	/** 完整的环境变量：不继承 Host 进程的，用户环境里的 `GIT_*` 和全局配置到不了这里。 */
	env: Record<string, string>;
	cwd: string;
	/** 写给命令的标准输入；不给时命令的标准输入是空的。 */
	stdin?: Buffer;
	/** false：只有影子仓库可写（做快照、比较、清理）；true：工作区也可写（还原）。 */
	writeWorkspace: boolean;
}

/** 沙盒里的命令的结果。 */
export interface SandboxedRunResult {
	/** 退出码；被信号结束时为空。 */
	code: number | null;
	stdout: Buffer;
	stderr: string;
}

/**
 * 在沙盒里运行一条命令：沙盒由实现方负责，没有网络，按 `writeWorkspace` 决定工作区能不能写。
 * `argv` 是完整的命令，`argv[0]` 是 git 的绝对路径。
 */
export type SandboxedRunner = (
	argv: readonly string[],
	options: SandboxedRunOptions,
) => Promise<SandboxedRunResult>;

/** 影子仓库里的 git 没有按预期结束，或者影子仓库里的数据不是本模块写的样子。 */
export class SnapshotError extends Error {
	override name = "SnapshotError";
}

/** 一条 git 命令在哪里运行。 */
export interface GitTarget {
	/** work tree，也是命令的当前目录：路径参数和输出里的路径都相对它。 */
	workTree: string;
	/** 索引文件。 */
	index: string;
}

/** 一条 git 命令的输入。 */
export interface GitInput {
	stdin?: Buffer;
	/** 这条命令要写工作区（还原）。 */
	writeWorkspace?: boolean;
}

/**
 * 提交里的作者和时间固定：不依赖用户的 git 身份配置，同一个 tree 接在同一个父提交后面得到的
 * 提交也相同。
 */
const identity = {
	GIT_AUTHOR_NAME: "ospreycode",
	GIT_AUTHOR_EMAIL: "ospreycode@localhost",
	GIT_AUTHOR_DATE: "@0 +0000",
	GIT_COMMITTER_NAME: "ospreycode",
	GIT_COMMITTER_EMAIL: "ospreycode@localhost",
	GIT_COMMITTER_DATE: "@0 +0000",
};

/** 对一个影子仓库运行 git：每条命令都带完整的环境变量，经沙盒运行。 */
export class ShadowGit {
	#git: string;
	#gitDir: string;
	#run: SandboxedRunner;

	/** `git` 是 git 可执行文件的绝对路径，`gitDir` 是影子仓库的 git 目录。 */
	constructor(git: string, gitDir: string, run: SandboxedRunner) {
		this.#git = git;
		this.#gitDir = gitDir;
		this.#run = run;
	}

	/** 运行一条 git 命令，不看退出码：约定中会失败的命令（还原时写不进去的文件）由调用方判断。 */
	exec(
		args: readonly string[],
		target: GitTarget,
		input: GitInput = {},
	): Promise<SandboxedRunResult> {
		return this.#run([this.#git, ...args], {
			env: {
				// 用户仓库自己的 .git 不参与：配置、hooks、索引和对象都只用影子仓库的
				GIT_DIR: this.#gitDir,
				GIT_WORK_TREE: target.workTree,
				GIT_INDEX_FILE: target.index,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_ATTR_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				// 路径参数按字面匹配：文件名里的 *、?、[ 和开头的 : 不当成模式
				GIT_LITERAL_PATHSPECS: "1",
				...identity,
				// gc 要再启动 git 的其他子命令
				PATH: dirname(this.#git),
			},
			cwd: target.workTree,
			...(input.stdin === undefined ? {} : { stdin: input.stdin }),
			writeWorkspace: input.writeWorkspace === true,
		});
	}

	/** 运行一条 git 命令，返回它的标准输出；退出码不是 0 时抛出带 stderr 的 `SnapshotError`。 */
	async run(
		args: readonly string[],
		target: GitTarget,
		input: GitInput = {},
	): Promise<Buffer> {
		const result = await this.exec(args, target, input);
		if (result.code !== 0) {
			throw new SnapshotError(
				`git ${args[0]} 没有正常结束（${result.code === null ? "被信号结束" : `退出码 ${result.code}`}）：${result.stderr.trim()}`,
			);
		}
		return result.stdout;
	}

	/** 运行一条只输出一个对象名的命令（`write-tree`、`commit-tree`、`mktree`）。 */
	async objectName(
		args: readonly string[],
		target: GitTarget,
		input: GitInput = {},
	): Promise<string> {
		return (await this.run(args, target, input)).toString("ascii").trim();
	}
}

/** 把 `-z` 的输出按 NUL 切开。路径保持原来的字节：文件名不一定是 UTF-8。 */
export function splitNul(output: Buffer): Buffer[] {
	const parts: Buffer[] = [];
	let start = 0;
	for (
		let end = output.indexOf(0);
		end !== -1;
		end = output.indexOf(0, start)
	) {
		parts.push(output.subarray(start, end));
		start = end + 1;
	}
	return parts;
}

/** 把路径拼成 `-z --stdin` 的输入：每个路径后面跟一个 NUL。 */
export function joinNul(paths: readonly Buffer[]): Buffer {
	const nul = Buffer.alloc(1);
	return Buffer.concat(paths.flatMap((path) => [path, nul]));
}
