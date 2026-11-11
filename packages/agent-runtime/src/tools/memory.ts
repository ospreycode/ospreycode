import { readFile } from "node:fs/promises";
import Type, { type Static } from "typebox";
import type { RuntimeChannel } from "../channel/open.js";
import type { MemoryProposeParams } from "../channel/protocol.js";
import type { ToolSpec } from "../contracts/index.js";
import { renderMemoryEntries } from "../instructions/memory-context.js";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { resolveTarget, sha256, ToolFailure, text } from "./files.js";

const closed = { additionalProperties: false } as const;

/** `memory_propose` 的参数。 */
export const memoryProposeArgumentsSchema = Type.Object(
	{
		scope: Type.Union([Type.Literal("project"), Type.Literal("user")], {
			description:
				'"project" for knowledge about this repository. "user" only for the user\'s own preferences and working habits that the user stated and that apply across projects.',
		}),
		kind: Type.Union([
			Type.Literal("fact"),
			Type.Literal("preference"),
			Type.Literal("decision"),
			Type.Literal("lesson"),
		]),
		title: Type.String({
			description:
				"One line, at most 120 characters, specific enough to judge relevance at a glance.",
		}),
		body: Type.String({
			description:
				"At most 2000 characters: what was learned, when it applies, and the basis (verified by running it, stated by the user, or inferred). Quote commands, paths and error messages exactly.",
		}),
		replaces: Type.Optional(
			Type.String({
				description:
					"Id of the existing memory this one corrects; once confirmed it becomes that memory's new version.",
			}),
		),
		files: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String({
							description: "Absolute, or relative to the workspace root.",
						}),
						line: Type.Optional(Type.Integer({ minimum: 1 })),
					},
					closed,
				),
				{
					description:
						"Files the memory refers to. They are hashed now so a later session can tell whether they changed.",
				},
			),
		),
	},
	closed,
);

/** `memory_propose` 的参数。 */
export type MemoryProposeArguments = Static<
	typeof memoryProposeArgumentsSchema
>;

/** `memory_search` 的参数。 */
export const memorySearchArgumentsSchema = Type.Object(
	{
		query: Type.String({
			description:
				"A few keywords, matched as case-insensitive substrings of titles and bodies.",
		}),
	},
	closed,
);

/** `memory_search` 的参数。 */
export type MemorySearchArguments = Static<typeof memorySearchArgumentsSchema>;

/** `memory_read` 的参数。 */
export const memoryReadArgumentsSchema = Type.Object(
	{
		id: Type.String({
			description: "The id of the memory, as shown in the memory index.",
		}),
	},
	closed,
);

/** `memory_read` 的参数。 */
export type MemoryReadArguments = Static<typeof memoryReadArgumentsSchema>;

const proposeSpec: ToolSpec = {
	declaration: {
		name: "memory_propose",
		description:
			"Propose a long-term memory for future sessions; it takes effect only after the user confirms it. Propose what a later session would otherwise have to rediscover: how the project is really built and tested, constraints and decisions with their reasons, approaches that failed and why, the user's stable preferences. A few precise memories are worth more than many vague ones. Do not propose unverified guesses, or what the repository already shows, including what the rule files say. To correct an existing memory, give its id in `replaces`.",
		parameters: { ...memoryProposeArgumentsSchema },
	},
	read_only: false,
	idempotent: true,
	concurrent: false,
	executor: "runtime",
};

const searchSpec: ToolSpec = {
	declaration: {
		name: "memory_search",
		description:
			"Search the long-term memories in effect for this project and this user; returns the best matches with their bodies and sources. Memories can be out of date: check a result against the files it refers to before relying on it.",
		parameters: { ...memorySearchArgumentsSchema },
	},
	read_only: true,
	idempotent: true,
	concurrent: true,
	executor: "runtime",
};

const readSpec: ToolSpec = {
	declaration: {
		name: "memory_read",
		description:
			"Read the body and the sources of one long-term memory by its id. Check it against the files it refers to before relying on it.",
		parameters: { ...memoryReadArgumentsSchema },
	},
	read_only: true,
	idempotent: true,
	concurrent: true,
	executor: "runtime",
};

/**
 * 记忆工具的声明，只给主 agent。不在 `toolRegistry` 里：启用哪几个由 Host 按这个 session 的
 * 记忆选项决定，配置文件的 `[tools]` 不能开关它们。
 */
export const memoryToolRegistry: ReadonlyMap<string, ToolSpec> = new Map(
	[proposeSpec, searchSpec, readSpec].map((spec) => [
		spec.declaration.name,
		spec,
	]),
);

/**
 * 记忆工具：和文件工具一样先向 Host 登记，允许后经通道的 `memory/*` 取内容或提交候选。
 * 记忆库在 Host 一侧，沙盒里读不到。
 */
export function memoryTools(channel: RuntimeChannel): LocalTool[] {
	const propose: LocalTool<MemoryProposeArguments> = {
		spec: proposeSpec,
		schema: memoryProposeArgumentsSchema,
		async prepare(args, context) {
			// 引用文件的内容哈希在沙盒里算：Host 不读仓库的源文件
			const files: MemoryProposeParams["files"] = [];
			for (const file of args.files ?? []) {
				const path = await resolveTarget(file.path, context.workspace);
				files.push({
					path,
					...(file.line === undefined ? {} : { line: file.line }),
					sha256: sha256(await readFile(path)),
				});
			}
			return {
				async run() {
					const result = await channel.request("memory/propose", {
						scope: args.scope,
						kind: args.kind,
						title: args.title,
						body: args.body,
						...(args.replaces === undefined ? {} : { replaces: args.replaces }),
						files,
					});
					if (!result.recorded) throw new ToolFailure(result.reason);
					return text(
						`Proposed as [${result.id}]. It is not in effect yet: the user decides whether to confirm it.`,
					);
				},
			};
		},
	};
	const search: LocalTool<MemorySearchArguments> = {
		spec: searchSpec,
		schema: memorySearchArgumentsSchema,
		async prepare(args) {
			return {
				async run(_signal, toolCallId) {
					const { memories } = await channel.request("memory/search", {
						query: args.query,
						tool_call_id: toolCallId,
					});
					return text(
						memories.length === 0
							? "No memory in effect matches."
							: await renderMemoryEntries(memories),
					);
				},
			};
		},
	};
	const read: LocalTool<MemoryReadArguments> = {
		spec: readSpec,
		schema: memoryReadArgumentsSchema,
		async prepare(args) {
			return {
				async run(_signal, toolCallId) {
					const { memory } = await channel.request("memory/read", {
						id: args.id,
						tool_call_id: toolCallId,
					});
					if (memory === null) {
						throw new ToolFailure(
							`No memory in effect has the id ${args.id}. It may have been retired, marked expired or deleted.`,
						);
					}
					return text(await renderMemoryEntries([memory]));
				},
			};
		},
	};
	return [propose, search, read];
}
