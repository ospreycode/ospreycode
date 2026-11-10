import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	FileEdit,
	PreparedCall,
	ToolContext,
} from "../tool-executor/local-tool.js";
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

/**
 * 准备一次文件改动：目标要在可写范围里；已有的文件要读过、之后没有被别人改过。`next` 按现在的内容
 * 给出新内容，`done` 给出写完后交给模型的话。登记带上改动前后的哈希，执行时再核对一次旧内容：
 * 等 Host 回复期间文件可能又变了。
 */
export async function prepareFileEdit(
	target: string,
	context: ToolContext,
	next: (current: Buffer | undefined, path: string) => Buffer,
	done: (path: string, written: Buffer) => string,
): Promise<PreparedCall> {
	const path = await resolveTarget(target, context.workspace);
	if (!context.writableRoots.some((root) => isInside(path, root))) {
		throw new ToolFailure(
			`${path} is outside the writable roots (${context.writableRoots.join(", ")}). Changing files there is not supported yet.`,
		);
	}
	const current = await currentContent(path);
	const oldHash = current === undefined ? null : sha256(current);
	if (oldHash !== null) context.records.check(path, oldHash);
	const content = next(current, path);
	const edit: FileEdit = {
		path,
		old_sha256: oldHash,
		new_sha256: sha256(content),
	};
	return {
		edit,
		async run() {
			const latest = await currentContent(path);
			if ((latest === undefined ? null : sha256(latest)) !== oldHash) {
				throw new ToolFailure(
					`${path} changed while the edit was being prepared. Read it again, then try again.`,
				);
			}
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
			context.records.record(path, edit.new_sha256);
			return text(done(path, content));
		},
	};
}
