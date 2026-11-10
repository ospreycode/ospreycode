import { join } from "node:path";
import {
	type AdditionalPermissions,
	type ApprovalPolicy,
	type BuiltinSandboxMode,
	builtinSandboxModes,
	type GranularApproval,
	type GranularCategory,
	granularCategories,
	type RuleSource,
	type SandboxPermissions,
} from "@ospreycode/sandbox";

/**
 * 权限判断用到的目录，由运行器建在临时目录里：主目录里有工作区、Host 根目录和一个凭据文件，
 * 主目录外有一个 `PATH` 里的工具目录（agent 不可写）和一个工作区之外的目录。
 */
export interface DecisionDirectories {
	home: string;
	workspace: string;
	hostRoot: string;
	/** Host 根目录里放开给这个沙盒的临时目录。 */
	sessionTmp: string;
	/** 凭据文件：任何批准都放不开的读取路径。 */
	credential: string;
	/** `PATH` 里的工具目录，里面有 `git`、`npm`、`gh` 和 `deploy`。 */
	tools: string;
	outside: string;
}

/**
 * 预期的判断，从松到严：直接执行、询问用户、按审批策略拒绝、按 `forbidden`（内置的或规则里的）拒绝。
 * 都按 sandbox 的设计文档写，不照实现的输出填。
 */
export type ExpectedDecision = "allow" | "ask" | "deny" | "forbidden";

/** 一份权限规则文件：来源和解析后的 TOML 值。 */
export interface RuleFileSpec {
	source: RuleSource;
	value: unknown;
}

/** 交给 Permission 判断的一个动作。 */
export type DecisionRequest =
	| {
			kind: "command";
			command: string;
			sandbox_permissions?: SandboxPermissions;
			additional_permissions?: AdditionalPermissions;
	  }
	| { kind: "file_edits"; paths: string[] }
	| { kind: "permissions"; write?: string[]; network?: string[] }
	| { kind: "network"; host: string }
	| { kind: "mcp_tool"; server: string; tool: string; destructive: boolean };

/** 固定输入里的一项：在什么策略和规则下判断哪个动作，预期是什么。 */
export interface DecisionCase {
	name: string;
	/** 报告里按它分组。 */
	group:
		| "development"
		| "dangerous_command"
		| "builtin_forbidden"
		| "command_rules"
		| "escalation"
		| "matrix";
	sandboxMode: BuiltinSandboxMode;
	approvalPolicy: ApprovalPolicy;
	granular?: GranularApproval;
	rules?(dirs: DecisionDirectories): RuleFileSpec[];
	request(dirs: DecisionDirectories): DecisionRequest;
	expected: ExpectedDecision;
}

type Text = string | ((dirs: DecisionDirectories) => string);

interface CommandOptions {
	rules?: (dirs: DecisionDirectories) => RuleFileSpec[];
	sandbox_permissions?: SandboxPermissions;
	additional_permissions?: (dirs: DecisionDirectories) => AdditionalPermissions;
}

/** 默认组合（`workspace-write` 加 `on-request`）下的一条命令；名字就是命令本身。 */
function command(
	group: DecisionCase["group"],
	text: Text,
	expected: ExpectedDecision,
	options: CommandOptions = {},
	label?: string,
): DecisionCase {
	const render = (dirs: DecisionDirectories) =>
		typeof text === "string" ? text : text(dirs);
	const shown =
		typeof text === "string"
			? text
			: text({
					home: "~",
					workspace: "$WORKSPACE",
					hostRoot: "~/.ospreycode",
					sessionTmp: "~/.ospreycode/tmp/s1",
					credential: "~/secrets/key",
					tools: "$TOOLS",
					outside: "$OUTSIDE",
				});
	const { additional_permissions } = options;
	return {
		name: label === undefined ? shown : `${shown}（${label}）`,
		group,
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
		...(options.rules === undefined ? {} : { rules: options.rules }),
		request: (dirs) => ({
			kind: "command",
			command: render(dirs),
			...(options.sandbox_permissions === undefined
				? {}
				: { sandbox_permissions: options.sandbox_permissions }),
			...(additional_permissions === undefined
				? {}
				: { additional_permissions: additional_permissions(dirs) }),
		}),
		expected,
	};
}

const userRules =
	(...rules: object[]) =>
	(): RuleFileSpec[] => [{ source: "user", value: { rules } }];

/** 评测时的权限规则文件里唯一的一条规则，这里经启动参数传入。 */
const rmAllowed = (): RuleFileSpec[] => [
	{
		source: "startup",
		value: { rules: [{ pattern: ["rm"], decision: "allow" }] },
	},
];

const ghPrompt = userRules({
	pattern: ["gh", "pr", ["view", "list"]],
	decision: "prompt",
});
const pushForbidden = userRules({
	pattern: ["git", "push"],
	decision: "forbidden",
});
const gitAllowedPushPrompt = userRules(
	{ pattern: ["git"], decision: "allow" },
	{ pattern: ["git", "push"], decision: "prompt" },
);

/** `deploy` 的 `allow` 规则，声明了对工作区里 `out/` 的写入。 */
const deployAllowed = userRules({
	pattern: ["deploy"],
	decision: "allow",
	permissions: { file_system: { write: ["$WORKSPACE/out"] } },
});
const writeOut = (dirs: DecisionDirectories): AdditionalPermissions => ({
	file_system: { write: [join(dirs.workspace, "out")] },
});
const writeOutside = (dirs: DecisionDirectories): AdditionalPermissions => ({
	file_system: { write: [dirs.outside] },
});

/** 正常的开发操作：沙盒允许的范围内直接执行，问了就是多问。 */
const development: DecisionCase[] = [
	"git status",
	"git diff HEAD~1 -- src",
	"git log --oneline -5",
	"git commit -m 'fix parser'",
	"npm install",
	"npm test",
	"npm run build -- --watch=false",
	"FOO=1 npm test",
	"cd packages/app && npm test",
	"timeout 60 npm test",
	"env NODE_ENV=test node scripts/check.js",
	"node --test test/",
	"python3 -m pytest -q tests/test_parser.py",
	"go test ./...",
	"cargo build --release",
	"make -j4 all",
	"ls -la",
	"cat package.json | head -20",
	"rg -n TODO src",
	"find . -name '*.tmp' -print",
	"mkdir -p build && cp src/a.txt build/",
	"echo done > build/status.txt",
	"sed -i.bak 's/a/b/' src/a.txt",
	'for f in src/*.ts; do wc -l "$f"; done',
	"rm build/output.txt",
	"rm -r build",
	"dd if=src/a.bin of=build/a.bin",
	"echo test > /dev/null",
	"curl -sS https://registry.npmjs.org/left-pad",
].map((text) => command("development", text, "allow"));
development.push(
	command("development", (d) => `ls ${d.sessionTmp}`, "allow"),
	command("development", "cat ~/.ssh/known_hosts", "allow"),
);

/** 危险命令判断：强制删除先询问，穿过包装命令，按小写比较。 */
const dangerous: DecisionCase[] = [
	"rm -f a.txt",
	"rm -rf build/",
	"rm -fr build",
	"rm -r -f build",
	"rm --force a.txt",
	"RM -rf build/",
	"rm -rf build/ 2>/dev/null",
	'rm -rf "$BUILD_DIR"',
	"sh -c 'rm -rf build'",
	'bash -lc "rm -rf dist"',
	"timeout 5 rm -rf build",
	"nohup rm -rf build &",
	"env KEEP=1 rm -rf build",
	"find . -name '*.o' -exec rm -f {} +",
	"xargs rm -f < files.txt",
	"npm test && rm -rf coverage",
	"if [ -d build ]; then rm -rf build; fi",
	"echo $(rm -rf build)",
].map((text) => command("dangerous_command", text, "ask"));
dangerous.push(
	// 用户级配置和启动参数的 allow 规则盖过危险命令判断，前缀不要求写明 -f
	command(
		"dangerous_command",
		"rm -rf build/",
		"allow",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
	command(
		"dangerous_command",
		"rm -rf build/ 2>/dev/null",
		"allow",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
	command(
		"dangerous_command",
		'rm -rf "$BUILD_DIR"',
		"allow",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
	command(
		"dangerous_command",
		"npm test && rm -rf coverage",
		"allow",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
	// eval 的脚本里的强制删除不按 allow 处理
	command(
		"dangerous_command",
		"eval 'rm -rf build'",
		"ask",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
	// 可执行文件不是 PATH 里的那个 rm：工作区里的同名程序不算
	command(
		"dangerous_command",
		"./rm -rf build",
		"ask",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
);

/** 内置的 forbidden：任何配置都不能放开。 */
const forbidden: DecisionCase[] = [
	"sudo apt-get install -y jq",
	"su -c 'make install'",
	"doas reboot",
	"pkexec true",
	"env sudo ls",
	"bash -c 'sudo ls'",
	"timeout 5 sudo ls",
	"echo $(sudo cat /etc/shadow)",
	"npm test || sudo npm test",
	"rm -rf /",
	"rm -rf /etc",
	"rm -rf ~",
	"rm -rf $HOME",
	"rm -r ~",
	"rm -rf .",
	"rm -rf ..",
	"mkfs.ext4 /dev/sda1",
	"wipefs -a /dev/sda",
	"diskutil eraseDisk JHFS+ Blank disk2",
	"dd if=/dev/zero of=/dev/disk2 bs=1m",
	"echo x > /dev/disk2",
	"cat ~/.ospreycode/config.toml",
	"echo x >> ~/.ospreycode/config.toml",
	"claude --dangerously-skip-permissions -p 'fix it'",
	"codex --dangerously-bypass-approvals-and-sandbox exec 'fix it'",
	"claude --permission-mode bypassPermissions -p 'fix it'",
].map((text) => command("builtin_forbidden", text, "forbidden"));
forbidden.push(
	command("builtin_forbidden", (d) => `rm -rf ${d.workspace}`, "forbidden"),
	command("builtin_forbidden", (d) => `rm -rf ${d.hostRoot}`, "forbidden"),
	command(
		"builtin_forbidden",
		(d) => `cp ${d.hostRoot}/config.toml .`,
		"forbidden",
	),
	command("builtin_forbidden", (d) => `cat ${d.credential}`, "forbidden"),
	command(
		"builtin_forbidden",
		(d) => `tar czf keys.tgz ${d.credential}`,
		"forbidden",
	),
	// 任何 allow 都不能批准
	command(
		"builtin_forbidden",
		"rm -rf ~",
		"forbidden",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
	command(
		"builtin_forbidden",
		"sudo rm -rf build",
		"forbidden",
		{ rules: rmAllowed },
		"rm 的 allow 规则",
	),
);

/** 命令规则的匹配：收紧的判断按文件名、不分大小写、穿过包装命令；多条同时匹配取最严的。 */
const commandRules: DecisionCase[] = [
	command(
		"command_rules",
		"gh pr view 7888",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"gh pr list --state open",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"GH pr view 1",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"env GH_PAGER=cat gh pr view 1",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"/opt/homebrew/bin/gh pr view 1",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"bash -c 'gh pr view 1'",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"git status && gh pr list",
		"ask",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"gh pr --repo openai/codex view 7888",
		"allow",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"gh issue list",
		"allow",
		{ rules: ghPrompt },
		"gh pr 的 prompt 规则",
	),
	command(
		"command_rules",
		"git push origin main",
		"forbidden",
		{ rules: pushForbidden },
		"git push 的 forbidden 规则",
	),
	command(
		"command_rules",
		"git status && git push",
		"forbidden",
		{ rules: pushForbidden },
		"git push 的 forbidden 规则",
	),
	command(
		"command_rules",
		"sh -c 'git push'",
		"forbidden",
		{ rules: pushForbidden },
		"git push 的 forbidden 规则",
	),
	command(
		"command_rules",
		"/usr/bin/git push",
		"forbidden",
		{ rules: pushForbidden },
		"git push 的 forbidden 规则",
	),
	command(
		"command_rules",
		"git pull",
		"allow",
		{ rules: pushForbidden },
		"git push 的 forbidden 规则",
	),
	command(
		"command_rules",
		"git push",
		"ask",
		{ rules: gitAllowedPushPrompt },
		"git 的 allow 和 git push 的 prompt",
	),
	command(
		"command_rules",
		"git status",
		"allow",
		{ rules: gitAllowedPushPrompt },
		"git 的 allow 和 git push 的 prompt",
	),
];

/** 越界申请：默认询问；allow 规则声明了申请的权限、调用的又确实是规则里的命令时免询问。 */
const escalation: DecisionCase[] = [
	command(
		"escalation",
		"git commit -m x",
		"ask",
		{ sandbox_permissions: "require_escalated" },
		"require_escalated",
	),
	command(
		"escalation",
		"npm test",
		"ask",
		{
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: () => ({ local_binding: true }),
		},
		"申请 local_binding",
	),
	command(
		"escalation",
		"deploy --target out",
		"allow",
		{
			rules: deployAllowed,
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: writeOut,
		},
		"allow 规则声明了申请的写入",
	),
	command(
		"escalation",
		"deploy --target out",
		"ask",
		{
			rules: deployAllowed,
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: writeOutside,
		},
		"申请的写入超出 allow 规则",
	),
	command(
		"escalation",
		"deploy --target out",
		"ask",
		{ rules: deployAllowed, sandbox_permissions: "require_escalated" },
		"allow 规则加 require_escalated",
	),
	command(
		"escalation",
		"./deploy --target out",
		"ask",
		{
			rules: deployAllowed,
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: writeOut,
		},
		"工作区里的同名程序",
	),
	command(
		"escalation",
		"deploy --target $TARGET",
		"ask",
		{
			rules: deployAllowed,
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: writeOut,
		},
		"参数带变量",
	),
	command(
		"escalation",
		"deploy --target out && make install",
		"ask",
		{
			rules: deployAllowed,
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: writeOut,
		},
		"有一段没有命中 allow",
	),
];

/** 固定的命令集：默认组合（`workspace-write` 加 `on-request`）下每条命令该执行、询问还是拒绝。 */
export const commandCases: DecisionCase[] = [
	...development,
	...dangerous,
	...forbidden,
	...commandRules,
	...escalation,
];

const allCategories = (enabled: boolean): GranularApproval =>
	Object.fromEntries(
		granularCategories.map((category) => [category, enabled]),
	) as GranularApproval;

interface PolicySetting {
	label: string;
	approvalPolicy: ApprovalPolicy;
	granular?: GranularApproval;
}

const policySettings: PolicySetting[] = [
	{ label: "on-request", approvalPolicy: "on-request" },
	{ label: "never", approvalPolicy: "never" },
	{
		label: "granular 全部开启",
		approvalPolicy: "granular",
		granular: allCategories(true),
	},
	{
		label: "granular 全部关闭",
		approvalPolicy: "granular",
		granular: allCategories(false),
	},
	{
		label: "granular 只开 sandbox_approval",
		approvalPolicy: "granular",
		granular: { ...allCategories(false), sandbox_approval: true },
	},
];

/** 需要审批的动作在这个审批策略下是询问还是拒绝。 */
function asks(
	category: GranularCategory,
	policy: PolicySetting,
): ExpectedDecision {
	if (policy.approvalPolicy === "on-request") return "ask";
	if (policy.approvalPolicy === "never") return "deny";
	return policy.granular?.[category] === true ? "ask" : "deny";
}

interface MatrixAction {
	label: string;
	rules?: (dirs: DecisionDirectories) => RuleFileSpec[];
	request(dirs: DecisionDirectories): DecisionRequest;
	/** 不写表示三种沙盒模式都判断；没有沙盒时不会发生的动作只列有沙盒的两种。 */
	modes?: readonly BuiltinSandboxMode[];
	expected(mode: BuiltinSandboxMode, policy: PolicySetting): ExpectedDecision;
}

const sandboxed = ["read-only", "workspace-write"] as const;
const networkRules = (): RuleFileSpec[] => [
	{
		source: "user",
		value: {
			network_rules: [
				{ host: "registry.npmjs.org", decision: "allow" },
				{ host: "*.tracker.example", decision: "forbidden" },
			],
			mcp_rules: [{ server: "docs", decision: "allow" }],
		},
	},
];

const matrixActions: MatrixAction[] = [
	{
		label: "普通命令",
		request: () => ({ kind: "command", command: "npm test" }),
		expected: () => "allow",
	},
	{
		label: "强制删除",
		request: () => ({ kind: "command", command: "rm -rf build" }),
		expected: (_mode, policy) => asks("sandbox_approval", policy),
	},
	{
		label: "命中 prompt 规则的命令",
		rules: ghPrompt,
		request: () => ({ kind: "command", command: "gh pr view 1" }),
		expected: (_mode, policy) => asks("rules", policy),
	},
	{
		label: "内置 forbidden 的命令",
		request: () => ({ kind: "command", command: "sudo make install" }),
		expected: () => "forbidden",
	},
	{
		label: "require_escalated",
		request: () => ({
			kind: "command",
			command: "git commit -m x",
			sandbox_permissions: "require_escalated",
		}),
		// danger-full-access 下没有沙盒可越，越界申请不问
		expected: (mode, policy) =>
			mode === "danger-full-access"
				? "allow"
				: asks("sandbox_approval", policy),
	},
	{
		label: "with_additional_permissions",
		request: (dirs) => ({
			kind: "command",
			command: "make install",
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: { file_system: { write: [dirs.outside] } },
		}),
		expected: (mode, policy) =>
			mode === "danger-full-access"
				? "allow"
				: asks("sandbox_approval", policy),
	},
	{
		label: "request_permissions",
		request: (dirs) => ({
			kind: "permissions",
			write: [dirs.outside],
			network: ["registry.npmjs.org"],
		}),
		expected: (mode, policy) =>
			mode === "danger-full-access"
				? "allow"
				: asks("request_permissions", policy),
	},
	{
		label: "可写范围之外的文件改动",
		modes: sandboxed,
		request: (dirs) => ({
			kind: "file_edits",
			paths: [join(dirs.outside, "notes.txt")],
		}),
		expected: (_mode, policy) => asks("sandbox_approval", policy),
	},
	{
		label: "没放行的域名",
		modes: sandboxed,
		request: () => ({ kind: "network", host: "example.com" }),
		expected: (_mode, policy) => asks("network", policy),
	},
	{
		label: "allow 规则放行的域名",
		modes: sandboxed,
		rules: networkRules,
		request: () => ({ kind: "network", host: "registry.npmjs.org" }),
		expected: () => "allow",
	},
	{
		label: "forbidden 规则禁止的域名",
		modes: sandboxed,
		rules: networkRules,
		request: () => ({ kind: "network", host: "a.tracker.example" }),
		expected: () => "forbidden",
	},
	{
		label: "本机地址",
		modes: sandboxed,
		request: () => ({ kind: "network", host: "127.0.0.1" }),
		// 本机和私有网段的地址一律拒绝，不询问
		expected: () => "deny",
	},
	{
		label: "没有规则的 MCP 工具",
		request: () => ({
			kind: "mcp_tool",
			server: "tickets",
			tool: "create",
			destructive: false,
		}),
		expected: (_mode, policy) => asks("mcp_tools", policy),
	},
	{
		label: "allow 规则放行的 MCP 工具",
		rules: networkRules,
		request: () => ({
			kind: "mcp_tool",
			server: "docs",
			tool: "search",
			destructive: false,
		}),
		expected: () => "allow",
	},
	{
		label: "allow 规则放行、标注为破坏性的 MCP 工具",
		rules: networkRules,
		request: () => ({
			kind: "mcp_tool",
			server: "docs",
			tool: "delete",
			destructive: true,
		}),
		expected: (_mode, policy) => asks("mcp_tools", policy),
	},
];

/** 沙盒模式和审批策略的每种组合下，各类动作该执行、询问还是拒绝。 */
export const matrixCases: DecisionCase[] = matrixActions.flatMap((action) =>
	(action.modes ?? builtinSandboxModes).flatMap((mode) =>
		policySettings.map(
			(policy): DecisionCase => ({
				name: `${action.label}：${mode} 加 ${policy.label}`,
				group: "matrix",
				sandboxMode: mode,
				approvalPolicy: policy.approvalPolicy,
				...(policy.granular === undefined ? {} : { granular: policy.granular }),
				...(action.rules === undefined ? {} : { rules: action.rules }),
				request: action.request,
				expected: action.expected(mode, policy),
			}),
		),
	),
);
