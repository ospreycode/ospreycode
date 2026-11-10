import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import type {
	ToolCallRegisterParams,
	ToolResult,
} from "@ospreycode/agent-runtime";

/** 编辑工具登记的文件改动：路径和改动前后的哈希。 */
export type RegisteredEdit = NonNullable<ToolCallRegisterParams["edit"]>;

/** 磁盘上这个文件内容的 SHA-256；不存在时为 `null`，读不了或不是普通文件时为空。 */
function fileHash(path: string): string | null | undefined {
	let fd: number;
	try {
		// 路径来自沙盒内的 runtime：不阻塞地打开，确认是普通文件再读，不在 FIFO 上挂住
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === undefined) throw error;
		return code === "ENOENT" || code === "ENOTDIR" ? null : undefined;
	}
	try {
		if (!fstatSync(fd).isFile()) return undefined;
		return createHash("sha256").update(readFileSync(fd)).digest("hex");
	} finally {
		closeSync(fd);
	}
}

/**
 * 登记了文件改动、task 结束时还没有结果的调用：按登记的哈希核对磁盘，是新内容记成功，
 * 是旧内容记失败，都不是记结果不确定。
 */
export function settleEdit(edit: RegisteredEdit): ToolResult {
	const hash = fileHash(edit.path);
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
