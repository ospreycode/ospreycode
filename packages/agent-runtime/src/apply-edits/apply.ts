import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	ftruncateSync,
	lstatSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { dirname, parse } from "node:path";

/**
 * 可写范围之外的一个文件改动。`add` 新建文件，要求它不存在；`update` 改已有的文件。
 * `path` 是规范化的绝对路径，各级都不能是符号链接。
 */
export interface FileEditOp {
	op: "add" | "update";
	path: string;
	/** 改动前内容的 SHA-256；`add` 为空。 */
	old_sha256: string | null;
	/** 完整的新内容。 */
	content: string;
}

/** apply-edits 的结果：全部写入，或者失败并列出已经写入的文件（部分写入算失败）。 */
export type ApplyEditsResult =
	| { status: "succeeded" }
	| { status: "failed"; message: string; written: string[] };

/** macOS 的 `O_NOFOLLOW_ANY`：路径的任何一级是符号链接时打开失败。Node 的 `fs.constants` 里没有它。 */
const noFollowAny = 0x20000000;

class EditFailure extends Error {}

/**
 * 不跟随符号链接地打开文件用的标志。macOS 交给内核检查路径的每一级；Linux 没有这样的标志，
 * 逐级确认上级目录不是符号链接，最后一级用 `O_NOFOLLOW`。
 */
function noFollowFlags(path: string): number {
	if (process.platform === "darwin") return noFollowAny;
	const { root } = parse(path);
	for (let dir = dirname(path); dir !== root; dir = dirname(dir)) {
		if (lstatSync(dir).isSymbolicLink()) {
			throw new EditFailure(`${dir} is a symbolic link`);
		}
	}
	return constants.O_NOFOLLOW;
}

function writeAll(fd: number, content: Buffer): void {
	for (let offset = 0; offset < content.length; ) {
		offset += writeSync(fd, content, offset, content.length - offset, offset);
	}
}

/**
 * 执行批准的文件改动。先核对全部文件：`update` 的旧内容哈希要对得上，`add` 的文件不能已经存在，
 * 有一个不符就什么都不写。`update` 在核对时打开的同一个文件描述符上截断和写入，中间不再按路径
 * 打开，路径被换成别的文件也写不到那里；不写临时文件再改名，那需要整个目录的写权限。
 */
export function applyFileEdits(edits: readonly FileEditOp[]): ApplyEditsResult {
	const written: string[] = [];
	const open = new Map<FileEditOp, number>();
	try {
		for (const edit of edits) {
			const flags = noFollowFlags(edit.path);
			if (edit.op === "add") {
				// 上级目录要已经存在：这里不建目录，那需要再上一级目录的写权限
				if (!lstatSync(dirname(edit.path)).isDirectory()) {
					throw new EditFailure(`${dirname(edit.path)} is not a directory`);
				}
				if (lstatSync(edit.path, { throwIfNoEntry: false }) !== undefined) {
					throw new EditFailure(`${edit.path} already exists`);
				}
				continue;
			}
			const fd = openSync(edit.path, constants.O_RDWR | flags);
			open.set(edit, fd);
			if (!fstatSync(fd).isFile()) {
				throw new EditFailure(`${edit.path} is not a regular file`);
			}
			const hash = createHash("sha256").update(readFileSync(fd)).digest("hex");
			if (hash !== edit.old_sha256) {
				throw new EditFailure(
					`${edit.path} has changed since the edit was prepared`,
				);
			}
		}
		for (const edit of edits) {
			const content = Buffer.from(edit.content, "utf8");
			let fd = open.get(edit);
			if (fd === undefined) {
				fd = openSync(
					edit.path,
					constants.O_WRONLY |
						constants.O_CREAT |
						constants.O_EXCL |
						noFollowFlags(edit.path),
					0o666,
				);
				open.set(edit, fd);
			} else {
				ftruncateSync(fd, 0);
			}
			writeAll(fd, content);
			written.push(edit.path);
		}
		return { status: "succeeded" };
	} catch (error) {
		// 文件系统报告的错误（没有权限、路径上有符号链接、上级目录不存在）和核对不符都是约定中的失败
		if (
			!(error instanceof EditFailure) &&
			(error as NodeJS.ErrnoException).code === undefined
		) {
			throw error;
		}
		return { status: "failed", message: (error as Error).message, written };
	} finally {
		for (const fd of open.values()) closeSync(fd);
	}
}
