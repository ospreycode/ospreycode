import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import {
	type FileChange,
	type FileEditOp,
	fileDiff,
	type ToolCallRegisterParams,
	type ToolResult,
} from "@ospreycode/agent-runtime";

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

/** 申请的一个文件改动和 Host 核对过哈希的那份旧内容（文件原来不存在时为 `null`）。 */
export function editChange(
	edit: FileEditOp,
	current: Buffer | null,
): FileChange {
	return {
		path: edit.path,
		before: current ?? undefined,
		after: Buffer.from(edit.content, "utf8"),
	};
}

/**
 * 一个文件改动的统一 diff，按 Host 核对过哈希的那份旧内容算出：用户批准时看到的改动就是将要
 * 写入的改动。和编辑工具在沙盒里写入时附在结果上的 diff 是同一种写法。
 */
export function editDiff(edit: FileEditOp, current: Buffer | null): string {
	return fileDiff(editChange(edit, current));
}

/** 磁盘上这个文件现在是改动后的内容、改动前的内容，还是都不是。 */
function editState(edit: RegisteredEdit): "new" | "old" | "neither" {
	const current = readTarget(edit.path);
	const hash =
		current === undefined || current === null ? current : sha256(current);
	return hash === edit.new_sha256
		? "new"
		: hash === edit.old_sha256
			? "old"
			: "neither";
}

/**
 * 恢复中断的 session 时，只有"开始执行"、没有结果的文件改动：按记下的哈希核对磁盘。全是新内容
 * 记成功，全是旧内容记失败，其余记结果不确定并逐个列出。
 */
export function settleInterruptedEdits(
	edits: readonly RegisteredEdit[],
): ToolResult {
	const states = edits.map((edit) => ({
		path: edit.path,
		state: editState(edit),
	}));
	const paths = edits.map((edit) => edit.path).join(", ");
	if (states.every(({ state }) => state === "new")) {
		return {
			status: "succeeded",
			content: [
				{
					type: "text",
					text: `The session was interrupted during this call. ${paths} had already been written.`,
				},
			],
		};
	}
	if (states.every(({ state }) => state === "old")) {
		return {
			status: "failed",
			content: [
				{
					type: "text",
					text: `The session was interrupted before this call changed anything: ${paths} still has the old content.`,
				},
			],
		};
	}
	const describe = {
		new: "written",
		old: "not changed",
		neither: "matches neither the old nor the new version",
	};
	return {
		status: "interrupted",
		content: [
			{
				type: "text",
				text: `The session was interrupted during this call. Read these files before relying on them:\n${states.map(({ path, state }) => `${path}: ${describe[state]}`).join("\n")}`,
			},
		],
	};
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
