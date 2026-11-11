import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** 测试用的本地 MCP server（`fixtures/mcp-server.mjs`）。 */
export const serverFixture = fileURLToPath(
	new URL("./fixtures/mcp-server.mjs", import.meta.url),
);

/** 在 `mcp.json` 里用 node 运行测试用 server 的写法。 */
export const fixtureServer = {
	type: "stdio",
	command: "node",
	args: [serverFixture],
};

/** 写一个文件，上级目录不存在就建出来；`executable` 为真时加执行权限。 */
export function writeFile(
	path: string,
	content: string,
	executable = false,
): void {
	// Host 根目录要求权限为 700：它里面的目录可能就是这里建出来的
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, content);
	if (executable) chmodSync(path, 0o755);
}

/** 在 `parent` 下写一个 skill。 */
export function writeSkill(
	parent: string,
	name: string,
	description: string,
): void {
	writeFile(
		join(parent, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions of ${name}.\n`,
	);
}

/** 写一份 `mcp.json`。 */
export function writeMcpConfig(
	file: string,
	servers: Record<string, object>,
): void {
	writeFile(file, JSON.stringify({ $schema: mcpSchema, mcpServers: servers }));
}

/** 写一份 `hooks.json`。 */
export function writeHooks(
	file: string,
	hooks: Record<string, object[]>,
): void {
	writeFile(file, JSON.stringify({ hooks }));
}

/**
 * 写一个 hook 脚本（node）：`output` 是函数的源码，用它从收到的输入算出写到 stdout 的对象。
 */
export function writeHookScript(path: string, output: string): void {
	writeFile(
		path,
		[
			"#!/usr/bin/env node",
			"let text = '';",
			"process.stdin.on('data', (chunk) => { text += chunk; });",
			"process.stdin.on('end', () => {",
			`\tprocess.stdout.write(JSON.stringify((${output})(JSON.parse(text))));`,
			"});",
			"",
		].join("\n"),
		true,
	);
}

/** 写一个带 skill、MCP server 和 hooks 的插件。 */
export function writePlugin(directory: string, version: string): void {
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
	writeMcpConfig(join(directory, "mcp.json"), { tools: fixtureServer });
	writeHookScript(join(directory, "dev.ospreycode", "stop.cjs"), "() => ({})");
	writeHooks(join(directory, "dev.ospreycode", "hooks.json"), {
		Stop: [{ hooks: [{ command: "./stop.cjs", onFailure: "continue" }] }],
	});
}
