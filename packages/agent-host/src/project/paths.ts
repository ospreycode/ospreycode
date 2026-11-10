import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** `child` 是不是 `parent` 本身或它里面的路径。两者都要是真实路径。 */
export function isInside(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

/**
 * 绝对路径对应的真实路径：已存在的部分取真实路径，还不存在的部分原样接在后面。权限按真实路径
 * 判断和放行，经符号链接指到别处的路径按它指向的位置算。
 */
export function realTarget(path: string): string {
	const missing: string[] = [];
	for (let existing = path; ; existing = dirname(existing)) {
		try {
			return join(realpathSync(existing), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missing.unshift(basename(existing));
		}
	}
}

/** `path` 和 `other` 是不是同一个位置，或者一个在另一个里面。两者都要是真实路径。 */
export function overlaps(path: string, other: string): boolean {
	return isInside(path, other) || isInside(other, path);
}

/** 当前进程的用户 ID。 */
export function currentUid(): number {
	if (process.getuid === undefined) {
		throw new Error("只支持 macOS 和 Linux");
	}
	return process.getuid();
}
