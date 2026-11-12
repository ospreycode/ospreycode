import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkFilesystem } from "./filesystem.js";
import { currentUid, isInside } from "./paths.js";

/** 工作区或 Host 根目录不满足要求，或者工作区已经有打开的 session。 */
export class WorkspaceError extends Error {
	override name = "WorkspaceError";
}

/** 工作区：启动 Host 时的当前目录，取真实路径。 */
export function resolveWorkspace(path: string): string {
	if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
		throw new WorkspaceError(`工作区不是目录：${path}`);
	}
	return realpathSync(path);
}

/** 项目根目录，以及它是不是 git 仓库。 */
export interface ProjectRoot {
	root: string;
	git: boolean;
}

/**
 * 项目根目录：从工作区逐级向上找到的第一个 `.git`（目录或文件）所在的目录，不是 git 仓库时就是
 * 工作区。只看 `.git` 在不在，识别时不运行 git、不读仓库里的文件。
 */
export function findProjectRoot(workspace: string): ProjectRoot {
	for (let dir = workspace; ; dir = dirname(dir)) {
		if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false }) !== undefined) {
			return { root: dir, git: true };
		}
		if (dirname(dir) === dir) return { root: workspace, git: false };
	}
}

/**
 * 在 Host 根目录下建一个 0700 的目录。已有的不能是符号链接：沙盒按路径放开根目录下的子目录，
 * 链接会把放开的范围带到别处。
 */
export function ensureDirectory(path: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) {
		mkdirSync(path, { mode: 0o700 });
		return;
	}
	if (!stat.isDirectory()) {
		throw new WorkspaceError(
			`Host 根目录下的 ${path} 要是目录，不能是符号链接或文件`,
		);
	}
}

/**
 * 准备 Host 根目录，返回真实路径：不存在时以 0700 创建，已存在时要属于当前用户、权限为 0700，
 * 并且不在网络文件系统上（SQLite 的 WAL 不可用）。所有沙盒都拒绝读取整个根目录，再按用途放开子目录。
 */
export function prepareRoot(root: string): string {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stat = statSync(root);
	if (stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o700) {
		throw new WorkspaceError(
			`Host 根目录要属于当前用户、权限为 700，现在是 ${(stat.mode & 0o777).toString(8)}：${root}`,
		);
	}
	const real = realpathSync(root);
	const network = networkFilesystem(real);
	if (network !== undefined) {
		throw new WorkspaceError(
			`Host 根目录在网络文件系统（${network}）上，SQLite 的 WAL 在上面不可用：${real}`,
		);
	}
	for (const dir of ["data", "data/locks", "data/logs"]) {
		ensureDirectory(join(real, dir));
	}
	return real;
}

/** 根目录和工作区互相包含时报错：快照和搜索会碰到 Host 的数据，或者 agent 读不到自己的工作区。 */
export function checkSeparate(root: string, workspace: string): void {
	if (isInside(root, workspace) || isInside(workspace, root)) {
		throw new WorkspaceError(
			`Host 根目录 ${root} 和工作区 ${workspace} 不能互相包含`,
		);
	}
}

/**
 * Host 和它依赖的包（包括 Node 本身）不能装在工作区里：沙盒内的 agent 可以改写工作区，改过的代码
 * 下次会在沙盒外运行。`files` 是 Host 用到的程序文件。
 */
export function checkInstallLocation(
	workspace: string,
	files: readonly string[],
): void {
	const inside = files.find((file) => isInside(realpathSync(file), workspace));
	if (inside !== undefined) {
		throw new WorkspaceError(
			`Osprey Code 的程序文件 ${inside} 在工作区 ${workspace} 里：沙盒里的 agent 能改写它，改过的代码会在沙盒外运行。把 Osprey Code 装到工作区之外再运行`,
		);
	}
}

/** 一个 session 在根目录下的目录。 */
export interface SessionDirectories {
	/** 作为 `TMPDIR` 的临时目录，这个 session 的沙盒可读写。 */
	tmp: string;
	/** 命令的输出文件，由 Host 写入，沙盒只能读。 */
	output: string;
	/** 这个项目的构建缓存，命令沙盒可读写。 */
	cache: string;
	/**
	 * worker（在自己的工作区里运行的子 agent）的工作区所在的目录：每个 worker 一个子目录，只有它自己的
	 * 沙盒可写，这个 session 的其他沙盒只读。配置里有这样的定义时才创建（`ensureWorkersDirectory`）。
	 */
	workers: string;
}

/**
 * 一个 session 自己的临时目录、输出目录和 worker 目录的位置。目录名取 session 标识的前 12 个字符：
 * Unix socket 的路径有长度上限，沙盒后端的 socket 建在临时目录里。
 */
export function sessionPaths(
	root: string,
	sessionId: string,
): Pick<SessionDirectories, "tmp" | "output" | "workers"> {
	const name = sessionId.slice(0, 12);
	return {
		tmp: join(root, "tmp", name),
		output: join(root, "output", name),
		workers: join(root, "workers", name),
	};
}

/**
 * 一个工作区的影子仓库所在的目录 `snapshots/<项目>/<工作区>/`。目录名和工作区锁的文件名用同一个
 * 摘要：工作区真实路径 SHA-256 的前 16 位十六进制。
 */
export function snapshotDirectory(
	root: string,
	projectId: string,
	workspace: string,
): string {
	const digest = createHash("sha256").update(workspace).digest("hex");
	return join(root, "snapshots", projectId, digest.slice(0, 16));
}

/** 创建 session 的临时目录、输出目录和它所属项目的缓存目录。worker 目录用到时才创建。 */
export function createSessionDirectories(
	root: string,
	sessionId: string,
	projectId: string,
): SessionDirectories {
	const directories = {
		...sessionPaths(root, sessionId),
		cache: join(root, "cache", projectId),
	};
	for (const parent of ["tmp", "output", "cache"]) {
		ensureDirectory(join(root, parent));
	}
	for (const dir of [directories.tmp, directories.output, directories.cache]) {
		ensureDirectory(dir);
	}
	return directories;
}

/** 创建这个 session 的 worker 目录：沙盒按路径放开它，要在准备沙盒之前建好。 */
export function ensureWorkersDirectory(
	root: string,
	directories: SessionDirectories,
): void {
	ensureDirectory(join(root, "workers"));
	ensureDirectory(directories.workers);
}
