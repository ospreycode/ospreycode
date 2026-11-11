import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionInfo } from "@ospreycode/agent-host";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	fixtureServer,
	writeHookScript,
	writeHooks,
	writeMcpConfig,
	writePlugin,
	writeSkill,
} from "./extension-fixture.js";
import {
	type CliResult,
	runCli,
	type TestDirectories,
	testDirectories,
} from "./harness.js";
import { type PtyCli, startInPty } from "./pty.js";

vi.setConfig({ testTimeout: 60_000 });

let dirs: TestDirectories;
let terminal: PtyCli | undefined;

beforeEach(() => {
	dirs = testDirectories();
	terminal = undefined;
});

afterEach(async () => {
	if (terminal !== undefined) {
		terminal.kill();
		await terminal.exit;
	}
	dirs.cleanup();
});

/** 在工作区里运行 CLI，标准输入是空的管道。 */
function cli(...args: string[]): Promise<CliResult> {
	return runCli(args, { cwd: dirs.workspace, env: dirs.env });
}

/** 在伪终端里运行 CLI：要用户确认的命令。 */
function inTerminal(...args: string[]): PtyCli {
	terminal = startInPty(args, { cwd: dirs.workspace, env: dirs.env });
	return terminal;
}

function userMcp(): { mcpServers: Record<string, unknown> } {
	return JSON.parse(readFileSync(join(dirs.root, "mcp.json"), "utf8"));
}

describe("mcp", () => {
	test("add 把本地和远程 server 写进用户级的 mcp.json，list 和 get 列出来，remove 删掉", async () => {
		const local = await cli(
			"mcp",
			"add",
			"tools",
			"--env",
			"LEVEL=debug",
			"--",
			"node",
			"server.js",
			"--stdio",
		);
		expect(local).toMatchObject({ code: 0, stderr: "" });
		const remote = await cli(
			"mcp",
			"add",
			"Docs",
			"--url",
			"https://mcp.example.com/mcp",
		);
		expect(remote.code).toBe(0);
		expect(userMcp().mcpServers).toEqual({
			tools: {
				type: "stdio",
				command: "node",
				args: ["server.js", "--stdio"],
				env: { LEVEL: "debug" },
			},
			Docs: { type: "streamable-http", url: "https://mcp.example.com/mcp" },
		});

		const listed = await cli("mcp", "list");
		expect(listed.code).toBe(0);
		// 标签是规范化之后的名字
		expect(listed.stdout).toContain(
			"docs  已启用  用户级  streamable-http https://mcp.example.com/mcp",
		);
		expect(listed.stdout).toContain(
			"tools  已启用  用户级  stdio node server.js --stdio",
		);

		const json = await cli("mcp", "list", "--json");
		const items = JSON.parse(json.stdout) as ExtensionInfo[];
		expect(items.map((item) => [item.name, item.transport])).toEqual([
			["docs", "streamable-http"],
			["tools", "stdio"],
		]);

		const got = await cli(
			"mcp",
			"get",
			"docs",
			"--credential-file",
			`mcp:docs=${dirs.credentialFile}`,
		);
		expect(got.code).toBe(0);
		expect(got.stdout).toContain("docs（用户级）  已启用");
		// 标识里是 mcp.json 里写的名字，删除时也用它
		expect(got.stdout).toContain("标识：mcp/user/Docs");
		expect(got.stdout).toContain("凭据：静态令牌");
		expect(got.stdout).not.toContain("test-key");

		const removed = await cli("mcp", "remove", "Docs");
		expect(removed.code).toBe(0);
		expect(Object.keys(userMcp().mcpServers)).toEqual(["tools"]);
		const again = await cli("mcp", "remove", "Docs");
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("用户级的 mcp.json 里没有 Docs");
	});

	test("add 写得不对时不改文件：两种写法只能选一种，同名的不覆盖，不合规范的拒绝", async () => {
		const neither = await cli("mcp", "add", "tools");
		expect(neither.code).toBe(2);
		expect(neither.stderr).toContain("两种只能写一种");
		const both = await cli(
			"mcp",
			"add",
			"tools",
			"--url",
			"https://mcp.example.com/",
			"--",
			"node",
		);
		expect(both.code).toBe(2);

		expect((await cli("mcp", "add", "tools", "--", "node")).code).toBe(0);
		const duplicate = await cli("mcp", "add", "tools", "--", "python");
		expect(duplicate.code).toBe(2);
		expect(duplicate.stderr).toContain("已经有 tools");
		const invalid = await cli("mcp", "add", "plain", "--url", "ftp://x/");
		expect(invalid.code).toBe(2);
		expect(userMcp().mcpServers).toEqual({
			tools: { type: "stdio", command: "node", args: [] },
		});
	});

	test("没有配置时 list 说明一句，get 找不到时是用法错误", async () => {
		const listed = await cli("mcp", "list");
		expect(listed).toMatchObject({ code: 0, stdout: "" });
		expect(listed.stderr).toContain("没有配置 MCP server");
		const got = await cli("mcp", "get", "nothing");
		expect(got.code).toBe(2);
		expect(got.stderr).toContain("没有 MCP server nothing");
	});

	// 这些路径在碰到钥匙串之前就结束：测试不读写用户真实的钥匙串
	test.runIf(process.platform === "darwin")(
		"token 和 login 先确认是启用着的远程 server，令牌只从终端或 --with-token 读",
		async () => {
			writeMcpConfig(join(dirs.root, "mcp.json"), {
				tools: fixtureServer,
				docs: { type: "streamable-http", url: "https://mcp.example.com/mcp" },
			});
			for (const command of ["token", "login"]) {
				const unknown = await cli("mcp", command, "nothing");
				expect(unknown.code).toBe(2);
				expect(unknown.stderr).toContain("没有启用的 MCP server nothing");
				const local = await cli("mcp", command, "tools");
				expect(local.code).toBe(2);
				expect(local.stderr).toContain("tools 是本地 server");
			}
			const piped = await cli("mcp", "token", "docs");
			expect(piped.code).toBe(2);
			expect(piped.stderr).toContain("--with-token");
			const empty = await cli("mcp", "token", "docs", "--with-token");
			expect(empty.code).toBe(2);
			expect(empty.stderr).toContain("没有读到令牌");
		},
	);

	// 同样在碰到钥匙串之前就结束
	test.runIf(process.platform === "darwin")(
		"secret 先确认是启用着的本地 server、密钥在用户级配置里声明过，值只从终端或 --with-secret 读",
		async () => {
			writeMcpConfig(join(dirs.root, "mcp.json"), {
				tools: fixtureServer,
				docs: { type: "streamable-http", url: "https://mcp.example.com/mcp" },
			});
			const unknown = await cli("mcp", "secret", "nothing", "API_KEY");
			expect(unknown.code).toBe(2);
			expect(unknown.stderr).toContain("没有启用的 MCP server nothing");
			const remote = await cli("mcp", "secret", "docs", "API_KEY");
			expect(remote.code).toBe(2);
			expect(remote.stderr).toContain("docs 是远程 server");
			const undeclared = await cli("mcp", "secret", "tools", "API_KEY");
			expect(undeclared.code).toBe(2);
			expect(undeclared.stderr).toContain(
				'先在 [mcp_secrets.tools] 里写 API_KEY = ["<域名>"]',
			);

			dirs.writeConfig('[mcp_secrets.tools]\nAPI_KEY = ["api.example.com"]\n');
			const piped = await cli("mcp", "secret", "tools", "API_KEY");
			expect(piped.code).toBe(2);
			expect(piped.stderr).toContain("--with-secret");
			const empty = await cli(
				"mcp",
				"secret",
				"tools",
				"API_KEY",
				"--with-secret",
			);
			expect(empty.code).toBe(2);
			expect(empty.stderr).toContain("没有读到密钥");

			const got = await cli("mcp", "get", "tools");
			expect(got.stdout).toContain("密钥：API_KEY，只发往 api.example.com");
		},
	);

	test.runIf(process.platform !== "darwin")(
		"token、secret、login、logout 在没有系统凭据库的平台上说明改用 --credential-file",
		async () => {
			for (const command of ["token", "secret", "login", "logout"]) {
				const result = await cli(
					"mcp",
					command,
					"docs",
					...(command === "secret" ? ["API_KEY"] : []),
				);
				expect(result.code).toBe(2);
				expect(result.stderr).toContain("--credential-file mcp:<标签>=<路径>");
			}
		},
	);
});

describe("trust 和 hooks", () => {
	beforeEach(() => {
		writeSkill(join(dirs.workspace, ".agents", "skills"), "review", "审阅改动");
		writeMcpConfig(join(dirs.workspace, ".ospreycode", "mcp.json"), {
			tools: fixtureServer,
		});
		writeHookScript(
			join(dirs.workspace, ".ospreycode", "check.cjs"),
			"() => ({})",
		);
		writeHooks(join(dirs.workspace, ".ospreycode", "hooks.json"), {
			PreToolUse: [
				{
					matcher: "shell",
					hooks: [{ command: "./check.cjs", onFailure: "block" }],
				},
			],
		});
		writeHookScript(join(dirs.root, "hooks", "stop.cjs"), "() => ({})");
		writeHooks(join(dirs.root, "hooks.json"), {
			Stop: [
				{
					hooks: [
						{
							command: "./stop.cjs",
							onFailure: "continue",
							permissions: "read-only",
						},
					],
				},
			],
		});
	});

	test("trust list 列出每个扩展的状态，没确认的另在 stderr 上提示；--json 给出完整的条目", async () => {
		const listed = await cli("trust", "list");
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("skill review（仓库自带）  未确认");
		expect(listed.stdout).toContain("MCP server tools（仓库自带）  未确认");
		expect(listed.stdout).toMatch(/hooks .*hooks\.json（仓库自带） {2}未确认/);
		expect(listed.stdout).toMatch(/hooks .*hooks\.json（用户级） {2}已启用/);
		expect(listed.stderr).toContain("仓库自带的 skill review 还没有确认");

		const json = await cli("trust", "list", "--json");
		const items = JSON.parse(json.stdout) as ExtensionInfo[];
		expect(items.map((item) => [item.kind, item.origin, item.status])).toEqual(
			expect.arrayContaining([
				["skill", "project", "unconfirmed"],
				["mcp_server", "project", "unconfirmed"],
				["hooks", "project", "unconfirmed"],
				["hooks", "user", "enabled"],
			]),
		);
	});

	test("hooks list 列出每份配置的来源、状态和各个 handler", async () => {
		const listed = await cli("hooks", "list");
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("用户级  已启用");
		expect(listed.stdout).toContain(`位置：${join(dirs.root, "hooks.json")}`);
		expect(listed.stdout).toMatch(/Stop.*stop\.cjs/);
		expect(listed.stdout).toContain("仓库自带  未确认");
		expect(listed.stdout).toMatch(/PreToolUse.*shell.*check\.cjs/);
	});

	test("trust review 不在终端里时是用法错误，什么都不确认", async () => {
		const result = await cli("trust", "review");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("标准输入不是终端");
		expect((await cli("trust", "list")).stdout).not.toContain(
			"（仓库自带）  已启用",
		);
	});

	test("trust review 逐个显示内容摘要，回答 y 的确认，别的跳过，q 结束", async () => {
		const review = inTerminal("trust", "review");
		await review.waitFor("（1/3）hooks");
		await review.waitFor("check.cjs");
		await review.waitFor("确认并启用这份内容？");
		review.write("\r");
		await review.waitFor("（2/3）skill review（仓库自带）  未确认");
		await review.waitFor("审阅改动");
		review.write("y\r");
		await review.waitFor("（3/3）MCP server tools（仓库自带）  未确认");
		await review.waitFor("stdio node");
		review.write("q\r");
		await review.waitFor("确认了 1 个，还有 2 个没有确认");
		expect(await review.exit).toBe(0);

		const listed = await cli("trust", "list");
		expect(listed.stdout).toContain("skill review（仓库自带）  已启用");
		expect(listed.stdout).toContain("MCP server tools（仓库自带）  未确认");

		// 确认的是当时的内容：内容变了就要重新确认
		writeSkill(
			join(dirs.workspace, ".agents", "skills"),
			"review",
			"审阅改动，然后删库",
		);
		expect((await cli("trust", "list")).stdout).toContain(
			"skill review（仓库自带）  内容变了",
		);
	});

	test("没有要确认的扩展时 trust review 直接结束", async () => {
		dirs.cleanup();
		dirs = testDirectories();
		const review = inTerminal("trust", "review");
		await review.waitFor("没有要确认的扩展");
		expect(await review.exit).toBe(0);
	});
});

describe("plugin", () => {
	let source: string;

	beforeEach(() => {
		source = join(dirs.home, "src", "demo");
		writePlugin(source, "1.0.0");
	});

	test("add --yes 列出插件带的组件后安装；list 列出来；update 没有变化时什么都不做；remove 卸载", async () => {
		const added = await cli("plugin", "add", source, "--yes");
		expect(added).toMatchObject({ code: 0, stderr: "" });
		expect(added.stdout).toContain("插件 demo 1.0.0");
		expect(added.stdout).toContain("演示插件");
		expect(added.stdout).toContain(`来源：本地目录 ${source}`);
		expect(added.stdout).toContain("skills（1）：\n  review：审阅改动");
		expect(added.stdout).toMatch(/MCP server（1）：\n {2}tools：stdio node /);
		expect(added.stdout).toContain(
			"hooks（1）：\n  Stop：./dev.ospreycode/stop.cjs",
		);
		expect(added.stdout).toContain(
			"可执行文件（1）：\n  dev.ospreycode/stop.cjs",
		);
		expect(added.stdout).toContain("已安装插件 demo");

		const listed = await cli("plugin", "list");
		expect(listed.stdout).toMatch(
			new RegExp(`^demo {2}\\S+ {2}已启用 {2}${source}\n$`),
		);
		const json = JSON.parse((await cli("plugin", "list", "--json")).stdout);
		expect(json).toMatchObject([
			{
				name: "demo",
				status: "enabled",
				source: { type: "local", path: source },
			},
		]);
		expect((await cli("trust", "list")).stdout).toContain(
			"skill review（插件 demo）  已启用",
		);

		const unchanged = await cli("plugin", "update", "demo", "--yes");
		expect(unchanged.code).toBe(0);
		expect(unchanged.stdout).toContain("已经安装的就是这份内容");

		const removed = await cli("plugin", "remove", "demo", "--yes");
		expect(removed.code).toBe(0);
		expect(removed.stdout).toContain("已卸载插件 demo，数据目录留着");
		expect((await cli("plugin", "list")).stderr).toContain("还没有安装插件");
		const missing = await cli("plugin", "remove", "demo", "--yes");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("没有安装插件 demo");
	});

	test("不带 --yes 又不在终端里时是用法错误，什么都不装", async () => {
		const added = await cli("plugin", "add", source);
		expect(added.code).toBe(2);
		expect(added.stderr).toContain("加上 --yes 直接安装");
		expect(existsSync(join(dirs.root, "plugins"))).toBe(false);
	});

	test("在终端里安装要用户确认：不同意就不安装，退出码 1", async () => {
		const declined = inTerminal("plugin", "add", source);
		await declined.waitFor("插件 demo 1.0.0");
		await declined.waitFor("安装这个插件？");
		declined.write("\r");
		await declined.waitFor("没有安装");
		expect(await declined.exit).toBe(1);
		expect((await cli("plugin", "list")).stderr).toContain("还没有安装插件");

		const accepted = inTerminal("plugin", "add", source);
		await accepted.waitFor("安装这个插件？");
		accepted.write("y\r");
		await accepted.waitFor("已安装插件 demo");
		expect(await accepted.exit).toBe(0);
	});

	test("update 列出相对已安装版本的变化，回答 d 看完整差异，确认后换成新版本", async () => {
		expect((await cli("plugin", "add", source, "--yes")).code).toBe(0);
		writePlugin(source, "1.1.0");
		writeFileSync(join(source, "notes.txt"), "新加的说明\n");
		writeSkill(join(source, "skills"), "review", "审阅改动和测试");

		const update = inTerminal("plugin", "update", "demo");
		await update.waitFor("插件 demo 1.1.0");
		await update.waitFor("相对已安装版本的变化（2）：");
		await update.waitFor("[清单] 修改 plugin.json");
		await update.waitFor("[skill] 修改 skills/review/SKILL.md");
		await update.waitFor("其他文件的变化：1 个");
		await update.waitFor("d 查看完整差异");
		update.write("d\r");
		await update.waitFor("=== 新增 notes.txt");
		await update.waitFor("+description: 审阅改动和测试");
		update.write("y\r");
		await update.waitFor("已更新插件 demo");
		expect(await update.exit).toBe(0);

		const added = await cli("plugin", "update", "demo", "--yes");
		expect(added.stdout).toContain("已经安装的就是这份内容");
	});

	test("在终端里卸载先确认，再问要不要删数据目录", async () => {
		expect((await cli("plugin", "add", source, "--yes")).code).toBe(0);
		const data = join(dirs.root, "plugin-data", "demo");
		writeMcpConfig(join(data, "state.json"), {});

		const remove = inTerminal("plugin", "remove", "demo");
		await remove.waitFor("卸载插件 demo？");
		remove.write("y\r");
		await remove.waitFor("连它的数据目录一起删除？");
		remove.write("y\r");
		await remove.waitFor("已卸载插件 demo，数据目录也删除了");
		expect(await remove.exit).toBe(0);
		expect(existsSync(data)).toBe(false);
	});

	test("不合规范的目录装不上", async () => {
		const broken = join(dirs.home, "src", "broken");
		writeMcpConfig(join(broken, "mcp.json"), {});
		const result = await cli("plugin", "add", broken, "--yes");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("不是合规的插件");
	});
});

test("--help 列出扩展的命令，补全脚本里也有", async () => {
	const help = await cli("--help");
	for (const name of [
		"mcp list",
		"mcp get",
		"mcp add",
		"mcp remove",
		"mcp token",
		"mcp secret",
		"mcp login",
		"mcp logout",
		"plugin list",
		"plugin add",
		"plugin update",
		"plugin remove",
		"trust list",
		"trust review",
		"hooks list",
	]) {
		expect(help.stdout).toContain(name);
	}
	const completion = await cli("completion", "bash");
	expect(completion.stdout).toContain("plugin");
	expect(completion.stdout).toContain("--delete-data");
});
