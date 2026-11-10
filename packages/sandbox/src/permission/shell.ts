import { readFile } from "node:fs/promises";
import { Language, type Node, Parser } from "web-tree-sitter";
import { isFixedWord } from "./words.js";
import { scriptArgument, unwrap } from "./wrappers.js";

/**
 * 词的一部分：
 *
 * - `literal`：字面的文本，已经去掉引号和转义；`quoted` 为 false 的部分没有加引号，
 *   开头的 `~`、其中的通配符和花括号由 shell 展开
 * - `variable`：`$NAME` 或 `${NAME}`
 * - `dynamic`：命令替换、带运算的参数展开等，到执行时才知道值
 */
export type ShellWordPart =
	| { kind: "literal"; text: string; quoted: boolean }
	| { kind: "variable"; name: string }
	| { kind: "dynamic" };

/** 命令里的一个词。 */
export interface ShellWord {
	/** 源码里的写法。 */
	text: string;
	/** 去掉引号和转义后的字面值；含变量、命令替换等不是字面值的部分时没有。 */
	value?: string;
	parts: ShellWordPart[];
}

/** 一处文件重定向。 */
export interface ShellRedirect {
	/** 操作符，如 `>`、`>>`、`<`、`&>`。 */
	operator: string;
	target: ShellWord;
}

/** 脚本里的一条字面命令。 */
export interface ShellCommand {
	/** 命令名和参数；命令前的变量赋值和重定向不在里面。 */
	words: ShellWord[];
	/** 这是包装命令（`env`、`timeout`、`xargs`、`find -exec` 等）时，它执行的命令。 */
	wrapped: ShellCommand[];
	/** `bash -c`、`sh -c` 这类调用、`eval` 或 `trap` 的字面脚本参数解析出的脚本。 */
	script?: { via: "shell" | "eval" | "trap"; body: ShellScript };
}

/** 解析后的一段 bash 脚本。 */
export interface ShellScript {
	/**
	 * 脚本里的每条字面命令，按出现的顺序；控制流、命令替换、子 shell 和函数体里的都在内。
	 * 脚本参数里的命令在各条命令的 `script` 里。
	 */
	commands: ShellCommand[];
	/** 脚本里的文件重定向，不含脚本参数里的。 */
	redirects: ShellRedirect[];
	/** 整段只由普通的词和 `&&`、`||`、`;`、`|` 连接；这时 `commands` 就是按顺序的各段。 */
	plain: boolean;
	/** 有语法错误。 */
	hasError: boolean;
	/** 带 heredoc 或换行。 */
	multiline: boolean;
}

/** bash 解析器，加载一次后传给判断命令和校验权限规则文件的函数。 */
export interface ShellParser {
	/** 解析一段按 bash 语法写的脚本；语法错误不抛出，记在结果的 `hasError` 里。 */
	parse(script: string): ShellScript;
}

type Parse = (script: string) => ShellScript;

/** 把相邻的同类字面部分并成一个，通配符和花括号才能在一个部分里完整地看到。 */
function addLiteral(parts: ShellWordPart[], text: string, quoted: boolean) {
	const last = parts.at(-1);
	if (last?.kind === "literal" && last.quoted === quoted) last.text += text;
	else parts.push({ kind: "literal", text, quoted });
}

/** 没加引号的词：反斜杠后面的字符是字面的，反斜杠加换行是续行。 */
function addUnquoted(parts: ShellWordPart[], text: string) {
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\\") {
			addLiteral(parts, text[index], false);
		} else if (index + 1 === text.length) {
			addLiteral(parts, "\\", true);
		} else {
			index++;
			if (text[index] !== "\n") addLiteral(parts, text[index], true);
		}
	}
}

const ansiEscapes: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
};

/** `$'…'` 里的转义。 */
function decodeAnsiC(text: string): string {
	return text.replace(
		/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
		(_, sequence: string) => {
			if (/^[0-7]/.test(sequence)) {
				return String.fromCodePoint(Number.parseInt(sequence, 8));
			}
			if (sequence.length === 1) return ansiEscapes[sequence] ?? sequence;
			if (sequence.startsWith("c")) {
				return String.fromCodePoint(sequence.charCodeAt(1) & 0x1f);
			}
			const code = Number.parseInt(sequence.slice(1), 16);
			// `\U` 能写出 Unicode 范围之外的值，bash 也不认，原样留下
			return code <= 0x10ffff ? String.fromCodePoint(code) : sequence;
		},
	);
}

const expansions = new Set([
	"simple_expansion",
	"expansion",
	"command_substitution",
	"arithmetic_expansion",
]);

/**
 * 双引号里的内容。按源码的位置切出字面的部分，不用语法树里的 `string_content`：
 * tree-sitter-bash 把展开之前和结尾引号之前的空白算进了后一个节点。
 */
function addDoubleQuoted(parts: ShellWordPart[], node: Node) {
	const text = node.text;
	const before = parts.length;
	const literal = (from: number, to: number) => {
		if (from === to) return;
		// 双引号里反斜杠只转义这几个字符，反斜杠加换行是续行
		const content = text
			.slice(from, to)
			.replace(/\\([$`"\\\n])/g, (_, escaped: string) =>
				escaped === "\n" ? "" : escaped,
			);
		addLiteral(parts, content, true);
	};
	let position = text.indexOf('"') + 1;
	for (const child of node.children) {
		if (!expansions.has(child.type)) continue;
		const leading = child.text.length - child.text.trimStart().length;
		literal(position, child.startIndex - node.startIndex + leading);
		addParts(parts, child);
		position = child.endIndex - node.startIndex;
	}
	const last = node.lastChild;
	const closed =
		last !== null && last.type === '"' && last.endIndex > last.startIndex;
	literal(position, closed ? text.length - 1 : text.length);
	// 空的 `""` 也要留下一个加了引号的部分：`""~` 里的 `~` 不在词的开头，bash 不展开它
	if (parts.length === before) addLiteral(parts, "", true);
}

function addParts(parts: ShellWordPart[], node: Node) {
	switch (node.type) {
		case "word":
			addUnquoted(parts, node.text);
			break;
		case "raw_string":
			addLiteral(parts, node.text.replace(/^'|'$/g, ""), true);
			break;
		case "ansi_c_string":
			addLiteral(parts, decodeAnsiC(node.text.replace(/^\$'|'$/g, "")), true);
			break;
		case "string":
			addDoubleQuoted(parts, node);
			break;
		case "concatenation":
			for (const child of node.children) addParts(parts, child);
			break;
		case "simple_expansion":
		case "expansion": {
			// 只认 `$NAME` 和 `${NAME}`；带下标、默认值、截取等运算的算作不知道值
			const [name, ...rest] = node.namedChildren;
			const simple =
				name !== undefined &&
				rest.length === 0 &&
				name.type.endsWith("variable_name") &&
				node.childCount === (node.type === "expansion" ? 3 : 2);
			parts.push(
				simple ? { kind: "variable", name: name.text } : { kind: "dynamic" },
			);
			break;
		}
		default:
			if (node.childCount === 0 && (!node.isNamed || node.type === "number")) {
				addLiteral(parts, node.text, false);
			} else {
				parts.push({ kind: "dynamic" });
			}
	}
}

function wordOf(node: Node): ShellWord {
	const parts: ShellWordPart[] = [];
	addParts(parts, node);
	let value: string | undefined = "";
	for (const part of parts) {
		value =
			value === undefined || part.kind !== "literal"
				? undefined
				: value + part.text;
	}
	return { text: node.text, parts, ...(value === undefined ? {} : { value }) };
}

function commandOf(words: ShellWord[], parse: Parse): ShellCommand {
	const argument = scriptArgument(words);
	return {
		words,
		wrapped: unwrap(words).map((inner) => commandOf(inner, parse)),
		...(argument === undefined
			? {}
			: { script: { via: argument.via, body: parse(argument.source) } }),
	};
}

/** 这条语句最右边的简单命令。 */
function lastCommand(node: Node): Node | undefined {
	if (node.type === "command") return node;
	if (node.type !== "pipeline" && node.type !== "list") return undefined;
	const last = node.lastNamedChild;
	return last === null ? undefined : lastCommand(last);
}

interface Found {
	commands: ShellCommand[];
	redirects: ShellRedirect[];
	heredoc: boolean;
	/** 语法树算进重定向、其实是命令参数的词，按命令节点的 id。 */
	trailing: Map<number, Node[]>;
}

/** 找出语法树里的每条命令和每处重定向，不管它们嵌在什么结构里。 */
function visit(node: Node, found: Found, parse: Parse) {
	switch (node.type) {
		case "command": {
			const name = node.childForFieldName("name")?.firstChild;
			const words = [
				...(name == null ? [] : [name]),
				...node.childrenForFieldName("argument"),
				...(found.trailing.get(node.id) ?? []),
			].map(wordOf);
			if (words.length > 0) found.commands.push(commandOf(words, parse));
			break;
		}
		case "redirected_statement": {
			// `cmd >out arg` 里 bash 把 arg 当作 cmd 的参数，tree-sitter-bash 却把它记成重定向的第二个目标
			const body = node.childForFieldName("body");
			const command = body === null ? undefined : lastCommand(body);
			const trailing = node
				.childrenForFieldName("redirect")
				.filter((redirect) => redirect.type === "file_redirect")
				.flatMap((redirect) =>
					redirect.childrenForFieldName("destination").slice(1),
				);
			if (command !== undefined && trailing.length > 0) {
				found.trailing.set(command.id, trailing);
			}
			break;
		}
		case "file_redirect": {
			const [destination] = node.childrenForFieldName("destination");
			const operator = node.children.find((child) => !child.isNamed);
			if (destination !== undefined && operator !== undefined) {
				found.redirects.push({
					operator: operator.type,
					target: wordOf(destination),
				});
			}
			break;
		}
		case "heredoc_redirect":
			found.heredoc = true;
			break;
	}
	// 命令的词里还可能有命令替换，重定向和变量赋值也一样
	for (const child of node.children) visit(child, found, parse);
}

/** 这个节点只由不带引号的词、单引号和不含展开的双引号字符串组成。 */
function isLiteralNode(node: Node): boolean {
	switch (node.type) {
		case "word":
		case "raw_string":
			return true;
		case "number":
			return node.childCount === 0;
		case "string":
			return node.children.every(
				(child) => child.type === '"' || child.type === "string_content",
			);
		case "concatenation":
			return node.children.every(isLiteralNode);
		default:
			return false;
	}
}

/**
 * 普通的词：字面值，执行时也不会被 bash 展开（通配符、花括号、`~`）。照 Codex 的
 * `try_parse_word_only_commands_sequence`；Codex 还拒绝带反斜杠转义的词和 zsh 才会展开的写法
 * （`HEAD^`、`=cmd`、`foo#bar`），这里转义已经按 bash 的规则解码，命令也只用 bash 执行，不必拒绝。
 */
function isPlainWord(node: Node | null): boolean {
	return node !== null && isLiteralNode(node) && isFixedWord(wordOf(node));
}

/** 这条语句只由普通的词和 `&&`、`||`、`|` 连接。 */
function isPlainStatement(node: Node): boolean {
	switch (node.type) {
		case "command":
			return node.children.every((child, index) =>
				child.type === "command_name"
					? isPlainWord(child.firstChild)
					: node.fieldNameForChild(index) === "argument" && isPlainWord(child),
			);
		case "list":
			return node.children.every((child) =>
				child.isNamed
					? isPlainStatement(child)
					: child.type === "&&" || child.type === "||",
			);
		case "pipeline":
			return node.children.every((child) =>
				child.isNamed ? isPlainStatement(child) : child.type === "|",
			);
		default:
			return false;
	}
}

/**
 * 加载 bash 解析器（tree-sitter-bash）。加载是异步的，之后的解析都是同步的；
 * 调用方加载一次后传给 `parseRuleFile`、`decideCommand` 和 `suggestedRule`。
 */
export async function loadShellParser(): Promise<ShellParser> {
	await Parser.init();
	// src/permission 和 dist/permission 到包里的 vendor 目录的相对位置相同
	const grammar = new URL(
		"../../vendor/tree-sitter-bash.wasm",
		import.meta.url,
	);
	const parser = new Parser();
	parser.setLanguage(await Language.load(await readFile(grammar)));
	const parse = (script: string): ShellScript => {
		const tree = parser.parse(script);
		if (tree === null) throw new Error("tree-sitter 没有返回语法树");
		try {
			const root = tree.rootNode;
			const found: Found = {
				commands: [],
				redirects: [],
				heredoc: false,
				trailing: new Map(),
			};
			visit(root, found, parse);
			return {
				commands: found.commands,
				redirects: found.redirects,
				plain:
					found.commands.length > 0 &&
					root.children.every((child) =>
						child.isNamed ? isPlainStatement(child) : child.type === ";",
					),
				hasError: root.hasError,
				multiline: found.heredoc || script.includes("\n"),
			};
		} finally {
			// 语法树在 WASM 的内存里，不归垃圾回收管
			tree.delete();
		}
	};
	return { parse };
}

/** 要逐条判断的一条命令。 */
export interface LiteralCommand {
	words: ShellWord[];
	/** 在 `eval` 的脚本参数里：这样的命令不按 `allow` 处理。 */
	viaEval: boolean;
}

/**
 * 脚本里要逐条判断的命令：每条字面命令、它去掉各层包装后的命令，以及脚本参数
 * （`bash -c`、`eval`、`trap`）里的命令。
 */
export function literalCommands(
	script: ShellScript,
	viaEval = false,
): LiteralCommand[] {
	const expand = (command: ShellCommand): LiteralCommand[] => [
		{ words: command.words, viaEval },
		...command.wrapped.flatMap(expand),
		...(command.script === undefined
			? []
			: literalCommands(
					command.script.body,
					viaEval || command.script.via === "eval",
				)),
	];
	return script.commands.flatMap(expand);
}

/** 脚本和它的脚本参数。 */
function withNested(script: ShellScript): ShellScript[] {
	const nested = (command: ShellCommand): ShellScript[] => [
		...command.wrapped.flatMap(nested),
		...(command.script === undefined ? [] : withNested(command.script.body)),
	];
	return [script, ...script.commands.flatMap(nested)];
}

/** 脚本里的全部重定向，脚本参数里的也在内。 */
export function allRedirects(script: ShellScript): ShellRedirect[] {
	return withNested(script).flatMap((each) => each.redirects);
}

/** 脚本或它的某个脚本参数有语法错误。 */
export function hasSyntaxError(script: ShellScript): boolean {
	return withNested(script).some((each) => each.hasError);
}

/** 命令在源码里的写法，给用户和模型看。 */
export function commandText(words: readonly ShellWord[]): string {
	return words.map((word) => word.text).join(" ");
}
