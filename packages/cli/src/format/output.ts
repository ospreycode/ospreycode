import { sanitize } from "./text.js";

/** 流式输出留开头这么多字符。 */
const headLimit = 4_000;
/** 流式输出留末尾这么多字符。 */
const tailLimit = 16_000;

/** 一段输出的开头几行和末尾几行，和中间没有留下的行数。 */
export interface OutputPreview {
	head: string[];
	omitted: number;
	tail: string[];
}

/**
 * 一次工具调用流式到达的输出。只留开头和末尾各一段：开头常有出错的原因，末尾是最后的结果，完整的
 * 输出在 Host 保存的文件里。
 */
export class OutputBuffer {
	#head = "";
	#tail = "";
	/** 开头和末尾之间丢掉过字符。 */
	#dropped = false;
	/** 到现在为止的换行个数。 */
	#breaks = 0;
	#endsWithBreak = false;

	/** 还没有输出。 */
	get empty(): boolean {
		return this.#head === "";
	}

	append(text: string): void {
		const clean = sanitize(text);
		if (clean === "") return;
		this.#breaks += clean.split("\n").length - 1;
		this.#endsWithBreak = clean.endsWith("\n");
		const room = headLimit - this.#head.length;
		this.#head += clean.slice(0, room);
		this.#tail += clean.slice(room);
		if (this.#tail.length > tailLimit) {
			this.#tail = this.#tail.slice(-tailLimit);
			this.#dropped = true;
		}
	}

	/** 至多 `head` 行开头和 `tail` 行末尾；行数不超过两者之和时全部在 `head` 里。 */
	preview(head: number, tail: number): OutputPreview {
		const total = this.#breaks + (this.#endsWithBreak ? 0 : 1);
		if (this.empty) return { head: [], omitted: 0, tail: [] };
		if (!this.#dropped) {
			const lines = `${this.#head}${this.#tail}`.split("\n");
			if (this.#endsWithBreak) lines.pop();
			return previewLines(lines, head, tail);
		}
		// 中间丢过字符：开头那一段的最后一行、末尾那一段的第一行可能不完整，不用
		const first = this.#head.split("\n").slice(0, -1).slice(0, head);
		const rest = this.#tail.split("\n").slice(1);
		if (this.#endsWithBreak) rest.pop();
		const last = rest.slice(-tail);
		return {
			head: first,
			omitted: total - first.length - last.length,
			tail: last,
		};
	}
}

/** 至多留下开头的 `head` 行和末尾的 `tail` 行，中间省掉的另记行数。 */
export function previewLines(
	lines: readonly string[],
	head: number,
	tail: number,
): OutputPreview {
	if (lines.length <= head + tail) {
		return { head: [...lines], omitted: 0, tail: [] };
	}
	return {
		head: lines.slice(0, head),
		omitted: lines.length - head - tail,
		tail: lines.slice(lines.length - tail),
	};
}

/** 一段文字的预览：按行拆开，末尾的换行不算一行。 */
export function previewText(
	text: string,
	head: number,
	tail: number,
): OutputPreview {
	const lines = sanitize(text).split("\n");
	if (lines.at(-1) === "") lines.pop();
	return previewLines(lines, head, tail);
}

/** 预览排成一列行：省掉的行数写在开头和末尾之间。 */
export function previewRows(preview: OutputPreview): string[] {
	return [
		...preview.head,
		...(preview.omitted === 0 ? [] : [`… +${preview.omitted} 行`]),
		...preview.tail,
	];
}
