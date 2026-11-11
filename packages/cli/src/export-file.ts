import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";

/** 导出文件写好了（`lines` 是写了多少行），或者打不开（`unwritable` 是系统给的错误）。 */
export type ExportWritten =
	| { lines: number }
	| { unwritable: NodeJS.ErrnoException };

/**
 * 把导出的 session（JSONL 的各行）写进文件，已有的文件被覆盖。文件只对当前用户可读写：导出的是
 * 对话的全部内容。文件打不开是约定中的失败，作为结果返回，由调用方按自己的方式报告。
 */
export function writeExportFile(
	path: string,
	lines: Iterable<string>,
): ExportWritten {
	let file: number;
	try {
		file = openSync(path, "w", 0o600);
	} catch (error) {
		return { unwritable: error as NodeJS.ErrnoException };
	}
	try {
		// 文件原来就有时权限不会跟着变，收紧到只对当前用户可读写
		fchmodSync(file, 0o600);
		let count = 0;
		for (const line of lines) {
			writeSync(file, `${line}\n`);
			count += 1;
		}
		return { lines: count };
	} finally {
		closeSync(file);
	}
}
