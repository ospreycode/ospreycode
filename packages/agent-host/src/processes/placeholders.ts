import {
	lstatSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../project/locks.js";
import type { ProcessIdentity } from "./info.js";

/** 登记表的内容：工作区的真实路径 → 可能留在里面的占位。 */
type Table = Record<string, string[]>;

function parseTable(text: string, path: string): Table {
	const value: unknown = JSON.parse(text);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!Object.values(value).every(
			(paths) =>
				Array.isArray(paths) && paths.every((item) => typeof item === "string"),
		)
	) {
		throw new Error(`占位登记表的格式不对：${path}`);
	}
	return value as Table;
}

/**
 * Linux 上受保护路径的占位登记表（`data/placeholders.json`）。sandbox-runtime 为还不存在的受保护名字
 * 在用户的目录里放占位（空文件或空目录），命令结束后删除；Host 被强制结束时它们会留下来。
 * Host 在包装前把可能放的占位记在这里，session 结束和下次打开同一工作区时删除仍为空的残留。
 */
export class Placeholders {
	#file: string;
	#lock: string;
	#owner: ProcessIdentity;
	#workspace: string;
	#recorded = new Set<string>();

	/** `dataDir` 是 Host 根目录下的 `data/`，`owner` 是加锁用的 Host 进程身份。 */
	constructor(dataDir: string, owner: ProcessIdentity, workspace: string) {
		this.#file = join(dataDir, "placeholders.json");
		this.#lock = join(dataDir, "locks", "placeholders.lock");
		this.#owner = owner;
		this.#workspace = workspace;
	}

	#read(): Table {
		let text: string;
		try {
			text = readFileSync(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		return parseTable(text, this.#file);
	}

	/** 包装前登记这次可能放的占位；登记过的不再写。 */
	async record(paths: readonly string[]): Promise<void> {
		const fresh = paths.filter((path) => !this.#recorded.has(path));
		if (fresh.length === 0) return;
		await withFileLock(this.#lock, this.#owner, () => {
			const table = this.#read();
			table[this.#workspace] = [
				...new Set([...(table[this.#workspace] ?? []), ...fresh]),
			];
			writeFileAtomic(this.#file, JSON.stringify(table));
		});
		for (const path of fresh) this.#recorded.add(path);
	}

	/**
	 * 删除这个工作区登记过、现在仍为空的占位，并去掉登记。有内容的不动：那是用户或命令之后
	 * 自己建的。调用时这个工作区不能有沙盒在运行（持有工作区锁）。
	 */
	async clean(): Promise<void> {
		await withFileLock(this.#lock, this.#owner, () => {
			const table = this.#read();
			for (const path of table[this.#workspace] ?? []) {
				// 不跟随符号链接：占位是普通的空文件或空目录
				const stat = lstatSync(path, { throwIfNoEntry: false });
				if (stat?.isFile() === true && stat.size === 0) unlinkSync(path);
				if (stat?.isDirectory() === true && readdirSync(path).length === 0) {
					rmdirSync(path);
				}
			}
			delete table[this.#workspace];
			writeFileAtomic(this.#file, JSON.stringify(table));
		});
		this.#recorded.clear();
	}
}
