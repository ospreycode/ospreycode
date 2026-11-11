import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const commitPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const refPattern = /^refs\/[A-Za-z0-9._/-]+$/;

/** 读一个可以不存在的文件；路径上有一段不是目录也算不存在。 */
function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
			return undefined;
		}
		throw error;
	}
}

function commit(text: string | undefined): string | undefined {
	const value = text?.trim();
	return value !== undefined && commitPattern.test(value) ? value : undefined;
}

/**
 * 项目根目录当前的 commit：读 git 目录里的 `HEAD`，不运行 git。不是 git 仓库、还没有提交，或者
 * 这些文件不是预期的格式时为空：它们是用户项目里的文件，只从里面取一个十六进制的 commit。
 */
export function readHeadCommit(projectRoot: string): string | undefined {
	const dotGit = join(projectRoot, ".git");
	// worktree 和子模块的 `.git` 是一个文件，写着 git 目录的位置
	const pointer = readOptional(dotGit);
	const gitDir =
		pointer === undefined
			? dotGit
			: resolve(projectRoot, pointer.replace(/^gitdir: /, "").trim());
	const head = readOptional(join(gitDir, "HEAD"))?.trim();
	if (head === undefined) return undefined;
	if (!head.startsWith("ref: ")) return commit(head);
	const ref = head.slice("ref: ".length);
	if (!refPattern.test(ref) || ref.split("/").includes("..")) return undefined;
	// worktree 的分支引用在公共的 git 目录里
	const common = readOptional(join(gitDir, "commondir"))?.trim();
	const commonDir = common === undefined ? gitDir : resolve(gitDir, common);
	const loose =
		commit(readOptional(join(gitDir, ref))) ??
		commit(readOptional(join(commonDir, ref)));
	if (loose !== undefined) return loose;
	const packed = readOptional(join(commonDir, "packed-refs"));
	for (const line of packed?.split("\n") ?? []) {
		const [hash, name] = line.split(" ");
		if (name === ref) return commit(hash);
	}
	return undefined;
}
