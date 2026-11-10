import { ToolFailure } from "../tools/files.js";

/**
 * 文件的读取记录：agent 上次读到或写入的内容的哈希，按真实路径记。编辑前据此确认文件之后没有被
 * 别人改过（用户可能同时在编辑器里修改）。记录只在这个 agent 进程里，重启后要重新读取。
 */
export class FileRecords {
	#hashes = new Map<string, string>();

	/** 记下刚读到或写入的内容。 */
	record(path: string, hash: string): void {
		this.#hashes.set(path, hash);
	}

	/** 要改的文件还没有读过，或者现在的内容和上次读到的不一样时，要求重新读取。 */
	check(path: string, currentHash: string): void {
		const known = this.#hashes.get(path);
		if (known === undefined) {
			throw new ToolFailure(
				`${path} has not been read yet. Read it first, then try again.`,
			);
		}
		if (known !== currentHash) {
			throw new ToolFailure(
				`${path} has changed since it was last read. Read it again, then try again.`,
			);
		}
	}
}
