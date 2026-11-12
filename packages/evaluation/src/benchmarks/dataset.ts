import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** 由种子和名字得到的排序键：同样的种子每次得到同样的顺序，换种子就换一批题。 */
export function rank(seed: string, key: string): string {
	return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

/** 按 `rank` 排序。 */
export function ranked<T>(
	items: readonly T[],
	seed: string,
	key: (item: T) => string,
): T[] {
	return items
		.map((item) => ({ item, order: rank(seed, key(item)) }))
		.sort((a, b) => (a.order < b.order ? -1 : 1))
		.map(({ item }) => item);
}

/** 清单里一个非空的字符串字段。 */
export function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value === "") {
		throw new Error(`manifest.json 的 ${key} 要是非空的字符串`);
	}
	return value;
}

/** 清单里一个对象。 */
export function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`manifest.json 的 ${what} 要是对象`);
	}
	return value as Record<string, unknown>;
}

/** 清单里取值有限的字段。 */
export function oneOf<T extends string>(
	value: string,
	choices: readonly T[],
	key: string,
): T {
	if (!(choices as readonly string[]).includes(value)) {
		throw new Error(`manifest.json 的 ${key} 不能是 ${value}`);
	}
	return value as T;
}

/** 清单里一道题的 `image_digest`。 */
export function digest(task: Record<string, unknown>, where: string): string {
	const value = text(task, "image_digest");
	if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
		throw new Error(`manifest.json 的 ${where}.image_digest 不是 digest`);
	}
	return value;
}

/** 题目的文件里应当正好有一处这段文字：上游换了写法就报错，不悄悄漏掉。 */
export function requireOnce(
	content: string,
	fragment: string,
	where: string,
): void {
	const count = content.split(fragment).length - 1;
	if (count !== 1) {
		throw new Error(
			`${where} 里应当正好有一处 ${JSON.stringify(fragment)}，实际有 ${count} 处`,
		);
	}
}

/** 把题目的文件里正好出现一次的一段文字换掉。 */
export function replaceOnce(
	content: string,
	from: string,
	to: string,
	where: string,
): string {
	requireOnce(content, from, where);
	return content.replace(from, () => to);
}

/** 改写一个文件。 */
export function rewrite(path: string, edit: (content: string) => string): void {
	writeFileSync(path, edit(readFileSync(path, "utf8")));
}

/** 题目仓库的检出要在清单固定的 commit 上，题目目录里没有改动。 */
export function checkCheckout(
	checkout: string,
	manifest: { commit: string; tasksPath: string },
): void {
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
	const head = git("rev-parse", "HEAD");
	if (head !== manifest.commit) {
		throw new Error(`${checkout} 在 ${head}，清单固定的是 ${manifest.commit}`);
	}
	if (git("status", "--porcelain", "--", manifest.tasksPath) !== "") {
		throw new Error(`${checkout} 的 ${manifest.tasksPath} 里有没提交的改动`);
	}
}
