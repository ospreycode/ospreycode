import {
	loadShellParser,
	PermissionConfigError,
	parseRuleFile,
	type RuleSource,
	type ShellParser,
} from "@ospreycode/sandbox";
import { beforeAll, describe, expect, test } from "vitest";

let parser: ShellParser;
beforeAll(async () => {
	parser = await loadShellParser();
});

function load(value: unknown, source: RuleSource = "user") {
	return parseRuleFile(value, { path: "/rules/default.toml", source, parser });
}

/** 加载失败时出错的键。 */
function errorKey(value: unknown, source: RuleSource = "user"): string {
	try {
		load(value, source);
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(PermissionConfigError);
		return (thrown as PermissionConfigError).key;
	}
	throw new Error("没有报错");
}

/** 文档里的例子。 */
const ghRule = {
	pattern: ["gh", "pr", ["view", "list"]],
	decision: "prompt",
	justification: "查看 PR 前先确认",
	match: ["gh pr view 7888"],
	not_match: ["gh pr --repo openai/codex view 7888"],
};

describe("权限规则文件", () => {
	test("三种规则写在同一份文件里，没写的块是空的", () => {
		expect(
			load({
				rules: [ghRule],
				network_rules: [{ host: "Registry.NPMJS.org.", decision: "allow" }],
				mcp_rules: [
					{ server: "github", decision: "allow" },
					{
						server: "github",
						tool: "delete_repo",
						decision: "forbidden",
						justification: "不删仓库",
					},
				],
			}),
		).toEqual({
			path: "/rules/default.toml",
			source: "user",
			rules: {
				rules: [ghRule],
				// 域名转成小写的 A-label、去掉末尾的点
				network_rules: [{ host: "registry.npmjs.org", decision: "allow" }],
				mcp_rules: [
					{ server: "github", decision: "allow" },
					{
						server: "github",
						tool: "delete_repo",
						decision: "forbidden",
						justification: "不删仓库",
					},
				],
			},
		});
		expect(load({}).rules).toEqual({
			rules: [],
			network_rules: [],
			mcp_rules: [],
		});
	});

	test("写法不对时报错，带出错的键", () => {
		expect(errorKey([])).toBe("");
		expect(errorKey({ rule: [] })).toBe("rule");
		expect(errorKey({ rules: {} })).toBe("rules");
		expect(errorKey({ rules: ["rm"] })).toBe("rules[0]");
		expect(errorKey({ rules: [{ ...ghRule, when: "always" }] })).toBe(
			"rules[0].when",
		);
		expect(errorKey({ mcp_rules: [{ decision: "allow" }] })).toBe(
			"mcp_rules[0].server",
		);
		expect(
			errorKey({
				mcp_rules: [{ server: "github", tool: 1, decision: "allow" }],
			}),
		).toBe("mcp_rules[0].tool");
	});

	test("decision 必须写明，只能取这类规则有的决定", () => {
		expect(errorKey({ rules: [{ pattern: ["make"] }] })).toBe(
			"rules[0].decision",
		);
		expect(
			errorKey({ rules: [ghRule, { pattern: ["make"], decision: "deny" }] }),
		).toBe("rules[1].decision");
		// 没放行的域名本来就会询问，域名规则没有 prompt
		expect(
			errorKey({
				network_rules: [{ host: "example.com", decision: "prompt" }],
			}),
		).toBe("network_rules[0].decision");
		expect(errorKey({ mcp_rules: [{ server: "github" }] })).toBe(
			"mcp_rules[0].decision",
		);
	});

	test("仓库里的权限规则文件只能收紧，写了 allow 就加载失败", () => {
		expect(
			errorKey({ rules: [{ pattern: ["make"], decision: "allow" }] }, "repo"),
		).toBe("rules[0].decision");
		expect(
			errorKey(
				{ network_rules: [{ host: "example.com", decision: "allow" }] },
				"repo",
			),
		).toBe("network_rules[0].decision");
		expect(
			errorKey(
				{ mcp_rules: [{ server: "github", decision: "allow" }] },
				"repo",
			),
		).toBe("mcp_rules[0].decision");

		const tightening = {
			rules: [ghRule, { pattern: ["make"], decision: "forbidden" }],
			network_rules: [{ host: "example.com", decision: "forbidden" }],
			mcp_rules: [{ server: "github", decision: "prompt" }],
		};
		expect(load(tightening, "repo").rules).toEqual(tightening);
		// 启动参数指定的文件和用户级的一样可以写 allow
		expect(
			load({ rules: [{ pattern: ["make"], decision: "allow" }] }, "startup")
				.source,
		).toBe("startup");
	});
});

describe("命令规则", () => {
	test("pattern 不能是空的，第一个词只能写命令名", () => {
		expect(errorKey({ rules: [{ pattern: [], decision: "prompt" }] })).toBe(
			"rules[0].pattern",
		);
		expect(errorKey({ rules: [{ pattern: "rm", decision: "prompt" }] })).toBe(
			"rules[0].pattern",
		);
		expect(
			errorKey({ rules: [{ pattern: ["git", []], decision: "prompt" }] }),
		).toBe("rules[0].pattern[1]");
		expect(
			errorKey({ rules: [{ pattern: ["git", 1], decision: "prompt" }] }),
		).toBe("rules[0].pattern[1]");
		for (const first of ["/usr/bin/git", "./git", ["git", "bin/git"]]) {
			expect(
				errorKey({ rules: [{ pattern: [first, "push"], decision: "allow" }] }),
			).toBe("rules[0].pattern[0]");
		}
		// 后面的位置可以写路径
		load({ rules: [{ pattern: ["cat", "/etc/hosts"], decision: "prompt" }] });
	});

	test("match 里的例子没匹配、not_match 里的例子匹配了，都加载失败", () => {
		expect(
			errorKey({
				rules: [{ ...ghRule, match: ["gh pr view 7888", "gh issue list"] }],
			}),
		).toBe("rules[0].match[1]");
		expect(
			errorKey({ rules: [{ ...ghRule, not_match: ["gh pr list --web"] }] }),
		).toBe("rules[0].not_match[0]");
	});

	test("收紧的规则核对例子时不分大小写、取文件名、穿过包装命令和脚本参数", () => {
		load({
			rules: [
				{
					pattern: ["rm"],
					decision: "forbidden",
					match: [
						"rm -r build/ 2>/dev/null",
						"sh -c 'rm -rf x'",
						"/bin/RM x",
						"env A=1 timeout 5 rm x",
						"find . -name '*.o' -exec rm {} +",
						"echo $(rm x)",
					],
					not_match: ["echo rm", "rmdir x", "git rm x"],
				},
			],
		});
	});

	test("allow 规则核对例子时要整段是普通的命令，命令名和规则里写的一样", () => {
		const allow = (examples: { match?: string[]; not_match?: string[] }) => ({
			rules: [{ pattern: ["npm", "test"], decision: "allow", ...examples }],
		});
		load(
			allow({
				match: [
					"npm test",
					"npm test -- --watch=false | tail",
					"bash -lc 'npm test'",
				],
				not_match: [
					"npm run test",
					"./node_modules/.bin/npm test",
					"NPM test",
					"npm test > out.txt",
					"env CI=1 npm test",
					"eval 'npm test'",
					"echo $(npm test)",
				],
			}),
		);
		expect(errorKey(allow({ match: ["npm test 2>&1"] }))).toBe(
			"rules[0].match[0]",
		);
	});

	test("permissions 只用于 allow，路径写绝对路径或以 $WORKSPACE/、~/ 开头", () => {
		const permissions = {
			file_system: {
				read: ["~/.ssh/known_hosts", "/opt/data"],
				write: ["$WORKSPACE/.git"],
			},
			unix_sockets: ["ssh-agent"],
			local_binding: true,
		};
		const rule = { pattern: ["git", "push"], decision: "allow", permissions };
		expect(load({ rules: [rule] }).rules.rules).toEqual([rule]);

		expect(errorKey({ rules: [{ ...rule, decision: "prompt" }] })).toBe(
			"rules[0].permissions",
		);
		expect(
			errorKey({
				rules: [{ ...rule, permissions: { file_system: { write: [".git"] } } }],
			}),
		).toBe("rules[0].permissions.file_system.write[0]");
		expect(
			errorKey({ rules: [{ ...rule, permissions: { local_binding: "yes" } }] }),
		).toBe("rules[0].permissions.local_binding");
		expect(
			errorKey({ rules: [{ ...rule, permissions: { network: ["x.com"] } }] }),
		).toBe("rules[0].permissions.network");
	});
});

describe("域名规则", () => {
	test("host 规范成小写的 A-label，写法不对的报错", () => {
		const hosts = (host: string) =>
			load({ network_rules: [{ host, decision: "forbidden" }] }).rules
				.network_rules[0].host;
		expect(hosts("*.Example.COM")).toBe("*.example.com");
		expect(hosts("例子.测试")).toBe("xn--fsqu00a.xn--0zwm56d");
		expect(hosts("[0:0:0:0:0:0:0:1]")).toBe("[::1]");
		for (const host of ["*.com", "a*.example.com", "https://example.com", ""]) {
			expect(
				errorKey({ network_rules: [{ host, decision: "forbidden" }] }),
				host,
			).toBe("network_rules[0].host");
		}
	});

	test("allow 不能写本机和私有网段的地址，forbidden 可以", () => {
		for (const host of ["localhost", "127.0.0.1", "192.168.1.1", "[::1]"]) {
			expect(
				errorKey({ network_rules: [{ host, decision: "allow" }] }),
				host,
			).toBe("network_rules[0].host");
			load({ network_rules: [{ host, decision: "forbidden" }] });
		}
	});
});
