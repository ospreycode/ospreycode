import {
	type CommandSpec,
	commandLine,
	commands,
	type OptionSpec,
	subcommands,
} from "./commands.js";

function optionLabel(option: OptionSpec): string {
	const names =
		option.short === undefined
			? `    --${option.name}`
			: `-${option.short}, --${option.name}`;
	return option.value === undefined ? names : `${names} ${option.value}`;
}

function table(rows: readonly (readonly [string, string])[]): string[] {
	const width = Math.max(...rows.map(([label]) => label.length));
	return rows.map(
		([label, description]) => `  ${label.padEnd(width)}  ${description}`,
	);
}

/** 一条命令的帮助，从命令表生成。 */
export function helpText(command: CommandSpec): string {
	const root = command.path.length === 0;
	// 根命令的帮助列出全部能运行的命令，其余的只列下一级
	const listed = root
		? commands.filter((other) => other.path.length > 0 && other.group !== true)
		: subcommands(command);
	const lines: string[] = [];
	if (command.group === true) {
		lines.push(`用法：${commandLine(command)} <子命令> [选项]`);
	} else {
		lines.push(
			`用法：${[commandLine(command), "[选项]", command.usage].filter((part) => part !== "").join(" ")}`,
		);
		if (root) lines.push("      ospreycode <命令> [选项]");
	}
	lines.push("", command.summary);
	if (command.notes !== undefined) lines.push("", ...command.notes);
	if (listed.length > 0) {
		lines.push(
			"",
			root ? "命令：" : "子命令：",
			...table(
				listed.map((other) => [
					[...other.path.slice(root ? 0 : command.path.length), other.usage]
						.filter((part) => part !== "")
						.join(" "),
					other.summary,
				]),
			),
		);
	}
	lines.push(
		"",
		"选项：",
		...table(
			command.options.map((option) => [
				optionLabel(option),
				option.description,
			]),
		),
	);
	return `${lines.join("\n")}\n`;
}
