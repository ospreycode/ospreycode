import { isUtf8 } from "node:buffer";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

/**
 * 结果里带 diff 的文件改动，改动前后的内容各自不超过这么多字节：再大的文件按行比较花的时间和
 * diff 本身的大小都没有上限，而它只是给界面看的。
 */
export const resultDiffLimit = 256 * 1024;

/** 一个文件的改动：路径、改动前的内容（文件原来不存在时为空）和改动后的内容。 */
export interface FileChange {
	/** 规范化的绝对路径，写进 diff 的文件头。 */
	path: string;
	before: Buffer | undefined;
	after: Buffer;
}

/**
 * 一个文件改动的 unified diff，文件头里是它的路径，新建的文件改动前写 `/dev/null`。改动前的内容
 * 不是合法的 UTF-8 时没法按行比较，照 git 的写法只说明两者不同。
 */
export function fileDiff({ path, before, after }: FileChange): string {
	if (before !== undefined && !isUtf8(before)) {
		return `Binary files ${path} and ${path} differ\n`;
	}
	return createTwoFilesPatch(
		before === undefined ? "/dev/null" : path,
		path,
		before === undefined ? "" : before.toString("utf8"),
		after.toString("utf8"),
		undefined,
		undefined,
		{ headerOptions: FILE_HEADERS_ONLY },
	);
}

/**
 * 一次工具调用做的文件改动的 unified diff，附在成功的结果上给界面显示；其中有文件超过
 * `resultDiffLimit` 时为空，结果不带 diff。
 */
export function resultDiff(changes: readonly FileChange[]): string | undefined {
	const tooLarge = changes.some(
		({ before, after }) =>
			(before?.length ?? 0) > resultDiffLimit || after.length > resultDiffLimit,
	);
	return tooLarge ? undefined : changes.map(fileDiff).join("");
}
