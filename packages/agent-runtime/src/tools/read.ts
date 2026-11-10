import { readFile } from "node:fs/promises";
import Type, { type Static } from "typebox";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { resolveTarget, sha256, ToolFailure, text } from "./files.js";
import {
	formatSize,
	maxReadBytes,
	maxReadLines,
	truncateHead,
} from "./truncate.js";

/** read 工具的参数。 */
export const readArgumentsSchema = Type.Object(
	{
		path: Type.String({
			description:
				"Path of the file to read, absolute or relative to the workspace root.",
		}),
		offset: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Line number to start reading from (1-indexed).",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Maximum number of lines to read.",
			}),
		),
	},
	{ additionalProperties: false },
);

/** read 工具的参数。 */
export type ReadArguments = Static<typeof readArgumentsSchema>;

/** 二进制文件的判断：开头这一段里有 NUL 字节。 */
const binaryProbeBytes = 8192;

/**
 * 一次读取给模型的内容：从 `offset` 行起，不超过 `limit` 行和单次的行数、字节上限，被截断或还有
 * 剩余时在末尾写明怎样续读。说明的写法照 pi-coding-agent 1.5.0 的 read 工具（MIT，
 * Copyright (c) 2025 Mario Zechner）。
 */
export function renderLines(
	lines: readonly string[],
	args: ReadArguments,
): string {
	const start = (args.offset ?? 1) - 1;
	if (lines.length === 0 && start === 0) return "[The file is empty.]";
	if (start >= lines.length) {
		throw new ToolFailure(
			`Offset ${args.offset} is beyond the end of the file (${lines.length} lines).`,
		);
	}
	const end =
		args.limit === undefined
			? lines.length
			: Math.min(start + args.limit, lines.length);
	const truncation = truncateHead(lines.slice(start, end));
	const first = start + 1;
	if (truncation.lines === 0) {
		const size = formatSize(Buffer.byteLength(lines[start] as string, "utf8"));
		return `[Line ${first} is ${size}, over the ${formatSize(maxReadBytes)} limit of one read. Read part of it with the shell tool: sed -n '${first}p' ${args.path} | head -c ${maxReadBytes}]`;
	}
	const last = start + truncation.lines;
	if (truncation.truncatedBy !== undefined) {
		const limit =
			truncation.truncatedBy === "lines"
				? `${maxReadLines} lines`
				: formatSize(maxReadBytes);
		return `${truncation.content}\n\n[Showing lines ${first}-${last} of ${lines.length} (${limit} limit). Use offset=${last + 1} to continue.]`;
	}
	if (last < lines.length) {
		return `${truncation.content}\n\n[${lines.length - last} more lines in the file. Use offset=${last + 1} to continue.]`;
	}
	return truncation.content;
}

/** read 工具：读文本文件，记下读到的内容，供之后的编辑核对。 */
export const readTool: LocalTool<ReadArguments> = {
	spec: {
		declaration: {
			name: "read",
			description: `Read a text file. Output is cut at ${maxReadLines} lines or ${formatSize(maxReadBytes)}, whichever comes first; continue with \`offset\` until you have what you need. Read a file before you edit or overwrite it.`,
			parameters: { ...readArgumentsSchema },
		},
		read_only: true,
		idempotent: true,
		concurrent: true,
		executor: "runtime",
	},
	schema: readArgumentsSchema,
	async prepare(args, context) {
		const path = await resolveTarget(args.path, context.workspace);
		return {
			async run() {
				const bytes = await readFile(path);
				if (bytes.subarray(0, binaryProbeBytes).includes(0)) {
					throw new ToolFailure(
						`${path} is a binary file. The read tool only shows text files.`,
					);
				}
				context.records.record(path, sha256(bytes));
				const lines = bytes.toString("utf8").split("\n");
				// 以换行结尾的文件，最后一个换行之后没有一行
				if (lines.at(-1) === "") lines.pop();
				return text(renderLines(lines, args));
			},
		};
	},
};
