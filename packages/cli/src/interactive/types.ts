import type {
	ApprovalAnswer,
	ApprovalRequested,
	ApprovalRequestedEvent,
	QueuedInput,
	SessionConfig,
} from "@ospreycode/agent-host";

export type {
	ApprovalAnswer,
	ApprovalPolicy,
	ReasoningEffort,
} from "@ospreycode/agent-host";
export type { ToolResult } from "../format/result.js";

// 下面这些类型定义在 sandbox、api 和 agent-runtime 包里，agent-host 的入口没有单独导出，
// CLI 又只依赖 agent-host：从用到它们的事件和配置的类型里取出来。

/** 模型清单的一个条目。 */
export type ModelEntry = SessionConfig["model"];

/** 工具调用和权限申请的询问。 */
export type ToolCallApproval = Extract<
	ApprovalRequested,
	{ kind: "tool_call" }
>;

/** 询问里要判断的动作：命令、文件改动、权限申请等。 */
export type PermissionRequest = ToolCallApproval["request"];

/** `request_permissions` 的申请。 */
export type PermissionsRequest = Extract<
	PermissionRequest,
	{ kind: "permissions" }
>;

/** 只批准 `request_permissions` 申请里的一部分时，批准的那些。 */
export type GrantedPermissions = NonNullable<
	Extract<ApprovalAnswer, { decision: "approve" }>["granted"]
>;

/** 询问可以保存成的命令规则。 */
export type CommandRule = NonNullable<ToolCallApproval["suggested_rule"]>;

/** 事件里的用户输入的一段：文字、提及的路径、图片或图片的引用。 */
export type InputBlock = QueuedInput["input"][number];

/** 带着公共字段的询问事件。 */
export type ApprovalEvent = ApprovalRequestedEvent;
