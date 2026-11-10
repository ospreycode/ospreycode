import type {
	McpToolRequest,
	PermissionDecision,
} from "../contracts/requests.js";
import type { RuleFile } from "../contracts/rules.js";
import { askOrDeny, type PolicyContext } from "./decide.js";

/**
 * 判断一次 MCP 工具调用。MCP 工具在 server 自己的进程或远程服务里执行，沙盒管不到，所以默认
 * 每次询问（类别 `mcp_tools`）：
 *
 * - 命中 `forbidden` 规则的拒绝。
 * - 命中 `prompt` 规则的询问，理由写进 `reasons`。
 * - 命中 `allow` 规则的放行；`destructive` 为 true（server 明确标注了 `destructiveHint: true`）
 *   时仍然询问。
 *
 * 规则的 `tool` 不写时匹配这个 server 的全部工具；多条规则同时匹配时取最严的。
 */
export function decideMcpTool(
	request: McpToolRequest,
	context: PolicyContext & { rules: RuleFile[]; destructive: boolean },
): PermissionDecision {
	const called = `${request.server} 的 ${request.tool}`;
	const rules = context.rules
		.flatMap((file) => file.rules.mcp_rules)
		.filter(
			(rule) =>
				rule.server === request.server &&
				(rule.tool === undefined || rule.tool === request.tool),
		);
	const forbidden = rules.find((rule) => rule.decision === "forbidden");
	if (forbidden !== undefined) {
		const { justification } = forbidden;
		return {
			action: "deny",
			reason: "forbidden_rule",
			message: `The MCP tool \`${request.tool}\` of server \`${request.server}\` is blocked by a \`forbidden\` permission rule.${justification === undefined ? "" : ` ${justification}`}`,
		};
	}
	const prompts = rules.filter((rule) => rule.decision === "prompt");
	if (prompts.length > 0) {
		// 类别用 mcp_tools 而不是 rules：granular 的 rules 照 Codex 只管命令的 prompt 规则，
		// 用户关掉 mcp_tools 时要的是 MCP 工具一律不问，prompt 规则不应该让其中一部分又问起来
		return askOrDeny(
			"mcp_tools",
			prompts.map(
				(rule) =>
					rule.justification ?? `权限规则要求调用前询问：MCP 工具 ${called}`,
			),
			context,
		);
	}
	if (rules.length > 0 && !context.destructive) return { action: "allow" };
	return askOrDeny(
		"mcp_tools",
		[
			rules.length > 0
				? `MCP 工具 ${called} 被 server 标注为破坏性操作，每次调用都要询问`
				: `申请调用 MCP 工具 ${called}`,
		],
		context,
	);
}
