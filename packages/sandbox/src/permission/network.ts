import { isLocalOrPrivateHost } from "../contracts/hosts.js";
import type {
	NetworkRequest,
	PermissionDecision,
} from "../contracts/requests.js";
import type { NetworkRule, RuleFile } from "../contracts/rules.js";
import { askOrDeny, type PolicyContext } from "./decide.js";

/** 域名规则是否匹配这个主机：精确相同，或者通配 `*.example.com` 匹配它的子域名（不含本域）。 */
function matches(rule: NetworkRule, host: string): boolean {
	return rule.host.startsWith("*.")
		? host.endsWith(rule.host.slice(1))
		: rule.host === host;
}

/**
 * 判断一次网络访问：本机和私有网段的地址、命中 `forbidden` 规则的直接拒绝；命中 `allow` 规则的
 * 放行；其余的按审批策略询问或拒绝（类别 `network`）。端口不参与匹配。
 */
export function decideNetwork(
	request: NetworkRequest,
	context: PolicyContext & { rules: RuleFile[] },
): PermissionDecision {
	const { host } = request;
	if (isLocalOrPrivateHost(host)) {
		return {
			action: "deny",
			reason: "policy",
			categories: ["network"],
			message: `Connections to local and private network addresses such as ${host} are always denied.`,
		};
	}
	const rules = context.rules
		.flatMap((file) => file.rules.network_rules)
		.filter((rule) => matches(rule, host));
	const forbidden = rules.find((rule) => rule.decision === "forbidden");
	if (forbidden !== undefined) {
		const { justification } = forbidden;
		return {
			action: "deny",
			reason: "forbidden_rule",
			message: `Access to ${host} is blocked by a \`forbidden\` permission rule.${justification === undefined ? "" : ` ${justification}`}`,
		};
	}
	if (rules.length > 0) return { action: "allow" };
	return askOrDeny("network", [`申请访问 ${host}:${request.port}`], context);
}

/**
 * 把域名规则编译成 sandbox-runtime 的名单：`forbidden` 进 `deniedDomains`，`allow` 进
 * `allowedDomains`。同一个域名两边都有时由 sandbox-runtime 按拒绝处理。
 */
export function networkLists(rules: RuleFile[]): {
	allowedDomains: string[];
	deniedDomains: string[];
} {
	const hosts = (decision: NetworkRule["decision"]) => [
		...new Set(
			rules
				.flatMap((file) => file.rules.network_rules)
				.filter((rule) => rule.decision === decision)
				.map((rule) => rule.host),
		),
	];
	return { allowedDomains: hosts("allow"), deniedDomains: hosts("forbidden") };
}
