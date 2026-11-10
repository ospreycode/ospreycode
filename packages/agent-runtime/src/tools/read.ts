import { readFile } from "node:fs/promises";
import type { ImageBlock, UserContent } from "@ospreycode/api/protocol";
import Type, { type Static } from "typebox";
import { imageSize } from "../context/estimate.js";
import { ImageError, scaleImage } from "../context/image.js";
import type { FileRecords } from "../tool-executor/file-records.js";
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
export const binaryProbeBytes = 8192;

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

function renderText(
	path: string,
	bytes: Buffer,
	args: ReadArguments,
	records: FileRecords,
): string {
	if (bytes.subarray(0, binaryProbeBytes).includes(0)) {
		throw new ToolFailure(
			`${path} is a binary file. The read tool only shows text files and images (PNG, JPEG, GIF, WebP).`,
		);
	}
	records.record(path, sha256(bytes));
	const lines = bytes.toString("utf8").split("\n");
	// 以换行结尾的文件，最后一个换行之后没有一行
	if (lines.at(-1) === "") lines.pop();
	return renderLines(lines, args);
}

/**
 * 文件头是不是 PNG、JPEG、GIF 或 WebP 的。按完整的签名比：以 "GIF" 这几个字母开头的文本文件
 * 不算图片。
 */
function isImage(bytes: Buffer): boolean {
	const head = bytes.subarray(0, 12).toString("latin1");
	return (
		head.startsWith("\x89PNG\r\n\x1a\n") ||
		head.startsWith("\xff\xd8\xff") ||
		head.startsWith("GIF87a") ||
		head.startsWith("GIF89a") ||
		(head.startsWith("RIFF") && head.slice(8) === "WEBP")
	);
}

function size(bytes: Uint8Array): string {
	const found = imageSize(bytes);
	if (found === undefined) throw new Error("通过了缩放的图片读不出尺寸");
	return `${found.width}x${found.height}`;
}

/**
 * 读一个文件给模型看：图片缩放成图片块，前面用一行文字写明格式和尺寸，其余的按文本读。是不是图片
 * 看文件头，不看扩展名：扩展名不对的图片照样能看，改了扩展名的别的文件不会被当成图片去解码。
 * `read` 工具和 `@` 提及的展开共用。
 */
export async function readContent(
	path: string,
	args: ReadArguments,
	records: FileRecords,
): Promise<UserContent[]> {
	const bytes = await readFile(path);
	if (!isImage(bytes)) return text(renderText(path, bytes, args, records));
	let image: ImageBlock;
	try {
		image = await scaleImage(bytes);
	} catch (error) {
		if (!(error instanceof ImageError)) throw error;
		throw new ToolFailure(
			`${path} is an image that cannot be shown: ${error.message}`,
		);
	}
	records.record(path, sha256(bytes));
	const shown = Buffer.from(image.data, "base64");
	// 模型按看到的图片说坐标，缩小过的要让它知道原来的尺寸
	const note = shown.equals(bytes)
		? `[Image, ${image.media_type}, ${size(shown)}.]`
		: `[Image, ${image.media_type}, scaled down from ${size(bytes)} to ${size(shown)}.]`;
	return [{ type: "text", text: note }, image];
}

/** read 工具：读文本文件和图片，记下读到的内容，供之后的编辑核对。 */
export const readTool: LocalTool<ReadArguments> = {
	spec: {
		declaration: {
			name: "read",
			description: `Read a text file or an image (PNG, JPEG, GIF, WebP). Text is cut at ${maxReadLines} lines or ${formatSize(maxReadBytes)}, whichever comes first; continue with \`offset\` until you have what you need. An image is returned as an image, scaled down when it is large; \`offset\` and \`limit\` do not apply to it. Read a file before you edit or overwrite it.`,
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
				return readContent(path, args, context.records);
			},
		};
	},
};
