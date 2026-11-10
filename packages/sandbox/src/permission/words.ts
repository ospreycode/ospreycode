import type { ShellWord } from "./shell.js";

/** 通配符和花括号展开（`{a,b}`、`{1..3}`）；`find` 用的 `{}` 不展开。 */
const globPattern = /[*?[]|\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/** 把 shell 不再解释的字符换成占位符。 */
function opaque(text: string): string {
	return "x".repeat(text.length);
}

/** 展开 `~` 和 `$HOME` 之后的词。 */
export interface ExpandedWord {
	text: string;
	/**
	 * 和 `text` 等长：加了引号的字符和展开出来的主目录换成占位符，剩下的是 shell 还会解释的字符。
	 * `{a,"b"}` 这样引号夹在中间的花括号展开，要把整个词连起来才看得出。
	 */
	shape: string;
	/** 带没加引号的通配符或花括号展开：指向哪些路径要到执行时才知道。 */
	glob: boolean;
}

function expanded(text: string, shape: string): ExpandedWord {
	return { text, shape, glob: globPattern.test(shape) };
}

/** 展开词里的 `~` 和 `$HOME`；含其他变量、命令替换或 `~user` 时不知道它的值，没有结果。 */
export function expandWord(
	word: ShellWord,
	home: string,
): ExpandedWord | undefined {
	let text = "";
	let shape = "";
	for (const [index, part] of word.parts.entries()) {
		if (part.kind === "dynamic") return undefined;
		if (part.kind === "variable") {
			if (part.name !== "HOME") return undefined;
			text += home;
			shape += opaque(home);
		} else if (part.quoted) {
			text += part.text;
			shape += opaque(part.text);
		} else if (index === 0 && part.text.startsWith("~")) {
			if (part.text !== "~" && !part.text.startsWith("~/")) return undefined;
			text += home + part.text.slice(1);
			shape += opaque(home) + part.text.slice(1);
		} else {
			text += part.text;
			shape += part.text;
		}
	}
	return expanded(text, shape);
}

/**
 * `名字=值` 写法里的值（`--config=~/x`、`of=/dev/disk2`）；不是这种写法时没有结果。
 * 值开头没加引号的 `~` 展开成主目录：bash 对像赋值的参数也展开它。
 */
export function assignedValue(
	word: ExpandedWord,
	home: string,
): ExpandedWord | undefined {
	const equals = word.text.indexOf("=");
	if (equals === -1) return undefined;
	const text = word.text.slice(equals + 1);
	const shape = word.shape.slice(equals + 1);
	return /^~(\/|$)/.test(shape)
		? expanded(home + text.slice(1), opaque(home) + shape.slice(1))
		: expanded(text, shape);
}

/** 通配之前的目录在 `text` 里的写法：匹配到的路径都在它下面。 */
export function globDirectory({ text, shape }: ExpandedWord): string {
	return text.slice(0, text.lastIndexOf("/", shape.search(globPattern)) + 1);
}

/**
 * 词是字面值，执行时 bash 也不会把它展开成别的东西：没有没加引号的通配符、花括号展开，
 * 开头和 `=`、`:` 后面也没有没加引号的 `~`。按 `allow` 匹配的词要满足这一条，
 * 解析出的词才等于程序实际收到的参数。
 */
export function isFixedWord(word: ShellWord): boolean {
	let shape = "";
	for (const part of word.parts) {
		if (part.kind !== "literal") return false;
		shape += part.quoted ? opaque(part.text) : part.text;
	}
	return !globPattern.test(shape) && !/(?:^|[=:])~/.test(shape);
}
