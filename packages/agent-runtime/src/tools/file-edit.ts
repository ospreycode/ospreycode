import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	FileEdit,
	PreparedCall,
	ToolContext,
} from "../tool-executor/local-tool.js";
import { resultDiff } from "./diff.js";
import {
	isFileSystemError,
	isInside,
	resolveTarget,
	sha256,
	ToolFailure,
	text,
} from "./files.js";

/** 文件现在的内容；不存在时为空。 */
async function currentContent(path: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path);
	} catch (error) {
		if (isFileSystemError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (isFileSystemError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * 准备一次文件改动：已有的文件要读过、之后没有被别人改过。`next` 按现在的内容给出新内容，
 * `done` 给出写完后交给模型的话。
 *
 * 目标在可写范围里时在 agent 沙盒里写：登记带上改动前后的哈希，执行时再核对一次旧内容，等 Host
 * 回复期间文件可能又变了。目标在范围之外时组装成文件改动的申请交给 Host，模型不用改参数。
 */
export async function prepareFileEdit(
	target: string,
	context: ToolContext,
	next: (current: Buffer | undefined, path: string) => Buffer,
	done: (path: string, written: Buffer) => string,
): Promise<PreparedCall> {
	const path = await resolveTarget(target, context.workspace);
	const current = await currentContent(path);
	const oldHash = current === undefined ? null : sha256(current);
	if (oldHash !== null) context.records.check(path, oldHash);
	const content = next(current, path);
	const newHash = sha256(content);
	if (!context.writableRoots.some((root) => isInside(path, root))) {
		// apply-edits 的写权限只到文件，建不了目录
		if (current === undefined && !(await isDirectory(dirname(path)))) {
			throw new ToolFailure(
				`The directory ${dirname(path)} does not exist, and it is outside the writable roots (${context.writableRoots.join(", ")}). Create it first with the shell tool, asking for write permission on its parent.`,
			);
		}
		return {
			fileEdits: [
				{
					op: current === undefined ? "add" : "update",
					path,
					old_sha256: oldHash,
					content: content.toString("utf8"),
				},
			],
			applied: () => context.records.record(path, newHash),
		};
	}
	const edit: FileEdit = { path, old_sha256: oldHash, new_sha256: newHash };
	// 按登记时读到的旧内容算：执行时再核对一次，旧内容变了就不写，也就没有这份 diff
	const diff = resultDiff([{ path, before: current, after: content }]);
	return {
		edit,
		...(diff === undefined ? {} : { diff }),
		async run() {
			const latest = await currentContent(path);
			if ((latest === undefined ? null : sha256(latest)) !== oldHash) {
				throw new ToolFailure(
					`${path} changed while the edit was being prepared. Read it again, then try again.`,
				);
			}
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
			context.records.record(path, newHash);
			return text(done(path, content));
		},
	};
}
