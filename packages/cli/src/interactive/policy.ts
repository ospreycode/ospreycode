import type { GranularApproval, SessionConfig } from "@ospreycode/agent-host";
import type { ApprovalPolicy } from "./types.js";

/** 审批策略和各自的说明，从松到严；取值和 `--approval` 接受的相同。 */
export const approvalPolicies: readonly {
	policy: ApprovalPolicy;
	description: string;
}[] = [
	{ policy: "on-request", description: "需要批准的动作都先询问" },
	{
		policy: "granular",
		description: "按类别决定是询问还是直接拒绝，选中后逐类设置",
	},
	{
		policy: "never",
		description: "从不询问：需要批准的动作直接拒绝，权限规则放行的照常执行",
	},
];

/** `granular` 的一个类别。 */
export type GranularCategory = keyof GranularApproval;

/** `granular` 的七个类别各管哪些询问，按配置里的顺序。 */
export const granularCategories: Readonly<Record<GranularCategory, string>> = {
	sandbox_approval: "越界申请和内置的危险命令判断",
	rules: "命中 prompt 权限规则的动作",
	request_permissions: "模型用权限申请工具申请更多的权限",
	skill_approval: "运行 skill 带的脚本",
	mcp_elicitations: "MCP server 向用户提问",
	mcp_tools: "调用 MCP 工具",
	network: "访问没有放行的域名",
};

/**
 * 逐类设置打开时各类别的取值。策略已经是 `granular` 时是它现在的七个类别；否则是当前策略的等效值
 * （`on-request` 都询问，`never` 都直接拒绝）：原样应用的话，换过去的那一刻行为不变。
 */
export function currentGranular(
	config: Pick<SessionConfig, "approvalPolicy" | "granular">,
): Record<GranularCategory, boolean> {
	const { granular } = config;
	if (granular !== undefined) return { ...granular };
	const ask = config.approvalPolicy === "on-request";
	const table = {} as Record<GranularCategory, boolean>;
	for (const category of Object.keys(granularCategories)) {
		table[category as GranularCategory] = ask;
	}
	return table;
}

/** 一句话写出各类别是询问还是直接拒绝。 */
export function describeGranular(table: GranularApproval): string {
	const categories = Object.keys(granularCategories) as GranularCategory[];
	const asked = categories.filter((category) => table[category]);
	const denied = categories.filter((category) => !table[category]);
	return [
		...(asked.length === 0 ? [] : [`询问 ${asked.join("、")}`]),
		...(denied.length === 0 ? [] : [`直接拒绝 ${denied.join("、")}`]),
	].join("；");
}
