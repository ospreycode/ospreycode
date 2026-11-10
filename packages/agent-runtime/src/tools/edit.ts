import Type, { type Static } from "typebox";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { applyEdits } from "./edit-apply.js";
import { prepareFileEdit } from "./file-edit.js";
import { ToolFailure } from "./files.js";

/** edit 工具的参数。 */
export const editArgumentsSchema = Type.Object(
	{
		path: Type.String({
			description:
				"Path of the file to edit, absolute or relative to the workspace root.",
		}),
		edits: Type.Array(
			Type.Object(
				{
					old_text: Type.String({
						description:
							"Exact text to replace. It must appear exactly once in the file and must not overlap another edit in the same call.",
					}),
					new_text: Type.String({ description: "The replacement text." }),
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				description:
					"One or more replacements. Each one is matched against the original file, not against the result of the others. Merge changes to nearby lines into one edit.",
			},
		),
	},
	{ additionalProperties: false },
);

/** edit 工具的参数。 */
export type EditArguments = Static<typeof editArgumentsSchema>;

/** 按 UTF-8 解码，不合法的字节序列报错：换成替换字符再写回会破坏文件。BOM 留在内容里，写回时原样保留。 */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** edit 工具：在已有的文件里做一处或几处精确的文本替换。 */
export const editTool: LocalTool<EditArguments> = {
	spec: {
		declaration: {
			name: "edit",
			description:
				"Edit a file by exact text replacement. Every `old_text` must match one unique, non-overlapping region of the file as it is now. Read the file first, and batch the changes to one file into a single call.",
			parameters: { ...editArgumentsSchema },
		},
		read_only: false,
		idempotent: false,
		concurrent: false,
		executor: "runtime",
	},
	schema: editArgumentsSchema,
	prepare: (args, context) =>
		prepareFileEdit(
			args.path,
			context,
			(current, path) => {
				if (current === undefined) {
					throw new ToolFailure(
						`${path} does not exist. Use the write tool to create it.`,
					);
				}
				let content: string;
				try {
					content = utf8.decode(current);
				} catch (error) {
					if (!(error instanceof TypeError)) throw error;
					throw new ToolFailure(
						`${path} is not valid UTF-8, so the edit tool cannot change it.`,
					);
				}
				return Buffer.from(applyEdits(content, args.edits, path), "utf8");
			},
			(path) => `Replaced ${args.edits.length} block(s) in ${path}.`,
		),
};
