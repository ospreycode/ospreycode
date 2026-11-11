import Type, { type Static } from "typebox";
import type { RuntimeChannel } from "../channel/open.js";
import type { ToolSpec } from "../contracts/index.js";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { ToolFailure, text } from "./files.js";

/** `skill_load` 的参数。 */
export const skillLoadArgumentsSchema = Type.Object(
	{
		name: Type.String({
			description: "The name of the skill, exactly as listed in <skills>.",
		}),
	},
	{ additionalProperties: false },
);

/** `skill_load` 的参数。 */
export type SkillLoadArguments = Static<typeof skillLoadArgumentsSchema>;

/**
 * `skill_load` 的声明。不在 `toolRegistry` 里：有启用的 skill 时由 Host 加进启用的工具，
 * 配置文件的 `[tools]` 不能开关它。
 */
export const skillLoadTool: ToolSpec = {
	declaration: {
		name: "skill_load",
		description:
			"Load the full instructions of a skill listed in <skills>. Load a skill before starting a task that its description matches, then follow its instructions. The result names the skill's directory; scripts and files the instructions mention are relative to it. Reading a SKILL.md file with the read tool does not load the skill: only this tool returns the content the user has approved.",
		parameters: { ...skillLoadArgumentsSchema },
	},
	read_only: true,
	idempotent: true,
	concurrent: true,
	executor: "runtime",
};

/**
 * `skill_load`：和文件工具一样先向 Host 登记，允许后经通道的 `skill/load` 取内容。内容由 Host
 * 读取并核对哈希：模型读到的是用户确认过的那一份，不是 agent 沙盒里此刻的文件。
 */
export function skillLoadLocalTool(
	channel: RuntimeChannel,
): LocalTool<SkillLoadArguments> {
	return {
		spec: skillLoadTool,
		schema: skillLoadArgumentsSchema,
		async prepare(args) {
			return {
				async run() {
					const result = await channel.request("skill/load", {
						name: args.name,
					});
					if (!result.loaded) throw new ToolFailure(result.reason);
					return text(result.content);
				},
			};
		},
	};
}
