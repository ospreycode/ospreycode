import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	createHost,
	type ExtensionInfo,
	type Host,
} from "@ospreycode/agent-host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	fixtureServer,
	writeFile,
	writeHookScript,
	writeHooks,
	writeMcpConfig,
	writeSkill,
} from "./extension-harness.js";
import { type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;
let host: Host;

beforeEach(() => {
	dirs = testDirectories();
	host = createHost({ root: dirs.root, env: dirs.env, credentialStore: null });
});

afterEach(() => {
	dirs.cleanup();
});

async function items(): Promise<ExtensionInfo[]> {
	return (await host.extensions.list(dirs.workspace)).items;
}

async function find(
	match: (item: ExtensionInfo) => boolean,
): Promise<ExtensionInfo> {
	const item = (await items()).find(match);
	if (item === undefined) throw new Error("没有找到这个扩展");
	return item;
}

const named = (kind: ExtensionInfo["kind"], name: string) =>
	find((item) => item.kind === kind && item.name === name);

/** 状态一览：`种类 名字` 到状态。 */
async function statuses(): Promise<Record<string, string>> {
	return Object.fromEntries(
		(await items()).map((item) => [
			`${item.kind} ${item.origin} ${item.kind === "hooks" ? "" : item.name}`.trim(),
			item.status,
		]),
	);
}

function projectConfig(): string {
	return join(dirs.workspace, ".ospreycode");
}

describe("仓库自带的扩展要确认", () => {
	beforeEach(() => {
		writeSkill(join(dirs.workspace, ".agents", "skills"), "deploy", "部署");
		writeMcpConfig(join(projectConfig(), "mcp.json"), {
			tools: fixtureServer(),
		});
		writeHookScript(join(projectConfig(), "check.cjs"));
		writeHooks(join(projectConfig(), "hooks.json"), {
			PreToolUse: [
				{
					matcher: "^shell$",
					hooks: [{ command: "./check.cjs", onFailure: "continue" }],
				},
			],
		});
	});

	test("没确认时都不启用，并提示怎么确认", async () => {
		expect(await statuses()).toEqual({
			"skill project deploy": "unconfirmed",
			"mcp_server project tools": "unconfirmed",
			"hooks project": "unconfirmed",
		});
		const { warnings } = await host.extensions.list(dirs.workspace);
		expect(warnings).toHaveLength(3);
		for (const warning of warnings) {
			expect(warning).toContain("还没有确认");
			expect(warning).toContain("ospreycode trust review");
		}
	});

	test("确认前能看到它会运行什么", async () => {
		expect((await named("skill", "deploy")).summary).toEqual(["部署"]);
		const server = await named("mcp_server", "tools");
		expect(server.summary?.[0]).toMatch(/^stdio node .*mcp-server\.ts$/);
		const hooks = await find((item) => item.kind === "hooks");
		expect(hooks.summary).toEqual([
			`PreToolUse(^shell$): ${join(projectConfig(), "check.cjs")}`,
		]);
	});

	test("确认之后启用；确认记录放在沙盒读不到的 data/ 里", async () => {
		for (const item of await items()) {
			await host.extensions.confirm(
				dirs.workspace,
				item.id,
				item.hash as string,
			);
		}
		expect(Object.values(await statuses())).toEqual([
			"enabled",
			"enabled",
			"enabled",
		]);
		expect(
			existsSync(join(dirs.root, "data", "trust", "extensions.json")),
		).toBe(true);
	});

	test("内容变了要重新确认：skill 的任何文件、server 的定义、项目配置目录里的文件", async () => {
		for (const item of await items()) {
			await host.extensions.confirm(
				dirs.workspace,
				item.id,
				item.hash as string,
			);
		}
		writeFile(
			join(dirs.workspace, ".agents", "skills", "deploy", "run.sh"),
			"echo hi\n",
		);
		expect((await named("skill", "deploy")).status).toBe("changed");

		// hook 用到的脚本变了：hooks 要重新确认；本地 server 会运行这个目录里的文件，也要重新确认
		writeFile(join(projectConfig(), "check.cjs"), "process.exit(2)\n", true);
		expect((await find((item) => item.kind === "hooks")).status).toBe(
			"changed",
		);
		expect((await named("mcp_server", "tools")).status).toBe("changed");
		const { warnings } = await host.extensions.list(dirs.workspace);
		expect(warnings.filter((w) => w.includes("和确认时不一样"))).toHaveLength(
			3,
		);
	});

	test("远程 server 只按定义确认：项目配置目录里别的文件变了不影响", async () => {
		writeMcpConfig(join(projectConfig(), "mcp.json"), {
			remote: {
				type: "streamable-http",
				url: "https://mcp.example.invalid/mcp",
			},
		});
		const server = await named("mcp_server", "remote");
		expect(server.summary).toEqual([
			"streamable-http https://mcp.example.invalid/mcp",
		]);
		await host.extensions.confirm(
			dirs.workspace,
			server.id,
			server.hash as string,
		);
		writeFile(join(projectConfig(), "notes.txt"), "x\n");
		expect((await named("mcp_server", "remote")).status).toBe("enabled");
		writeMcpConfig(join(projectConfig(), "mcp.json"), {
			remote: {
				type: "streamable-http",
				url: "https://other.example.invalid/mcp",
			},
		});
		expect((await named("mcp_server", "remote")).status).toBe("changed");
	});

	test("确认的是审阅时看到的那份内容：之后又变了就拒绝", async () => {
		const skill = await named("skill", "deploy");
		writeFile(
			join(dirs.workspace, ".agents", "skills", "deploy", "extra.md"),
			"x\n",
		);
		await expect(
			host.extensions.confirm(dirs.workspace, skill.id, skill.hash as string),
		).rejects.toThrow(ConfigError);
		expect((await named("skill", "deploy")).status).toBe("unconfirmed");
	});

	test("停用后不启用，重新启用时确认过的内容还算数", async () => {
		const skill = await named("skill", "deploy");
		await host.extensions.confirm(
			dirs.workspace,
			skill.id,
			skill.hash as string,
		);
		await host.extensions.setEnabled(dirs.workspace, skill.id, false);
		expect((await named("skill", "deploy")).status).toBe("disabled");
		await host.extensions.setEnabled(dirs.workspace, skill.id, true);
		expect((await named("skill", "deploy")).status).toBe("enabled");
	});

	test("另一个项目里同名的扩展要另外确认", async () => {
		const skill = await named("skill", "deploy");
		await host.extensions.confirm(
			dirs.workspace,
			skill.id,
			skill.hash as string,
		);
		const other = join(dirs.home, "other");
		writeSkill(join(other, ".agents", "skills"), "deploy", "部署");
		const { items: found } = await host.extensions.list(other);
		expect(found.map((item) => item.status)).toEqual(["unconfirmed"]);
	});
});

describe("用户自己安装的扩展", () => {
	test("不用确认就启用，可以停用", async () => {
		writeSkill(join(dirs.home, ".agents", "skills"), "notes", "记笔记");
		writeMcpConfig(join(dirs.root, "mcp.json"), { tools: fixtureServer() });
		writeHookScript(join(dirs.root, "hooks", "log.cjs"));
		writeHooks(join(dirs.root, "hooks.json"), {
			Stop: [
				{
					hooks: [
						{
							command: "./log.cjs",
							onFailure: "continue",
							permissions: "read-only",
						},
					],
				},
			],
		});
		expect(await statuses()).toEqual({
			"skill user notes": "enabled",
			"mcp_server user tools": "enabled",
			"hooks user": "enabled",
		});
		const hooks = await find((item) => item.kind === "hooks");
		await expect(
			host.extensions.confirm(dirs.workspace, hooks.id, hooks.hash as string),
		).rejects.toThrow("不用确认");
		await host.extensions.setEnabled(dirs.workspace, hooks.id, false);
		expect((await find((item) => item.kind === "hooks")).status).toBe(
			"disabled",
		);
	});

	test("同名的 skill 项目级的优先；同标签的 server 用户级的优先", async () => {
		writeSkill(join(dirs.home, ".agents", "skills"), "deploy", "用户的");
		const project = writeSkill(
			join(dirs.workspace, ".agents", "skills"),
			"deploy",
			"仓库的",
		);
		writeMcpConfig(join(dirs.root, "mcp.json"), { Tools: fixtureServer() });
		writeMcpConfig(join(projectConfig(), "mcp.json"), {
			tools: fixtureServer(),
		});
		for (const item of await items()) {
			if (item.origin === "project") {
				await host.extensions.confirm(
					dirs.workspace,
					item.id,
					item.hash as string,
				);
			}
		}
		const found = await items();
		expect(
			found
				.filter((item) => item.kind === "skill")
				.map((item) => [item.origin, item.status]),
		).toEqual([
			["project", "enabled"],
			["user", "shadowed"],
		]);
		expect(
			found.find((item) => item.kind === "skill" && item.origin === "user")
				?.detail,
		).toBe(`和 ${project} 同名`);
		expect(
			found
				.filter((item) => item.kind === "mcp_server")
				.map((item) => [item.origin, item.name, item.status]),
		).toEqual([
			["user", "tools", "enabled"],
			["project", "tools", "shadowed"],
		]);
	});

	test("加载失败只影响它自己，原因写在状态里", async () => {
		writeSkill(join(dirs.home, ".agents", "skills"), "notes", "记笔记");
		writeFile(join(dirs.root, "hooks.json"), '{"hooks": {"Nope": []}}');
		writeMcpConfig(join(dirs.root, "mcp.json"), {
			old: { type: "http", url: "https://mcp.example.invalid/" },
			tools: fixtureServer(),
		});
		const found = await items();
		expect(found.find((item) => item.kind === "hooks")).toMatchObject({
			status: "failed",
		});
		expect(found.find((item) => item.kind === "skill")?.status).toBe("enabled");
		expect(
			found
				.filter((item) => item.kind === "mcp_server")
				.map((item) => item.name),
		).toEqual(["tools"]);
		const { warnings } = await host.extensions.list(dirs.workspace);
		expect(warnings.join("\n")).toContain("streamable-http");
	});
});

describe("用户级的 mcp.json", () => {
	test("加一个 server、再删掉", async () => {
		await host.extensions.addMcpServer("docs", {
			type: "streamable-http",
			url: "https://mcp.example.invalid/mcp",
		});
		expect((await named("mcp_server", "docs")).status).toBe("enabled");
		await expect(
			host.extensions.addMcpServer("docs", fixtureServer()),
		).rejects.toThrow("已经有 docs");
		expect(await host.extensions.removeMcpServer("docs")).toBe(true);
		expect(await host.extensions.removeMcpServer("docs")).toBe(false);
		expect(await items()).toEqual([]);
	});

	test("不合规范的声明不写进文件", async () => {
		await expect(
			host.extensions.addMcpServer("bad", {
				type: "http",
				url: "https://mcp.example.invalid/",
			}),
		).rejects.toThrow(ConfigError);
		await expect(
			host.extensions.addMcpServer("bad", {
				type: "streamable-http",
				url: "http://mcp.example.invalid/",
			}),
		).rejects.toThrow("https");
		expect(existsSync(join(dirs.root, "mcp.json"))).toBe(false);
	});
});

/** 一个带 skill、MCP server 和 hooks 的插件目录。 */
function writePlugin(directory: string, version = "1.0.0"): void {
	writeFile(
		join(directory, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "demo",
			version,
			description: "演示插件",
		}),
	);
	writeSkill(join(directory, "skills"), "review", "审阅改动");
	writeMcpConfig(join(directory, "mcp.json"), { tools: fixtureServer() });
	writeHookScript(join(directory, "dev.ospreycode", "stop.cjs"));
	writeHooks(join(directory, "dev.ospreycode", "hooks.json"), {
		Stop: [{ hooks: [{ command: "./stop.cjs", onFailure: "continue" }] }],
	});
}

describe("插件", () => {
	let source: string;

	beforeEach(() => {
		source = join(dirs.home, "src", "demo");
		writePlugin(source);
	});

	test("安装分两步：准备好给用户看，确认后才生效", async () => {
		const stage = await host.extensions.stagePlugin({
			type: "local",
			path: source,
		});
		expect(stage).toMatchObject({
			name: "demo",
			declaredVersion: "1.0.0",
			description: "演示插件",
			skills: [{ name: "review", description: "审阅改动" }],
			unchanged: false,
		});
		expect(stage.servers.map((server) => server.name)).toEqual(["tools"]);
		expect(stage.hooks).toEqual([
			{ event: "Stop", command: "./dev.ospreycode/stop.cjs", args: [] },
		]);
		expect(stage.executables).toEqual(["dev.ospreycode/stop.cjs"]);
		expect(stage.changes).toBeUndefined();
		// 还没确认：不算安装，扩展列表里也没有
		expect(host.extensions.plugins()).toEqual([]);
		expect(await items()).toEqual([]);

		await stage.commit();
		expect(host.extensions.plugins()).toMatchObject([
			{ name: "demo", version: stage.version, source: { type: "local" } },
		]);
		expect(await statuses()).toEqual({
			"plugin plugin demo": "enabled",
			"skill plugin review": "enabled",
			"mcp_server plugin demo_tools": "enabled",
			"hooks plugin": "enabled",
		});
		expect((await named("plugin", "demo")).version).toBe("1.0.0");
		// 装在 Host 根目录里，不在源目录里运行
		expect(
			existsSync(
				join(dirs.root, "plugins", "demo", stage.version, "plugin.json"),
			),
		).toBe(true);
	});

	test("不确认就什么也不留下", async () => {
		const stage = await host.extensions.stagePlugin({
			type: "local",
			path: source,
		});
		stage.discard();
		expect(host.extensions.plugins()).toEqual([]);
		expect(readdirSync(join(dirs.root, "plugins"))).toEqual([]);
	});

	test("不合规的插件装不上", async () => {
		writeFile(join(source, "plugin.json"), '{"name": "Demo Plugin"}');
		await expect(
			host.extensions.stagePlugin({ type: "local", path: source }),
		).rejects.toThrow(ConfigError);
		expect(readdirSync(join(dirs.root, "plugins"))).toEqual([]);
	});

	test("更新列出变了什么，确认后换成新版本；数据目录保留", async () => {
		await (
			await host.extensions.stagePlugin({ type: "local", path: source })
		).commit();
		const [installed] = host.extensions.plugins();
		const data = join(dirs.root, "plugin-data", "demo");
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "state.json"), "{}");

		const same = await host.extensions.stagePluginUpdate("demo");
		expect(same.unchanged).toBe(true);
		same.discard();

		writePlugin(source, "1.1.0");
		writeMcpConfig(join(source, "mcp.json"), {
			tools: fixtureServer({ MODE: "new" }),
		});
		writeFile(join(source, "skills", "review", "extra.md"), "x\n");
		const stage = await host.extensions.stagePluginUpdate("demo");
		expect(stage.unchanged).toBe(false);
		expect(
			stage.changes?.map(({ path, change, category }) => [
				path,
				change,
				category,
			]),
		).toEqual([
			["mcp.json", "modified", "mcp"],
			["plugin.json", "modified", "manifest"],
			["skills/review/extra.md", "added", "other"],
		]);
		expect(
			stage.changes?.find((change) => change.path === "mcp.json")?.diff,
		).toContain("MODE");
		await stage.commit();
		expect(host.extensions.plugins()[0]?.version).not.toBe(installed?.version);
		expect((await named("plugin", "demo")).version).toBe("1.1.0");
		// 没有打开的 session 在用旧版本：旧的版本目录删掉
		expect(readdirSync(join(dirs.root, "plugins", "demo"))).toEqual([
			stage.version,
		]);
		expect(existsSync(join(data, "state.json"))).toBe(true);
	});

	test("装好的内容被改了就停用，重新安装才恢复", async () => {
		const stage = await host.extensions.stagePlugin({
			type: "local",
			path: source,
		});
		await stage.commit();
		writeFile(
			join(dirs.root, "plugins", "demo", stage.version, "skills", "x.md"),
			"tampered\n",
		);
		expect(await statuses()).toEqual({
			"plugin plugin demo": "changed",
			"skill plugin review": "changed",
			"mcp_server plugin demo_tools": "changed",
			"hooks plugin": "changed",
		});
		const plugin = await named("plugin", "demo");
		await expect(
			host.extensions.confirm(dirs.workspace, plugin.id, plugin.hash as string),
		).rejects.toThrow("plugin update");
	});

	test("卸载：去掉登记，数据目录和 server 的缓存目录经确认才删", async () => {
		await (
			await host.extensions.stagePlugin({ type: "local", path: source })
		).commit();
		const data = join(dirs.root, "plugin-data", "demo");
		const cache = join(dirs.root, "server-cache", "plugin", "demo");
		mkdirSync(data, { recursive: true });
		mkdirSync(cache, { recursive: true });
		expect(await host.extensions.removePlugin("demo", false)).toBe(true);
		expect(await items()).toEqual([]);
		expect(existsSync(join(dirs.root, "plugins", "demo"))).toBe(false);
		expect(existsSync(data)).toBe(true);
		expect(existsSync(cache)).toBe(true);

		await (
			await host.extensions.stagePlugin({ type: "local", path: source })
		).commit();
		expect(await host.extensions.removePlugin("demo", true)).toBe(true);
		expect(existsSync(data)).toBe(false);
		expect(existsSync(cache)).toBe(false);
		expect(await host.extensions.removePlugin("demo", true)).toBe(false);
	});

	test("git 地址只接受 https:// 和 file://，不带凭据", async () => {
		await expect(
			host.extensions.stagePlugin({
				type: "git",
				url: "ssh://git@example.invalid/demo.git",
			}),
		).rejects.toThrow("https:// 或 file://");
		await expect(
			host.extensions.stagePlugin({
				type: "git",
				url: "https://user:token@example.invalid/demo.git",
			}),
		).rejects.toThrow("用户名和密码");
	});

	test.runIf(process.platform === "darwin")(
		"从 git 仓库安装：在沙盒里克隆，版本是完整的 commit",
		async () => {
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", source, ...args], {
					env: {
						...dirs.env,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@example.invalid",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@example.invalid",
					},
					encoding: "utf8",
				}).trim();
			git("init", "--quiet");
			git("add", "-A");
			git("commit", "--quiet", "-m", "init");
			const commit = git("rev-parse", "HEAD");
			const stage = await host.extensions.stagePlugin({
				type: "git",
				url: `file://${source}`,
			});
			expect(stage.version).toBe(commit);
			expect(stage.source).toEqual({
				type: "git",
				url: `file://${source}`,
				commit,
			});
			await stage.commit();
			const installed = join(dirs.root, "plugins", "demo", commit);
			expect(readFileSync(join(installed, "plugin.json"), "utf8")).toContain(
				'"demo"',
			);
			expect(existsSync(join(installed, ".git"))).toBe(false);
			// 克隆用的临时目录不留
			expect(
				readdirSync(join(dirs.root, "tmp")).filter((name) =>
					name.startsWith("plugin-"),
				),
			).toEqual([]);
		},
	);
});
