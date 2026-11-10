// 替换的规则照 pi-coding-agent 1.5.0 的 src/core/tools/edit-diff.ts，只做精确匹配。pi 以 MIT 许可证发布：Copyright (c) 2025 Mario Zechner
import { ToolFailure } from "./files.js";

/** 一处替换。 */
export interface Replacement {
	old_text: string;
	new_text: string;
}

const bomMark = "\uFEFF";

function toLf(value: string): string {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function occurrences(content: string, part: string): number {
	let count = 0;
	for (
		let at = content.indexOf(part);
		at !== -1;
		at = content.indexOf(part, at + 1)
	) {
		count += 1;
	}
	return count;
}

/**
 * 把几处替换应用到文件内容上，返回新内容。每处的 `old_text` 都按原内容匹配，必须恰好出现一次，
 * 各处不能重叠。模型写的是 LF，所以匹配前把内容统一成 LF，写回时恢复文件原来的换行和开头的 BOM。
 * 匹配不上、不唯一、重叠或替换后没有变化时抛出 `ToolFailure`，不做模糊匹配。
 */
export function applyEdits(
	content: string,
	edits: readonly Replacement[],
	path: string,
): string {
	const bom = content.startsWith(bomMark) ? bomMark : "";
	const body = content.slice(bom.length);
	const firstBreak = body.indexOf("\n");
	const crlf = firstBreak > 0 && body[firstBreak - 1] === "\r";
	const base = toLf(body);
	const label = (index: number) =>
		edits.length === 1 ? "old_text" : `edits[${index}].old_text`;

	const matches = edits.map((edit, index) => {
		const oldText = toLf(edit.old_text);
		if (oldText === "") {
			throw new ToolFailure(`${label(index)} must not be empty.`);
		}
		const count = occurrences(base, oldText);
		if (count === 0) {
			throw new ToolFailure(
				`Could not find ${label(index)} in ${path}. It must match the file exactly, including whitespace and line breaks.`,
			);
		}
		if (count > 1) {
			throw new ToolFailure(
				`Found ${count} occurrences of ${label(index)} in ${path}. It must be unique: include more of the surrounding lines.`,
			);
		}
		return {
			index,
			at: base.indexOf(oldText),
			length: oldText.length,
			newText: toLf(edit.new_text),
		};
	});
	matches.sort((a, b) => a.at - b.at);

	let result = "";
	let cursor = 0;
	for (const [position, match] of matches.entries()) {
		const previous = matches[position - 1];
		if (previous !== undefined && match.at < cursor) {
			throw new ToolFailure(
				`edits[${previous.index}] and edits[${match.index}] overlap in ${path}. Merge them into one edit.`,
			);
		}
		result += base.slice(cursor, match.at) + match.newText;
		cursor = match.at + match.length;
	}
	result += base.slice(cursor);
	if (result === base) {
		throw new ToolFailure(
			`No changes made to ${path}: the replacements produce identical content.`,
		);
	}
	return bom + (crlf ? result.replaceAll("\n", "\r\n") : result);
}
