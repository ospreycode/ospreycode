import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `mcp.json` 声明的规范版本。 */
export const mcpSchema =
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** 测试用的本地 MCP server（`fixtures/mcp-server.ts`）。 */
export const serverFixture = fileURLToPath(
	new URL("./fixtures/mcp-server.ts", import.meta.url),
);

/** 写一个文件，上级目录不存在就建出来；`executable` 为真时加执行权限。 */
export function writeFile(
	path: string,
	content: string,
	executable = false,
): void {
	// Host 根目录要求权限为 700：它可能就是这里建出来的
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, content);
	if (executable) chmodSync(path, 0o755);
}

/** 在 `parent` 下写一个 skill，返回它的目录。`files` 是 skill 目录里另外的文件。 */
export function writeSkill(
	parent: string,
	name: string,
	description: string,
	body = `Instructions of ${name}.`,
	files: Record<string, string> = {},
): string {
	const directory = join(parent, name);
	writeFile(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
	);
	for (const [path, content] of Object.entries(files)) {
		writeFile(join(directory, path), content, path.endsWith(".sh"));
	}
	return directory;
}

/** 写一份 `mcp.json`。 */
export function writeMcpConfig(
	file: string,
	servers: Record<string, object>,
): void {
	writeFile(file, JSON.stringify({ $schema: mcpSchema, mcpServers: servers }));
}

/**
 * 用 node 运行测试用 server 的声明。`command` 写命令名，项目级和插件的配置也能用；
 * `env` 是配置里给 server 的环境变量。
 */
export function fixtureServer(
	env: Record<string, string> = {},
): Record<string, unknown> {
	return { type: "stdio", command: "node", args: [serverFixture], env };
}

/** 写一份 `hooks.json`。 */
export function writeHooks(
	file: string,
	hooks: Record<string, object[]>,
): void {
	writeFile(file, JSON.stringify({ hooks }));
}

/** 一个 hook 脚本的行为。 */
export interface HookScript {
	/** 把收到的输入和环境变量追加到这个文件，一次一行 JSON。 */
	log?: string;
	/** 写到 stdout 的对象；是字符串时当作函数的源码，用它从输入算出要输出的对象。 */
	output?: object | string;
	/** 写到 stderr 的话。 */
	stderr?: string;
	exitCode?: number;
	/** 退出之前等多久，毫秒。 */
	delayMs?: number;
	/** 另外执行的语句：可以用 `input` 和 `require`。 */
	body?: string;
}

/** 写一个 hook 脚本（node）。 */
export function writeHookScript(path: string, script: HookScript = {}): void {
	const output =
		typeof script.output === "string"
			? `(${script.output})(input)`
			: JSON.stringify(script.output ?? {});
	writeFile(
		path,
		[
			"#!/usr/bin/env node",
			'const { appendFileSync } = require("node:fs");',
			"let text = '';",
			"process.stdin.on('data', (chunk) => { text += chunk; });",
			"process.stdin.on('end', () => {",
			"\tconst input = JSON.parse(text);",
			script.log === undefined
				? ""
				: `\tappendFileSync(${JSON.stringify(script.log)}, JSON.stringify({ input, env: process.env, cwd: process.cwd() }) + "\\n");`,
			script.body === undefined ? "" : `\t${script.body}`,
			script.stderr === undefined
				? ""
				: `\tprocess.stderr.write(${JSON.stringify(script.stderr)});`,
			script.output === undefined
				? ""
				: `\tprocess.stdout.write(JSON.stringify(${output}));`,
			`\tsetTimeout(() => process.exit(${script.exitCode ?? 0}), ${script.delayMs ?? 0});`,
			"});",
			"",
		].join("\n"),
		true,
	);
}
