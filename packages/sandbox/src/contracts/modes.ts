/** 内置的三种沙盒模式。 */
export const builtinSandboxModes = [
	"read-only",
	"workspace-write",
	"danger-full-access",
] as const;

/** 内置的沙盒模式。 */
export type BuiltinSandboxMode = (typeof builtinSandboxModes)[number];

/** 沙盒模式：内置的三种之一，或用户级配置里命名权限配置的名字。 */
export type SandboxMode = string;

/** 审批策略，从松到严排列。 */
export const approvalPolicies = ["on-request", "granular", "never"] as const;

/** 审批策略：需要越出沙盒时是否停下来问用户。 */
export type ApprovalPolicy = (typeof approvalPolicies)[number];

/** `granular` 审批策略的七个类别，名字照 Codex 的 `approval_policy.granular`，另加后两个。 */
export const granularCategories = [
	"sandbox_approval",
	"rules",
	"request_permissions",
	"skill_approval",
	"mcp_elicitations",
	"mcp_tools",
	"network",
] as const;

/** `granular` 审批策略的一个类别。 */
export type GranularCategory = (typeof granularCategories)[number];

/** `granular` 下每个类别是否询问；不询问的类别自动拒绝，原因写进工具结果。 */
export type GranularApproval = Readonly<Record<GranularCategory, boolean>>;

/**
 * 命名权限配置（`[permissions.<名字>]`），只能写在仓库以外的配置里。
 * 继承时保留受保护的路径，`write` 写到受保护的路径上时加载报错。
 */
export interface PermissionProfile {
	extends: "read-only" | "workspace-write";
	/** 按路径设读、写或禁止，路径是绝对路径或以 `~/` 开头。 */
	paths?: Readonly<Record<string, "read" | "write" | "deny">>;
	/** 按域名放行或禁止，写法同域名规则的 `host`。 */
	domains?: Readonly<Record<string, "allow" | "deny">>;
}
