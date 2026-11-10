import { type Dirent, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import { type CommandChoices, commands } from "./commands.js";
import { mentionText } from "./input.js";

/** 一次最多给出的候选：再多列表也翻不过来，接着输入就能缩小范围。 */
const maxSuggestions = 100;

/**
 * 命令参数的候选。已经完整写出唯一的候选时不再给：补全列表开着的时候 Enter 只是选中候选，
 * 列表关了才提交。
 */
function argumentItems(
	candidates: readonly string[],
	typed: string,
): AutocompleteItem[] | null {
	const matching = candidates.filter((candidate) =>
		candidate.startsWith(typed),
	);
	if (matching.length === 0) return null;
	if (matching.length === 1 && matching[0] === typed) return null;
	return matching.map((candidate) => ({ value: candidate, label: candidate }));
}

/** 会话内命令在补全里的条目：名字、说明、参数的写法和参数的候选。 */
export function slashCommands(choices: CommandChoices): SlashCommand[] {
	return commands.map((command) => {
		const candidates = command.choices;
		return {
			name: command.name,
			description: command.description,
			...(command.argumentHint === undefined
				? {}
				: { argumentHint: command.argumentHint }),
			...(candidates === undefined
				? {}
				: {
						getArgumentCompletions: (typed: string) =>
							argumentItems(candidates(choices), typed),
					}),
		};
	});
}

// 光标之前正在写的提及：`@` 的位置要求和提交时拆分输入的一致
const mentionToken =
	/(?:^|[\s，。、；：！？（）「」『』【】《》“”‘’([{<])(@(?:"[^"]*|[^\s"]*))$/u;

function listDirectory(directory: string): Dirent[] {
	try {
		return readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		// 路径写到一半时目录多半不存在，没有候选就是了
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
			return [];
		}
		throw error;
	}
}

/**
 * `@` 提及的候选：光标所在的那一级目录里名字以已写的部分开头的文件和目录，目录在前。
 * `token` 是光标之前的 `@路径` 或 `@"路径`。
 */
export function mentionSuggestions(
	workspace: string,
	token: string,
): AutocompleteItem[] {
	const typed = token.slice(token.startsWith('@"') ? 2 : 1);
	const slash = typed.lastIndexOf("/");
	const directory = typed.slice(0, slash + 1);
	const name = typed.slice(slash + 1).toLowerCase();
	return listDirectory(resolve(workspace, directory))
		.filter(
			(entry) =>
				entry.name.toLowerCase().startsWith(name) &&
				// 隐藏文件要自己写出开头的点才列出来
				(name.startsWith(".") || !entry.name.startsWith(".")),
		)
		.sort(
			(a, b) =>
				Number(b.isDirectory()) - Number(a.isDirectory()) ||
				a.name.localeCompare(b.name),
		)
		.slice(0, maxSuggestions)
		.map((entry) => {
			const suffix = entry.isDirectory() ? "/" : "";
			return {
				value: mentionText(`${directory}${entry.name}${suffix}`),
				// 界面库按标签末尾的斜杠认目录：选中目录后不加空格，可以接着补全下一级
				label: `${entry.name}${suffix}`,
				...(directory === "" ? {} : { description: directory }),
			};
		});
}

/**
 * 输入框的补全：`/` 开头的会话内命令和它们的参数，`@` 提及的文件路径。界面库自带的 `@` 补全要靠
 * 外部的 `fd` 命令搜索，这里改成逐级列目录，不依赖用户装了什么。
 */
export class PromptAutocomplete extends CombinedAutocompleteProvider {
	readonly #workspace: string;

	constructor(choices: CommandChoices, workspace: string) {
		super(slashCommands(choices), workspace);
		this.#workspace = workspace;
	}

	override async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = lines[cursorLine].slice(0, cursorCol);
		const token = mentionToken.exec(before)?.[1];
		if (token === undefined) {
			return super.getSuggestions(lines, cursorLine, cursorCol, options);
		}
		const items = mentionSuggestions(this.#workspace, token);
		// 已经完整写出唯一的候选时不再给，Enter 直接提交
		if (
			items.length === 0 ||
			(items.length === 1 && items[0].value === token)
		) {
			return null;
		}
		return { items, prefix: token };
	}

	/**
	 * 补全列表是为当时光标前的文字算的，列表在按键之后异步刷新。按键成批到达时（机器忙、连接有延迟），
	 * 输入框挨个处理、中间来不及刷新，Enter 或 Tab 到的时候列表还是旧的：光标前不再以算列表时的前缀
	 * 结尾。套用它会把输入改成别的命令（`/quit` 变成 `/quisandbox`），所以这时不改输入。
	 */
	override applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (!lines[cursorLine].slice(0, cursorCol).endsWith(prefix)) {
			return { lines, cursorLine, cursorCol };
		}
		return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}
