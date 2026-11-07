import Type, { type Static } from "typebox";
import type { ToolSpec } from "../contracts/index.js";

const closed = { additionalProperties: false } as const;

/** shell 工具的参数，照 Codex。Host 执行前按它校验模型写出的参数。 */
export const shellArgumentsSchema = Type.Object(
	{
		command: Type.String({
			description: "The command to run with `bash -c`.",
		}),
		workdir: Type.Optional(
			Type.String({
				description:
					"Working directory. Defaults to the workspace root; relative paths are resolved against the workspace root. Must be an existing directory inside the workspace.",
			}),
		),
		timeout_ms: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 600_000,
				description: "Timeout in milliseconds. Defaults to 120000.",
			}),
		),
		sandbox_permissions: Type.Optional(
			Type.Union(
				[
					Type.Literal("use_default"),
					Type.Literal("with_additional_permissions"),
					Type.Literal("require_escalated"),
				],
				{
					description:
						"`use_default` runs the command in the current sandbox. `with_additional_permissions` adds only `additional_permissions` for this command; prefer it. `require_escalated` asks to lift the sandbox's file restrictions for this command when additional permissions are not enough. Both ask the user first.",
				},
			),
		),
		additional_permissions: Type.Optional(
			Type.Object(
				{
					file_system: Type.Optional(
						Type.Object(
							{
								read: Type.Optional(Type.Array(Type.String())),
								write: Type.Optional(Type.Array(Type.String())),
							},
							closed,
						),
					),
					unix_sockets: Type.Optional(Type.Array(Type.String())),
					local_binding: Type.Optional(Type.Boolean()),
				},
				{
					...closed,
					description:
						"Permissions added for this command only, with `sandbox_permissions: with_additional_permissions`. Paths are absolute.",
				},
			),
		),
		justification: Type.Optional(
			Type.String({
				description:
					"One sentence telling the user why the command needs more permissions.",
			}),
		),
		prefix_rule: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'A command prefix the user may save as a rule so that similar commands are not asked again, such as ["npm", "test"].',
			}),
		),
	},
	closed,
);

/** shell 工具的参数。 */
export type ShellArguments = Static<typeof shellArgumentsSchema>;

/** shell 工具：命令不在 agent 沙盒里运行，由 Host 按当时的策略单独启动命令沙盒执行。 */
export const shellTool: ToolSpec = {
	declaration: {
		name: "shell",
		description:
			"Run a shell command. Each command runs in its own sandbox, and the result tells which sandbox it ran in. If the sandbox blocks something the task needs, run the command again with `sandbox_permissions` to ask the user for the extra permissions.",
		parameters: { ...shellArgumentsSchema },
	},
	read_only: false,
	idempotent: false,
	concurrent: false,
	executor: "host",
};
