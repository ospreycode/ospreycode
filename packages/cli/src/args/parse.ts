import { parseArgs } from "node:util";
import { UsageError } from "../errors.js";
import {
	type CommandSpec,
	commandLine,
	commandName,
	commands,
	subcommands,
} from "./commands.js";

/** 解析过的命令行：选中的命令，以及它的选项和位置参数。 */
export interface ParsedArgs {
	command: CommandSpec;
	/** 写了的开关，按长选项的名字。 */
	flags: ReadonlySet<string>;
	/** 带取值的选项，按长选项的名字，取值按写的顺序。 */
	values: ReadonlyMap<string, readonly string[]>;
	positionals: readonly string[];
}

/** 一个开关有没有写。 */
export function flag(args: ParsedArgs, name: string): boolean {
	return args.flags.has(name);
}

/** 一个选项的取值；写了多次时取最后一次，没有写时为空。 */
export function value(args: ParsedArgs, name: string): string | undefined {
	return args.values.get(name)?.at(-1);
}

/** 一个可以写多次的选项的全部取值。 */
export function values(args: ParsedArgs, name: string): readonly string[] {
	return args.values.get(name) ?? [];
}

/** 命令行开头的几个词选中的命令：子命令写在最前面，都不是命令的名字时是根命令。 */
export function selectCommand(argv: readonly string[]): CommandSpec {
	const root = commands.find((command) => command.path.length === 0);
	if (root === undefined) throw new Error("命令表里没有根命令");
	let selected: CommandSpec = root;
	for (const word of argv) {
		const next: CommandSpec | undefined = subcommands(selected).find(
			(command) => commandName(command) === word,
		);
		if (next === undefined) break;
		selected = next;
	}
	return selected;
}

/**
 * 解析命令行。未知的选项、缺少或多余的取值和位置参数抛出 `UsageError`。用 `parseArgs` 的宽松模式
 * 拆出记号再自己检查：严格模式的报错是英文的，也不带命令的名字。
 */
export function parseCommandLine(argv: readonly string[]): ParsedArgs {
	const command = selectCommand(argv);
	const { tokens } = parseArgs({
		args: argv.slice(command.path.length),
		options: Object.fromEntries(
			command.options.map((option) => [
				option.name,
				{
					type: option.value === undefined ? "boolean" : "string",
					...(option.short === undefined ? {} : { short: option.short }),
				} as const,
			]),
		),
		strict: false,
		allowPositionals: true,
		tokens: true,
	});
	const flags = new Set<string>();
	const collected = new Map<string, string[]>();
	const positionals: string[] = [];
	for (const token of tokens) {
		if (token.kind === "positional") positionals.push(token.value);
		if (token.kind !== "option") continue;
		const option = command.options.find((spec) => spec.name === token.name);
		if (option === undefined) {
			throw new UsageError(`未知的选项 ${token.rawName}`);
		}
		if (option.value === undefined) {
			if (token.value !== undefined) {
				throw new UsageError(`选项 ${token.rawName} 不带取值`);
			}
			flags.add(option.name);
		} else {
			if (token.value === undefined) {
				throw new UsageError(`选项 ${token.rawName} 后面要写 ${option.value}`);
			}
			collected.set(option.name, [
				...(collected.get(option.name) ?? []),
				token.value,
			]);
		}
	}
	const parsed = { command, flags, values: collected, positionals };
	// 要看帮助时不检查其余的参数
	if (flags.has("help")) return parsed;
	if (command.group === true) {
		const names = subcommands(command).map(commandName);
		throw new UsageError(
			positionals[0] === undefined
				? `${commandLine(command)} 后面要写子命令：${names.join("、")}`
				: `未知的命令 ${commandLine(command)} ${positionals[0]}，可用的子命令：${names.join("、")}`,
		);
	}
	if (positionals.length < command.minArgs) {
		throw new UsageError(`缺少参数 ${command.usage}`);
	}
	if (positionals.length > command.maxArgs) {
		throw new UsageError(
			`多余的参数：${positionals.slice(command.maxArgs).join(" ")}`,
		);
	}
	return parsed;
}
