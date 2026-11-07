import type { AdditionalPermissions } from "./requests.js";

/** 规则的决定：不询问、每次执行前询问、直接拒绝。 */
export type RuleDecision = "allow" | "prompt" | "forbidden";

/** 命令规则（`[[rules]]`），字段和 Codex 的 `prefix_rule` 相同。 */
export interface CommandRule {
	/** 命令前缀，每个位置是一个词或几个候选词；第一个词只能写命令名。 */
	pattern: (string | string[])[];
	decision: RuleDecision;
	justification?: string;
	/** 加载时检查规则用：这些命令必须匹配。 */
	match?: string[];
	/** 加载时检查规则用：这些命令必须不匹配。 */
	not_match?: string[];
	/** 只用于 `allow`：申请的额外权限落在其中时免询问；路径可以以 `$WORKSPACE/` 开头。 */
	permissions?: AdditionalPermissions;
}

/** 域名规则（`[[network_rules]]`）。没放行的域名本来就会询问，所以没有 `prompt`。 */
export interface NetworkRule {
	/** 精确的域名、开头带 `*.` 的通配（只匹配子域名）或 IP 地址。 */
	host: string;
	decision: "allow" | "forbidden";
	justification?: string;
}

/** MCP 工具规则（`[[mcp_rules]]`）。 */
export interface McpRule {
	/** Host 分配的 server 标签。 */
	server: string;
	/** 不写表示整个 server。 */
	tool?: string;
	decision: RuleDecision;
	justification?: string;
}

/** 一组权限规则：内置的、用户级和仓库的 `rules/*.toml`、`--rules` 指定的文件。 */
export interface RuleSet {
	rules: CommandRule[];
	network_rules: NetworkRule[];
	mcp_rules: McpRule[];
}
