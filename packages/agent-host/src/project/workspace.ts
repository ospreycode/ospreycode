import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentUid, isInside } from "./paths.js";

/** 工作区或 Host 根目录不满足要求。 */
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

/**
 * 项目根目录：从工作区逐级向上找到的第一个 `.git`（目录或文件）所在的目录，不是 git 仓库时就是
 * 工作区。只看 `.git` 在不在，识别时不运行 git、不读仓库里的文件。
 */
export function findProjectRoot(workspace: string): string {
	for (let dir = workspace; ; dir = dirname(dir)) {
		if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false }) !== undefined) {
			return dir;
		}
		if (dirname(dir) === dir) return workspace;
	}
}

/**
 * 准备 Host 根目录，返回真实路径：不存在时以 0700 创建，已存在时要属于当前用户、权限为 0700。
 * 所有沙盒都拒绝读取整个根目录，再按用途放开子目录。
 */
export function prepareRoot(root: string): string {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stat = statSync(root);
	if (stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o700) {
		throw new WorkspaceError(
			`Host 根目录要属于当前用户、权限为 700，现在是 ${(stat.mode & 0o777).toString(8)}：${root}`,
		);
	}
	return realpathSync(root);
}

/** 根目录和工作区互相包含时报错：快照和搜索会碰到 Host 的数据，或者 agent 读不到自己的工作区。 */
export function checkSeparate(root: string, workspace: string): void {
	if (isInside(root, workspace) || isInside(workspace, root)) {
		throw new WorkspaceError(
			`Host 根目录 ${root} 和工作区 ${workspace} 不能互相包含`,
		);
	}
}

/** 一个 session 在根目录下的目录。 */
export interface SessionDirectories {
	/** 作为 `TMPDIR` 的临时目录，这个 session 的沙盒可读写。 */
	tmp: string;
	/** 命令的输出文件，由 Host 写入，沙盒只能读。 */
	output: string;
}

/**
 * 创建 session 的临时目录和输出目录。目录名取 session 标识的前 12 个字符：
 * Unix socket 的路径有长度上限，沙盒后端的 socket 建在临时目录里。
 */
export function createSessionDirectories(
	root: string,
	sessionId: string,
): SessionDirectories {
	const name = sessionId.slice(0, 12);
	const directories = {
		tmp: join(root, "tmp", name),
		output: join(root, "output", name),
	};
	for (const dir of Object.values(directories)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	return directories;
}
