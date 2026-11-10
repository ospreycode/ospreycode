import { isAbsolute } from "node:path";
import { PermissionConfigError } from "../contracts/config.js";
import {
	InvalidHostError,
	isLocalOrPrivateHost,
	normalizeHostPattern,
} from "../contracts/hosts.js";
import type { AdditionalPermissions } from "../contracts/requests.js";
import type {
	CommandRule,
	McpRule,
	NetworkRule,
	RuleDecision,
	RuleFile,
	RuleSource,
} from "../contracts/rules.js";
import { exampleMatches } from "./command-rules.js";
import type { ShellParser } from "./shell.js";

function joinKey(parent: string, key: string): string {
	const part = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
	return parent === "" ? part : `${parent}.${part}`;
}

function table(value: unknown, key: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value instanceof Date
	) {
		throw new PermissionConfigError(key, "要是一个表");
	}
	return value as Record<string, unknown>;
}

/** 校验一个表，不认识的键报错；返回按键取值的函数，取到的键是它在文件里的位置。 */
function fields(value: unknown, key: string, known: readonly string[]) {
	const entries = table(value, key);
	const unknown = Object.keys(entries).find((name) => !known.includes(name));
	if (unknown !== undefined) {
		throw new PermissionConfigError(joinKey(key, unknown), "不认识的键");
	}
	return (name: string): [unknown, string] => [
		entries[name],
		joinKey(key, name),
	];
}

function list(value: unknown, key: string): unknown[] {
	if (!Array.isArray(value)) throw new PermissionConfigError(key, "要是数组");
	return value;
}

function text(value: unknown, key: string): string {
	if (typeof value !== "string" || value === "") {
		throw new PermissionConfigError(key, "要是非空的字符串");
	}
	return value;
}

function texts(value: unknown, key: string): string[] {
	return list(value, key).map((item, index) => text(item, `${key}[${index}]`));
}

/** 可选的字段：没写时结果里不带这个键。 */
function optional<Name extends string, Value>(
	name: Name,
	[value, key]: [unknown, string],
	parse: (value: unknown, key: string) => Value,
): { [K in Name]?: Value } {
	return (value === undefined ? {} : { [name]: parse(value, key) }) as {
		[K in Name]?: Value;
	};
}

/** `decision`：必须写明；仓库里的权限规则文件只能收紧。 */
function decision<Decision extends RuleDecision>(
	[value, key]: [unknown, string],
	allowed: readonly Decision[],
	source: RuleSource,
): Decision {
	if (!allowed.includes(value as Decision)) {
		throw new PermissionConfigError(key, `要是 ${allowed.join("、")} 之一`);
	}
	if (source === "repo" && value === "allow") {
		throw new PermissionConfigError(
			key,
			"仓库里的权限规则文件只能收紧，不能写 allow",
		);
	}
	return value as Decision;
}

function pattern(value: unknown, key: string): (string | string[])[] {
	const positions = list(value, key).map((position, index) => {
		const positionKey = `${key}[${index}]`;
		const candidates = Array.isArray(position)
			? texts(position, positionKey)
			: [text(position, positionKey)];
		if (candidates.length === 0) {
			throw new PermissionConfigError(positionKey, "候选词不能是空的");
		}
		if (index === 0 && candidates.some((name) => name.includes("/"))) {
			throw new PermissionConfigError(
				positionKey,
				"第一个词只能写命令名，不能写路径",
			);
		}
		return Array.isArray(position) ? candidates : candidates[0];
	});
	if (positions.length === 0) {
		throw new PermissionConfigError(key, "不能是空的");
	}
	return positions;
}

/** 规则声明的路径：绝对路径，或以 `$WORKSPACE/`、`~/` 开头。 */
function declaredPaths(value: unknown, key: string): string[] {
	return texts(value, key).map((path, index) => {
		if (
			!isAbsolute(path) &&
			!path.startsWith("$WORKSPACE/") &&
			!path.startsWith("~/")
		) {
			throw new PermissionConfigError(
				`${key}[${index}]`,
				"路径要写绝对路径，或以 $WORKSPACE/、~/ 开头",
			);
		}
		return path;
	});
}

function permissions(value: unknown, key: string): AdditionalPermissions {
	const field = fields(value, key, [
		"file_system",
		"unix_sockets",
		"local_binding",
	]);
	return {
		...optional("file_system", field("file_system"), (fileSystem, fsKey) => {
			const access = fields(fileSystem, fsKey, ["read", "write"]);
			return {
				...optional("read", access("read"), declaredPaths),
				...optional("write", access("write"), declaredPaths),
			};
		}),
		...optional("unix_sockets", field("unix_sockets"), texts),
		...optional(
			"local_binding",
			field("local_binding"),
			(binding, bindingKey) => {
				if (typeof binding !== "boolean") {
					throw new PermissionConfigError(bindingKey, "要是 true 或 false");
				}
				return binding;
			},
		),
	};
}

function commandRule(
	value: unknown,
	key: string,
	source: RuleSource,
	parser: ShellParser,
): CommandRule {
	const field = fields(value, key, [
		"pattern",
		"decision",
		"justification",
		"match",
		"not_match",
		"permissions",
	]);
	const rule: CommandRule = {
		pattern: pattern(...field("pattern")),
		decision: decision(
			field("decision"),
			["allow", "prompt", "forbidden"],
			source,
		),
		...optional("justification", field("justification"), text),
		...optional("match", field("match"), texts),
		...optional("not_match", field("not_match"), texts),
		...optional("permissions", field("permissions"), permissions),
	};
	if (rule.permissions !== undefined && rule.decision !== "allow") {
		throw new PermissionConfigError(
			joinKey(key, "permissions"),
			"只有 allow 规则能声明 permissions",
		);
	}
	for (const [name, expected] of [
		["match", true],
		["not_match", false],
	] as const) {
		for (const [index, example] of (rule[name] ?? []).entries()) {
			if (exampleMatches(rule, parser.parse(example)) !== expected) {
				throw new PermissionConfigError(
					`${joinKey(key, name)}[${index}]`,
					expected ? "规则没有匹配这个例子" : "规则匹配了这个不该匹配的例子",
				);
			}
		}
	}
	return rule;
}

function networkRule(
	value: unknown,
	key: string,
	source: RuleSource,
): NetworkRule {
	const field = fields(value, key, ["host", "decision", "justification"]);
	const [host, hostKey] = field("host");
	let normalized: string;
	try {
		normalized = normalizeHostPattern(text(host, hostKey));
	} catch (error) {
		if (!(error instanceof InvalidHostError)) throw error;
		throw new PermissionConfigError(hostKey, error.message);
	}
	const rule: NetworkRule = {
		host: normalized,
		decision: decision(field("decision"), ["allow", "forbidden"], source),
		...optional("justification", field("justification"), text),
	};
	if (rule.decision === "allow" && isLocalOrPrivateHost(normalized)) {
		throw new PermissionConfigError(
			hostKey,
			"本机和私有网段的地址一律拒绝，不能写 allow",
		);
	}
	return rule;
}

function mcpRule(value: unknown, key: string, source: RuleSource): McpRule {
	const field = fields(value, key, [
		"server",
		"tool",
		"decision",
		"justification",
	]);
	return {
		server: text(...field("server")),
		...optional("tool", field("tool"), text),
		decision: decision(
			field("decision"),
			["allow", "prompt", "forbidden"],
			source,
		),
		...optional("justification", field("justification"), text),
	};
}

/**
 * 校验一份解析后的权限规则文件（TOML 的解析由调用方做）。出错时抛出 `PermissionConfigError`，
 * `key` 是出错的位置，如 `rules[0].pattern[0]`。
 *
 * - 三种规则写在 `[[rules]]`、`[[network_rules]]` 和 `[[mcp_rules]]` 里，不认识的键报错。
 * - `decision` 必须写明；仓库来源的文件只能写 `prompt` 和 `forbidden`（域名规则只能 `forbidden`）。
 * - 命令规则的 `pattern` 第一个词只能是命令名；`match` 和 `not_match` 的例子当场核对；
 *   `permissions` 只用于 `allow`，路径写绝对路径或以 `$WORKSPACE/`、`~/` 开头。
 * - 域名规则的 `host` 规范成小写的 A-label，`allow` 不能写本机和私有网段的地址。
 */
export function parseRuleFile(
	value: unknown,
	options: { path: string; source: RuleSource; parser: ShellParser },
): RuleFile {
	const { source, parser } = options;
	const field = fields(value, "", ["rules", "network_rules", "mcp_rules"]);
	const blocks = <Rule>(
		name: string,
		parse: (value: unknown, key: string) => Rule,
	): Rule[] => {
		const [block, key] = field(name);
		return block === undefined
			? []
			: list(block, key).map((item, index) => parse(item, `${key}[${index}]`));
	};
	return {
		path: options.path,
		source,
		rules: {
			rules: blocks("rules", (item, key) =>
				commandRule(item, key, source, parser),
			),
			network_rules: blocks("network_rules", (item, key) =>
				networkRule(item, key, source),
			),
			mcp_rules: blocks("mcp_rules", (item, key) => mcpRule(item, key, source)),
		},
	};
}
