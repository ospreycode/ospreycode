import type { TextBlock } from "@ospreycode/api/protocol";
import type { RecordedRuleFile } from "../contracts/index.js";
import { maxRuleFilesBytes, type RuleFile } from "./rule-files.js";

function attributes(file: RecordedRuleFile): string {
	return `path=${JSON.stringify(file.path)} source="${file.source}"`;
}

/**
 * 一份规则文件单独一个文本块，包上来源路径：仓库里的内容不和用户的话放在同一块。
 * 文件末尾的空白不放进去：文件通常以换行结尾，结束标记前不留空行。
 */
function ruleFileBlock(file: RuleFile): TextBlock {
	const text = file.included
		? `<rule_file ${attributes(file)}>\n${file.content.trimEnd()}\n</rule_file>`
		: `<rule_file ${attributes(file)} bytes="${file.bytes}" included="false">\nNot included: the rule files of the workspace and its parent directories are over the total limit of ${maxRuleFilesBytes} bytes. Read this file with the read tool when you need it.\n</rule_file>`;
	return { type: "text", text };
}

/**
 * 会话开始的上下文消息的内容：规则文件（用户级的在前，然后从根目录到工作区）、skills 列表、
 * 子 agent 的列表（子 agent 自己是它的补充说明）、记忆索引、当前日期和操作系统。只渲染一次，
 * 之后原样发送。`memoryIndex` 是渲染好的记忆索引，`skills` 是渲染好的 skills 列表，`subagents`
 * 是渲染好的和子 agent 有关的那一块，没有时不放。
 */
export function renderContextMessage(
	files: readonly RuleFile[],
	environment: { date: string; os: string },
	memoryIndex?: TextBlock,
	skills?: TextBlock,
	subagents?: TextBlock,
): TextBlock[] {
	return [
		...files.map(ruleFileBlock),
		...(skills === undefined ? [] : [skills]),
		...(subagents === undefined ? [] : [subagents]),
		...(memoryIndex === undefined ? [] : [memoryIndex]),
		{
			type: "text",
			text: `<environment>\nCurrent date: ${environment.date}\nOperating system: ${environment.os}\n</environment>`,
		},
	];
}

/**
 * 规则文件和已经告诉模型的不一样时的替换说明：变了的和新出现的文件给出新内容，不在了的写明路径。
 * 没有变化时返回 `undefined`。会话开始的上下文消息不动，这份说明追加在后面。
 */
export function renderRuleFilesUpdate(
	recorded: readonly RecordedRuleFile[],
	current: readonly RuleFile[],
): TextBlock[] | undefined {
	const before = new Map(recorded.map((file) => [file.path, file]));
	const changed = current.filter((file) => {
		const old = before.get(file.path);
		return (
			old === undefined ||
			old.sha256 !== file.sha256 ||
			old.included !== file.included
		);
	});
	const paths = new Set(current.map((file) => file.path));
	const removed = recorded.filter((file) => !paths.has(file.path));
	if (changed.length === 0 && removed.length === 0) return undefined;
	return [
		{
			type: "text",
			text: "<rule_files_update>\nThe rule files changed since the start of the session. Each <rule_file> below replaces the earlier one with the same path.\n</rule_files_update>",
		},
		...changed.map(ruleFileBlock),
		...removed.map(
			(file): TextBlock => ({
				type: "text",
				text: `<rule_file ${attributes(file)} removed="true">\nThis rule file no longer exists. Its earlier content no longer applies.\n</rule_file>`,
			}),
		),
	];
}
