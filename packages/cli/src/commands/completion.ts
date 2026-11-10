import {
	type CommandSpec,
	commandName,
	commands,
	type OptionSpec,
	subcommands,
} from "../args/commands.js";
import type { ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";

/** 补全脚本里标识一条命令的键：命令的各级名字用空格连起来，根命令是空串。 */
function key(command: CommandSpec): string {
	return command.path.join(" ");
}

function optionNames(option: OptionSpec): string[] {
	return [
		...(option.short === undefined ? [] : [`-${option.short}`]),
		`--${option.name}`,
	];
}

/** 补全到某条命令时的候选：下一级的子命令和它自己的选项。 */
function candidates(command: CommandSpec): string[] {
	return [
		...subcommands(command).map((sub) => commandName(sub)),
		...command.options.flatMap(optionNames),
	];
}

/** 单引号里的文本。 */
function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * 三种 shell 的脚本都先从已经输入的词里认出命令（和解析时一样，子命令写在最前面），再按命令
 * 给出候选。带取值的选项后面补它的候选值，取值是路径时交给 shell 补文件名。
 */
function bash(): string {
	const descend = commands
		.filter((command) => command.path.length > 0)
		.map((command) => `"${key(command)}"`);
	const cases = commands.flatMap((command) => {
		const valued = command.options.filter(
			(option) => option.value !== undefined,
		);
		const previous = valued.map((option) => {
			const words = option.choices?.join(" ");
			return `\t\t\t\t${optionNames(option).join("|")}) ${
				words === undefined
					? "return"
					: `COMPREPLY=($(compgen -W ${quote(words)} -- "$cur")); return`
			} ;;`;
		});
		return [
			`\t\t"${key(command)}")`,
			...(previous.length === 0
				? []
				: ['\t\t\tcase "$prev" in', ...previous, "\t\t\tesac"]),
			`\t\t\tCOMPREPLY=($(compgen -W ${quote(candidates(command).join(" "))} -- "$cur"))`,
			"\t\t\t;;",
		];
	});
	return [
		'# ospreycode 的 bash 补全：eval "$(ospreycode completion bash)"',
		"_ospreycode() {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的写法，不是漏了反引号
		'\tlocal cur="${COMP_WORDS[COMP_CWORD]}" prev="${COMP_WORDS[COMP_CWORD-1]}"',
		'\tlocal cmd="" word next i',
		"\tfor ((i = 1; i < COMP_CWORD; i++)); do",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的写法，不是漏了反引号
		'\t\tword="${COMP_WORDS[i]}"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的写法，不是漏了反引号
		'\t\tnext="${cmd:+$cmd }$word"',
		'\t\tcase "$next" in',
		`\t\t\t${descend.join("|")}) cmd="$next" ;;`,
		"\t\t\t*) break ;;",
		"\t\tesac",
		"\tdone",
		"\tCOMPREPLY=()",
		'\tcase "$cmd" in',
		...cases,
		"\tesac",
		"}",
		"complete -o default -F _ospreycode ospreycode",
		"",
	].join("\n");
}

function zsh(): string {
	const descend = commands
		.filter((command) => command.path.length > 0)
		.map((command) => `"${key(command)}"`);
	// _describe 的条目写成 "名字:说明"，名字里的冒号要转义
	const described = (name: string, description: string) =>
		quote(`${name.replaceAll(":", "\\:")}:${description}`);
	const cases = commands.flatMap((command) => {
		const valued = command.options.filter(
			(option) => option.value !== undefined,
		);
		const previous = valued.map((option) => {
			const action =
				option.choices !== undefined
					? `compadd -- ${option.choices.join(" ")}`
					: option.path === true
						? "_files"
						: "";
			return `\t\t\t\t${optionNames(option).join("|")}) ${action}${action === "" ? "" : "; "}return ;;`;
		});
		const subs = subcommands(command).map((sub) =>
			described(commandName(sub), sub.summary),
		);
		const options = command.options.flatMap((option) =>
			optionNames(option).map((name) => described(name, option.description)),
		);
		return [
			`\t\t"${key(command)}")`,
			...(previous.length === 0
				? []
				: ['\t\t\tcase "$words[CURRENT-1]" in', ...previous, "\t\t\tesac"]),
			`\t\t\tsubs=(${subs.join(" ")})`,
			`\t\t\topts=(${options.join(" ")})`,
			"\t\t\t;;",
		];
	});
	return [
		"#compdef ospreycode",
		'# ospreycode 的 zsh 补全：eval "$(ospreycode completion zsh)"',
		"_ospreycode() {",
		'\tlocal cmd="" word next i',
		// options 和 commands 是 zsh 自己的特殊变量，不能拿来用
		"\tlocal -a subs opts",
		"\tfor ((i = 2; i < CURRENT; i++)); do",
		'\t\tword="$words[i]"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的写法，不是漏了反引号
		'\t\tnext="${cmd:+$cmd }$word"',
		'\t\tcase "$next" in',
		`\t\t\t${descend.join("|")}) cmd="$next" ;;`,
		"\t\t\t*) break ;;",
		"\t\tesac",
		"\tdone",
		'\tcase "$cmd" in',
		...cases,
		"\tesac",
		"\t(( $#subs )) && _describe -t commands '命令' subs",
		"\t_describe -t options '选项' opts",
		"}",
		"compdef _ospreycode ospreycode",
		"",
	].join("\n");
}

function fish(): string {
	const descend = commands
		.filter((command) => command.path.length > 0)
		.map((command) => quote(key(command)));
	const lines = commands.flatMap((command) => {
		const condition = `-n ${quote(`test "$(__ospreycode_command)" = "${key(command)}"`)}`;
		return [
			...subcommands(command).map(
				(sub) =>
					`complete -c ospreycode ${condition} -f -a ${quote(commandName(sub))} -d ${quote(sub.summary)}`,
			),
			...command.options.map((option) => {
				const value =
					option.value === undefined
						? ""
						: option.choices !== undefined
							? ` -x -a ${quote(option.choices.join(" "))}`
							: option.path === true
								? " -r -F"
								: " -x";
				return `complete -c ospreycode ${condition}${option.short === undefined ? "" : ` -s ${option.short}`} -l ${option.name}${value} -d ${quote(option.description)}`;
			}),
		];
	});
	return [
		"# ospreycode 的 fish 补全：ospreycode completion fish | source",
		"function __ospreycode_command",
		"\tset -l tokens (commandline -opc)",
		"\tset -l cmd ''",
		"\tfor token in $tokens[2..-1]",
		'\t\tset -l next (string trim -- "$cmd $token")',
		`\t\tif contains -- "$next" ${descend.join(" ")}`,
		"\t\t\tset cmd $next",
		"\t\telse",
		"\t\t\tbreak",
		"\t\tend",
		"\tend",
		"\techo $cmd",
		"end",
		...lines,
		"",
	].join("\n");
}

const scripts: Readonly<Record<string, () => string>> = { bash, zsh, fish };

/** `ospreycode completion <shell>`：输出补全脚本，由命令表生成。 */
export async function runCompletion(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [shell] = args.positionals;
	if (!Object.hasOwn(scripts, shell)) {
		throw new UsageError(
			`不支持的 shell：${shell}，可以是 ${Object.keys(scripts).join("、")}`,
		);
	}
	context.stdout.write(scripts[shell]());
	return 0;
}
