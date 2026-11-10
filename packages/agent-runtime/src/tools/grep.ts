import type { Dirent } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import Type, { type Static } from "typebox";
import type { LocalTool } from "../tool-executor/local-tool.js";
import {
	isFileSystemError,
	isInside,
	resolveTarget,
	ToolFailure,
	text,
} from "./files.js";
import {
	globMatcher,
	type IgnoreFile,
	isIgnored,
	parseIgnore,
} from "./ignore.js";
import { binaryProbeBytes } from "./read.js";
import { formatSize, maxReadBytes } from "./truncate.js";

/** 一次搜索最多给模型的匹配行数（照 pi-coding-agent 的 grep 工具的默认值）。 */
const maxGrepMatches = 100;

/** 匹配行最多给出的字符数：压缩过的文件一行就能占满输出的上限。 */
const maxGrepLineChars = 500;

/** 超过这个大小的文件不搜：文件整个读进内存再按行匹配。 */
const maxGrepFileBytes = 10 * 1024 * 1024;

/** 没有搜的路径最多列出几个，其余只给个数。 */
const maxListedSkips = 10;

/** grep 工具的参数。 */
export const grepArgumentsSchema = Type.Object(
	{
		pattern: Type.String({
			minLength: 1,
			description:
				"Regular expression in JavaScript syntax, matched against each line. Escape special characters to search for literal text.",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"File or directory to search, absolute or relative to the workspace root. Defaults to the workspace root.",
			}),
		),
		glob: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Only search files whose path matches this glob, such as `*.ts`, `src/**/*.test.ts` or `*.{ts,tsx}`. A glob without `/` matches the file name in any directory; one with `/` is relative to the searched directory.",
			}),
		),
		ignore_case: Type.Optional(
			Type.Boolean({ description: "Match letters regardless of case." }),
		),
	},
	{ additionalProperties: false },
);

/** grep 工具的参数。 */
export type GrepArguments = Static<typeof grepArgumentsSchema>;

/** 一次搜索的条件和到目前为止的结果。 */
interface Search {
	regex: RegExp;
	/** `glob` 参数：只搜相对搜索目录的路径匹配它的文件。 */
	include: RegExp | undefined;
	workspace: string;
	signal: AbortSignal;
	/** 给模型的匹配行。 */
	lines: string[];
	/** `lines` 用换行连起来的字节数。 */
	bytes: number;
	/** 因为哪一项上限停了下来；没有停时为空。 */
	stopped?: "lines" | "bytes";
	/** 没有搜的路径和原因。 */
	skipped: string[];
}

/** 给模型看的路径：工作区里的相对工作区根，能直接交给 `read`。 */
function shown(path: string, workspace: string): string {
	const inside = relative(workspace, path);
	return isInside(path, workspace) && inside !== "" ? inside : path;
}

/** 文件系统报告的错误记成没有搜的路径，其余的错误照常抛出。 */
function skip(search: Search, path: string, error: unknown): void {
	if (!isFileSystemError(error)) throw error;
	search.skipped.push(`${shown(path, search.workspace)} (${error.code})`);
}

/** 要搜的文件读出来的样子：文本的全部字节，或者不搜的原因。 */
type Loaded =
	| { kind: "text"; bytes: Buffer }
	| { kind: "binary" }
	| { kind: "too_large" };

async function load(path: string): Promise<Loaded> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		if (size <= maxGrepFileBytes) {
			const bytes = await file.readFile();
			return bytes.subarray(0, binaryProbeBytes).includes(0)
				? { kind: "binary" }
				: { kind: "text", bytes };
		}
		// 太大的二进制文件不用报告：它本来就不搜
		const probe = Buffer.alloc(binaryProbeBytes);
		const { bytesRead } = await file.read(probe, 0, probe.length, 0);
		return probe.subarray(0, bytesRead).includes(0)
			? { kind: "binary" }
			: { kind: "too_large" };
	} finally {
		await file.close();
	}
}

const tooLarge = `larger than ${formatSize(maxGrepFileBytes)}`;

function cut(line: string): string {
	if (line.length <= maxGrepLineChars) return line;
	// 不从代理对中间切开：半个代理对不是合法的文字
	const last = line.charCodeAt(maxGrepLineChars - 1);
	const end =
		last >= 0xd800 && last <= 0xdbff ? maxGrepLineChars - 1 : maxGrepLineChars;
	return `${line.slice(0, end)} [line cut at ${maxGrepLineChars} characters]`;
}

/** 在一个文件的内容里按行匹配，行号和 `read` 的一致。到了上限就记下原因并停止。 */
function searchText(search: Search, path: string, bytes: Buffer): void {
	const name = shown(path, search.workspace);
	const lines = bytes.toString("utf8").split("\n");
	// 以换行结尾的文件，最后一个换行之后没有一行
	if (lines.at(-1) === "") lines.pop();
	for (const [index, raw] of lines.entries()) {
		// 行尾的 CR 和文件开头的 BOM 不是这一行的内容，`^` 和 `$` 不该被它们挡住
		let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (index === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
		if (!search.regex.test(line)) continue;
		if (search.lines.length === maxGrepMatches) {
			search.stopped = "lines";
			return;
		}
		const entry = `${name}:${index + 1}:${cut(line)}`;
		// 除第一行外，每行前面有一个换行符
		const size =
			Buffer.byteLength(entry, "utf8") + (search.lines.length > 0 ? 1 : 0);
		if (search.bytes + size > maxReadBytes) {
			search.stopped = "bytes";
			return;
		}
		search.lines.push(entry);
		search.bytes += size;
	}
}

/** 一个目录里的 `.gitignore`；没有时为空，读不了时记成没有搜的路径。 */
async function readIgnore(
	search: Search,
	directory: string,
): Promise<IgnoreFile[]> {
	const path = join(directory, ".gitignore");
	try {
		return [{ directory, rules: parseIgnore(await readFile(path, "utf8")) }];
	} catch (error) {
		if (isFileSystemError(error) && error.code === "ENOENT") return [];
		skip(search, path, error);
		return [];
	}
}

/**
 * 搜索起点所在仓库的根目录：从它往上第一个有 `.git` 的目录；不在仓库里时为空。看不了的目录
 * （没有权限、被沙盒拦下）当作没有 `.git`。
 */
async function repositoryRoot(directory: string): Promise<string | undefined> {
	for (let current = directory; ; current = dirname(current)) {
		try {
			await lstat(join(current, ".git"));
			return current;
		} catch (error) {
			if (!isFileSystemError(error)) throw error;
		}
		if (dirname(current) === current) return undefined;
	}
}

/** 搜索起点之上、到仓库根目录为止各级目录里的 `.gitignore`，从浅到深。 */
async function inheritedIgnores(
	search: Search,
	root: string,
): Promise<IgnoreFile[]> {
	const top = await repositoryRoot(root);
	if (top === undefined) return [];
	const directories: string[] = [];
	for (let current = root; current !== top; current = dirname(current)) {
		directories.unshift(dirname(current));
	}
	const files = await Promise.all(
		directories.map((directory) => readIgnore(search, directory)),
	);
	return files.flat();
}

/**
 * 搜一个目录：按名字的顺序逐个处理，子目录就地往下走。不进 `.git` 和被忽略的目录，不跟随
 * 符号链接，不搜管道、设备这类特殊文件。`inherited` 是上级目录的 `.gitignore`。
 */
async function searchDirectory(
	search: Search,
	root: string,
	directory: string,
	entries: Dirent[],
	inherited: readonly IgnoreFile[],
): Promise<void> {
	const ignores = entries.some(
		(entry) => entry.name === ".gitignore" && entry.isFile(),
	)
		? [...inherited, ...(await readIgnore(search, directory))]
		: inherited;
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		if (search.stopped !== undefined) return;
		search.signal.throwIfAborted();
		const path = join(directory, entry.name);
		if (entry.name === ".git") continue;
		if (entry.isDirectory()) {
			if (isIgnored(ignores, path, true)) continue;
			let children: Dirent[];
			try {
				children = await readdir(path, { withFileTypes: true });
			} catch (error) {
				skip(search, path, error);
				continue;
			}
			await searchDirectory(search, root, path, children, ignores);
		} else if (entry.isFile()) {
			if (isIgnored(ignores, path, false)) continue;
			if (search.include?.test(relative(root, path)) === false) continue;
			let loaded: Loaded;
			try {
				loaded = await load(path);
			} catch (error) {
				skip(search, path, error);
				continue;
			}
			if (loaded.kind === "text") {
				searchText(search, path, loaded.bytes);
			} else if (loaded.kind === "too_large") {
				search.skipped.push(`${shown(path, search.workspace)} (${tooLarge})`);
			}
		}
	}
}

/** 搜 `root`（文件或目录），结果记在 `search` 里。`root` 本身搜不了时抛出。 */
async function searchTarget(search: Search, root: string): Promise<void> {
	const target = await stat(root);
	if (target.isDirectory()) {
		const entries = await readdir(root, { withFileTypes: true });
		const inherited = await inheritedIgnores(search, root);
		await searchDirectory(search, root, root, entries, inherited);
		return;
	}
	// 打开管道会一直等到另一头有人写
	if (!target.isFile()) {
		throw new ToolFailure(`${root} is not a file or a directory.`);
	}
	const loaded = await load(root);
	if (loaded.kind === "binary") {
		throw new ToolFailure(
			`${root} is a binary file. The grep tool only searches text files.`,
		);
	}
	if (loaded.kind === "too_large") {
		throw new ToolFailure(
			`${root} is ${tooLarge}. Search it with the shell tool.`,
		);
	}
	searchText(search, root, loaded.bytes);
}

/** 给模型的结果：匹配行，之后是到了上限和没有搜的路径的说明。 */
function render(search: Search): string {
	const notes: string[] = [];
	if (search.stopped !== undefined) {
		const limit =
			search.stopped === "lines"
				? `${maxGrepMatches} lines`
				: formatSize(maxReadBytes);
		notes.push(
			`[Showing the first ${search.lines.length} matching lines (${limit} limit); more lines match. Narrow the pattern, path or glob to see them.]`,
		);
	}
	if (search.skipped.length > 0) {
		const more = search.skipped.length - maxListedSkips;
		notes.push(
			`[Not searched: ${search.skipped.slice(0, maxListedSkips).join(", ")}${more > 0 ? `, and ${more} more` : ""}.]`,
		);
	}
	return [
		search.lines.length === 0 ? "No matches found." : search.lines.join("\n"),
		...notes,
	].join("\n\n");
}

/** 模型写的模式和 glob 编译成正则表达式；写错的把原因交给模型。 */
function compile(
	source: string,
	what: string,
	build: (source: string) => RegExp,
): RegExp {
	try {
		return build(source);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new ToolFailure(`Invalid ${what}: ${error.message}`);
	}
}

/** grep 工具：按行搜索一个文件，或者一个目录下的文本文件。 */
export const grepTool: LocalTool<GrepArguments> = {
	spec: {
		declaration: {
			name: "grep",
			description: `Search file contents for a regular expression and return the matching lines as \`path:line:text\`. Searches one file, or every text file under a directory, skipping \`.git\`, files ignored by \`.gitignore\`, binary files and files over ${formatSize(maxGrepFileBytes)}; symbolic links are not followed. Returns at most ${maxGrepMatches} matching lines or ${formatSize(maxReadBytes)}, whichever comes first, so narrow the pattern, \`path\` or \`glob\` when the result is cut. Use \`read\` with \`offset\` to see the lines around a match.`,
			parameters: { ...grepArgumentsSchema },
		},
		read_only: true,
		idempotent: true,
		concurrent: true,
		executor: "runtime",
	},
	schema: grepArgumentsSchema,
	async prepare(args, context) {
		// 不带 `u` 标志：模型常按别的正则写法转义，`u` 下会成语法错误
		const regex = compile(
			args.pattern,
			"pattern",
			(source) => new RegExp(source, args.ignore_case === true ? "i" : ""),
		);
		const include =
			args.glob === undefined
				? undefined
				: compile(args.glob, "glob", globMatcher);
		const root = await resolveTarget(args.path ?? ".", context.workspace);
		return {
			async run(signal) {
				const search: Search = {
					regex,
					include,
					workspace: context.workspace,
					signal,
					lines: [],
					bytes: 0,
					skipped: [],
				};
				await searchTarget(search, root);
				return text(render(search));
			},
		};
	},
};
