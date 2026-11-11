import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { McpServerDefinition } from "@ospreycode/mcp";
import {
	expandPlaceholders,
	type PluginDirectories,
	staysInside,
} from "../paths/paths.js";

/** 这个包支持的规范版本和它们的 `mcp.json` schema 标识。 */
export const mcpSchemaIds: Readonly<Record<string, string>> = {
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json": "1.0.0",
};

/** 解析 `mcp.json` 时的设置。 */
export interface McpConfigOptions extends PluginDirectories {
	/**
	 * 用户级配置：`command` 另外允许写绝对路径。用户自己写的配置不分发，其余规则和插件的相同。
	 */
	userLevel: boolean;
	/**
	 * `plugin.json` 的规范版本；`mcp.json` 的版本和它不同时停用这个插件的 MCP（§7.2.2）。
	 * 插件之外的 `mcp.json` 没有 `plugin.json`，不传。
	 */
	manifestVersion?: string;
	/**
	 * 按 server 给出它的插件根目录和数据目录，顶替上面两个目录。插件之外的 `mcp.json` 用它：
	 * 那里每个 server 有自己的数据目录。
	 */
	serverDirectories?: (name: string) => PluginDirectories;
}

/** 一个有效的 server 声明。 */
export interface McpServerEntry {
	/** `mcpServers` 里的键。 */
	name: string;
	definition: McpServerDefinition;
}

/** 被跳过的 server 声明。 */
export interface SkippedMcpServer {
	name: string;
	/** `invalid`：不满足规范；`unsupported_transport`：声明有效，但本项目不支持这种传输。 */
	reason: "invalid" | "unsupported_transport";
	message: string;
}

/** 解析 `mcp.json` 的结果。 */
export interface ParsedMcpConfig {
	/** 整份配置用不了的原因；有值时这个插件的 MCP 停用，`servers` 为空。 */
	disabled?: string;
	servers: McpServerEntry[];
	skipped: SkippedMcpServer[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		isObject(value) &&
		Object.values(value).every((item) => typeof item === "string")
	);
}

function unknownField(
	entry: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	return Object.keys(entry).find((key) => !allowed.includes(key));
}

type Parsed = { definition: McpServerDefinition } | { error: string };

function parseStdio(
	entry: Record<string, unknown>,
	options: McpConfigOptions,
): Parsed {
	const unknown = unknownField(entry, [
		"type",
		"command",
		"args",
		"env",
		"cwd",
	]);
	if (unknown !== undefined) {
		return { error: `stdio server 不能有字段 ${unknown}` };
	}
	const { command, args = [], env = {}, cwd } = entry;
	if (typeof command !== "string" || command === "") {
		return { error: "command 要是非空的字符串" };
	}
	if (
		!Array.isArray(args) ||
		!args.every((item): item is string => typeof item === "string")
	) {
		return { error: "args 要是字符串的数组" };
	}
	if (!isStringRecord(env)) return { error: "env 的值都要是字符串" };
	if ("PLUGIN_ROOT" in env || "PLUGIN_DATA" in env) {
		return { error: "env 里不能有 PLUGIN_ROOT 和 PLUGIN_DATA" };
	}

	// command 是一个词，不展开占位符：只有命令名、插件内的路径，以及用户级配置里的绝对路径
	let executable = command;
	if (command.startsWith("./")) {
		executable = resolve(options.pluginRoot, command);
		if (!staysInside(executable, options.pluginRoot)) {
			return { error: `command 指向了插件目录之外：${command}` };
		}
	} else if (command.includes("/") || command.includes("\\")) {
		if (!(options.userLevel && isAbsolute(command))) {
			return {
				error: options.userLevel
					? "command 只能是命令名、./ 开头的路径或绝对路径"
					: "command 只能是命令名或 ./ 开头的插件内路径",
			};
		}
	}

	let directory = options.pluginRoot;
	if (cwd !== undefined) {
		if (typeof cwd !== "string") return { error: "cwd 要是字符串" };
		const inData = /^\$\{PLUGIN_DATA\}(\/|$)/.test(cwd);
		if (
			!inData &&
			!cwd.startsWith("./") &&
			!/^\$\{PLUGIN_ROOT\}(\/|$)/.test(cwd)
		) {
			return {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: 规范的占位符写法，不是漏了反引号
				error: "cwd 只能以 ./、${PLUGIN_ROOT} 或 ${PLUGIN_DATA} 开头",
			};
		}
		directory = resolve(options.pluginRoot, expandPlaceholders(cwd, options));
		const root = inData ? options.pluginData : options.pluginRoot;
		if (!staysInside(directory, root)) {
			return {
				error: `cwd 落在了${inData ? "插件数据目录" : "插件目录"}之外：${cwd}`,
			};
		}
	}

	return {
		definition: {
			transport: "stdio",
			command: executable,
			args: args.map((item) => expandPlaceholders(item, options)),
			env: Object.fromEntries(
				Object.entries(env).map(([key, value]) => [
					key,
					expandPlaceholders(value, options),
				]),
			),
			cwd: directory,
		},
	};
}

/** IPv4 的 127.0.0.0/8 和 IPv6 的 ::1；`hostname` 是 WHATWG URL 规范化后的写法。 */
function isLoopbackLiteral(hostname: string): boolean {
	if (isIP(hostname) === 4) return hostname.startsWith("127.");
	return hostname === "[::1]";
}

function parseRemote(entry: Record<string, unknown>): Parsed {
	const unknown = unknownField(entry, ["type", "url", "headers"]);
	if (unknown !== undefined) {
		return { error: `远程 server 不能有字段 ${unknown}` };
	}
	const { url: text, headers = {} } = entry;
	if (typeof text !== "string" || !URL.canParse(text)) {
		return { error: "url 要是绝对的 http 或 https 地址" };
	}
	const url = new URL(text);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { error: "url 要是绝对的 http 或 https 地址" };
	}
	if (
		url.username !== "" ||
		url.password !== "" ||
		/^[^/?#]*\/\/[^/?#]*@/.test(text)
	) {
		return { error: "url 不能带用户信息" };
	}
	if (text.includes("#")) return { error: "url 不能带片段" };
	if (
		url.protocol === "http:" &&
		url.hostname !== "localhost" &&
		!isLoopbackLiteral(url.hostname)
	) {
		return { error: "除 localhost 和环回地址外，url 必须用 https" };
	}
	if (!isStringRecord(headers)) return { error: "headers 的值都要是字符串" };
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(headers)) {
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
			return { error: `headers 里的名字不是合法的 HTTP 头：${name}` };
		}
		// 值只能是可见字符、空格和制表符，首尾不能有空白（RFC 9110 §5.5）
		if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(value) || value !== value.trim()) {
			return { error: `headers 里 ${name} 的值不是合法的 HTTP 头的值` };
		}
		const lower = name.toLowerCase();
		if (seen.has(lower)) {
			return { error: `headers 里 ${name} 出现了不止一次（只有大小写不同）` };
		}
		seen.add(lower);
	}
	return {
		definition: { transport: "streamable-http", url: url.href, headers },
	};
}

/**
 * 解析并校验一份 `mcp.json`（§7.2）。顶层不满足要求时整份配置停用；单个 server 不满足时只跳过
 * 这一个。`args`、`env` 的值和 `cwd` 里的 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 已经展开，`./` 开头的
 * `command` 已经解析成绝对路径；返回的 `env` 不含 `PLUGIN_ROOT`、`PLUGIN_DATA`，启动时用
 * `pluginEnvironment` 加上。
 */
export function parseMcpConfig(
	text: string,
	options: McpConfigOptions,
): ParsedMcpConfig {
	const disabled = (reason: string): ParsedMcpConfig => ({
		disabled: reason,
		servers: [],
		skipped: [],
	});
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return disabled(`mcp.json 不是合法的 JSON：${(error as Error).message}`);
	}
	if (!isObject(raw)) return disabled("mcp.json 的顶层要是一个对象");
	const { $schema: schema, mcpServers } = raw;
	if (typeof schema !== "string") return disabled("mcp.json 缺少 $schema");
	const version = mcpSchemaIds[schema];
	if (version === undefined) {
		return disabled(`不支持 mcp.json 的 $schema 声明的规范版本：${schema}`);
	}
	if (
		options.manifestVersion !== undefined &&
		options.manifestVersion !== version
	) {
		return disabled(
			`mcp.json 的规范版本 ${version} 和 plugin.json 的 ${options.manifestVersion} 不同`,
		);
	}
	const extra = unknownField(raw, ["$schema", "mcpServers"]);
	if (extra !== undefined) {
		return disabled(`mcp.json 的顶层不能有字段 ${extra}`);
	}
	if (!isObject(mcpServers)) {
		return disabled("mcp.json 缺少 mcpServers，或者它不是对象");
	}

	const result: ParsedMcpConfig = { servers: [], skipped: [] };
	for (const [name, entry] of Object.entries(mcpServers)) {
		const invalid = (message: string) =>
			result.skipped.push({ name, reason: "invalid", message });
		if (!isObject(entry)) {
			invalid("server 的配置要是一个对象");
			continue;
		}
		const { type } = entry;
		if (type !== "stdio" && type !== "streamable-http" && type !== "sse") {
			invalid(
				type === "http"
					? 'type 不能写 "http"，Streamable HTTP 写成 "streamable-http"'
					: "type 要是 stdio、streamable-http 或 sse",
			);
			continue;
		}
		const parsed =
			type === "stdio"
				? parseStdio(entry, {
						...options,
						...options.serverDirectories?.(name),
					})
				: parseRemote(entry);
		if ("error" in parsed) {
			invalid(parsed.error);
		} else if (type === "sse") {
			result.skipped.push({
				name,
				reason: "unsupported_transport",
				message: "不支持已弃用的 HTTP+SSE 传输（type: sse）",
			});
		} else {
			result.servers.push({ name, definition: parsed.definition });
		}
	}
	return result;
}

/**
 * 插件子进程的环境变量（§9.1）：在调用方选定的基础环境上叠加配置的 `env`，最后设置
 * `PLUGIN_ROOT` 和 `PLUGIN_DATA`，配置和基础环境里的同名变量都被替换。
 */
export function pluginEnvironment(
	base: Readonly<Record<string, string>>,
	configured: Readonly<Record<string, string>>,
	directories: PluginDirectories,
): Record<string, string> {
	return {
		...base,
		...configured,
		PLUGIN_ROOT: directories.pluginRoot,
		PLUGIN_DATA: directories.pluginData,
	};
}
