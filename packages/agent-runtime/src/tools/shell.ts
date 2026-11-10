import Type, { type Static } from "typebox";
import type { ToolSpec } from "../contracts/index.js";

const closed = { additionalProperties: false } as const;

/**
 * shell 工具的参数，照 Codex，另加后台命令的几项。Host 执行前按它校验模型写出的参数。
 * 根上只能是一个对象（各家模型的工具参数都这样要求），所以四种动作共用一组参数，各项在哪种动作下
 * 有效由 Host 检查。
 */
export const shellArgumentsSchema = Type.Object(
	{
		action: Type.Optional(
			Type.Union(
				[
					Type.Literal("run"),
					Type.Literal("status"),
					Type.Literal("write_stdin"),
					Type.Literal("stop"),
				],
				{
					description:
						"`run` (the default) runs `command`. The other actions work on background commands: `status` reports the one named by `background_id`, or lists all of them when `background_id` is omitted; `write_stdin` writes `stdin` to it; `stop` ends it.",
				},
			),
		),
		command: Type.Optional(
			Type.String({
				description: "The command to run with `bash -c`. Required for `run`.",
			}),
		),
		workdir: Type.Optional(
			Type.String({
				description:
					"Working directory. Defaults to the workspace root; relative paths are resolved against the workspace root. Must be an existing directory inside the workspace.",
			}),
		),
		timeout_ms: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 7_200_000,
				description:
					"Time limit in milliseconds. A foreground command defaults to 120000 and takes at most 600000; when the limit passes it is moved to the background and keeps running. A background command has no limit in an interactive session unless you give one; in a non-interactive run it defaults to 600000 and takes at most 7200000. A monitor defaults to 300000 and takes at most 1800000 (600000 in a non-interactive run).",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Run the command in the background and return its id at once. Use it for servers and other long-running commands. The command keeps running after the task ends; you get a notification when it ends, and its output is in a file you can read.",
			}),
		),
		monitor: Type.Optional(
			Type.Boolean({
				description:
					"Run the command in the background and get every line it prints as a notification, until it exits or its time limit passes. Use it to watch for events, such as new lines in a log.",
			}),
		),
		background_id: Type.Optional(
			Type.String({
				description:
					"The id of a background command, for `status`, `write_stdin` and `stop`.",
			}),
		),
		stdin: Type.Optional(
			Type.String({
				description:
					"Text for `write_stdin`, written as is: end it with a newline if the program reads lines. Only commands started with `background` have a stdin; they have no terminal.",
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
					'With `sandbox_permissions: with_additional_permissions` only: a command prefix the user may save as a rule so that similar commands are not asked again, such as ["npm", "test"].',
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
			"Run a shell command, in the foreground or in the background. Each command runs in its own sandbox, and the result tells which sandbox it ran in. If the sandbox blocks something the task needs, run the command again with `sandbox_permissions` to ask the user for the extra permissions. A foreground command that passes its time limit is moved to the background: the result gives its id and the output so far. Read the output of a background command from its output file with the read tool.",
		parameters: { ...shellArgumentsSchema },
	},
	read_only: false,
	idempotent: false,
	concurrent: false,
	executor: "host",
};
