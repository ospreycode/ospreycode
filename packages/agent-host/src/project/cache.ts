import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./identity.js";
import { registeredProject } from "./lookup.js";

/** 清空哪些构建缓存。 */
export interface ClearCacheOptions {
	/** 只清这个目录所在项目的缓存；不给时清空全部项目的。 */
	directory?: string;
}

function isDirectory(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Go 把模块缓存里的目录设成只读，要先加回写权限才删得掉。不跟随符号链接。 */
function makeWritable(dir: string): void {
	chmodSync(dir, 0o700);
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) makeWritable(join(dir, entry.name));
	}
}

/**
 * 清空构建缓存（Host 根目录下的 `cache/<project_id>/`），返回清空了的项目。只删目录里的内容，
 * 留下目录本身：打开着的 session 的沙盒按路径放开这个目录。不检查有没有打开的 session，正在运行的
 * 构建可能因此失败，重新运行就会重建缓存。没有缓存目录时什么也不做。目录不存在时抛出 `WorkspaceError`。
 */
export function clearCache(
	root: string,
	registry: Registry,
	options: ClearCacheOptions,
): string[] {
	const cache = join(root, "cache");
	let projects: (string | undefined)[];
	if (options.directory !== undefined) {
		projects = [registeredProject(registry, options.directory)];
	} else {
		projects = isDirectory(cache) ? readdirSync(cache) : [];
	}
	return projects.filter((projectId): projectId is string => {
		if (projectId === undefined) return false;
		const dir = join(cache, projectId);
		if (!isDirectory(dir)) return false;
		makeWritable(dir);
		for (const name of readdirSync(dir)) {
			rmSync(join(dir, name), { recursive: true, force: true });
		}
		return true;
	});
}
