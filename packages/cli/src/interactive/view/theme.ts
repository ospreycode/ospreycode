import {
	type EditorTheme,
	type MarkdownTheme,
	type SelectListTheme,
	type SettingsListTheme,
	styleText,
	type TextStyle,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { style } from "../../format/style.js";
import type { Tone } from "../../format/text.js";

export { style };

/** Markdown 里另外用到的几种样式，写法同 `style`：只用终端自己的颜色。 */
const paint = (textStyle: TextStyle) => (text: string) =>
	styleText(text, textStyle, "256color");

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

/** 逐项改设置的列表（granular 的类别、扩展）的样式。 */
export const settingsListTheme: SettingsListTheme = {
	label: (text, selected) => (selected ? style.selected(text) : text),
	value: (text, selected) =>
		selected ? style.selected(text) : style.dim(text),
	description: style.dim,
	cursor: style.selected("→ "),
	hint: style.dim,
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
