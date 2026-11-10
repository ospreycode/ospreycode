import { basename, dirname, join, resolve } from "node:path";
import type { AdditionalPermissions } from "../contracts/requests.js";
import type { CommandRule, RuleFile } from "../contracts/rules.js";
import type { CommandContext } from "./decide.js";
import {
	existingRealPath,
	fileAt,
	isWithin,
	pathForms,
	withRealPaths,
} from "./paths.js";
import {
	type LiteralCommand,
	literalCommands,
	type ShellScript,
	type ShellWord,
} from "./shell.js";
import { expandWord, isFixedWord } from "./words.js";
import { commandName } from "./wrappers.js";

/** 规则文件里的命令规则，按决定分开。 */
export interface CommandRules {
	forbidden: CommandRule[];
	prompt: CommandRule[];
	/** 只有用户级和启动参数指定的：仓库里的规则只能收紧。 */
	allow: CommandRule[];
}

/** 把几份权限规则文件里的命令规则按决定分开。 */
export function commandRules(files: readonly RuleFile[]): CommandRules {
	const pick = (decision: CommandRule["decision"], from: readonly RuleFile[]) =>
		from.flatMap((file) =>
			file.rules.rules.filter((rule) => rule.decision === decision),
		);
	return {
		forbidden: pick("forbidden", files),
		prompt: pick("prompt", files),
		allow: pick(
			"allow",
			files.filter((file) => file.source !== "repo"),
		),
	};
}

function candidates(token: string | string[]): string[] {
	return typeof token === "string" ? [token] : token;
}

/**
 * 收紧的匹配，用于 `forbidden` 和 `prompt`：命令名取文件名、不分大小写，其余位置按字面值比较。
 * 调用方对每条字面命令和它去掉包装后的命令都比一遍。
 */
export function matchesLoosely(
	rule: CommandRule,
	words: readonly ShellWord[],
): boolean {
	return (
		words.length >= rule.pattern.length &&
		rule.pattern.every((token, index) => {
			const value = index === 0 ? commandName(words) : words[index].value;
			return candidates(token).some(
				(candidate) =>
					(index === 0 ? candidate.toLowerCase() : candidate) === value,
			);
		})
	);
}

/** 这个词调用的是不是规则里写的那个命令。 */
export type Invokes = (word: ShellWord, name: string) => boolean;

/** 只看写法：加载规则时核对例子用，那时还不知道 `PATH` 和工作目录。 */
export const invokesByName: Invokes = (word, name) =>
	word.value === name && isFixedWord(word);

/** 系统目录：这里的可执行文件不经 `PATH` 也认。 */
const systemDirectories = ["/bin", "/sbin", "/usr/bin", "/usr/sbin"];

/** 这个路径上可执行文件的真实路径。 */
function executableAt(path: string): string | undefined {
	const stats = fileAt(path);
	return stats?.isFile() && (stats.mode & 0o111) !== 0
		? existingRealPath(path)
		: undefined;
}

/**
 * `allow` 用的可执行文件身份检查：按执行命令的进程的 `PATH` 查找规则里的命令名，调用时写的路径
 * 取真实路径后必须等于查找结果或位于系统目录，并且不在 agent 可写的目录里；只写命令名的，
 * 按 `PATH` 查到的那个文件判断。这样 agent 自己放进工作区的同名程序不会被当成规则里的命令。
 */
export function executableIdentity(
	workdir: string,
	context: Pick<CommandContext, "path" | "home" | "agentWritable">,
): Invokes {
	const writable = withRealPaths(context.agentWritable);
	const agentWritable = (path: string) =>
		writable.some((directory) => isWithin(path, directory));
	const found = new Map<string, string | undefined>();
	const lookup = (name: string): string | undefined => {
		if (!found.has(name)) {
			let real: string | undefined;
			for (const directory of context.path.split(":")) {
				const path = resolve(workdir, directory, name);
				real = executableAt(path);
				if (real === undefined) continue;
				// shell 执行的就是第一个查到的文件，它在 agent 可写的目录里就不再往后找
				if (agentWritable(path) || agentWritable(real)) real = undefined;
				break;
			}
			found.set(name, real);
		}
		return found.get(name);
	};
	return (word, name) => {
		const written = word.value;
		if (written === undefined) return false;
		if (!written.includes("/")) {
			return (
				written === name && isFixedWord(word) && lookup(name) !== undefined
			);
		}
		const expanded = expandWord(word, context.home);
		if (expanded === undefined || expanded.glob) return false;
		const path = resolve(workdir, expanded.text);
		const real = executableAt(path);
		return (
			real !== undefined &&
			!agentWritable(path) &&
			!agentWritable(real) &&
			(real === lookup(name) ||
				(systemDirectories.includes(dirname(real)) && basename(real) === name))
		);
	};
}

/**
 * `allow` 的匹配：第一个词要通过可执行文件身份检查，其余位置按字面值比较，并且不能是执行时
 * 还会被 bash 展开的词。前缀之后的参数不限。
 */
export function matchesAllow(
	rule: CommandRule,
	words: readonly ShellWord[],
	invokes: Invokes,
): boolean {
	return (
		words.length >= rule.pattern.length &&
		rule.pattern.every((token, index) =>
			candidates(token).some((candidate) =>
				index === 0
					? invokes(words[0], candidate)
					: words[index].value === candidate && isFixedWord(words[index]),
			),
		)
	);
}

/**
 * 整段脚本按 `allow` 处理时，各段命中的 `allow` 规则；不能按 `allow` 处理时没有结果。
 * 要求整段只由普通的词和 `&&`、`||`、`;`、`|` 连接、没有语法错误、每一段都命中 `allow`；
 * `bash -c`、`sh -c` 的脚本满足同样的条件时拆开逐段匹配，不满足就不按 `allow`；`eval` 一律不按 `allow`。
 */
export function allowedSegments(
	script: ShellScript,
	rules: readonly CommandRule[],
	invokes: Invokes,
): CommandRule[][] | undefined {
	if (!script.plain || script.hasError) return undefined;
	const segments: CommandRule[][] = [];
	for (const command of script.commands) {
		if (command.script?.via === "shell") {
			const inner = allowedSegments(command.script.body, rules, invokes);
			if (inner === undefined) return undefined;
			segments.push(...inner);
			continue;
		}
		if (commandName(command.words) === "eval") return undefined;
		const matched = rules.filter((rule) =>
			matchesAllow(rule, command.words, invokes),
		);
		if (matched.length === 0) return undefined;
		segments.push(matched);
	}
	return segments;
}

/** 规则 `permissions` 里的路径：`$WORKSPACE/` 按当时的工作区展开，`~/` 按主目录展开。 */
function declaredPath(
	path: string,
	context: Pick<CommandContext, "workspace" | "home">,
): string {
	if (path.startsWith("$WORKSPACE/")) {
		return join(context.workspace, path.slice("$WORKSPACE/".length));
	}
	return path.startsWith("~/") ? join(context.home, path.slice(2)) : path;
}

/** 申请的额外权限是不是都落在规则声明的范围内：路径在声明的路径之下或相同，socket 按字符串比较。 */
export function covers(
	declared: AdditionalPermissions | undefined,
	requested: AdditionalPermissions,
	context: Pick<CommandContext, "workspace" | "home">,
): boolean {
	const inside = (paths: string[] = [], within: string[] = []) => {
		const directories = withRealPaths(
			within.map((path) => declaredPath(path, context)),
		);
		// 申请的路径是模型写的：按词法的写法和真实路径都要在声明的范围内
		return paths.every((path) =>
			pathForms(path).every((form) =>
				directories.some((directory) => isWithin(form, directory)),
			),
		);
	};
	return (
		inside(requested.file_system?.read, declared?.file_system?.read) &&
		inside(requested.file_system?.write, declared?.file_system?.write) &&
		(requested.unix_sockets ?? []).every(
			(socket) => declared?.unix_sockets?.includes(socket) === true,
		) &&
		(requested.local_binding !== true || declared?.local_binding === true)
	);
}

/**
 * 整段脚本按 `allow` 处理，并且每一段都有一条命中的规则声明了申请的全部额外权限：
 * 权限是加给整条命令的，每一段都会带着它运行。
 */
export function allowCovers(
	script: ShellScript,
	rules: readonly CommandRule[],
	invokes: Invokes,
	requested: AdditionalPermissions,
	context: Pick<CommandContext, "workspace" | "home">,
): boolean {
	const segments = allowedSegments(script, rules, invokes);
	return (
		segments?.every((matched) =>
			matched.some((rule) => covers(rule.permissions, requested, context)),
		) === true
	);
}

/** 普通脚本拆开 `bash -c` 之后的各段；脚本不普通时为空。 */
function plainSegments(script: ShellScript): ShellWord[][] {
	if (!script.plain || script.hasError) return [];
	return script.commands.flatMap((command) =>
		command.script?.via === "shell"
			? plainSegments(command.script.body)
			: [command.words],
	);
}

/**
 * 加载时核对 `match` 和 `not_match`：例子里有没有一条命令按这条规则的匹配方式命中。
 * `allow` 规则只看普通脚本的各段，命令名要和规则里写的一样；可执行文件的身份到执行时才能检查。
 */
export function exampleMatches(
	rule: CommandRule,
	script: ShellScript,
): boolean {
	return rule.decision === "allow"
		? plainSegments(script).some((words) =>
				matchesAllow(rule, words, invokesByName),
			)
		: literalCommands(script).some(({ words }) => matchesLoosely(rule, words));
}

/** 命中某条规则的第一条命令。 */
export function firstMatch(
	rules: readonly CommandRule[],
	commands: readonly LiteralCommand[],
): { rule: CommandRule; command: LiteralCommand } | undefined {
	for (const command of commands) {
		const rule = rules.find((each) => matchesLoosely(each, command.words));
		if (rule !== undefined) return { rule, command };
	}
	return undefined;
}
