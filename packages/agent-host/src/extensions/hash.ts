import { createHash } from "node:crypto";
import {
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { isInside } from "../project/paths.js";

/** 一个目录里文件数的上限：扩展的目录不该有这么多文件，超过时不算哈希，按出错处理。 */
export const maxHashedFiles = 20_000;

/** 目录里的文件太多，算不了内容哈希。 */
export class TooManyFilesError extends Error {
	override name = "TooManyFilesError";
}

/** 一组内容的哈希：每一项是名字和字节，按名字排序后依次写入，名字和长度都算在里面。 */
export function hashEntries(
	entries: readonly { name: string; data: Buffer | string }[],
): string {
	const hash = createHash("sha256");
	for (const { name, data } of [...entries].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		hash.update(`${Buffer.byteLength(name, "utf8")}:${name}:${bytes.length}:`);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

/** 一个 JSON 值的规范写法：对象的键按字典序。哈希按它算，键的顺序不影响结果。 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * 目录里全部文件的内容：相对路径（`/` 分隔）和字节。符号链接不跟随，记它指向的路径：链接换了
 * 指向哈希就变，指向目录之外的内容也不会被读进来。可执行位算在名字里：给脚本加上执行权限也是改动。
 * `root` 要是真实路径；`skip` 里的相对路径（文件或目录）不算。
 */
export function directoryEntries(
	root: string,
	skip: readonly string[] = [],
): { name: string; data: Buffer | string }[] {
	const entries: { name: string; data: Buffer | string }[] = [];
	const walk = (directory: string, prefix: string) => {
		for (const name of readdirSync(directory).sort()) {
			const relative = prefix === "" ? name : `${prefix}/${name}`;
			if (skip.includes(relative)) continue;
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				walk(path, relative);
				continue;
			}
			if (entries.length >= maxHashedFiles) {
				throw new TooManyFilesError(
					`${root} 里的文件超过 ${maxHashedFiles} 个，算不了内容哈希`,
				);
			}
			if (stat.isSymbolicLink()) {
				entries.push({ name: `${relative}@`, data: readlinkSync(path) });
			} else if (stat.isFile()) {
				entries.push({
					name: (stat.mode & 0o111) === 0 ? relative : `${relative}*`,
					data: readFileSync(path),
				});
			}
		}
	};
	walk(root, "");
	return entries;
}

/** 目录的内容哈希：其中全部文件的路径和内容。目录不存在时是空目录的哈希。 */
export function hashDirectory(
	root: string,
	skip: readonly string[] = [],
): string {
	if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) {
		return hashEntries([]);
	}
	return hashEntries(directoryEntries(realpathSync(root), skip));
}

/**
 * skill 的内容哈希：`files` 是 `@ospreycode/skills` 列出的它包含的全部文件（相对 skill 目录）。
 * 读文件时跟随符号链接：列出的文件已经检查过不指向 `containedIn` 之外；独立 skill 里指向外面的链接
 * 读到的就是模型会读到的内容。`containedIn` 给出时再核对一次，两次读取之间换了指向的链接算作出错。
 */
export function hashSkill(
	directory: string,
	files: readonly string[],
	containedIn?: string,
): string {
	return hashEntries(
		files.map((name) => {
			const path = join(directory, name);
			if (
				containedIn !== undefined &&
				!isInside(realpathSync(path), containedIn)
			) {
				throw new Error(`${path} 指向了 ${containedIn} 之外`);
			}
			return { name, data: readFileSync(path) };
		}),
	);
}
