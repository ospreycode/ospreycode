import { readdir } from "node:fs/promises";
import Type, { type Static } from "typebox";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { resolveTarget, text } from "./files.js";
import {
	formatSize,
	maxReadBytes,
	maxReadLines,
	truncateHead,
} from "./truncate.js";

/** ls 工具的参数。 */
export const lsArgumentsSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					"Directory to list, absolute or relative to the workspace root. Defaults to the workspace root.",
			}),
		),
	},
	{ additionalProperties: false },
);

/** ls 工具的参数。 */
export type LsArguments = Static<typeof lsArgumentsSchema>;

/**
 * 目录下一层的列表，每行一个名字，按名字排序：子目录以 `/` 结尾，符号链接以 `@` 结尾（不看它指向
 * 哪里），隐藏文件也在里面。超过读文件的单次上限时只给前一段并注明总数。`ls` 工具和 `@` 提及目录
 * 共用。
 */
export async function listDirectory(path: string): Promise<string> {
	const entries = (await readdir(path, { withFileTypes: true }))
		.map((entry) =>
			entry.isDirectory()
				? `${entry.name}/`
				: entry.isSymbolicLink()
					? `${entry.name}@`
					: entry.name,
		)
		.sort();
	if (entries.length === 0) return "[The directory is empty.]";
	const truncation = truncateHead(entries);
	return truncation.truncatedBy === undefined
		? truncation.content
		: `${truncation.content}\n\n[Showing the first ${truncation.lines} of ${entries.length} entries. Use the shell tool to see the rest.]`;
}

/** ls 工具：列出一个目录下的一层。 */
export const lsTool: LocalTool<LsArguments> = {
	spec: {
		declaration: {
			name: "ls",
			description: `List the entries of a directory, one name per line, sorted by name. Directories end with \`/\` and symbolic links with \`@\`; hidden entries are included and ignore rules do not apply. The list is cut at ${maxReadLines} entries or ${formatSize(maxReadBytes)}, whichever comes first.`,
			parameters: { ...lsArgumentsSchema },
		},
		read_only: true,
		idempotent: true,
		concurrent: true,
		executor: "runtime",
	},
	schema: lsArgumentsSchema,
	async prepare(args, context) {
		const path = await resolveTarget(args.path ?? ".", context.workspace);
		return {
			async run() {
				return text(await listDirectory(path));
			},
		};
	},
};
