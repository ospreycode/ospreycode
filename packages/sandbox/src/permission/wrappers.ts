import { basename } from "node:path";
import type { ShellWord } from "./shell.js";

/** 命令名：第一个词的文件名，转成小写（macOS 默认的 APFS 不区分大小写）；第一个词不是字面值时没有。 */
export function commandName(words: readonly ShellWord[]): string | undefined {
	const value = words[0]?.value;
	return value === undefined ? undefined : basename(value).toLowerCase();
}

/** 把后面的参数当命令执行的包装命令，以及怎样跳过它自己的参数。 */
interface Wrapper {
	/** 带参数的短选项。 */
	short?: string;
	/** 带参数、并且参数和选项分开写的长选项。 */
	long?: readonly string[];
	/** 命令之前的位置参数个数（`timeout` 的时长）。 */
	positional?: number;
	/** 命令之前可以有 `NAME=VALUE`。 */
	assignments?: boolean;
}

const wrappers = new Map<string, Wrapper>([
	[
		"sudo",
		{
			short: "CDRTUghprtu",
			long: [
				"chdir",
				"chroot",
				"close-from",
				"command-timeout",
				"group",
				"host",
				"other-user",
				"prompt",
				"role",
				"type",
				"user",
			],
			assignments: true,
		},
	],
	["doas", { short: "Cau" }],
	[
		"env",
		{
			short: "CSu",
			long: ["chdir", "split-string", "unset"],
			assignments: true,
		},
	],
	["nohup", {}],
	["time", { short: "fo", long: ["format", "output"] }],
	["command", {}],
	["builtin", {}],
	["exec", { short: "a" }],
	["timeout", { short: "ks", long: ["kill-after", "signal"], positional: 1 }],
	["nice", { short: "n", long: ["adjustment"] }],
	["ionice", { short: "cnp", long: ["class", "classdata", "pid"] }],
	["stdbuf", { short: "eio", long: ["error", "input", "output"] }],
	["setsid", {}],
	[
		"xargs",
		{
			short: "EIJLPRSadns",
			long: [
				"arg-file",
				"delimiter",
				"max-args",
				"max-chars",
				"max-procs",
				"process-slot-var",
			],
		},
	],
	["watch", { short: "n", long: ["interval"] }],
	["caffeinate", { short: "tw" }],
	// `busybox rm -rf x`：第一个参数是它内置的命令名
	["busybox", {}],
	["toybox", {}],
]);

/** `find` 的 `-exec`、`-execdir`、`-ok`、`-okdir` 后面到 `;` 或 `{} +` 为止的命令。 */
function findCommands(words: readonly ShellWord[]): ShellWord[][] {
	const commands: ShellWord[][] = [];
	let index = 1;
	while (index < words.length) {
		const action = words[index].value;
		index++;
		if (
			action !== "-exec" &&
			action !== "-execdir" &&
			action !== "-ok" &&
			action !== "-okdir"
		) {
			continue;
		}
		const start = index;
		while (
			index < words.length &&
			words[index].value !== ";" &&
			!(words[index].value === "+" && words[index - 1].value === "{}")
		) {
			index++;
		}
		if (index > start) commands.push(words.slice(start, index));
	}
	return commands;
}

/**
 * 包装命令（`sudo`、`env`、`timeout`、`xargs`、`find -exec` 等）执行的命令：去掉一层包装之后的词。
 * 不是包装命令，或者后面没有命令时为空。
 */
export function unwrap(words: readonly ShellWord[]): ShellWord[][] {
	const name = commandName(words);
	if (name === undefined) return [];
	if (name === "find") return findCommands(words);
	const wrapper = wrappers.get(name);
	if (wrapper === undefined) return [];
	let positional = wrapper.positional ?? 0;
	let options = true;
	let index = 1;
	for (; index < words.length; index++) {
		const value = words[index].value;
		if (options && value === "--") {
			options = false;
		} else if (options && value?.startsWith("--")) {
			// `--name=value` 自带参数；分开写的参数是下一个词
			if (wrapper.long?.includes(value.slice(2))) index++;
		} else if (options && value?.startsWith("-") && value.length > 1) {
			// `command -v` 只是查找命令，不执行
			if (name === "command" && /[vV]/.test(value)) return [];
			// 连写的短选项里，带参数的选项在末尾时参数是下一个词，否则参数紧跟在它后面
			const valued = [...value.slice(1)].findIndex((letter) =>
				wrapper.short?.includes(letter),
			);
			if (valued === value.length - 2) index++;
		} else if (
			wrapper.assignments &&
			value !== undefined &&
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
		) {
			// `env A=1 cmd`、`sudo A=1 cmd` 的变量赋值
		} else if (positional > 0) {
			positional--;
		} else {
			break;
		}
	}
	return index < words.length ? [words.slice(index)] : [];
}

/** 用 `-c` 执行脚本参数的 shell。 */
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

/** `bash -c`、`sh -c` 这类调用的脚本：选项之后的第一个参数。 */
function shellScript(words: readonly ShellWord[]): ShellWord | undefined {
	let command = false;
	let index = 1;
	for (; index < words.length; index++) {
		const value = words[index].value;
		if (value === "--") {
			index++;
			break;
		}
		if (value === undefined || !/^[-+]./.test(value)) break;
		if (value.startsWith("--")) {
			if (value === "--rcfile" || value === "--init-file") index++;
		} else {
			// `-lc`、`-ec` 这样连写的也算
			command ||= value.startsWith("-") && value.includes("c");
			// `-o 选项名`、`-O shopt 选项名`
			if (/[oO]$/.test(value)) index++;
		}
	}
	return command ? words[index] : undefined;
}

/** 命令的脚本参数：由哪种命令执行，和脚本的字面内容。 */
export interface ScriptArgument {
	via: "shell" | "eval" | "trap";
	source: string;
}

/**
 * `bash -c`、`sh -c` 这类调用、`eval` 和 `trap` 的脚本参数。只取字面的脚本：
 * 含变量或命令替换的脚本到执行时才知道内容。
 */
export function scriptArgument(
	words: readonly ShellWord[],
): ScriptArgument | undefined {
	const name = commandName(words);
	if (name === undefined) return undefined;
	if (shells.has(name)) {
		const source = shellScript(words)?.value;
		return source === undefined ? undefined : { via: "shell", source };
	}
	if (name === "eval") {
		// eval 把参数用空格连起来再执行
		const values = words.slice(1).map((word) => word.value);
		return values.length === 0 || values.includes(undefined)
			? undefined
			: { via: "eval", source: values.join(" ") };
	}
	if (name === "trap") {
		// `trap 动作 信号…`；只有一个参数时是恢复这个信号的默认处理，`-` 也是
		const operands = words
			.slice(1)
			.filter(
				(word) => word.value === undefined || !/^-[-lp]$/.test(word.value),
			);
		const source = operands.length > 1 ? operands[0].value : undefined;
		return source === undefined || source === "-"
			? undefined
			: { via: "trap", source };
	}
	return undefined;
}
