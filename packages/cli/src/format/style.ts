import {
	indexedColor,
	styleText,
	type TextStyle,
} from "@earendil-works/pi-tui";

/**
 * 只用终端自己的 16 色，写成 256 色的转义序列：颜色跟着用户的终端配色走，深色浅色背景都看得清，
 * 也不用探测终端支持哪种颜色。
 */
const paint = (style: TextStyle) => (text: string) =>
	styleText(text, style, "256color");

/** 交互界面和非交互模式的过程输出用到的几种文字样式。 */
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

/** 一组文字样式：上色的，或者原样不动的。 */
export type Style = typeof style;

/** 不上色的一组样式：输出不是终端（管道、文件）时用。 */
export const plainStyle: Style = Object.fromEntries(
	Object.keys(style).map((name) => [name, (text: string) => text]),
) as Style;
