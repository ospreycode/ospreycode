import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	createHost,
	type Host,
	type SessionOptions,
} from "@ospreycode/agent-host";
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
