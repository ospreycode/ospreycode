import { isAbsolute, join, resolve } from "node:path";
import {
	ModelConfigError,
	type ModelFields,
	parseModelFields,
} from "@ospreycode/api";
import type { ReasoningEffort } from "@ospreycode/api/protocol";
import {
	type ApprovalPolicy,
	approvalPolicies,
	builtinSandboxModes,
	type GranularCategory,
	granularCategories,
	PermissionConfigError,
	type PermissionProfile,
	parsePermissionProfile,
} from "@ospreycode/sandbox";
import type { CredentialSource } from "../credentials/sources.js";
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
	proxy?: string;
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
	proxy: "user_only",
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

function credentials(
	value: unknown,
	key: string,
	home: string | undefined,
): Record<string, CredentialSource> {
	const result: Record<string, CredentialSource> = {};
	for (const [id, source] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, id);
		const fields = table(source, itemKey);
		const names = Object.keys(fields);
		if (names.length !== 1 || (names[0] !== "file" && names[0] !== "env")) {
			throw new KeyError(
				itemKey,
				'要写成 { file = "<路径>" } 或 { env = "<变量名>" }',
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

function proxy(value: unknown, key: string): string {
	const url = URL.parse(string(value, key));
	if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
		throw new KeyError(key, "要是 http:// 或 https:// 开头的代理地址");
	}
	return url.href;
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
			case "proxy":
				layer.proxy = proxy(value, key);
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
	for (const [id, source] of Object.entries(layer.credentials ?? {})) {
		if ("file" in source && !isAbsolute(source.file)) {
			throw new KeyError(joinKey("credentials", id), "凭据文件要写绝对路径");
		}
	}
	return {
		...layer,
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
