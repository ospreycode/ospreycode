import { lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type ExpandedWord, globDirectory } from "./words.js";

/** 模型写的路径上会遇到的错误：路径不存在、过长、成环，或所在的目录不让查看。 */
const unreachable = new Set([
	"ENOENT",
	"ENOTDIR",
	"EACCES",
	"ELOOP",
	"ENAMETOOLONG",
]);

/** 对模型写的路径做一次文件系统查询；路径到不了（或带 NUL）时没有结果，其他错误照常抛出。 */
function query<Result>(
	read: (path: string) => Result,
	path: string,
): Result | undefined {
	if (path.includes("\0")) return undefined;
	try {
		return read(path);
	} catch (error) {
		if (unreachable.has((error as NodeJS.ErrnoException).code ?? "")) {
			return undefined;
		}
		throw error;
	}
}

/** 这个路径上的文件，跟随符号链接；到不了时没有结果：这样的路径上没有能执行或能删除的东西。 */
export function fileAt(path: string): Stats | undefined {
	return query((each) => statSync(each, { throwIfNoEntry: false }), path);
}

/** 这个路径本身，不跟随最后一级的符号链接。 */
function linkAt(path: string): Stats | undefined {
	return query((each) => lstatSync(each, { throwIfNoEntry: false }), path);
}

/** 已存在的路径的真实路径；用系统的 realpath，大小写不敏感的文件系统上得到磁盘上的写法。 */
export function existingRealPath(path: string): string | undefined {
	return query((each) => realpathSync.native(each), path);
}

/** `path` 是不是 `directory` 本身或在它里面；两者都是规范化的绝对路径。 */
export function isWithin(path: string, directory: string): boolean {
	return (
		path === directory ||
		path.startsWith(directory.endsWith("/") ? directory : `${directory}/`)
	);
}

/**
 * `/dev/stdout`、`/proc/self` 这类路径指向哪里取决于访问它的进程：在 Host 里解析，得到的是
 * Host 自己的文件，不是命令会访问的位置，所以不解析。
 */
const processRelative = ["/dev", "/proc"];

/**
 * 绝对路径的真实路径：解析掉符号链接，`..` 和内核一样按解析后的位置取上级，大小写不敏感的
 * 文件系统上取磁盘上的写法。从某一级起到不了时，剩下的部分按词法接上：不存在的路径也要能比较。
 * 从根目录往下逐级解析，随手写的长字符串在第一级就停下。
 */
export function realPath(path: string): string {
	const lexical = resolve(path);
	if (processRelative.some((directory) => isWithin(lexical, directory))) {
		return lexical;
	}
	// 路径存在时一次查询就够了
	const whole = existingRealPath(path);
	if (whole !== undefined) return whole;
	const parts = path.split("/");
	let current = "/";
	for (const [index, part] of parts.entries()) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		const real = existingRealPath(join(current, part));
		if (real === undefined) return resolve(current, ...parts.slice(index));
		current = real;
	}
	return current;
}

/**
 * 这个绝对路径可能指的位置：按词法规范化的写法和真实路径。模型写的路径和受保护的位置都用
 * 两种写法比较，符号链接、`/tmp` 和 `/private/tmp` 这样的别名、大小写不同的写法才不会漏掉。
 */
export function pathForms(path: string): string[] {
	return [...new Set([resolve(path), realPath(path)])];
}

/** 删除这个绝对路径时删掉的位置：最后一级是符号链接时删的是链接本身，只解析它所在的目录。 */
export function deletionForms(path: string): string[] {
	const real = linkAt(path)?.isSymbolicLink()
		? join(realPath(dirname(path)), basename(path))
		: realPath(path);
	return [...new Set([resolve(path), real])];
}

/** 这些位置传入的写法和它们的真实路径。 */
export function withRealPaths(paths: readonly string[]): string[] {
	return [...new Set(paths.flatMap((path) => pathForms(resolve(path))))];
}

/**
 * 展开后的词指向的绝对路径，没有规范化；带通配时是通配之前的目录，匹配到的都在它下面。
 * 相对路径按 `base` 解析，`base` 未知（脚本里有 `cd`）时没有结果。
 */
export function locate(
	word: ExpandedWord,
	base: string | undefined,
): string | undefined {
	const path = word.glob ? globDirectory(word) || "." : word.text;
	if (isAbsolute(path)) return path;
	return base === undefined || path === "" ? undefined : `${base}/${path}`;
}
