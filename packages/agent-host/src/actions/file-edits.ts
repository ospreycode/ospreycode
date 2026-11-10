import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import type {
	FileEditOp,
	ToolCallRegisterParams,
	ToolResult,
} from "@ospreycode/agent-runtime";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

/** 编辑工具登记的文件改动：路径和改动前后的哈希。 */
export type RegisteredEdit = NonNullable<ToolCallRegisterParams["edit"]>;

/** 内容的 SHA-256，十六进制。 */
export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 磁盘上这个文件的内容；不存在时为 `null`，读不了或不是普通文件时为空。 */
export function readTarget(path: string): Buffer | null | undefined {
	let fd: number;
	try {
		// 路径来自沙盒内的 runtime：不阻塞地打开，确认是普通文件再读，不在 FIFO 上挂住；
		// 最后一级是符号链接时不跟过去，按读不了算
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === undefined) throw error;
		return code === "ENOENT" || code === "ENOTDIR" ? null : undefined;
	}
	try {
		return fstatSync(fd).isFile() ? readFileSync(fd) : undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * 一个文件改动的统一 diff，按 Host 核对过哈希的那份旧内容算出：用户批准时看到的改动就是将要
 * 写入的改动。旧内容不是合法的 UTF-8 时没法按行比较，照 git 的写法只说明两者不同。
 */
export function editDiff(edit: FileEditOp, current: Buffer | null): string {
	if (current !== null && !isUtf8(current)) {
		return `Binary files ${edit.path} and ${edit.path} differ\n`;
	}
	return createTwoFilesPatch(
		current === null ? "/dev/null" : edit.path,
		edit.path,
		current === null ? "" : current.toString("utf8"),
		edit.content,
		undefined,
		undefined,
		{ headerOptions: FILE_HEADERS_ONLY },
	);
}

/**
 * 登记了文件改动、task 结束时还没有结果的调用：按登记的哈希核对磁盘，是新内容记成功，
 * 是旧内容记失败，都不是记结果不确定。
 */
export function settleEdit(edit: RegisteredEdit): ToolResult {
	const current = readTarget(edit.path);
	const hash =
		current === undefined || current === null ? current : sha256(current);
	if (hash === edit.new_sha256) {
		return {
			status: "succeeded",
			content: [
				{
					type: "text",
					text: `${edit.path} was written before the task ended.`,
				},
			],
		};
	}
	if (hash === edit.old_sha256) {
		return {
			status: "failed",
			content: [
				{
					type: "text",
					text: `${edit.path} was not changed: the task ended first.`,
				},
			],
		};
	}
	return {
		status: "interrupted",
		content: [
			{
				type: "text",
				text: `The task ended while ${edit.path} was being changed. Its content matches neither the old nor the new version; read it before relying on it.`,
			},
		],
	};
}
