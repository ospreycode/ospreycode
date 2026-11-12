import { isAbsolute, join, resolve } from "node:path";
import {
	ModelConfigError,
	type ModelFields,
	parseModelFields,
	type ServerToolName,
	serverToolNames,
} from "@ospreycode/api";
import type { ReasoningEffort } from "@ospreycode/api/protocol";
import {
	type ApprovalPolicy,
	approvalPolicies,
	builtinSandboxModes,
	type GranularCategory,
	granularCategories,
	InvalidHostError,
	normalizeHostPattern,
	PermissionConfigError,
	type PermissionProfile,
	parsePermissionProfile,
} from "@ospreycode/sandbox";
import type {
	CommandSource,
	CredentialSource,
} from "../credentials/sources.js";
import { hostSetVariables } from "../processes/environment.js";
import { isInside } from "../project/paths.js";
import { joinKey, KeyError } from "./errors.js";

/** 推理强度的取值，从低到高。 */
export const reasoningEfforts: readonly ReasoningEffort[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 一个上限：数值，或 `null` 表示不设。 */
export type Limit = number | null;

/** `[budget]`：每个 run 的上限。 */
export interface BudgetLayer {
	max_cost_usd?: Limit;
	max_requests?: Limit;
	/** 毫秒；配置文件里写成 `max_duration = "30m"` 这样的时长。 */
	max_duration_ms?: Limit;
}

/** 一层配置：用户级配置、仓库配置或启动参数。都已校验，路径都已换成绝对路径。 */
export interface ConfigLayer {
	model?: string;
	reasoning_effort?: ReasoningEffort;
	sandbox_mode?: string;
	approval_policy?: ApprovalPolicy;
	approval_granular?: Partial<Record<GranularCategory, boolean>>;
	permissions?: Record<string, PermissionProfile>;
	environment?: Record<string, string>;
	budget?: BudgetLayer;
	deny_read?: string[];
	deny_write?: string[];
	models?: Record<string, ModelFields>;
	credentials?: Record<string, CredentialSource>;
	/** `[mcp_clients.<标签>]`：预先注册的 MCP OAuth 客户端，键是 server 的标签。 */
	mcp_clients?: Record<string, McpClientLayer>;
	/**
	 * `[mcp_secrets.<标签>]`：本地 MCP server 的密钥，键是 server 的标签，再是环境变量名，
	 * 值是真实值可以发往的域名。
	 */
	mcp_secrets?: Record<string, Record<string, string[]>>;
	/** 打开 session 时等每个 MCP server 就绪的秒数。 */
	mcp_startup_timeout_sec?: number;
	proxy?: string;
	/** 可选工具的开关，键是工具名。 */
	tools?: Record<string, boolean>;
	/** `[server_tools.<服务名>]`：模型服务自带的服务端工具的开关，键是服务名，再是工具名。 */
	server_tools?: Record<string, Partial<Record<ServerToolName, boolean>>>;
	ui?: UiLayer;
	/** session 记录保存的天数，从最后一次写入算起；只认用户级配置。 */
	session_retention_days?: number;
	/** `[agents.<名字>]`：子 agent 的定义，键是名字。 */
	agents?: Record<string, AgentLayer>;
}

/** 一个子 agent 的定义。模型和工具的名字在合并各层之后再核对。 */
export interface AgentLayer {
	/** 给主 agent 看的用途。 */
	description: string;
	/** 给子 agent 自己的补充说明。 */
	instructions?: string;
	/** 模型清单里的 ID；仓库配置里写的忽略。 */
	model?: string;
	reasoning_effort?: ReasoningEffort;
	/** 只能写 `read-only`：定义只能在 session 的沙盒模式之上收紧。 */
	sandbox_mode?: "read-only";
	/** 启用的内置工具。 */
	tools?: string[];
	/** `isolated` 的在自己的工作区里运行（worker）。 */
	workspace?: "shared" | "isolated";
}

/** 在授权服务器预先注册的 OAuth 客户端。 */
export interface McpClientLayer {
	client_id: string;
	/** 注册时写了固定回调地址的客户端监听的端口。 */
	callback_port?: number;
}

/** `[ui]`：交互界面的显示设置。 */
export interface UiLayer {
	/** 是否显示模型的推理内容。 */
	show_reasoning?: boolean;
}

/**
 * 配置键在仓库配置里的处理：`user_only` 的键只认用户级配置和启动参数，出现在仓库配置里时忽略
 * 并在启动时列出；`tighten` 的键在仓库配置里只接受更严的值；`normal` 的键可以覆盖用户级配置。
 */
export type KeyClass = "user_only" | "tighten" | "normal";

/** 配置文件里的每个键属于哪一类。 */
export const keyClasses: Readonly<Record<keyof ConfigLayer, KeyClass>> = {
	model: "user_only",
	reasoning_effort: "normal",
	sandbox_mode: "tighten",
	approval_policy: "tighten",
	approval_granular: "tighten",
	permissions: "user_only",
	environment: "user_only",
	budget: "tighten",
	deny_read: "tighten",
	deny_write: "tighten",
	models: "user_only",
	credentials: "user_only",
	mcp_clients: "user_only",
	mcp_secrets: "user_only",
	mcp_startup_timeout_sec: "user_only",
	proxy: "user_only",
	tools: "normal",
	// 打开之后模型能把对话里的内容发到模型服务之外：仓库配置只能关闭
	server_tools: "tighten",
	ui: "normal",
	session_retention_days: "user_only",
	// 仓库配置只能新增定义，其中的 `model` 忽略；和用户级同名的在合并时忽略
	agents: "tighten",
};

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析一层配置时的环境。 */
export interface LayerContext {
	/** 这层配置的来源：用户级配置的路径可以以 `~/` 开头，仓库配置的路径相对项目根目录。 */
	kind: "user" | "repo";
	/** 项目根目录的真实路径。 */
	projectRoot: string;
	/** Host 环境里的 HOME，展开 `~/` 用。 */
	home: string | undefined;
	/** runtime 提供、默认不启用的工具，`[tools]` 只能开关它们。 */
	optionalTools: readonly string[];
}

function isTable(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date)
	);
}

function table(value: unknown, key: string): Record<string, unknown> {
	if (!isTable(value)) throw new KeyError(key, "要是一个表");
	return value;
}

function string(value: unknown, key: string): string {
	if (typeof value !== "string" || value === "") {
		throw new KeyError(key, "要是非空的字符串");
	}
	return value;
}

function oneOf<T extends string>(
	value: unknown,
	key: string,
	choices: readonly T[],
): T {
	if (!choices.includes(value as T)) {
		throw new KeyError(key, `要是 ${choices.join("、")} 之一`);
	}
	return value as T;
}

/** 用户级配置的路径：绝对路径或以 `~/` 开头。 */
function userPath(value: unknown, key: string, home: string | undefined) {
	const path = string(value, key);
	if (path.startsWith("~/")) {
		if (home === undefined) {
			throw new KeyError(key, "Host 的环境变量里没有 HOME，展开不了 ~/");
		}
		return resolve(home, path.slice(2));
	}
	if (!isAbsolute(path)) {
		throw new KeyError(key, "要写绝对路径或以 ~/ 开头");
	}
	return resolve(path);
}

/** 仓库配置的路径：相对项目根目录，只能落在仓库之内。 */
function repoPath(value: unknown, key: string, projectRoot: string): string {
	const path = resolve(projectRoot, string(value, key));
	if (!isInside(path, projectRoot)) {
		throw new KeyError(key, "仓库配置里的路径只能指向仓库之内");
	}
	return path;
}

function paths(value: unknown, key: string, context: LayerContext): string[] {
	if (!Array.isArray(value)) throw new KeyError(key, "要是路径的数组");
	return value.map((item, i) =>
		context.kind === "user"
			? userPath(item, `${key}[${i}]`, context.home)
			: repoPath(item, `${key}[${i}]`, context.projectRoot),
	);
}

const durationUnits: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
};

/** `"none"` 表示不设；时长写成整数加单位 `s`、`m` 或 `h`，如 `"30m"`。 */
function limit(value: unknown, key: string, kind: "usd" | "count" | "time") {
	if (value === "none") return null;
	if (kind === "time") {
		const match =
			typeof value === "string" ? /^([1-9]\d*)([smh])$/.exec(value) : null;
		if (match === null) {
			throw new KeyError(
				key,
				'要写成 "30m" 这样的时长（单位 s、m、h），或 "none"',
			);
		}
		return Number(match[1]) * (durationUnits[match[2] ?? ""] ?? 0);
	}
	const valid =
		kind === "usd"
			? typeof value === "number" && Number.isFinite(value) && value > 0
			: Number.isSafeInteger(value) && (value as number) >= 1;
	if (!valid) {
		throw new KeyError(
			key,
			kind === "usd" ? '要是大于 0 的数，或 "none"' : '要是正整数，或 "none"',
		);
	}
	return value as number;
}

function budget(value: unknown, key: string): BudgetLayer {
	const result: BudgetLayer = {};
	for (const [name, item] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		switch (name) {
			case "max_cost_usd":
				result.max_cost_usd = limit(item, itemKey, "usd");
				break;
			case "max_requests":
				result.max_requests = limit(item, itemKey, "count");
				break;
			case "max_duration":
				result.max_duration_ms = limit(item, itemKey, "time");
				break;
			default:
				throw new KeyError(itemKey, "不认识的键");
		}
	}
	return result;
}

function granular(
	value: unknown,
	key: string,
): Partial<Record<GranularCategory, boolean>> {
	const result: Partial<Record<GranularCategory, boolean>> = {};
	for (const [name, ask] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		const category = oneOf(name, itemKey, granularCategories);
		if (typeof ask !== "boolean") {
			throw new KeyError(itemKey, "要是 true（询问）或 false（自动拒绝）");
		}
		result[category] = ask;
	}
	return result;
}

function environment(value: unknown, key: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, item] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		if (!variableName.test(name)) {
			throw new KeyError(itemKey, "不是合法的环境变量名");
		}
		if (hostSetVariables.has(name)) {
			throw new KeyError(itemKey, "这个变量由 Host 设置，不能改");
		}
		if (typeof item !== "string") throw new KeyError(itemKey, "要是字符串");
		result[name] = item;
	}
	return result;
}

function permissions(
	value: unknown,
	key: string,
): Record<string, PermissionProfile> {
	const result: Record<string, PermissionProfile> = {};
	for (const [name, profile] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			throw new KeyError(itemKey, "名字只能用字母、数字、下划线和连字符");
		}
		if ((builtinSandboxModes as readonly string[]).includes(name)) {
			throw new KeyError(itemKey, "不能和内置的沙盒模式同名");
		}
		try {
			result[name] = parsePermissionProfile(profile, itemKey);
		} catch (error) {
			if (!(error instanceof PermissionConfigError)) throw error;
			throw new KeyError(error.key, error.message);
		}
	}
	return result;
}

function models(value: unknown, key: string): Record<string, ModelFields> {
	const result: Record<string, ModelFields> = {};
	for (const [id, fields] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, id);
		if (id === "" || /[\s\p{Cc}]/u.test(id)) {
			throw new KeyError(itemKey, "模型 ID 不能为空，也不能有空白和控制字符");
		}
		try {
			result[id] = parseModelFields(fields, itemKey);
		} catch (error) {
			if (!(error instanceof ModelConfigError)) throw error;
			throw new KeyError(error.key, error.message);
		}
	}
	return result;
}

/** 输出凭据的命令：程序加参数数组，不经 shell；两个时间都是毫秒。 */
function commandSource(
	fields: Record<string, unknown>,
	key: string,
): CommandSource {
	const result: CommandSource = { command: "" };
	for (const [name, item] of Object.entries(fields)) {
		const itemKey = joinKey(key, name);
		switch (name) {
			case "command": {
				const program = string(item, itemKey);
				// 相对路径会按 Host 根目录解析，和用户在自己的 shell 里看到的不一样
				if (/[/\\]/.test(program) && !isAbsolute(program)) {
					throw new KeyError(
						itemKey,
						"要是绝对路径，或者不带路径分隔符、按 PATH 查找的程序名",
					);
				}
				result.command = program;
				break;
			}
			case "args":
				if (
					!Array.isArray(item) ||
					item.some((arg) => typeof arg !== "string")
				) {
					throw new KeyError(itemKey, "要是字符串的数组");
				}
				result.args = item;
				break;
			case "timeout_ms":
				if (!Number.isSafeInteger(item) || (item as number) < 1) {
					throw new KeyError(itemKey, "要是正整数（毫秒）");
				}
				result.timeout_ms = item as number;
				break;
			case "refresh_interval_ms":
				if (!Number.isSafeInteger(item) || (item as number) < 0) {
					throw new KeyError(itemKey, "要是不小于 0 的整数（毫秒）");
				}
				result.refresh_interval_ms = item as number;
				break;
			default:
				throw new KeyError(itemKey, "不认识的键");
		}
	}
	return result;
}

function credentials(
	value: unknown,
	key: string,
	home: string | undefined,
): Record<string, CredentialSource> {
	const result: Record<string, CredentialSource> = {};
	for (const [id, source] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, id);
		const fields = table(source, itemKey);
		if (fields.command !== undefined) {
			result[id] = commandSource(fields, itemKey);
			continue;
		}
		const names = Object.keys(fields);
		if (names.length !== 1 || (names[0] !== "file" && names[0] !== "env")) {
			throw new KeyError(
				itemKey,
				'要写成 { file = "<路径>" }、{ env = "<变量名>" } 或 { command = "<程序>", args = ["<参数>"] }',
			);
		}
		if (fields.file !== undefined) {
			result[id] = {
				file: userPath(fields.file, joinKey(itemKey, "file"), home),
			};
		} else {
			const name = string(fields.env, joinKey(itemKey, "env"));
			if (!variableName.test(name)) {
				throw new KeyError(joinKey(itemKey, "env"), "不是合法的环境变量名");
			}
			result[id] = { env: name };
		}
	}
	return result;
}

function tools(
	value: unknown,
	key: string,
	optional: readonly string[],
): Record<string, boolean> {
	const result: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		if (!optional.includes(name)) {
			throw new KeyError(
				itemKey,
				optional.length === 0
					? "不是可选工具：现在没有可以开关的工具"
					: `不是可选工具：可以开关的有 ${optional.join("、")}`,
			);
		}
		if (typeof enabled !== "boolean") {
			throw new KeyError(itemKey, "要是 true（启用）或 false（不启用）");
		}
		result[name] = enabled;
	}
	return result;
}

function serverTools(
	value: unknown,
	key: string,
): Record<string, Partial<Record<ServerToolName, boolean>>> {
	const result: Record<string, Partial<Record<ServerToolName, boolean>>> = {};
	for (const [service, switches] of Object.entries(table(value, key))) {
		const serviceKey = joinKey(key, service);
		const enabled: Partial<Record<ServerToolName, boolean>> = {};
		for (const [name, item] of Object.entries(table(switches, serviceKey))) {
			const itemKey = joinKey(serviceKey, name);
			const tool = serverToolNames.find((known) => known === name);
			if (tool === undefined) {
				throw new KeyError(
					itemKey,
					`不是服务端工具：可以开关的有 ${serverToolNames.join("、")}`,
				);
			}
			if (typeof item !== "boolean") {
				throw new KeyError(itemKey, "要是 true（启用）或 false（不启用）");
			}
			enabled[tool] = item;
		}
		result[service] = enabled;
	}
	return result;
}

function ui(value: unknown, key: string): UiLayer {
	const result: UiLayer = {};
	for (const [name, item] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		if (name !== "show_reasoning") throw new KeyError(itemKey, "不认识的键");
		if (typeof item !== "boolean") {
			throw new KeyError(itemKey, "要是 true 或 false");
		}
		result.show_reasoning = item;
	}
	return result;
}

function proxy(value: unknown, key: string): string {
	const url = URL.parse(string(value, key));
	if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
		throw new KeyError(key, "要是 http:// 或 https:// 开头的代理地址");
	}
	return url.href;
}

function mcpClients(
	value: unknown,
	key: string,
): Record<string, McpClientLayer> {
	const result: Record<string, McpClientLayer> = {};
	for (const [label, client] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, label);
		const fields = table(client, itemKey);
		for (const name of Object.keys(fields)) {
			if (name !== "client_id" && name !== "callback_port") {
				throw new KeyError(joinKey(itemKey, name), "不认识的键");
			}
		}
		const port = fields.callback_port;
		if (
			port !== undefined &&
			!(
				Number.isSafeInteger(port) &&
				(port as number) >= 1 &&
				(port as number) <= 65535
			)
		) {
			throw new KeyError(
				joinKey(itemKey, "callback_port"),
				"要是 1 到 65535 的端口号",
			);
		}
		result[label] = {
			client_id: string(fields.client_id, joinKey(itemKey, "client_id")),
			...(port === undefined ? {} : { callback_port: port as number }),
		};
	}
	return result;
}

function mcpSecrets(
	value: unknown,
	key: string,
): Record<string, Record<string, string[]>> {
	const result: Record<string, Record<string, string[]>> = {};
	for (const [label, secrets] of Object.entries(table(value, key))) {
		const labelKey = joinKey(key, label);
		const hosts: Record<string, string[]> = {};
		for (const [name, list] of Object.entries(table(secrets, labelKey))) {
			const nameKey = joinKey(labelKey, name);
			if (!variableName.test(name)) {
				throw new KeyError(nameKey, "不是合法的环境变量名");
			}
			if (!Array.isArray(list) || list.length === 0) {
				throw new KeyError(nameKey, "要是非空的域名列表");
			}
			hosts[name] = list.map((host: unknown) => {
				try {
					return normalizeHostPattern(string(host, nameKey));
				} catch (error) {
					if (!(error instanceof InvalidHostError)) throw error;
					throw new KeyError(
						nameKey,
						`域名 ${host} 写得不对：${error.message}`,
					);
				}
			});
		}
		result[label] = hosts;
	}
	return result;
}

function startupTimeout(value: unknown, key: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new KeyError(key, "要是正整数（秒）");
	}
	return value as number;
}

const agentName = /^[a-z][a-z0-9_-]*$/;

/**
 * 子 agent 的定义。仓库配置里的 `model` 不校验，列进 `ignored`：选用哪个模型只认用户级配置。
 */
function agents(
	value: unknown,
	key: string,
	kind: LayerContext["kind"],
	ignored: string[],
): Record<string, AgentLayer> {
	const result: Record<string, AgentLayer> = {};
	for (const [name, definition] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		if (!agentName.test(name)) {
			throw new KeyError(
				itemKey,
				"名字只能用小写字母、数字、下划线和连字符，以字母开头",
			);
		}
		const fields = table(definition, itemKey);
		const agent: AgentLayer = {
			description: string(fields.description, joinKey(itemKey, "description")),
		};
		for (const [field, item] of Object.entries(fields)) {
			const fieldKey = joinKey(itemKey, field);
			switch (field) {
				case "description":
					break;
				case "instructions":
					agent.instructions = string(item, fieldKey);
					break;
				case "model":
					if (kind === "repo") ignored.push(fieldKey);
					else agent.model = string(item, fieldKey);
					break;
				case "reasoning_effort":
					agent.reasoning_effort = oneOf(item, fieldKey, reasoningEfforts);
					break;
				case "sandbox_mode":
					agent.sandbox_mode = oneOf(item, fieldKey, ["read-only"] as const);
					break;
				case "tools":
					if (
						!Array.isArray(item) ||
						item.some((tool) => typeof tool !== "string")
					) {
						throw new KeyError(fieldKey, "要是工具名的数组");
					}
					agent.tools = item;
					break;
				case "workspace":
					agent.workspace = oneOf(item, fieldKey, [
						"shared",
						"isolated",
					] as const);
					break;
				default:
					throw new KeyError(fieldKey, "不认识的键");
			}
		}
		result[name] = agent;
	}
	return result;
}

/** 最小为 1 天，没有 0 或"永久"这类特殊值：清理因此不会碰 24 小时内写过的 session。 */
function retentionDays(value: unknown, key: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new KeyError(key, "要是不小于 1 的整数（天）");
	}
	return value as number;
}

/** 仓库配置里出现、因为只认用户级配置和启动参数而忽略的键。 */
export interface ParsedLayer {
	layer: ConfigLayer;
	ignored: string[];
}

/**
 * 校验一份配置文件的内容（smol-toml 解析出的表）。不认识的键和类型不对的值抛出 `KeyError`；
 * 仓库配置里只认用户级配置和启动参数的键不校验，列进 `ignored`。
 */
export function parseConfigTable(
	raw: Record<string, unknown>,
	context: LayerContext,
): ParsedLayer {
	const layer: ConfigLayer = {};
	const ignored: string[] = [];
	for (const [name, value] of Object.entries(raw)) {
		const key = joinKey("", name);
		if (!(name in keyClasses)) throw new KeyError(key, "不认识的键");
		const field = name as keyof ConfigLayer;
		if (context.kind === "repo" && keyClasses[field] === "user_only") {
			ignored.push(key);
			continue;
		}
		switch (field) {
			case "model":
				layer.model = string(value, key);
				break;
			case "reasoning_effort":
				layer.reasoning_effort = oneOf(value, key, reasoningEfforts);
				break;
			case "sandbox_mode": {
				const mode = string(value, key);
				if (context.kind === "user" && mode === "danger-full-access") {
					throw new KeyError(key, "danger-full-access 只能由启动参数指定");
				}
				layer.sandbox_mode = mode;
				break;
			}
			case "approval_policy":
				layer.approval_policy = oneOf(value, key, approvalPolicies);
				break;
			case "approval_granular":
				layer.approval_granular = granular(value, key);
				break;
			case "permissions":
				layer.permissions = permissions(value, key);
				break;
			case "environment":
				layer.environment = environment(value, key);
				break;
			case "budget":
				layer.budget = budget(value, key);
				break;
			case "deny_read":
				layer.deny_read = paths(value, key, context);
				break;
			case "deny_write":
				layer.deny_write = paths(value, key, context);
				break;
			case "models":
				layer.models = models(value, key);
				break;
			case "credentials":
				layer.credentials = credentials(value, key, context.home);
				break;
			case "mcp_clients":
				layer.mcp_clients = mcpClients(value, key);
				break;
			case "mcp_secrets":
				layer.mcp_secrets = mcpSecrets(value, key);
				break;
			case "mcp_startup_timeout_sec":
				layer.mcp_startup_timeout_sec = startupTimeout(value, key);
				break;
			case "proxy":
				layer.proxy = proxy(value, key);
				break;
			case "tools":
				layer.tools = tools(value, key, context.optionalTools);
				break;
			case "server_tools":
				layer.server_tools = serverTools(value, key);
				break;
			case "ui":
				layer.ui = ui(value, key);
				break;
			case "session_retention_days":
				layer.session_retention_days = retentionDays(value, key);
				break;
			case "agents":
				layer.agents = agents(value, key, context.kind, ignored);
				break;
		}
	}
	return { layer, ignored };
}

/** 校验启动参数里的模型定义和路径：SDK 的调用方传入的值同样要检查。 */
export function checkStartupLayer(layer: ConfigLayer): ConfigLayer {
	for (const field of ["deny_read", "deny_write"] as const) {
		for (const [i, path] of (layer[field] ?? []).entries()) {
			if (!isAbsolute(path)) {
				throw new KeyError(`${field}[${i}]`, "要写绝对路径");
			}
		}
	}
	const startupCredentials: Record<string, CredentialSource> = {};
	for (const [id, source] of Object.entries(layer.credentials ?? {})) {
		const key = joinKey("credentials", id);
		if ("file" in source && !isAbsolute(source.file)) {
			throw new KeyError(key, "凭据文件要写绝对路径");
		}
		startupCredentials[id] =
			"command" in source ? commandSource({ ...source }, key) : source;
	}
	return {
		...layer,
		...(layer.credentials === undefined
			? {}
			: { credentials: startupCredentials }),
		...(layer.models === undefined
			? {}
			: { models: models(layer.models, "models") }),
		...(layer.environment === undefined
			? {}
			: { environment: environment(layer.environment, "environment") }),
		...(layer.budget === undefined
			? {}
			: { budget: checkBudget(layer.budget) }),
	};
}

function checkBudget(value: BudgetLayer): BudgetLayer {
	const { max_cost_usd, max_requests, max_duration_ms } = value;
	if (max_cost_usd != null && !(max_cost_usd > 0)) {
		throw new KeyError("budget.max_cost_usd", "要是大于 0 的数，或不设");
	}
	for (const [name, item] of [
		["max_requests", max_requests],
		["max_duration_ms", max_duration_ms],
	] as const) {
		if (item != null && !(Number.isSafeInteger(item) && item >= 1)) {
			throw new KeyError(joinKey("budget", name), "要是正整数，或不设");
		}
	}
	return value;
}

/** 展开仓库配置文件的路径时用：`.ospreycode/config.toml`。 */
export function repoConfigPath(projectRoot: string): string {
	return join(projectRoot, ".ospreycode", "config.toml");
}
