import { isAbsolute, relative, sep } from "node:path";

/** `child` 是不是 `parent` 本身或它里面的路径。两者都要是真实路径。 */
export function isInside(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

/** 当前进程的用户 ID。 */
export function currentUid(): number {
	if (process.getuid === undefined) {
		throw new Error("只支持 macOS 和 Linux");
	}
	return process.getuid();
}
