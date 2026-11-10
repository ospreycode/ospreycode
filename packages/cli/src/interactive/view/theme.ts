import {
	type EditorTheme,
	indexedColor,
	type MarkdownTheme,
	type SelectListTheme,
	styleText,
	type TextStyle,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Tone } from "../format.js";

/**
 * 只用终端自己的 16 色，写成 256 色的转义序列：颜色跟着用户的终端配色走，深色浅色背景都看得清，
 * 也不用探测终端支持哪种颜色。
 */
const paint = (style: TextStyle) => (text: string) =>
	styleText(text, style, "256color");

/** 界面用到的几种文字样式。 */
export const style = {
	plain: (text: string) => text,
	dim: paint({ dim: true }),
	bold: paint({ bold: true }),
	italic: paint({ italic: true, dim: true }),
	accent: paint({ fg: indexedColor(6) }),
	user: paint({ fg: indexedColor(6), bold: true }),
	added: paint({ fg: indexedColor(2) }),
	removed: paint({ fg: indexedColor(1) }),
	hunk: paint({ fg: indexedColor(6), dim: true }),
	success: paint({ fg: indexedColor(2) }),
	warning: paint({ fg: indexedColor(3) }),
	error: paint({ fg: indexedColor(1) }),
	selected: paint({ fg: indexedColor(6), bold: true }),
};

/** 一行的色调对应的样式。 */
export const toneStyle: Record<Tone, (text: string) => string> = {
	plain: style.plain,
	dim: style.dim,
	added: style.added,
	removed: style.removed,
	hunk: style.hunk,
};

/** 列表（补全、选项、模型和后台命令的列表）的样式。 */
export const selectListTheme: SelectListTheme = {
	selectedPrefix: style.selected,
	selectedText: style.selected,
	description: style.dim,
	scrollInfo: style.dim,
	noMatch: style.dim,
};

/** 输入框的样式。 */
export const editorTheme: EditorTheme = {
	borderColor: style.dim,
	selectList: selectListTheme,
};

/** 模型回复里 Markdown 的样式。 */
export const markdownTheme: MarkdownTheme = {
	heading: style.bold,
	link: style.accent,
	linkUrl: style.dim,
	code: style.accent,
	codeBlock: style.plain,
	codeBlockBorder: style.dim,
	quote: style.italic,
	quoteBorder: style.dim,
	hr: style.dim,
	listBullet: style.accent,
	bold: style.bold,
	italic: paint({ italic: true }),
	strikethrough: paint({ strikethrough: true }),
	underline: paint({ underline: true }),
};

/**
 * 把文字折成不超过 `width` 列的行，每行前面加上 `indent`（第一行换成同样宽的 `marker`），折好之后
 * 再上色：界面库遇到超宽的行会报错，样式也不能跨行。
 */
export function wrapped(
	text: string,
	width: number,
	paintLine: (text: string) => string = style.plain,
	indent = "",
	marker = indent,
): string[] {
	// 窄到放不下缩进的终端上不缩进
	const indented = visibleWidth(indent) < width;
	const room = indented ? width - visibleWidth(indent) : width;
	return wrapTextWithAnsi(text, room).map((line, index) => {
		const prefix = index === 0 ? marker : indent;
		return `${indented ? prefix : ""}${paintLine(line)}`;
	});
}

/** 一行说明：超出宽度的部分截掉。 */
export function clipped(
	text: string,
	width: number,
	paintLine: (text: string) => string = style.plain,
): string {
	return paintLine(truncateToWidth(text, width, "…"));
}
