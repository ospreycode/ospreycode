import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** 显示时一行的色调，由界面换成颜色。 */
export type Tone = "plain" | "dim" | "added" | "removed" | "hunk";

/** 带色调的一行。 */
export interface DetailLine {
	text: string;
	tone: Tone;
}

/**
 * 模型、命令和文件里来的文字在显示之前去掉终端控制序列和控制字符：它们原样写到终端上会移动
 * 光标、改写已经显示的内容。制表符换成空格，回车当作换行。
 */
export function sanitize(text: string): string {
	return (
		stripTerminalSequences(text)
			.replaceAll("\r\n", "\n")
			.replaceAll("\r", "\n")
			.replaceAll("\t", "    ")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: 要去掉的就是控制字符
			.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
	);
}

/** 压成一行，过长的截断。 */
export function brief(text: string, limit = 200): string {
	const line = sanitize(text).replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 耗时：不到一分钟写秒，往上写分和秒。 */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes < 60
		? `${minutes}m${seconds % 60}s`
		: `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** 费用（美元）：不到一美分的保留四位小数。 */
export function formatUsd(amount: number): string {
	return `$${amount.toFixed(amount < 0.01 ? 4 : 2)}`;
}

/** 至多留下开头的 `limit` 行，省掉的行数另写一行。 */
export function headLines(lines: readonly string[], limit: number): string[] {
	if (lines.length <= limit) return [...lines];
	return [...lines.slice(0, limit), `… 还有 ${lines.length - limit} 行`];
}

/** 统一 diff 的各行按开头的符号定色调。 */
export function diffLines(diff: string): DetailLine[] {
	const lines = sanitize(diff).split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((text) => {
		if (text.startsWith("+++") || text.startsWith("---")) {
			return { text, tone: "hunk" };
		}
		if (text.startsWith("@@")) return { text, tone: "hunk" };
		if (text.startsWith("+")) return { text, tone: "added" };
		if (text.startsWith("-")) return { text, tone: "removed" };
		return { text, tone: "dim" };
	});
}

/** 一段文字的每一行前面加上符号，当作 diff 里加上或删去的行。 */
export function markedLines(
	text: string,
	tone: "added" | "removed",
): DetailLine[] {
	const lines = sanitize(text).split("\n");
	if (lines.at(-1) === "") lines.pop();
	const mark = tone === "added" ? "+" : "-";
	return lines.map((line) => ({ text: `${mark}${line}`, tone }));
}

/**
 * 模型写出的工具参数：是 JSON 对象时返回它，不是合法的 JSON（模型可能写错）或不是对象时为空，
 * 由调用方照原文显示。
 */
export function parseArguments(
	raw: string,
): Record<string, unknown> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * 一次工具调用的参数要点：命令原文，搜索的模式（后面是路径和 glob），或者路径；都没有时是压成
 * 一行的参数原文，一个参数也没写时为空。
 */
export function toolSummary(rawArguments: string): string {
	const args = parseArguments(rawArguments);
	if (typeof args?.command === "string") return `$ ${sanitize(args.command)}`;
	if (typeof args?.pattern === "string") {
		// 只显示路径看不出找的是什么
		return [
			`/${args.pattern}/${args.ignore_case === true ? "i" : ""}`,
			args.path,
			args.glob,
		]
			.flatMap((part) => (typeof part === "string" ? [sanitize(part)] : []))
			.join(" ");
	}
	if (typeof args?.path === "string") return sanitize(args.path);
	if (args !== undefined && Object.keys(args).length === 0) return "";
	return brief(rawArguments);
}
