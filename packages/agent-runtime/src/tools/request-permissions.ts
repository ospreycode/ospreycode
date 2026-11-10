import Type, { type Static } from "typebox";
import type { ToolSpec } from "../contracts/index.js";

const closed = { additionalProperties: false } as const;

/** request_permissions 工具的参数。Host 执行前按它校验模型写出的参数。 */
export const requestPermissionsArgumentsSchema = Type.Object(
	{
		file_system: Type.Optional(
			Type.Object(
				{
					read: Type.Optional(
						Type.Array(Type.String(), {
							description: "Absolute paths to read for the rest of the task.",
						}),
					),
					write: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Absolute paths of existing files or directories to write for the rest of the task.",
						}),
					),
				},
				closed,
			),
		),
		network: Type.Optional(
			Type.Array(Type.String(), {
				description: "Hosts to reach for the rest of the task.",
			}),
		),
		justification: Type.Optional(
			Type.String({
				description: "One sentence telling the user why the task needs this.",
			}),
		),
	},
	closed,
);

/** request_permissions 工具的参数。 */
export type RequestPermissionsArguments = Static<
	typeof requestPermissionsArgumentsSchema
>;

/** request_permissions 工具：申请本任务内之后的命令和编辑共用的权限，由 Host 询问用户。 */
export const requestPermissionsTool: ToolSpec = {
	declaration: {
		name: "request_permissions",
		description:
			"Ask the user for permissions that last for the rest of the task. Use it when several commands or edits need the same paths outside the sandbox; for a single command, use the shell tool's `sandbox_permissions` instead. The user may grant only part of the request, and the result lists what was granted.",
		parameters: { ...requestPermissionsArgumentsSchema },
	},
	read_only: false,
	idempotent: false,
	concurrent: false,
	executor: "host",
};
