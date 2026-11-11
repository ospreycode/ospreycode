// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 规范的占位符写法，不是漏了反引号
// 按 Agent Plugins 规范 1.0.0 的正文写的一致性测试：每条测试标明它对应的条款。
// 附录 A 的清单逐项都有对应的测试，清单的条目写在各组测试的名字里。
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	expandPlaceholders,
	type ParsedMcpConfig,
	type PluginReadResult,
	parseManifest,
	parseMcpConfig,
	pluginEnvironment,
	readPlugin,
} from "@ospreycode/agent-plugins";
import { afterAll, describe, expect, test } from "vitest";

const pluginSchema =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const base = realpathSync(mkdtempSync(join(tmpdir(), "osp-plugins-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;

/** 建一个插件目录：`files` 的键是相对路径，值是内容；对象按 JSON 写入。 */
function plugin(files: Record<string, unknown>): string {
	counter += 1;
	const root = join(base, `plugin-${counter}`);
	mkdirSync(root, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			typeof content === "string" ? content : JSON.stringify(content),
		);
	}
	return root;
}

function read(root: string): PluginReadResult {
	return readPlugin(root, {
		pluginData: join(base, "data", `d-${counter}`),
		maxSkills: 100,
		maxSkillFiles: 100,
	});
}

const minimal = { $schema: pluginSchema, name: "minimal-plugin" };

function skill(name: string, description = "Does a thing."): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
}

function codes(result: PluginReadResult): string[] {
	return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("§4.1 插件包：路径不能跑到插件目录之外", () => {
	test("§4.1(2)：根目录下没有 plugin.json 时拒绝插件", () => {
		const result = read(plugin({ "skills/a/SKILL.md": skill("a") }));
		expect(result.plugin).toBeUndefined();
		expect(codes(result)).toEqual(["plugin_rejected"]);
	});

	test("§4.1 失败范围 1：plugin.json 指向插件之外时拒绝插件", () => {
		const outside = plugin({ "plugin.json": minimal });
		const root = plugin({ "skills/a/SKILL.md": skill("a") });
		symlinkSync(join(outside, "plugin.json"), join(root, "plugin.json"));
		const result = read(root);
		expect(result.plugin).toBeUndefined();
		expect(codes(result)).toEqual(["plugin_rejected"]);
	});

	test("§4.1(3)：指向插件内的符号链接可以使用", () => {
		const root = plugin({
			"real/plugin.json": minimal,
			"real/skills/a/SKILL.md": skill("a"),
		});
		symlinkSync(join(root, "real", "plugin.json"), join(root, "plugin.json"));
		symlinkSync(join(root, "real", "skills"), join(root, "skills"));
		const result = read(root);
		expect(result.plugin?.skills.map((item) => item.name)).toEqual(["a"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("§4.1 失败范围 2：固定位置指向插件之外时，这一类组件用不了，另一类照常加载", () => {
		const outside = plugin({ "skills/a/SKILL.md": skill("a") });
		const root = plugin({
			"plugin.json": minimal,
			"mcp.json": {
				$schema: mcpSchema,
				mcpServers: { s: { type: "stdio", command: "node" } },
			},
		});
		symlinkSync(join(outside, "skills"), join(root, "skills"));
		const result = read(root);
		expect(result.plugin?.skills).toEqual([]);
		expect(result.plugin?.mcpServers.map((item) => item.name)).toEqual(["s"]);
		expect(codes(result)).toEqual(["skills_invalid"]);
	});

	test("§4.1 失败范围 3：SKILL.md 指向插件之外时只跳过这个 skill", () => {
		const outside = plugin({ "SKILL.md": skill("escaped") });
		const root = plugin({
			"plugin.json": minimal,
			"skills/kept/SKILL.md": skill("kept"),
		});
		mkdirSync(join(root, "skills", "escaped"));
		symlinkSync(
			join(outside, "SKILL.md"),
			join(root, "skills", "escaped", "SKILL.md"),
		);
		const result = read(root);
		expect(result.plugin?.skills.map((item) => item.name)).toEqual(["kept"]);
		expect(result.diagnostics).toMatchObject([
			{ code: "skill_skipped", subject: "escaped" },
		]);
	});

	test("§4.1 失败范围 4：server 的 command 或 cwd 跑到插件之外时，这个 server 无效", () => {
		const outside = plugin({ "bin/server": "#!/bin/sh\n" });
		const root = plugin({
			"plugin.json": minimal,
			"bin/ok": "#!/bin/sh\n",
			"mcp.json": {
				$schema: mcpSchema,
				mcpServers: {
					"dot-dot": { type: "stdio", command: "../bin/server" },
					"escaping-relative": {
						type: "stdio",
						command: "./../bin/server",
					},
					"linked-command": { type: "stdio", command: "./linked/server" },
					"cwd-not-relative": { type: "stdio", command: "node", cwd: "data" },
					"cwd-escapes": { type: "stdio", command: "node", cwd: "./../x" },
					"cwd-linked": { type: "stdio", command: "node", cwd: "./linked" },
					valid: { type: "stdio", command: "./bin/ok", cwd: "./bin" },
				},
			},
		});
		symlinkSync(join(outside, "bin"), join(root, "linked"));
		const result = read(root);
		expect(result.plugin?.mcpServers).toEqual([
			{
				name: "valid",
				definition: {
					transport: "stdio",
					command: join(root, "bin", "ok"),
					args: [],
					env: {},
					cwd: join(root, "bin"),
				},
			},
		]);
		expect(
			result.diagnostics.map(({ code, subject }) => [code, subject]),
		).toEqual([
			["server_invalid", "dot-dot"],
			["server_invalid", "escaping-relative"],
			["server_invalid", "linked-command"],
			["server_invalid", "cwd-not-relative"],
			["server_invalid", "cwd-escapes"],
			["server_invalid", "cwd-linked"],
		]);
	});

	test("§4.1 失败范围 5：skill 里指向插件之外的文件不列出，skill 本身照常加载", () => {
		const outside = plugin({ "secret.txt": "secret" });
		const root = plugin({
			"plugin.json": minimal,
			"skills/a/SKILL.md": skill("a"),
			"skills/a/references/in.md": "in",
		});
		symlinkSync(
			join(outside, "secret.txt"),
			join(root, "skills", "a", "references", "out.md"),
		);
		const result = read(root);
		expect(result.plugin?.skills[0]?.files).toEqual([
			"SKILL.md",
			"references/in.md",
		]);
		expect(result.diagnostics).toMatchObject([
			{ code: "skill_issue", subject: "a" },
		]);
	});

	test("§4.1(5)：args 和 env 的值是不透明的字符串，不按路径检查", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: mcpSchema,
				mcpServers: {
					s: {
						type: "stdio",
						command: "node",
						args: ["../../outside", "/etc/passwd"],
						env: { TARGET: "../elsewhere" },
					},
				},
			}),
			{ pluginRoot: base, pluginData: join(base, "data"), userLevel: false },
		);
		expect(parsed.skipped).toEqual([]);
		expect(parsed.servers[0]?.definition).toMatchObject({
			args: ["../../outside", "/etc/passwd"],
			env: { TARGET: "../elsewhere" },
		});
	});
});

describe("§5 plugin.json（清单：解析并校验 plugin.json；校验必填的 $schema 和 name；校验名称；报告并忽略未知字段）", () => {
	test("§5.2：最小的清单和完整的清单都能加载", () => {
		expect(parseManifest(JSON.stringify(minimal))).toEqual({
			manifest: {
				specVersion: "1.0.0",
				name: "minimal-plugin",
				extensions: {},
			},
			errors: [],
			warnings: [],
		});
		const full = {
			$schema: pluginSchema,
			name: "plugin-name",
			version: "1.2.0",
			description: "Brief plugin description",
			author: {
				name: "Author Name",
				email: "author@example.com",
				url: "https://example.com",
			},
			homepage: "https://docs.example.com/plugin",
			repository: "https://github.com/example/plugin",
			license: "MIT",
			keywords: ["keyword1", "keyword2"],
			extensions: { "com.example.client": { setting: true } },
		};
		const { $schema: _, ...fields } = full;
		expect(parseManifest(JSON.stringify(full))).toEqual({
			manifest: { specVersion: "1.0.0", ...fields },
			errors: [],
			warnings: [],
		});
	});

	test.each([
		["不是 JSON", "{ not json"],
		["顶层是数组", "[]"],
		["顶层是字符串", '"plugin"'],
	])("§5.2：清单%s时拒绝插件", (_, text) => {
		const parsed = parseManifest(text);
		expect(parsed.manifest).toBeUndefined();
		expect(parsed.errors).toHaveLength(1);
	});

	test("§5.2：未知的顶层字段报告后忽略，插件照常加载，字段不带任何含义", () => {
		const parsed = parseManifest(
			JSON.stringify({
				...minimal,
				mcpServers: { s: { type: "stdio", command: "node" } },
				skills: "./custom",
			}),
		);
		expect(parsed.manifest).toEqual({
			specVersion: "1.0.0",
			name: "minimal-plugin",
			extensions: {},
		});
		expect(parsed.errors).toEqual([]);
		expect(parsed.warnings).toHaveLength(2);
		expect(parsed.warnings[0]).toContain("mcpServers");
		expect(parsed.warnings[1]).toContain("skills");
	});

	test("§5.2：不支持的规范版本拒绝插件，并报告这个版本", () => {
		const unsupported =
			"https://agent-plugins.org/schemas/2.0.0/plugin.schema.json";
		const parsed = parseManifest(
			JSON.stringify({ $schema: unsupported, name: "p" }),
		);
		expect(parsed.manifest).toBeUndefined();
		expect(parsed.errors[0]).toContain(unsupported);
	});

	test.each([
		["缺少 $schema", { name: "p" }],
		["$schema 不是字符串", { $schema: 1, name: "p" }],
		["$schema 是空的", { $schema: "", name: "p" }],
		["缺少 name", { $schema: pluginSchema }],
		["name 不是字符串", { $schema: pluginSchema, name: 7 }],
		["name 是空的", { $schema: pluginSchema, name: "" }],
	])("§5.3：%s时拒绝插件，不查找也不执行它的组件", (_, manifest) => {
		const result = read(
			plugin({
				"plugin.json": manifest,
				"skills/a/SKILL.md": skill("a"),
				"mcp.json": {
					$schema: mcpSchema,
					mcpServers: { s: { type: "stdio", command: "node" } },
				},
			}),
		);
		expect(result.plugin).toBeUndefined();
		expect(new Set(codes(result))).toEqual(new Set(["plugin_rejected"]));
	});

	test.each([
		["version 不是字符串", { version: 1 }],
		["description 不是字符串", { description: ["x"] }],
		["homepage 不是字符串", { homepage: {} }],
		["repository 不是字符串", { repository: 3 }],
		["license 不是字符串", { license: false }],
		["keywords 不是数组", { keywords: "a,b" }],
		["keywords 里有不是字符串的项", { keywords: ["a", 1] }],
		["author 不是对象", { author: "Name" }],
		["author 里有其他字段", { author: { name: "N", twitter: "@n" } }],
		["author 的字段不是字符串", { author: { name: 1 } }],
		["extensions 的成员不是对象", { extensions: { "com.example": "x" } }],
	])("§5.2、§5.4：%s属于其他 schema 违规，拒绝插件", (_, fields) => {
		const parsed = parseManifest(JSON.stringify({ ...minimal, ...fields }));
		expect(parsed.manifest).toBeUndefined();
		expect(parsed.errors).toHaveLength(1);
	});

	test("§5.4：元数据字段只按 JSON 类型校验", () => {
		const parsed = parseManifest(
			JSON.stringify({
				...minimal,
				version: "not-semver",
				homepage: "not a url",
				repository: "also not a url",
				license: "Custom License, see LICENSE",
				author: { email: "not-an-email", url: "nowhere" },
			}),
		);
		expect(parsed.errors).toEqual([]);
		expect(parsed.manifest?.version).toBe("not-semver");
	});

	test.each(["my-plugin", "acme.tools", "lint3r", "a", "a".repeat(64)])(
		"§5.5：名称 %j 有效",
		(name) => {
			expect(
				parseManifest(JSON.stringify({ $schema: pluginSchema, name })).manifest
					?.name,
			).toBe(name);
		},
	);

	test.each([
		"My-Plugin",
		"-start",
		"end-",
		".start",
		"end.",
		"has--double",
		"too.many..dots",
		"under_score",
		"with space",
		"名字",
		"a".repeat(65),
	])("§5.5：名称 %j 无效，拒绝插件", (name) => {
		const parsed = parseManifest(
			JSON.stringify({ $schema: pluginSchema, name }),
		);
		expect(parsed.manifest).toBeUndefined();
		expect(parsed.errors).toHaveLength(1);
	});
});

describe("§6 组件的查找（清单：在固定位置查找每种支持的组件；固定位置不存在不算错）", () => {
	test("§6.1：从 skills/ 和 mcp.json 找到组件", () => {
		const result = read(
			plugin({
				"plugin.json": { $schema: pluginSchema, name: "reports-plugin" },
				"skills/summarize/SKILL.md": skill("summarize"),
				"mcp.json": {
					$schema: mcpSchema,
					mcpServers: { api: { type: "stdio", command: "node" } },
				},
			}),
		);
		expect(result.plugin?.skills.map((item) => item.name)).toEqual([
			"summarize",
		]);
		expect(result.plugin?.mcpServers.map((item) => item.name)).toEqual(["api"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("§6.1：plugin.json 不能改变组件的位置，也不能内嵌组件配置", () => {
		const result = read(
			plugin({
				"plugin.json": {
					...minimal,
					skills: "./custom-skills",
					mcpServers: { inline: { type: "stdio", command: "node" } },
				},
				"custom-skills/a/SKILL.md": skill("a"),
			}),
		);
		expect(result.plugin?.skills).toEqual([]);
		expect(result.plugin?.mcpServers).toEqual([]);
		expect(codes(result)).toEqual([
			"manifest_field_ignored",
			"manifest_field_ignored",
		]);
	});

	test("§6.2：固定位置都不存在时不报错", () => {
		const result = read(plugin({ "plugin.json": minimal }));
		expect(result.plugin).toMatchObject({ skills: [], mcpServers: [] });
		expect(result.diagnostics).toEqual([]);
	});

	test("§6.2：skills 不是目录时这一类用不了，MCP 照常加载", () => {
		const result = read(
			plugin({
				"plugin.json": minimal,
				skills: "not a directory",
				"mcp.json": {
					$schema: mcpSchema,
					mcpServers: { s: { type: "stdio", command: "node" } },
				},
			}),
		);
		expect(result.plugin?.mcpServers.map((item) => item.name)).toEqual(["s"]);
		expect(codes(result)).toEqual(["skills_invalid"]);
	});

	test("§6.2：mcp.json 不是普通文件时这一类用不了，skills 照常加载", () => {
		const root = plugin({
			"plugin.json": minimal,
			"skills/a/SKILL.md": skill("a"),
		});
		mkdirSync(join(root, "mcp.json"));
		const result = read(root);
		expect(result.plugin?.skills.map((item) => item.name)).toEqual(["a"]);
		expect(codes(result)).toEqual(["mcp_disabled"]);
	});

	test("§6.2：固定位置是断开的符号链接时这一类用不了", () => {
		const root = plugin({ "plugin.json": minimal });
		symlinkSync(join(root, "nowhere"), join(root, "skills"));
		symlinkSync(join(root, "nowhere.json"), join(root, "mcp.json"));
		const result = read(root);
		expect(result.plugin).toBeDefined();
		expect(codes(result)).toEqual(["skills_invalid", "mcp_disabled"]);
	});
});

describe("§7.1 skills", () => {
	test("每个直接子目录里名字正好是 SKILL.md 的普通文件算一个 skill，不往更深处找", () => {
		const root = plugin({
			"plugin.json": minimal,
			"skills/deploy/SKILL.md": skill("deploy"),
			"skills/deploy/scripts/rollback.sh": "#!/bin/sh\n",
			"skills/deploy/references/runbook.md": "runbook",
			"skills/group/nested/SKILL.md": skill("nested"),
			"skills/lowercase/skill.md": skill("lowercase"),
			"skills/README.md": "not a skill",
		});
		mkdirSync(join(root, "skills", "directory", "SKILL.md"), {
			recursive: true,
		});
		const result = read(root);
		expect(result.plugin?.skills).toMatchObject([
			{
				name: "deploy",
				directory: join(root, "skills", "deploy"),
				files: ["SKILL.md", "references/runbook.md", "scripts/rollback.sh"],
			},
		]);
		expect(result.diagnostics).toEqual([]);
	});

	test("不符合 Agent Skills 规范的 skill 被跳过并报告，其他 skill 和组件照常加载", () => {
		const result = read(
			plugin({
				"plugin.json": minimal,
				"skills/good/SKILL.md": skill("good"),
				"skills/wrong-name/SKILL.md": skill("other-name"),
				"skills/no-description/SKILL.md": "---\nname: no-description\n---\n",
				"skills/no-frontmatter/SKILL.md": "# Just text\n",
				"skills/Upper/SKILL.md": skill("Upper"),
				"skills/long/SKILL.md": skill("long", "d".repeat(1025)),
				"mcp.json": {
					$schema: mcpSchema,
					mcpServers: { s: { type: "stdio", command: "node" } },
				},
			}),
		);
		expect(result.plugin?.skills.map((item) => item.name)).toEqual(["good"]);
		expect(result.plugin?.mcpServers).toHaveLength(1);
		expect(
			result.diagnostics.map(({ code, subject }) => [code, subject]),
		).toEqual([
			["skill_skipped", "Upper"],
			["skill_skipped", "long"],
			["skill_skipped", "no-description"],
			["skill_skipped", "no-frontmatter"],
			["skill_skipped", "wrong-name"],
		]);
		expect(
			result.diagnostics.every((diagnostic) => diagnostic.message !== ""),
		).toBe(true);
	});
});

const directories = {
	pluginRoot: join(base, "config-root"),
	pluginData: join(base, "config-data"),
};
mkdirSync(directories.pluginRoot, { recursive: true });

function config(
	mcpServers: Record<string, unknown>,
	top: Record<string, unknown> = {},
): ParsedMcpConfig {
	return parseMcpConfig(
		JSON.stringify({ $schema: mcpSchema, mcpServers, ...top }),
		{ ...directories, userLevel: false, manifestVersion: "1.0.0" },
	);
}

/** 只有一个 server 的配置：有效时返回它的定义，否则返回跳过的原因。 */
function one(entry: unknown) {
	const parsed = config({ s: entry });
	return parsed.servers[0]?.definition ?? parsed.skipped[0]?.reason;
}

describe("§7.2.1 mcp.json 的格式（清单：选用支持的 $schema，再校验 mcp.json 和每个 server 的封闭格式）", () => {
	test("mcpServers 为空对象时有效", () => {
		expect(config({})).toEqual({ servers: [], skipped: [] });
	});

	test("规范里的例子：stdio、streamable-http 加载，sse 因为不支持而跳过", () => {
		const parsed = config({
			"local-validator": {
				type: "stdio",
				command: "./bin/validator",
				args: ["--data", "${PLUGIN_DATA}/validator"],
				env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
				cwd: "${PLUGIN_ROOT}",
			},
			"deployment-api": {
				type: "streamable-http",
				url: "https://deploy.example.com/mcp",
				headers: { "X-Tenant": "public-tenant" },
			},
			"legacy-events": { type: "sse", url: "https://legacy.example.com/sse" },
		});
		expect(parsed.servers).toEqual([
			{
				name: "local-validator",
				definition: {
					transport: "stdio",
					command: join(directories.pluginRoot, "bin", "validator"),
					args: ["--data", `${directories.pluginData}/validator`],
					env: { CONFIG: `${directories.pluginRoot}/config.json` },
					cwd: directories.pluginRoot,
				},
			},
			{
				name: "deployment-api",
				definition: {
					transport: "streamable-http",
					url: "https://deploy.example.com/mcp",
					headers: { "X-Tenant": "public-tenant" },
				},
			},
		]);
		expect(parsed.skipped).toMatchObject([
			{ name: "legacy-events", reason: "unsupported_transport" },
		]);
	});

	test.each([
		["缺少 type", { command: "node" }],
		["type 的值不认识", { type: "websocket", url: "wss://example.com" }],
		["type 写成 http", { type: "http", url: "https://example.com/mcp" }],
		["stdio 有未知字段", { type: "stdio", command: "node", shell: true }],
		[
			"stdio 带远程 server 的字段",
			{ type: "stdio", command: "node", url: "https://example.com" },
		],
		[
			"远程 server 带 stdio 的字段",
			{ type: "streamable-http", url: "https://example.com", args: [] },
		],
		[
			"远程 server 有未知字段",
			{ type: "streamable-http", url: "https://example.com", oauth: {} },
		],
		["sse 有未知字段", { type: "sse", url: "https://example.com", x: 1 }],
		["server 不是对象", "node server.js"],
		["stdio 缺少 command", { type: "stdio" }],
		["command 是空的", { type: "stdio", command: "" }],
		["command 不是字符串", { type: "stdio", command: ["node"] }],
		["args 不是数组", { type: "stdio", command: "node", args: "a b" }],
		["args 里有不是字符串的项", { type: "stdio", command: "node", args: [1] }],
		["env 不是对象", { type: "stdio", command: "node", env: ["A=1"] }],
		["env 的值不是字符串", { type: "stdio", command: "node", env: { A: 1 } }],
		["cwd 不是字符串", { type: "stdio", command: "node", cwd: 1 }],
		["远程 server 缺少 url", { type: "streamable-http" }],
		[
			"headers 的值不是字符串",
			{
				type: "streamable-http",
				url: "https://example.com",
				headers: { A: 1 },
			},
		],
	])("%s时这个 server 无效", (_, entry) => {
		expect(one(entry)).toBe("invalid");
	});
});

describe("§7.2.1 stdio（清单：command 解析成单个命令名或插件内路径的可执行词；默认工作目录是插件根目录；校验 cwd 的写法和解析后的位置；不要求配置的 PATH 影响命令名的解析）", () => {
	test("命令名原样保留，交给平台的可执行文件查找；args 单独传递", () => {
		expect(
			one({ type: "stdio", command: "npx", args: ["-y", "some-server"] }),
		).toEqual({
			transport: "stdio",
			command: "npx",
			args: ["-y", "some-server"],
			env: {},
			cwd: directories.pluginRoot,
		});
	});

	test("command 保持一个词：带空格的字符串不拆成命令和参数", () => {
		expect(one({ type: "stdio", command: "node server.js" })).toMatchObject({
			command: "node server.js",
			args: [],
		});
	});

	test("./ 开头的 command 相对插件根目录解析", () => {
		expect(one({ type: "stdio", command: "./bin/server" })).toMatchObject({
			command: join(directories.pluginRoot, "bin", "server"),
		});
	});

	test.each([
		"/usr/bin/node",
		"bin/server",
		"../server",
		"${PLUGIN_ROOT}/bin/server",
		"${PLUGIN_DATA}/bin/server",
	])("command %j 既不是命令名也不是 ./ 开头的路径，server 无效", (command) => {
		expect(one({ type: "stdio", command })).toBe("invalid");
	});

	test("配置的 PATH 只作为环境变量传给进程，不改变 command", () => {
		expect(
			one({ type: "stdio", command: "tool", env: { PATH: "/opt/bin" } }),
		).toMatchObject({ command: "tool", env: { PATH: "/opt/bin" } });
	});

	test("没有写 cwd 时用插件根目录", () => {
		expect(one({ type: "stdio", command: "node" })).toMatchObject({
			cwd: directories.pluginRoot,
		});
	});

	test.each([
		["./work", join(directories.pluginRoot, "work")],
		["${PLUGIN_ROOT}", directories.pluginRoot],
		["${PLUGIN_ROOT}/work", join(directories.pluginRoot, "work")],
		["${PLUGIN_DATA}", directories.pluginData],
		["${PLUGIN_DATA}/cache", join(directories.pluginData, "cache")],
	])("cwd %j 有效，先展开占位符再解析", (cwd, expected) => {
		expect(one({ type: "stdio", command: "node", cwd })).toMatchObject({
			cwd: expected,
		});
	});

	test.each([
		"work",
		"/tmp",
		"../outside",
		"${PLUGIN_ROOT}work",
		"${PLUGIN_DATA}-other",
		"${HOME}",
		"./../outside",
		"${PLUGIN_ROOT}/../outside",
		"${PLUGIN_DATA}/../outside",
	])("cwd %j 写法不对或解析后跑到外面，server 无效", (cwd) => {
		expect(one({ type: "stdio", command: "node", cwd })).toBe("invalid");
	});
});

describe("§7.2.1 远程 server（清单：检查远程 url 和按原样使用的 headers）", () => {
	test.each([
		"https://deploy.example.com/mcp",
		"https://example.com:8443/mcp?tenant=a",
		"http://localhost:3000/mcp",
		"http://127.0.0.1:3000/mcp",
		"http://127.8.9.10/mcp",
		"http://[::1]:3000/mcp",
	])("url %j 有效", (url) => {
		expect(one({ type: "streamable-http", url })).toMatchObject({
			transport: "streamable-http",
			url,
		});
	});

	test.each([
		["不是绝对地址", "/mcp"],
		["不是 http 或 https", "ws://example.com/mcp"],
		["是空的", ""],
		["带用户信息", "https://user:pass@example.com/mcp"],
		["只带用户名", "https://user@example.com/mcp"],
		["带片段", "https://example.com/mcp#section"],
		["带空的片段", "https://example.com/mcp#"],
		["非环回地址用 http", "http://example.com/mcp"],
		["私有网段的地址用 http", "http://192.168.1.10/mcp"],
		["localhost 的子域名用 http", "http://api.localhost/mcp"],
		["带点结尾的 localhost 用 http", "http://localhost./mcp"],
		["IPv4 映射的环回地址用 http", "http://[::ffff:127.0.0.1]/mcp"],
	])("url %s时 server 无效", (_, url) => {
		expect(one({ type: "streamable-http", url })).toBe("invalid");
	});

	test.each([
		["名字里有空格", { "X Tenant": "a" }],
		["名字里有冒号", { "X:Tenant": "a" }],
		["名字是空的", { "": "a" }],
		["值里有换行", { "X-Tenant": "a\r\nX-Injected: b" }],
		["值里有 NUL", { "X-Tenant": "a\u0000b" }],
		["同一个名字只有大小写不同", { "X-Tenant": "a", "x-tenant": "b" }],
	])("headers %s时 server 无效", (_, headers) => {
		expect(
			one({ type: "streamable-http", url: "https://example.com/mcp", headers }),
		).toBe("invalid");
	});

	test("url 和 headers 里不展开占位符和环境变量", () => {
		expect(
			one({
				type: "streamable-http",
				url: "https://example.com/${PLUGIN_ROOT}/mcp",
				headers: { "X-Root": "${PLUGIN_ROOT}", "X-Home": "${HOME} $HOME" },
			}),
		).toEqual({
			transport: "streamable-http",
			url: "https://example.com/$%7BPLUGIN_ROOT%7D/mcp",
			headers: { "X-Root": "${PLUGIN_ROOT}", "X-Home": "${HOME} $HOME" },
		});
	});
});

describe("§7.2.2 加载规则（清单：跳过传输不支持的 server，不影响其他 server 和组件；一个组件出问题时其他的照常加载）", () => {
	test.each([
		["不是合法的 JSON", "{ nope"],
		["顶层不是对象", "[]"],
		["缺少 $schema", JSON.stringify({ mcpServers: {} })],
		[
			"规范版本不支持",
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/9.0.0/mcp.schema.json",
				mcpServers: {},
			}),
		],
		["缺少 mcpServers", JSON.stringify({ $schema: mcpSchema })],
		[
			"mcpServers 不是对象",
			JSON.stringify({ $schema: mcpSchema, mcpServers: [] }),
		],
		[
			"顶层有其他字段",
			JSON.stringify({ $schema: mcpSchema, mcpServers: {}, inputs: [] }),
		],
	])("规则 2：mcp.json %s时停用这个插件的 MCP，skills 照常加载", (_, text) => {
		const result = read(
			plugin({
				"plugin.json": minimal,
				"skills/a/SKILL.md": skill("a"),
				"mcp.json": text,
			}),
		);
		expect(result.plugin?.skills.map((item) => item.name)).toEqual(["a"]);
		expect(result.plugin?.mcpServers).toEqual([]);
		expect(codes(result)).toEqual(["mcp_disabled"]);
	});

	test("规则 2、§10.1：mcp.json 的规范版本和 plugin.json 不同时停用 MCP", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: mcpSchema,
				mcpServers: { s: { type: "stdio", command: "node" } },
			}),
			{ ...directories, userLevel: false, manifestVersion: "1.1.0" },
		);
		expect(parsed.servers).toEqual([]);
		expect(parsed.disabled).toContain("1.1.0");
	});

	test("规则 3、4：无效的和传输不支持的 server 各自跳过并报告，其余照常加载", () => {
		const result = read(
			plugin({
				"plugin.json": minimal,
				"skills/a/SKILL.md": skill("a"),
				"mcp.json": {
					$schema: mcpSchema,
					mcpServers: {
						broken: { type: "stdio" },
						legacy: { type: "sse", url: "https://legacy.example.com/sse" },
						"legacy-broken": { type: "sse", url: "http://example.com/sse" },
						local: { type: "stdio", command: "node" },
						remote: { type: "streamable-http", url: "https://example.com/mcp" },
					},
				},
			}),
		);
		expect(result.plugin?.skills).toHaveLength(1);
		expect(result.plugin?.mcpServers.map((item) => item.name)).toEqual([
			"local",
			"remote",
		]);
		expect(
			result.diagnostics.map(({ code, subject }) => [code, subject]),
		).toEqual([
			["server_invalid", "broken"],
			["server_unsupported", "legacy"],
			["server_invalid", "legacy-broken"],
		]);
	});

	test("传输照 type 的声明：streamable-http 和 stdio 的定义各带自己的传输", () => {
		expect(one({ type: "stdio", command: "node" })).toMatchObject({
			transport: "stdio",
		});
		expect(
			one({ type: "streamable-http", url: "https://example.com/mcp" }),
		).toMatchObject({ transport: "streamable-http" });
	});
});

describe("§8 客户端扩展（清单：忽略没有实现的命名空间，不校验其内容；从顶层的命名空间目录找本项目的文件）", () => {
	test("§8.1：extensions 不是对象时报告后忽略，组件照常加载", () => {
		const result = read(
			plugin({
				"plugin.json": { ...minimal, extensions: ["com.example.client"] },
				"skills/a/SKILL.md": skill("a"),
			}),
		);
		expect(result.plugin?.manifest.extensions).toEqual({});
		expect(result.plugin?.skills).toHaveLength(1);
		expect(codes(result)).toEqual(["manifest_field_ignored"]);
	});

	test("§8.1：其他命名空间下的内容不校验，原样带过", () => {
		const extensions = {
			"com.example.client": { anything: [1, { deep: null }], hooks: "x" },
			"com.github.copilot": {},
		};
		const result = read(plugin({ "plugin.json": { ...minimal, extensions } }));
		expect(result.plugin?.manifest.extensions).toEqual(extensions);
		expect(result.diagnostics).toEqual([]);
	});

	test("§8.2：本项目的文件从顶层的 dev.ospreycode/ 目录找，其他命名空间的目录忽略", () => {
		const root = plugin({
			"plugin.json": minimal,
			"dev.ospreycode/hooks.json": { hooks: {} },
			"com.example.client/hooks/hooks.json": { whatever: true },
		});
		const result = read(root);
		expect(result.plugin?.namespaceDirectory).toBe(
			join(root, "dev.ospreycode"),
		);
		expect(result.diagnostics).toEqual([]);
		expect(
			read(plugin({ "plugin.json": minimal })).plugin?.namespaceDirectory,
		).toBeUndefined();
	});
});

describe("§9 环境变量和占位符（清单：提供 PLUGIN_ROOT 和 PLUGIN_DATA；在基础环境上叠加配置的 env；最后设置 PLUGIN_ROOT 和 PLUGIN_DATA；只在 args、env、cwd 里展开这两个占位符）", () => {
	test("§9.1：先是基础环境，再是配置的 env，最后是 PLUGIN_ROOT 和 PLUGIN_DATA", () => {
		expect(
			pluginEnvironment(
				{
					PATH: "/usr/bin",
					HOME: "/home/alex",
					PLUGIN_ROOT: "/ambient/root",
					PLUGIN_DATA: "/ambient/data",
				},
				{ PATH: "/opt/bin", DATA_DIR: `${directories.pluginData}/database` },
				directories,
			),
		).toEqual({
			PATH: "/opt/bin",
			HOME: "/home/alex",
			DATA_DIR: `${directories.pluginData}/database`,
			PLUGIN_ROOT: directories.pluginRoot,
			PLUGIN_DATA: directories.pluginData,
		});
	});

	test("§9.2：规范里的例子", () => {
		expect(
			one({
				type: "stdio",
				command: "npx",
				args: ["--config", "${PLUGIN_ROOT}/config/db.json"],
				cwd: "${PLUGIN_ROOT}",
				env: { DATA_DIR: "${PLUGIN_DATA}/database" },
			}),
		).toEqual({
			transport: "stdio",
			command: "npx",
			args: ["--config", `${directories.pluginRoot}/config/db.json`],
			cwd: directories.pluginRoot,
			env: { DATA_DIR: `${directories.pluginData}/database` },
		});
	});

	test("§9.2：每一处都替换，替换一次，换进去的文字不再扫描", () => {
		const tricky = {
			pluginRoot: "/root/${PLUGIN_DATA}",
			pluginData: "/data/${PLUGIN_ROOT}",
		};
		expect(
			expandPlaceholders(
				"${PLUGIN_ROOT}:${PLUGIN_DATA}:${PLUGIN_ROOT}",
				tricky,
			),
		).toBe("/root/${PLUGIN_DATA}:/data/${PLUGIN_ROOT}:/root/${PLUGIN_DATA}");
	});

	test("§9.2：不认识的占位符原样保留，不做其他变量展开", () => {
		expect(
			one({
				type: "stdio",
				command: "node",
				args: [
					"${HOME}",
					"$PLUGIN_ROOT",
					"${plugin_root}",
					"${PLUGIN_ROOT:-x}",
					"${CLAUDE_PLUGIN_ROOT}",
					"~/file",
					"%PLUGIN_ROOT%",
				],
				env: { A: "${USER}@${HOSTNAME}", B: "$(whoami)" },
			}),
		).toMatchObject({
			args: [
				"${HOME}",
				"$PLUGIN_ROOT",
				"${plugin_root}",
				"${PLUGIN_ROOT:-x}",
				"${CLAUDE_PLUGIN_ROOT}",
				"~/file",
				"%PLUGIN_ROOT%",
			],
			env: { A: "${USER}@${HOSTNAME}", B: "$(whoami)" },
		});
	});

	test("§9.2：env 的键不展开", () => {
		expect(
			one({
				type: "stdio",
				command: "node",
				env: { "${PLUGIN_ROOT}": "${PLUGIN_ROOT}" },
			}),
		).toMatchObject({ env: { "${PLUGIN_ROOT}": directories.pluginRoot } });
	});

	test.each(["PLUGIN_ROOT", "PLUGIN_DATA"])(
		"§9.2：env 里有 %s 时 server 无效",
		(name) => {
			expect(
				one({ type: "stdio", command: "node", env: { [name]: "/elsewhere" } }),
			).toBe("invalid");
		},
	);
});

describe("§11 客户端的最低要求", () => {
	test("§11.1(1)、(8)：能从一个目录路径加载插件，两种组件都支持", () => {
		const root = plugin({
			"plugin.json": {
				$schema: pluginSchema,
				name: "devtools",
				version: "2.0.1",
			},
			"skills/review/SKILL.md": skill("review"),
			"mcp.json": {
				$schema: mcpSchema,
				mcpServers: {
					local: { type: "stdio", command: "node" },
					remote: { type: "streamable-http", url: "https://example.com/mcp" },
				},
			},
			LICENSE: "Apache-2.0",
			"CHANGELOG.md": "# Changelog",
		});
		const result = read(root);
		expect(result.plugin?.root).toBe(root);
		expect(result.plugin?.manifest).toMatchObject({
			name: "devtools",
			version: "2.0.1",
			specVersion: "1.0.0",
		});
		expect(result.plugin?.skills).toHaveLength(1);
		expect(result.plugin?.mcpServers).toHaveLength(2);
		expect(result.diagnostics).toEqual([]);
	});

	test("§11.3(1)：其他类型的组件（命令、agents、hooks 等目录）忽略，不算错", () => {
		const result = read(
			plugin({
				"plugin.json": minimal,
				"commands/deploy.md": "# deploy",
				"agents/reviewer.md": "# reviewer",
				"hooks/hooks.json": { hooks: {} },
				".claude-plugin/plugin.json": { name: "other-format" },
				"skills/a/SKILL.md": skill("a"),
			}),
		);
		expect(result.plugin?.skills).toHaveLength(1);
		expect(result.diagnostics).toEqual([]);
	});

	test("§11.3(3)：一类组件整体出问题不影响另一类", () => {
		const skillsBroken = read(
			plugin({
				"plugin.json": minimal,
				skills: "file",
				"mcp.json": {
					$schema: mcpSchema,
					mcpServers: { s: { type: "stdio", command: "node" } },
				},
			}),
		);
		expect(skillsBroken.plugin?.mcpServers).toHaveLength(1);
		const mcpBroken = read(
			plugin({
				"plugin.json": minimal,
				"skills/a/SKILL.md": skill("a"),
				"mcp.json": "{",
			}),
		);
		expect(mcpBroken.plugin?.skills).toHaveLength(1);
	});
});
