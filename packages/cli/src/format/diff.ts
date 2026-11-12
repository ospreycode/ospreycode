import { sanitize } from "./text.js";

/** unified diff 里的一行。 */
export interface DiffLine {
	kind: "context" | "added" | "removed";
	/** 行号：删去的行是改动前的，其余是改动后的。 */
	number: number;
	/** 这一行的内容，不含开头的符号，已经去掉终端控制序列。 */
	text: string;
}

/** 一个文件的改动。 */
export interface FileDiff {
	/** 文件头里的路径。 */
	path: string;
	/** 改动前没有这个文件。 */
	created: boolean;
	/** 改动前的内容不是文字，没有按行的差异。 */
	binary: boolean;
	added: number;
	removed: number;
	/** 各个改动块，每块是连着的几行。 */
	hunks: DiffLine[][];
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const binaryFiles = /^Binary files (.*) and \1 differ$/;

/**
 * 解析工具结果和询问里的 unified diff（Host 和 runtime 生成的那种写法：每个文件以 `---`、`+++`
 * 两行开头，新建的文件改动前写 `/dev/null`）。块里的行按块头写的行数取，内容以 `---` 开头的行不会
 * 被当成下一个文件的开头。
 */
export function parseDiff(diff: string): FileDiff[] {
	const lines = diff.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const files: FileDiff[] = [];
	let at = 0;
	while (at < lines.length) {
		const line = lines[at] as string;
		const binary = binaryFiles.exec(line);
		if (binary !== null) {
			files.push({
				path: sanitize(binary[1] as string),
				created: false,
				binary: true,
				added: 0,
				removed: 0,
				hunks: [],
			});
			at += 1;
			continue;
		}
		const next = lines[at + 1];
		if (line.startsWith("--- ") && next?.startsWith("+++ ")) {
			files.push({
				path: sanitize(next.slice(4)),
				created: line.slice(4) === "/dev/null",
				binary: false,
				added: 0,
				removed: 0,
				hunks: [],
			});
			at += 2;
			continue;
		}
		const header = hunkHeader.exec(line);
		const file = files.at(-1);
		if (header === null || file === undefined) {
			at += 1;
			continue;
		}
		let oldNumber = Number(header[1]);
		let newNumber = Number(header[3]);
		let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
		let newLeft = header[4] === undefined ? 1 : Number(header[4]);
		const hunk: DiffLine[] = [];
		at += 1;
		while ((oldLeft > 0 || newLeft > 0) && at < lines.length) {
			const body = lines[at] as string;
			const text = sanitize(body.slice(1));
			at += 1;
			if (body.startsWith("+")) {
				hunk.push({ kind: "added", number: newNumber, text });
				file.added += 1;
				newNumber += 1;
				newLeft -= 1;
			} else if (body.startsWith("-")) {
				hunk.push({ kind: "removed", number: oldNumber, text });
				file.removed += 1;
				oldNumber += 1;
				oldLeft -= 1;
			} else if (!body.startsWith("\\")) {
				hunk.push({ kind: "context", number: newNumber, text });
				oldNumber += 1;
				newNumber += 1;
				oldLeft -= 1;
				newLeft -= 1;
			}
		}
		file.hunks.push(hunk);
	}
	return files;
}

/** 改动的行数，写在标题后面。 */
export function diffStat(file: Pick<FileDiff, "added" | "removed">): string {
	return `(+${file.added} -${file.removed})`;
}

/** 排好版的一行：行号栏、符号和内容；`gap` 是两个改动块之间的分隔。 */
export type DiffRow =
	| { kind: DiffLine["kind"]; gutter: string; sign: string; text: string }
	| { kind: "gap"; gutter: string };

/**
 * 一个文件的改动排成带行号的行：行号右对齐成一栏，后面是 `+`、`-` 或空格，再是内容；改动块之间
 * 用 `⋮` 隔开。
 */
export function diffRows(file: FileDiff): DiffRow[] {
	const width = Math.max(
		1,
		...file.hunks.flat().map((line) => String(line.number).length),
	);
	const sign = { context: " ", added: "+", removed: "-" };
	return file.hunks.flatMap((hunk, index) => [
		...(index === 0
			? []
			: [{ kind: "gap" as const, gutter: "⋮".padStart(width) }]),
		...hunk.map((line) => ({
			kind: line.kind,
			gutter: String(line.number).padStart(width),
			sign: sign[line.kind],
			text: line.text,
		})),
	]);
}
