import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { UserContent } from "@ospreycode/api/protocol";

/** 工具自己报告的失败，信息原样交给模型。 */
export class ToolFailure extends Error {
	override name = "ToolFailure";
}

/** 文件系统报告的错误：文件不存在、是目录、没有权限、被沙盒拦下。 */
export function isFileSystemError(
	error: unknown,
): error is NodeJS.ErrnoException {
	return (
		error instanceof Error &&
		typeof (error as NodeJS.ErrnoException).code === "string" &&
		typeof (error as NodeJS.ErrnoException).syscall === "string"
	);
}

/** 交给模型的一段文字。 */
export function text(value: string): UserContent[] {
	return [{ type: "text", text: value }];
}

/** 内容的 SHA-256，十六进制。 */
export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** `child` 是不是 `parent` 本身或它里面的路径。两者都要是真实路径。 */
export function isInside(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

/**
 * 工具参数里的路径对应的绝对路径：相对路径按工作区根解析，已存在的部分取真实路径，还不存在的
 * 部分原样接在后面。可写范围按真实路径判断，符号链接指到范围外的目标就不在范围内。
 */
export async function resolveTarget(
	path: string,
	workspace: string,
): Promise<string> {
	let existing = resolve(workspace, path);
	const missing: string[] = [];
	for (;;) {
		try {
			return join(await realpath(existing), ...missing);
		} catch (error) {
			if (!isFileSystemError(error) || error.code !== "ENOENT") throw error;
			missing.unshift(basename(existing));
			existing = dirname(existing);
		}
	}
}
