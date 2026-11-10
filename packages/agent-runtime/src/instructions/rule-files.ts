import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecordedRuleFile } from "../contracts/index.js";
import { isFileSystemError, sha256 } from "../tools/files.js";

/** 规则文件的名字：每个目录里取第一个存在的。 */
export const ruleFileNames = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

/**
 * 工作区和它的上级目录里的规则文件合计的上限（UTF-8 字节）。用固定值，不随模型的上下文窗口变化：
 * 否则换模型时要重新渲染会话开始的上下文消息。
 */
export const maxRuleFilesBytes = 32 * 1024;

/** 读到的一份规则文件。 */
export interface RuleFile extends RecordedRuleFile {
	content: string;
}

/** 这些情况都当作这个目录里没有这个名字的规则文件：不存在、名字是目录、上级目录在沙盒里读不到。 */
const absent = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);

async function readFirst(
	directory: string,
): Promise<{ path: string; content: string } | undefined> {
	for (const name of ruleFileNames) {
		const path = join(directory, name);
		try {
			return { path, content: await readFile(path, "utf8") };
		} catch (error) {
			if (!isFileSystemError(error) || !absent.has(error.code ?? "")) {
				throw error;
			}
		}
	}
	return undefined;
}

function ruleFile(
	file: { path: string; content: string },
	source: RuleFile["source"],
	included: boolean,
): RuleFile {
	const bytes = Buffer.from(file.content, "utf8");
	return {
		path: file.path,
		source,
		content: file.content,
		sha256: sha256(bytes),
		bytes: bytes.length,
		included,
	};
}

/**
 * 这个 session 的规则文件，按用户级、文件系统的根目录到工作区的顺序。用户级的由 Host 读好交来；
 * 其余的在沙盒里读取：工作区和它的每一级上级目录各取 `ruleFileNames` 里第一个存在的。
 *
 * 工作区和上级目录里的文件合计不超过 `maxRuleFilesBytes`，用户级的不计入：按顺序逐个处理，
 * 放得下的整份放入，放不下的整份不放（`included` 为假），任何情况下都不截断文件。
 */
export async function loadRuleFiles(
	workspace: string,
	user: { path: string; content: string } | null,
): Promise<RuleFile[]> {
	const directories: string[] = [];
	for (let directory = workspace; ; directory = dirname(directory)) {
		directories.unshift(directory);
		if (dirname(directory) === directory) break;
	}
	const files: RuleFile[] = user === null ? [] : [ruleFile(user, "user", true)];
	let total = 0;
	for (const directory of directories) {
		const found = await readFirst(directory);
		if (found === undefined) continue;
		const bytes = Buffer.byteLength(found.content, "utf8");
		const included = total + bytes <= maxRuleFilesBytes;
		if (included) total += bytes;
		files.push(ruleFile(found, "repository", included));
	}
	return files;
}

/** 写进 `instructions.recorded` 的状态：不带内容。 */
export function recordRuleFiles(
	files: readonly RuleFile[],
): RecordedRuleFile[] {
	return files.map(({ content: _, ...recorded }) => recorded);
}
