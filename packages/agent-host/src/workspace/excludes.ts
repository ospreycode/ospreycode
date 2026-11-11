import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 读 git 目录里的一个小文件：只读不是符号链接的普通文件，不超过 4 KiB。不是这样的文件时返回空。 */
function readGitFile(path: string): string | undefined {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat?.isFile() !== true || stat.size > 4096) return undefined;
	return readFileSync(path, "utf8");
}

/**
 * `root` 下的仓库的 git 公共目录：`.git` 是目录时就是它；是文件时（linked worktree、submodule）
 * 取 `gitdir:` 指向的目录，那里有 `commondir` 就再取它指向的目录。`root` 不是仓库时返回空。
 */
function commonDir(root: string): string | undefined {
	const dotGit = join(root, ".git");
	if (statSync(dotGit, { throwIfNoEntry: false })?.isDirectory() === true) {
		return dotGit;
	}
	const line = readGitFile(dotGit)?.split(/\r?\n/)[0];
	if (line?.startsWith("gitdir: ") !== true) return undefined;
	const gitDir = resolve(root, line.slice("gitdir: ".length));
	const common = readGitFile(join(gitDir, "commondir"))?.trim();
	return common === undefined || common === ""
		? gitDir
		: resolve(gitDir, common);
}

/**
 * `root` 下的仓库自己的忽略规则文件：git 公共目录下的 `info/exclude`。没有这个文件，或者 `root`
 * 不是仓库时返回空。只读 `.git` 下的文件，不运行 git；这里不核对 `.git` 文件指向的目录是否属于
 * 这个仓库：指到别处也只是多读一份忽略规则，和仓库里的 `.gitignore` 能做的一样。
 */
export function infoExclude(root: string): string | undefined {
	const common = commonDir(root);
	if (common === undefined) return undefined;
	const path = join(common, "info", "exclude");
	// 只认普通文件：管道之类的会让 git 一直等着读
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true
		? path
		: undefined;
}
