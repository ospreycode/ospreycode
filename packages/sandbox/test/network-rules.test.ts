import {
	decideMcpTool,
	decideNetwork,
	type GranularApproval,
	granularCategories,
	loadShellParser,
	type McpToolRequest,
	type NetworkRequest,
	networkLists,
	type PolicyContext,
	parseRuleFile,
	type RuleFile,
	type RuleSource,
	type ShellParser,
} from "@ospreycode/sandbox";
import { beforeAll, describe, expect, test } from "vitest";

let parser: ShellParser;
beforeAll(async () => {
	parser = await loadShellParser();
});

function rules(source: RuleSource, value: unknown): RuleFile {
	return parseRuleFile(value, {
		path: `/rules/${source}.toml`,
		source,
		parser,
	});
}

const onRequest: PolicyContext = {
	sandboxMode: "workspace-write",
	approvalPolicy: "on-request",
};
const never: PolicyContext = { ...onRequest, approvalPolicy: "never" };

/** `granular` 下只关闭这几个类别。 */
function granular(...off: (keyof GranularApproval)[]): PolicyContext {
	return {
		...onRequest,
		approvalPolicy: "granular",
		granular: Object.fromEntries(
			granularCategories.map((category) => [category, !off.includes(category)]),
		) as GranularApproval,
	};
}

const allow = { action: "allow" };
const forbiddenRule = { action: "deny", reason: "forbidden_rule" };
const policy = { action: "deny", reason: "policy" };

describe("域名规则", () => {
	const access = (host: string, port = 443): NetworkRequest => ({
		kind: "network",
		host,
		port,
	});
	const files = () => [
		rules("user", {
			network_rules: [
				{ host: "registry.npmjs.org", decision: "allow" },
				{ host: "*.github.com", decision: "allow" },
				{ host: "*.example.com", decision: "allow" },
			],
		}),
		rules("repo", {
			network_rules: [
				{
					host: "gist.github.com",
					decision: "forbidden",
					justification: "Do not upload to gists.",
				},
				{ host: "*.internal.example.com", decision: "forbidden" },
			],
		}),
	];
	const decide = (host: string, context: PolicyContext = onRequest) =>
		decideNetwork(access(host), { ...context, rules: files() });

	test("没放行的域名按审批策略询问或拒绝", () => {
		expect(
			decideNetwork(access("pypi.org"), { ...onRequest, rules: [] }),
		).toEqual({
			action: "ask",
			category: "network",
			categories: ["network"],
			reasons: ["申请访问 pypi.org:443"],
		});
		const refused = { ...policy, categories: ["network"] };
		expect(decide("pypi.org", never)).toMatchObject(refused);
		expect(decide("pypi.org", granular("network"))).toMatchObject(refused);
		expect(decide("pypi.org", granular("sandbox_approval"))).toMatchObject({
			action: "ask",
			category: "network",
		});
	});

	test("命中 allow 的放行，端口不参与匹配", () => {
		expect(decide("registry.npmjs.org", never)).toEqual(allow);
		expect(
			decideNetwork(access("registry.npmjs.org", 8080), {
				...never,
				rules: files(),
			}),
		).toEqual(allow);
	});

	test("通配只匹配子域名，不含本域", () => {
		expect(decide("api.github.com")).toEqual(allow);
		expect(decide("a.b.github.com")).toEqual(allow);
		expect(decide("github.com")).toMatchObject({ action: "ask" });
		expect(decide("notgithub.com")).toMatchObject({ action: "ask" });
		expect(decide("github.com.evil.test")).toMatchObject({ action: "ask" });
	});

	test("forbidden 优先于 allow，justification 写进拒绝原因", () => {
		const decision = decide("gist.github.com");
		expect(decision).toMatchObject(forbiddenRule);
		expect(decision).toHaveProperty(
			"message",
			"Access to gist.github.com is blocked by a `forbidden` permission rule. Do not upload to gists.",
		);
		expect(decide("db.internal.example.com")).toMatchObject(forbiddenRule);
		expect(decide("www.example.com")).toEqual(allow);
	});

	test("本机和私有网段的地址直接拒绝，不询问", () => {
		for (const host of [
			"localhost",
			"dev.localhost",
			"127.0.0.1",
			"10.0.0.5",
			"192.168.1.1",
			"169.254.169.254",
			"[::1]",
			"[fe80::1]",
		]) {
			expect(decide(host), host).toMatchObject({
				...policy,
				categories: ["network"],
			});
		}
	});

	test("编译成 sandbox-runtime 的名单", () => {
		expect(
			networkLists([
				...files(),
				rules("startup", {
					network_rules: [
						{ host: "registry.npmjs.org", decision: "allow" },
						{ host: "gist.github.com", decision: "allow" },
					],
				}),
			]),
		).toEqual({
			allowedDomains: [
				"registry.npmjs.org",
				"*.github.com",
				"*.example.com",
				"gist.github.com",
			],
			deniedDomains: ["gist.github.com", "*.internal.example.com"],
		});
		expect(networkLists([])).toEqual({ allowedDomains: [], deniedDomains: [] });
	});
});

describe("MCP 工具规则", () => {
	const call = (server: string, tool: string): McpToolRequest => ({
		kind: "mcp_tool",
		server,
		tool,
		arguments: "{}",
	});
	const files = () => [
		rules("user", {
			mcp_rules: [
				{ server: "docs", decision: "allow" },
				{ server: "github", tool: "list_issues", decision: "allow" },
				{
					server: "github",
					tool: "create_issue",
					decision: "prompt",
					justification: "新建 issue 前先确认",
				},
				{ server: "deploy", decision: "prompt" },
			],
		}),
		rules("repo", {
			mcp_rules: [
				{
					server: "github",
					tool: "delete_repo",
					decision: "forbidden",
					justification: "Repositories are never deleted from here.",
				},
				{ server: "docs", tool: "publish", decision: "prompt" },
				{ server: "shell", decision: "forbidden" },
			],
		}),
	];
	const decide = (
		server: string,
		tool: string,
		context: PolicyContext = onRequest,
		destructive = false,
	) =>
		decideMcpTool(call(server, tool), {
			...context,
			rules: files(),
			destructive,
		});

	test("没有规则的工具每次询问，never 和关闭 mcp_tools 时拒绝", () => {
		expect(decide("github", "get_issue")).toEqual({
			action: "ask",
			category: "mcp_tools",
			categories: ["mcp_tools"],
			reasons: ["申请调用 MCP 工具 github 的 get_issue"],
		});
		expect(decide("other", "anything")).toMatchObject({
			action: "ask",
			category: "mcp_tools",
		});
		expect(decide("github", "get_issue", never)).toMatchObject({
			...policy,
			categories: ["mcp_tools"],
		});
		expect(decide("github", "get_issue", granular("mcp_tools"))).toMatchObject(
			policy,
		);
		expect(decide("github", "get_issue", granular("rules"))).toMatchObject({
			action: "ask",
		});
	});

	test("allow 规则免去询问；不写 tool 的规则管整个 server", () => {
		expect(decide("github", "list_issues", never)).toEqual(allow);
		expect(decide("docs", "search", never)).toEqual(allow);
		expect(decide("docs", "read_page", never)).toEqual(allow);
	});

	test("server 明确标注为破坏性的工具，有 allow 规则也每次询问", () => {
		expect(decide("docs", "search", onRequest, true)).toEqual({
			action: "ask",
			category: "mcp_tools",
			categories: ["mcp_tools"],
			reasons: [
				"MCP 工具 docs 的 search 被 server 标注为破坏性操作，每次调用都要询问",
			],
		});
		expect(decide("docs", "search", never, true)).toMatchObject(policy);
	});

	test("多条规则同时匹配时取最严的", () => {
		// 整个 server 的 allow 加上这个工具的 prompt
		expect(decide("docs", "publish")).toEqual({
			action: "ask",
			category: "mcp_tools",
			categories: ["mcp_tools"],
			reasons: ["权限规则要求调用前询问：MCP 工具 docs 的 publish"],
		});
		expect(decide("github", "create_issue")).toEqual({
			action: "ask",
			category: "mcp_tools",
			categories: ["mcp_tools"],
			reasons: ["新建 issue 前先确认"],
		});
		expect(decide("deploy", "run", never)).toMatchObject(policy);
		// prompt 规则的询问也属于 mcp_tools，不属于 rules
		expect(decide("deploy", "run", granular("rules"))).toMatchObject({
			action: "ask",
			category: "mcp_tools",
		});
		expect(decide("deploy", "run", granular("mcp_tools"))).toMatchObject(
			policy,
		);
	});

	test("forbidden 规则直接拒绝，justification 写进拒绝原因", () => {
		const decision = decide("github", "delete_repo");
		expect(decision).toMatchObject(forbiddenRule);
		expect(decision).toHaveProperty(
			"message",
			"The MCP tool `delete_repo` of server `github` is blocked by a `forbidden` permission rule. Repositories are never deleted from here.",
		);
		expect(decide("shell", "exec")).toMatchObject(forbiddenRule);
	});
});
