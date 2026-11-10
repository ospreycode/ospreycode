import Type, { type Static } from "typebox";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { prepareFileEdit } from "./file-edit.js";

/** write 工具的参数。 */
export const writeArgumentsSchema = Type.Object(
	{
		path: Type.String({
			description:
				"Path of the file to write, absolute or relative to the workspace root.",
		}),
		content: Type.String({ description: "The complete content of the file." }),
	},
	{ additionalProperties: false },
);

/** write 工具的参数。 */
export type WriteArguments = Static<typeof writeArgumentsSchema>;

/** write 工具：新建文件或整个覆盖已有的文件，上级目录不存在时一并创建。 */
export const writeTool: LocalTool<WriteArguments> = {
	spec: {
		declaration: {
			name: "write",
			description:
				"Create a file or overwrite it with new content. Parent directories are created as needed. Use it for new files and complete rewrites; read an existing file before you overwrite it.",
			parameters: { ...writeArgumentsSchema },
		},
		read_only: false,
		idempotent: true,
		concurrent: false,
		executor: "runtime",
	},
	schema: writeArgumentsSchema,
	prepare: (args, context) =>
		prepareFileEdit(
			args.path,
			context,
			() => Buffer.from(args.content, "utf8"),
			(path, written) => `Wrote ${written.length} bytes to ${path}.`,
		),
};
