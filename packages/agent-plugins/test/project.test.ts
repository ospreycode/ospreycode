// 规范之外、本项目自己规定的行为：用户级配置、本项目的命名空间、给用户的提示。
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isInside,
	ospreyNamespace,
	parseMcpConfig,
	readPlugin,
	staysInside,
} from "@ospreycode/agent-plugins";
import { afterAll, describe, expect, test } from "vitest";

const pluginSchema =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const base = realpathSync(mkdtempSync(join(tmpdir(), "osp-plugins-own-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const limits = {
	pluginData: join(base, "data"),
	maxSkills: 100,
	maxSkillFiles: 100,
};

function pluginDirectory(name: string, manifest: unknown): string {
	const root = join(base, name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest));
	return root;
}

describe("插件之外的 mcp.json", () => {
	const directories = {
		pluginRoot: join(base, "server-root"),
		pluginData: join(base, "server-root"),
	};
	mkdirSync(directories.pluginRoot, { recursive: true });
	const text = JSON.stringify({
		$schema: mcpSchema,
		mcpServers: {
			absolute: { type: "stdio", command: "/opt/tools/server", args: ["x"] },
			relative: { type: "stdio", command: "bin/server" },
		},
	});

	test("用户级配置的 command 另外允许写绝对路径，其余规则不变", () => {
		const parsed = parseMcpConfig(text, { ...directories, userLevel: true });
		expect(parsed.servers).toEqual([
			{
				name: "absolute",
				definition: {
					transport: "stdio",
					command: "/opt/tools/server",
					args: ["x"],
					env: {},
					cwd: directories.pluginRoot,
				},
			},
		]);
		expect(parsed.skipped).toMatchObject([
			{ name: "relative", reason: "invalid" },
		]);
	});

	test("不是用户级配置时绝对路径无效", () => {
		const parsed = parseMcpConfig(text, { ...directories, userLevel: false });
		expect(parsed.servers).toEqual([]);
		expect(parsed.skipped.map((skipped) => skipped.name)).toEqual([
			"absolute",
			"relative",
		]);
	});

	test("不传 plugin.json 的版本时，$schema 只要是支持的版本", () => {
		expect(
			parseMcpConfig(JSON.stringify({ $schema: mcpSchema, mcpServers: {} }), {
				...directories,
				userLevel: false,
			}),
		).toEqual({ servers: [], skipped: [] });
		expect(
			parseMcpConfig(JSON.stringify({ mcpServers: {} }), {
				...directories,
				userLevel: false,
			}).disabled,
		).toBeDefined();
	});

	test('type 写成 "http" 时提示改成 streamable-http', () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: mcpSchema,
				mcpServers: { s: { type: "http", url: "https://example.com/mcp" } },
			}),
			{ ...directories, userLevel: false },
		);
		expect(parsed.skipped[0]?.message).toContain("streamable-http");
	});
});

describe("本项目的命名空间", () => {
	test("命名空间是 dev.ospreycode", () => {
		expect(ospreyNamespace).toBe("dev.ospreycode");
	});

	test("extensions 里本项目的键下有内容时忽略并提示", () => {
		const root = pluginDirectory("with-extension-data", {
			$schema: pluginSchema,
			name: "with-extension-data",
			extensions: {
				"dev.ospreycode": { hooks: { PreToolUse: [] } },
				"com.example.client": { setting: true },
			},
		});
		const { plugin, diagnostics } = readPlugin(root, limits);
		expect(plugin?.namespaceDirectory).toBeUndefined();
		expect(diagnostics).toMatchObject([
			{ code: "extension_data_ignored", subject: "dev.ospreycode" },
		]);
	});

	test("extensions 里本项目的键是空对象时不提示", () => {
		const root = pluginDirectory("empty-extension-data", {
			$schema: pluginSchema,
			name: "empty-extension-data",
			extensions: { "dev.ospreycode": {} },
		});
		expect(readPlugin(root, limits).diagnostics).toEqual([]);
	});

	test("命名空间目录指向插件之外时不返回它的位置", () => {
		const outside = join(base, "outside-namespace");
		mkdirSync(outside, { recursive: true });
		const root = pluginDirectory("linked-namespace", {
			$schema: pluginSchema,
			name: "linked-namespace",
		});
		symlinkSync(outside, join(root, "dev.ospreycode"));
		const { plugin, diagnostics } = readPlugin(root, limits);
		expect(plugin?.namespaceDirectory).toBeUndefined();
		expect(diagnostics).toMatchObject([
			{ code: "path_denied", subject: "dev.ospreycode" },
		]);
	});
});

describe("读取插件目录", () => {
	test("目录不存在时拒绝", () => {
		const result = readPlugin(join(base, "missing"), limits);
		expect(result.plugin).toBeUndefined();
		expect(result.diagnostics).toMatchObject([{ code: "plugin_rejected" }]);
	});

	test("root 是插件目录的真实路径", () => {
		const root = pluginDirectory("real-root", {
			$schema: pluginSchema,
			name: "real-root",
		});
		const link = join(base, "link-to-real-root");
		symlinkSync(root, link);
		expect(readPlugin(link, limits).plugin?.root).toBe(root);
	});

	test("skills 下的目录超过上限时报告没有加载完", () => {
		const root = pluginDirectory("many-skills", {
			$schema: pluginSchema,
			name: "many-skills",
		});
		for (const name of ["a", "b", "c"]) {
			mkdirSync(join(root, "skills", name), { recursive: true });
			writeFileSync(
				join(root, "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: x\n---\n`,
			);
		}
		const { plugin, diagnostics } = readPlugin(root, {
			...limits,
			maxSkills: 2,
		});
		expect(plugin?.skills.map((skill) => skill.name)).toEqual(["a", "b"]);
		expect(diagnostics).toMatchObject([{ code: "skills_invalid" }]);
	});
});

describe("路径检查", () => {
	test("isInside 按路径的分段比较", () => {
		expect(isInside("/a/b", "/a/b")).toBe(true);
		expect(isInside("/a/b/c", "/a/b")).toBe(true);
		expect(isInside("/a/bc", "/a/b")).toBe(false);
		expect(isInside("/a", "/a/b")).toBe(false);
	});

	test("staysInside 跟随符号链接，还不存在的路径按最深的已有上级判断", () => {
		const root = join(base, "contain");
		const outside = join(base, "contain-outside");
		mkdirSync(join(root, "sub"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(root, "out"));
		symlinkSync(join(root, "sub"), join(root, "in"));
		expect(staysInside(join(root, "sub", "new", "file"), root)).toBe(true);
		expect(staysInside(join(root, "in", "file"), root)).toBe(true);
		expect(staysInside(join(root, "out"), root)).toBe(false);
		expect(staysInside(join(root, "out", "new", "file"), root)).toBe(false);
		expect(staysInside(join(root, "..", "contain-outside"), root)).toBe(false);
	});
});
