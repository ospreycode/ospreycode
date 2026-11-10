// `.gitignore` 的匹配规则按 git 文档 gitignore(5) 的 PATTERN FORMAT 一节实现，不支持 `[[:alpha:]]`
// 这类 POSIX 字符类。

/** `.gitignore` 里的一条规则。 */
export interface IgnoreRule {
	/** `!` 开头：重新包括匹配的路径。 */
	negated: boolean;
	/** 以 `/` 结尾：只匹配目录。 */
	directoryOnly: boolean;
	/** 匹配相对这份 `.gitignore` 所在目录的路径。 */
	regex: RegExp;
}

/** 一份 `.gitignore`：所在的目录（绝对路径）和里面的规则。 */
export interface IgnoreFile {
	directory: string;
	rules: readonly IgnoreRule[];
}

function literal(char: string): string {
	return char.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
}

/** 字符集结束的 `]` 的位置；没有时为 -1，这个 `[` 按字面处理。 */
function classEnd(pattern: string, open: number): number {
	let index = open + 1;
	if (pattern[index] === "!" || pattern[index] === "^") index += 1;
	// 紧跟在开头的 `]` 是字符集里的字符
	if (pattern[index] === "]") index += 1;
	while (index < pattern.length && pattern[index] !== "]") {
		index += pattern[index] === "\\" ? 2 : 1;
	}
	return index < pattern.length ? index : -1;
}

/** `[` 和 `]` 之间的内容换成正则表达式的字符集。 */
function characterClass(body: string): string {
	const negated = body[0] === "!" || body[0] === "^";
	let members = "";
	for (let index = negated ? 1 : 0; index < body.length; index += 1) {
		const escaped = body[index] === "\\" && index + 1 < body.length;
		if (escaped) index += 1;
		const char = body[index] as string;
		// `-` 没有转义时是范围，其余在正则的字符集里有特殊含义的都按字面
		members += (escaped ? "\\]^-[" : "\\]^[").includes(char)
			? `\\${char}`
			: char;
	}
	// 通配符不跨目录，排除式的字符集也不能匹配 `/`
	return negated ? `[^/${members}]` : `[${members}]`;
}

/** 花括号是不是成对：不成对的按字面处理。 */
function balanced(pattern: string): boolean {
	let depth = 0;
	for (let index = 0; index < pattern.length; index += 1) {
		if (pattern[index] === "\\") index += 1;
		else if (pattern[index] === "{") depth += 1;
		else if (pattern[index] === "}") depth -= 1;
		if (depth < 0) return false;
	}
	return depth === 0;
}

/**
 * 把 `.gitignore` 写法的模式换成正则表达式的源码：`*` 和 `?` 不跨 `/`，占满一整段的 `**` 跨任意层
 * 目录，`[...]` 是字符集，`\` 转义下一个字符。`braces` 为真时另外支持 `{a,b}`。
 */
function translate(pattern: string, braces: boolean): string {
	let source = "";
	let depth = 0;
	for (let index = 0; index < pattern.length; ) {
		const char = pattern[index] as string;
		if (char === "\\" && index + 1 < pattern.length) {
			source += literal(pattern[index + 1] as string);
			index += 2;
		} else if (char === "*") {
			let end = index;
			while (pattern[end] === "*") end += 1;
			const wholeSegment =
				end - index >= 2 &&
				(index === 0 || pattern[index - 1] === "/") &&
				(end === pattern.length || pattern[end] === "/");
			if (!wholeSegment) {
				source += "[^/]*";
				index = end;
			} else if (end === pattern.length) {
				source += ".*";
				index = end;
			} else {
				// `**/` 也匹配零层目录
				source += "(?:.*/)?";
				index = end + 1;
			}
		} else if (char === "?") {
			source += "[^/]";
			index += 1;
		} else if (char === "[") {
			const close = classEnd(pattern, index);
			if (close === -1) {
				source += "\\[";
				index += 1;
			} else {
				source += characterClass(pattern.slice(index + 1, close));
				index = close + 1;
			}
		} else if (braces && char === "{") {
			source += "(?:";
			depth += 1;
			index += 1;
		} else if (braces && char === "}") {
			source += ")";
			depth -= 1;
			index += 1;
		} else if (braces && char === "," && depth > 0) {
			source += "|";
			index += 1;
		} else {
			source += literal(char);
			index += 1;
		}
	}
	return source;
}

/** 开头或中间有 `/` 的模式相对所在的目录，别的匹配任何一级目录里的名字。 */
function matcher(pattern: string, braces: boolean): RegExp {
	const anchored = pattern.includes("/");
	const source = translate(
		pattern.startsWith("/") ? pattern.slice(1) : pattern,
		braces,
	);
	return new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`);
}

/** 解析一份 `.gitignore` 的内容。写错的行（比如字符集的范围颠倒）不匹配任何路径，和 git 一样。 */
export function parseIgnore(content: string): IgnoreRule[] {
	return content.split(/\r?\n/).flatMap((line) => {
		// 行尾没有转义的空格不算模式的一部分
		let pattern = line.replace(/(?<!\\) +$/, "");
		if (pattern === "" || pattern.startsWith("#")) return [];
		const negated = pattern.startsWith("!");
		if (negated) pattern = pattern.slice(1);
		const directoryOnly = pattern.endsWith("/");
		if (directoryOnly) pattern = pattern.slice(0, -1);
		if (pattern === "") return [];
		try {
			return [{ negated, directoryOnly, regex: matcher(pattern, false) }];
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			return [];
		}
	});
}

/**
 * `glob` 参数的匹配器：和 `.gitignore` 的模式同一种写法，另外支持 `{a,b}`。匹配的是相对搜索目录的
 * 路径。写错时抛出 `SyntaxError`。
 */
export function globMatcher(glob: string): RegExp {
	return matcher(glob, balanced(glob));
}

/** `path` 相对 `directory` 的写法；`path` 在 `directory` 里面。 */
function below(directory: string, path: string): string {
	return path.slice(
		directory.endsWith("/") ? directory.length : directory.length + 1,
	);
}

/**
 * `path`（绝对路径）按这些 `.gitignore` 是不是被忽略。`files` 从浅到深排列：较深的文件、靠后的
 * 规则优先。被忽略的目录里面的路径不用再问：调用方不进被忽略的目录。
 */
export function isIgnored(
	files: readonly IgnoreFile[],
	path: string,
	directory: boolean,
): boolean {
	let ignored = false;
	for (const file of files) {
		const target = below(file.directory, path);
		for (const rule of file.rules) {
			if ((!rule.directoryOnly || directory) && rule.regex.test(target)) {
				ignored = !rule.negated;
			}
		}
	}
	return ignored;
}
