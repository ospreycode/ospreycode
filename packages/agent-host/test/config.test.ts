import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	createHost,
	type Host,
	type SessionOptions,
} from "@ospreycode/agent-host";
import { toolRegistry } from "@ospreycode/agent-runtime";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type TestDirectories, testDirectories, testModel } from "./harness.js";

let dirs: TestDirectories;
let host: Host;

beforeEach(() => {
	dirs = testDirectories();
	host = createHost({ root: dirs.root, env: dirs.env });
});

afterEach(() => {
	dirs.cleanup();
});

function userConfig(text: string): void {
	writeFileSync(join(dirs.root, "config.toml"), text);
}

/** 工作区本身是 git 仓库的根目录，仓库配置放在它的 `.ospreycode/` 下。 */
function repoConfig(text: string): void {
	mkdirSync(join(dirs.workspace, ".git"), { recursive: true });
	mkdirSync(join(dirs.workspace, ".ospreycode"), { recursive: true });
	writeFileSync(join(dirs.workspace, ".ospreycode", "config.toml"), text);
}

function resolve(options: Partial<SessionOptions> = {}) {
	return host.resolveConfig({
		workspace: dirs.workspace,
		models: { scripted: testModel },
		...options,
	});
}

function configError(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as Error).message;
	}
	throw new Error("没有抛出 ConfigError");
}

describe("分层", () => {
	test("启动参数优先于用户级配置，没写的项取内置默认值", () => {
		userConfig(`
model = "scripted"
reasoning_effort = "high"

[credentials]
test = { file = "${dirs.credentialFile}" }
`);
		const fromUser = resolve();
		expect(fromUser.model.id).toBe("scripted");
		expect(fromUser.reasoningEffort).toBe("high");
		expect(fromUser.credentials).toEqual({
			test: { file: dirs.credentialFile },
		});
		expect(fromUser.approvalPolicy).toBe("on-request");
		expect(fromUser.budget).toEqual({
			maxCostUsd: 10,
			maxRequests: 200,
			maxDurationMs: null,
		});
		const fromStartup = resolve({
			reasoningEffort: "low",
			budget: { maxCostUsd: null },
			credentials: { test: { env: "TEST_KEY" } },
		});
		expect(fromStartup.reasoningEffort).toBe("low");
		expect(fromStartup.budget.maxCostUsd).toBeNull();
		expect(fromStartup.credentials).toEqual({ test: { env: "TEST_KEY" } });
	});

	test("默认的沙盒模式：git 仓库里是 workspace-write，否则是 read-only", () => {
		expect(resolve({ model: "scripted" }).sandboxMode).toBe("read-only");
		mkdirSync(join(dirs.workspace, ".git"));
		expect(resolve({ model: "scripted" }).sandboxMode).toBe("workspace-write");
	});

	test("模型定义按字段合并，启动参数优先于用户级配置", () => {
		userConfig(`
[models.scripted]
context_window = 1000
max_output_tokens = 500

[models.scripted.price]
input = 1
`);
		const config = resolve({
			model: "scripted",
			models: {
				scripted: {
					...testModel,
					price: { output: 5, cache_read: 0.1, cache_write: 1.25 },
				},
			},
		});
		expect(config.model).toMatchObject({
			context_window: 200_000,
			price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
		});
	});

	test("内置清单的条目可以只覆盖个别字段", () => {
		userConfig(
			`[models.claude-haiku-5-5]\nbase_url = "https://relay.example.com/v1"`,
		);
		const config = resolve({ model: "claude-haiku-5-5" });
		expect(config.model).toMatchObject({
			id: "claude-haiku-5-5",
			protocol: "anthropic.messages",
			service: "anthropic",
			base_url: "https://relay.example.com/v1",
			prefix_check: true,
			thinking_level_map: { off: "disabled", low: "low" },
		});
		expect(config.models.map((model) => model.id)).toContain("gpt-5.6-sol");
	});

	test("禁止读写的路径在各层取并集，~/ 按 HOME 展开", () => {
		userConfig(`deny_read = ["~/secrets"]\ndeny_write = ["/opt/shared"]`);
		repoConfig(`deny_read = ["private"]`);
		const config = resolve({ model: "scripted", denyRead: ["/var/keys"] });
		expect(config.denyRead).toEqual([
			join(dirs.home, "secrets"),
			join(dirs.workspace, "private"),
			"/var/keys",
		]);
		expect(config.denyWrite).toEqual(["/opt/shared"]);
	});
});

describe("可选工具和显示设置", () => {
	const defaults = ["read", "edit", "write", "shell", "request_permissions"];
	const optional = [...toolRegistry.keys()].filter(
		(name) => !defaults.includes(name),
	);

	test("没有配置时只启用默认的工具，显示推理内容", () => {
		const config = resolve({ model: "scripted" });
		expect(config.tools).toEqual(defaults);
		expect(config.ui).toEqual({ showReasoning: true });
	});

	test.runIf(optional.length > 0)(
		"[tools] 打开的可选工具排在默认工具之后，仓库配置可以覆盖用户级配置",
		() => {
			const [name] = optional as [string];
			userConfig(`[tools]\n${name} = true`);
			expect(resolve({ model: "scripted" }).tools).toEqual([...defaults, name]);
			repoConfig(`[tools]\n${name} = false`);
			const config = resolve({ model: "scripted" });
			expect(config.tools).toEqual(defaults);
			expect(config.warnings).toEqual([]);
		},
	);

	test("可以打开的是 grep 和 ls：打开哪个启用哪个，都打开时按这个顺序排在默认工具之后；各层按工具名合并", () => {
		expect(optional).toEqual(["grep", "ls"]);
		userConfig(`[tools]\nls = true\ngrep = true`);
		expect(resolve({ model: "scripted" }).tools).toEqual([
			...defaults,
			"grep",
			"ls",
		]);
		userConfig(`[tools]\nls = true`);
		expect(resolve({ model: "scripted" }).tools).toEqual([...defaults, "ls"]);
		// 仓库配置只写了 grep：用户级配置打开的 ls 不受影响
		repoConfig(`[tools]\ngrep = true`);
		const config = resolve({ model: "scripted" });
		expect(config.tools).toEqual([...defaults, "grep", "ls"]);
		expect(config.warnings).toEqual([]);
	});

	test("[tools] 只能开关可选工具，值要是布尔值", () => {
		userConfig(`[tools]\nread = false`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/tools\.read 不是可选工具：可以开关的有 grep、ls/,
		);
		userConfig(`[tools]\nno_such_tool = true`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/tools\.no_such_tool 不是可选工具：可以开关的有 grep、ls/,
		);
		userConfig(`[tools]\ngrep = "yes"`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/tools\.grep 要是 true（启用）或 false（不启用）/,
		);
	});

	test("[ui] 仓库配置可以覆盖用户级配置，不认识的键报错", () => {
		userConfig(`[ui]\nshow_reasoning = false`);
		expect(resolve({ model: "scripted" }).ui).toEqual({ showReasoning: false });
		repoConfig(`[ui]\nshow_reasoning = true`);
		const config = resolve({ model: "scripted" });
		expect(config.ui).toEqual({ showReasoning: true });
		expect(config.warnings).toEqual([]);
		userConfig(`[ui]\ntheme = "dark"`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/ui\.theme 不认识的键/,
		);
		userConfig(`[ui]\nshow_reasoning = "no"`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/ui\.show_reasoning 要是 true 或 false/,
		);
	});
});

describe("仓库配置只能收紧", () => {
	test("只认用户级配置的键忽略并列出，沙盒模式只能改成 read-only", () => {
		repoConfig(`
model = "other"
sandbox_mode = "read-only"
[credentials]
test = { file = "relative" }
`);
		const config = resolve({ model: "scripted" });
		expect(config.model.id).toBe("scripted");
		expect(config.sandboxMode).toBe("read-only");
		expect(config.warnings).toEqual([
			expect.stringMatching(/model、credentials 只认用户级配置和启动参数/),
		]);

		repoConfig(`sandbox_mode = "workspace-write"`);
		userConfig(`sandbox_mode = "read-only"`);
		const looser = resolve({ model: "scripted" });
		expect(looser.sandboxMode).toBe("read-only");
		expect(looser.warnings).toEqual([
			expect.stringMatching(/sandbox_mode 在仓库配置里只能设为 read-only/),
		]);
	});

	test("审批策略只能改严，granular 的类别只能关闭", () => {
		repoConfig(`[approval_granular]\nnetwork = false\nrules = true`);
		const closed = resolve({ model: "scripted" });
		expect(closed.approvalPolicy).toBe("granular");
		expect(closed.granular).toMatchObject({ network: false, rules: true });
		expect(closed.warnings).toEqual([]);

		userConfig(`approval_policy = "never"`);
		repoConfig(`approval_policy = "on-request"`);
		const looser = resolve({ model: "scripted" });
		expect(looser.approvalPolicy).toBe("never");
		expect(looser.warnings).toEqual([
			expect.stringMatching(/approval_policy 比 never 更松/),
		]);
		// 启动参数优先于仓库配置
		expect(
			resolve({ model: "scripted", approvalPolicy: "on-request" })
				.approvalPolicy,
		).toBe("on-request");
	});

	test("上限只能调低", () => {
		repoConfig(`
[budget]
max_cost_usd = 2
max_requests = 500
max_duration = "30m"
`);
		const config = resolve({ model: "scripted" });
		expect(config.budget).toEqual({
			maxCostUsd: 2,
			maxRequests: 200,
			maxDurationMs: 30 * 60_000,
		});
		expect(config.warnings).toEqual([
			expect.stringMatching(/budget\.max_requests 在仓库配置里只能调低/),
		]);
	});

	test("路径只能指向仓库之内", () => {
		repoConfig(`deny_read = ["../outside"]`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/deny_read\[0\] 仓库配置里的路径只能指向仓库之内/,
		);
	});

	test("仓库配置是指向仓库之外的符号链接时不读取", () => {
		const outside = join(dirs.home, "elsewhere.toml");
		writeFileSync(outside, `secret = "hunter2"`);
		mkdirSync(join(dirs.workspace, ".git"));
		mkdirSync(join(dirs.workspace, ".ospreycode"));
		symlinkSync(outside, join(dirs.workspace, ".ospreycode", "config.toml"));
		const message = configError(() => resolve({ model: "scripted" }));
		expect(message).toMatch(/指向仓库之外的符号链接/);
		expect(message).not.toContain("hunter2");
	});
});

describe("加载出错时拒绝打开 session", () => {
	test("报出文件路径和出错的键", () => {
		userConfig(`[budget]\nmax_requests = 1.5`);
		expect(configError(() => resolve({ model: "scripted" }))).toBe(
			`${join(dirs.root, "config.toml")}：budget.max_requests 要是正整数，或 "none"`,
		);
		userConfig(`unknown_key = 1`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/unknown_key 不认识的键/,
		);
		userConfig(`sandbox_mode = "danger-full-access"`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/只能由启动参数指定/,
		);
		userConfig(`[environment]\nTMPDIR = "/tmp"`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/environment\.TMPDIR 这个变量由 Host 设置/,
		);
		userConfig(
			`[permissions.dev]\nextends = "workspace-write"\n[permissions.dev.domains]\n"127.0.0.1" = "allow"`,
		);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/permissions\.dev\.domains\."127\.0\.0\.1"/,
		);
	});

	test("TOML 语法错误只报行号和列号，不回显文件内容", () => {
		repoConfig(
			`reasoning_effort = "low"\napi_key = "sk-very-secret"\nbad = = 1\n`,
		);
		const message = configError(() => resolve({ model: "scripted" }));
		expect(message).toMatch(/第 3 行第 7 列不是合法的 TOML/);
		expect(message).not.toContain("sk-very-secret");
	});

	test("必需的项没有写：没有选用模型、granular 缺少类别、模型定义不全", () => {
		expect(configError(() => resolve())).toMatch(/没有选用模型/);
		expect(
			configError(() =>
				resolve({
					model: "scripted",
					approvalPolicy: "granular",
					granular: { rules: false },
				}),
			),
		).toMatch(/缺少 sandbox_approval、request_permissions/);
		userConfig(`[models.partial]\ncontext_window = 1000`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/models\.partial 内置清单里没有这个模型，要写全 protocol/,
		);
	});
});

describe("命名权限配置作为沙盒模式", () => {
	const strict = `
[permissions.strict]
extends = "read-only"
[permissions.strict.paths]
"~/" = "deny"
"~/scratch" = "write"
[permissions.strict.domains]
"registry.npmjs.org" = "allow"
`;

	test("sandbox_mode 写它的名字：按继承的模式和它的路径、域名解析，启动参数也能选用", () => {
		userConfig(`sandbox_mode = "strict"\n${strict}`);
		const config = resolve({ model: "scripted" });
		expect(config.sandboxMode).toBe("strict");
		expect(config.baseSandboxMode).toBe("read-only");
		expect(config.permissionProfile).toMatchObject({
			mode: "read-only",
			write: [join(dirs.home, "scratch")],
			deny: [dirs.home],
			domains: { allow: ["registry.npmjs.org"], deny: [] },
		});

		const builtin = resolve({ model: "scripted", sandboxMode: "read-only" });
		expect(builtin.sandboxMode).toBe("read-only");
		expect(builtin.baseSandboxMode).toBe("read-only");
		expect(builtin.permissionProfile).toBeUndefined();

		userConfig(strict);
		const startup = resolve({ model: "scripted", sandboxMode: "strict" });
		expect(startup.sandboxMode).toBe("strict");
		expect(startup.permissionProfile?.write).toEqual([
			join(dirs.home, "scratch"),
		]);
	});

	test("名字不存在时报错", () => {
		userConfig(strict);
		expect(
			configError(() => resolve({ model: "scripted", sandboxMode: "loose" })),
		).toMatch(/沙盒模式 loose 不存在/);
	});

	test("write 写到受保护的路径上时加载报错，没选用的配置也检查", () => {
		userConfig(`
[permissions.tools]
extends = "workspace-write"
[permissions.tools.paths]
"~/repo/.git" = "write"
`);
		expect(configError(() => resolve({ model: "scripted" }))).toBe(
			`${join(dirs.root, "config.toml")}：permissions.tools.paths."~/repo/.git" 写到了受保护的路径上（.git）：会被自动执行或能给工具授权的路径保持只读`,
		);
		userConfig(`
[permissions.tools]
extends = "workspace-write"
[permissions.tools.paths]
"${join(dirs.workspace, "sub", ".envrc")}" = "write"
`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/permissions\.tools\.paths\..*受保护的路径/,
		);
	});

	test("放不开的位置和沙盒后端表达不了的写法：选用时加载报错，带文件路径和出错的键", () => {
		const select = (paths: string, extra = "") => {
			userConfig(
				`sandbox_mode = "p"\n${extra}\n[permissions.p]\nextends = "workspace-write"\n[permissions.p.paths]\n${paths}`,
			);
			return configError(() => resolve({ model: "scripted" }));
		};
		expect(select(`"~/.ospreycode/data" = "read"`)).toMatch(
			/config\.toml：permissions\.p\.paths\."~\/\.ospreycode\/data" .*始终优先/,
		);
		expect(
			select(`"/opt/closed/sub" = "read"`, `deny_read = ["/opt/closed"]`),
		).toMatch(/permissions\.p\.paths\."\/opt\/closed\/sub"/);
		// 配置里指定的凭据文件，不只是当前模型用的那一个
		expect(
			select(
				`"${dirs.credentialFile}" = "read"`,
				`[credentials]\nother = { file = "${dirs.credentialFile}" }`,
			),
		).toMatch(/始终优先/);
		expect(select(`"${dirs.workspace}" = "deny"`)).toMatch(/当前的工作区/);
		expect(
			select(
				`"~/" = "deny"\n"~/a" = "read"\n"~/a/b" = "deny"\n"~/a/b/c" = "read"`,
			),
		).toMatch(/permissions\.p\.paths\."~\/a\/b\/c" .*三层/);
	});

	test("仓库配置不能选用它；用户级选用了它时，仓库配置的 read-only 忽略并告警", () => {
		userConfig(strict);
		repoConfig(`sandbox_mode = "strict"`);
		const ignored = resolve({ model: "scripted" });
		expect(ignored.sandboxMode).toBe("workspace-write");
		expect(ignored.warnings).toEqual([
			expect.stringMatching(/sandbox_mode 在仓库配置里只能设为 read-only/),
		]);

		userConfig(`sandbox_mode = "strict"\n${strict}`);
		repoConfig(`sandbox_mode = "read-only"`);
		const kept = resolve({ model: "scripted" });
		expect(kept.sandboxMode).toBe("strict");
		expect(kept.warnings).toEqual([
			expect.stringMatching(
				/sandbox_mode 用户级配置选用了命名权限配置 strict.*已忽略/,
			),
		]);
	});
});

describe("子 agent 的定义", () => {
	test("[agents.<名字>] 逐个解析：没写的项沿用 session 的，模型换成清单里的条目", () => {
		userConfig(`
[agents.explorer]
description = "Looks things up."

[agents.worker]
description = "Makes changes."
instructions = "Work in small steps."
model = "other"
reasoning_effort = "low"
sandbox_mode = "read-only"
tools = ["read", "grep"]
workspace = "isolated"
`);
		const config = resolve({
			model: "scripted",
			models: {
				scripted: testModel,
				other: { ...testModel, model: "other" },
			},
		});
		expect(config.agents.explorer).toEqual({
			description: "Looks things up.",
			readOnly: false,
			isolated: false,
		});
		expect(config.agents.worker).toMatchObject({
			description: "Makes changes.",
			instructions: "Work in small steps.",
			model: { id: "other", model: "other" },
			reasoningEffort: "low",
			readOnly: true,
			tools: ["read", "grep"],
			isolated: true,
		});
		expect(config.warnings).toEqual([]);
	});

	test("没有定义时是空的", () => {
		expect(resolve({ model: "scripted" }).agents).toEqual({});
	});

	test("写错的定义加载报错，带文件路径和出错的键", () => {
		const path = join(dirs.root, "config.toml");
		const load = (definition: string) => {
			userConfig(`[agents.explorer]\n${definition}`);
			return configError(() => resolve({ model: "scripted" }));
		};
		expect(load(`instructions = "x"`)).toBe(
			`${path}：agents.explorer.description 要是非空的字符串`,
		);
		expect(load(`description = "x"\ncolor = "red"`)).toBe(
			`${path}：agents.explorer.color 不认识的键`,
		);
		// 子 agent 的沙盒模式只能收紧
		expect(load(`description = "x"\nsandbox_mode = "danger-full-access"`)).toBe(
			`${path}：agents.explorer.sandbox_mode 要是 read-only 之一`,
		);
		expect(load(`description = "x"\nmodel = "missing"`)).toBe(
			`${path}：agents.explorer.model 模型清单里没有 missing`,
		);
		expect(load(`description = "x"\ntools = ["read", "spawn_agent"]`)).toMatch(
			/agents\.explorer\.tools 里的 spawn_agent 不是内置工具/,
		);
		userConfig(`[agents.Explorer]\ndescription = "x"`);
		expect(configError(() => resolve({ model: "scripted" }))).toMatch(
			/agents\.Explorer 名字只能用小写字母/,
		);
	});

	test("启用费用上限时，子 agent 的模型也要有价格", () => {
		const { price: _, ...unpriced } = testModel;
		userConfig(`[agents.explorer]\ndescription = "x"\nmodel = "free"`);
		const models = { scripted: testModel, free: unpriced };
		expect(configError(() => resolve({ model: "scripted", models }))).toMatch(
			/agents\.explorer\.model .*模型 free 在清单里没有价格/,
		);
		expect(
			resolve({ model: "scripted", models, budget: { maxCostUsd: null } })
				.agents.explorer?.model?.id,
		).toBe("free");
	});

	test("仓库配置可以添加定义，但不能指定模型，也不能覆盖用户级配置里同名的定义", () => {
		userConfig(`[agents.explorer]\ndescription = "from user"`);
		repoConfig(`
[agents.explorer]
description = "from repo"

[agents.reviewer]
description = "Reviews a change."
model = "scripted"
sandbox_mode = "read-only"
`);
		const config = resolve({ model: "scripted" });
		expect(config.agents.explorer?.description).toBe("from user");
		expect(config.agents.reviewer).toEqual({
			description: "Reviews a change.",
			readOnly: true,
			isolated: false,
		});
		expect(config.warnings).toEqual([
			expect.stringMatching(/agents\.reviewer\.model 只认用户级配置和启动参数/),
			expect.stringMatching(/agents\.explorer 和用户级配置里的定义同名/),
		]);
	});
});
