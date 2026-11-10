import { isAbsolute, join } from "node:path";
import {
	completeModel,
	ModelConfigError,
	type ModelEntry,
	type ModelFields,
	mergeModelFields,
} from "@ospreycode/api";
import type { ReasoningEffort } from "@ospreycode/api/protocol";
import {
	type ApprovalPolicy,
	type BuiltinSandboxMode,
	type GranularApproval,
	type GranularCategory,
	granularCategories,
	type PermissionProfile,
	type ResolvedProfile,
	type SandboxMode,
} from "@ospreycode/sandbox";
import type { CredentialSource } from "../credentials/sources.js";
import { ConfigError, joinKey, KeyError } from "./errors.js";
import { readRepoToml, readUserToml } from "./files.js";
import {
	type BudgetLayer,
	type ConfigLayer,
	checkStartupLayer,
	type LayerContext,
	type Limit,
	type ParsedLayer,
	parseConfigTable,
	repoConfigPath,
	type UiLayer,
} from "./layer.js";
import { resolveSandboxMode } from "./sandbox-mode.js";

export { ConfigError };

/** 每个 run 的上限，`null` 表示不设。 */
export interface BudgetOptions {
	maxCostUsd?: number | null;
	maxRequests?: number | null;
	maxDurationMs?: number | null;
}

/**
 * 打开 session 的选项，等同于启动参数：优先于仓库配置和用户级配置。没有写的项按仓库配置、
 * 用户级配置（Host 根目录下的 `config.toml`）和内置默认值的顺序取值。
 */
export interface SessionOptions {
	/** 工作区：启动 Host 时的当前目录。 */
	workspace: string;
	/** 选用的模型（`-m/--model`），取模型清单里的 ID。 */
	model?: string;
	reasoningEffort?: ReasoningEffort;
	/** 新增模型或按字段覆盖模型清单，键是模型 ID。 */
	models?: Readonly<Record<string, ModelFields>>;
	/** 凭据来源（`--credential-file`、`--credential-env`），键是凭据的 ID。 */
	credentials?: Readonly<Record<string, CredentialSource>>;
	/** 沙盒模式；`danger-full-access` 只能从这里指定。 */
	sandboxMode?: SandboxMode;
	approvalPolicy?: ApprovalPolicy;
	/** 审批策略为 `granular` 时各类别是否询问，按类别覆盖配置文件里的 `[approval_granular]`。 */
	granular?: Partial<GranularApproval>;
	/** 每个 run 的上限（`--max-cost`、`--max-requests`），按项覆盖。 */
	budget?: BudgetOptions;
	/** 额外禁止沙盒读取的绝对路径，和各层配置的 `deny_read` 取并集。 */
	denyRead?: readonly string[];
	/** 额外禁止沙盒写入的绝对路径，和各层配置的 `deny_write` 取并集。 */
	denyWrite?: readonly string[];
	/** 额外传给沙盒的环境变量，按变量覆盖用户级配置的 `[environment]`。 */
	environment?: Readonly<Record<string, string>>;
	/** 另外指定的权限规则文件（`--rules FILE`），绝对路径；和用户级的 `rules/*.toml` 一样可以写 `allow`。 */
	rules?: readonly string[];
}

/** 每个 run 的上限，`null` 表示不设。 */
export interface RunLimits {
	maxCostUsd: number | null;
	maxRequests: number | null;
	maxDurationMs: number | null;
}

/** 交互界面的显示设置。 */
export interface UiSettings {
	/** 是否显示模型的推理内容，默认显示。 */
	showReasoning: boolean;
}

/** 分层合并、检查过的 session 配置。 */
export interface SessionConfig {
	/** 工作区的真实路径。 */
	workspace: string;
	/** 项目根目录的真实路径。 */
	projectRoot: string;
	/** 选用的模型。 */
	model: ModelEntry;
	/** 合并后的模型清单。 */
	models: readonly ModelEntry[];
	reasoningEffort: ReasoningEffort;
	/** 凭据来源，键是凭据的 ID。 */
	credentials: Readonly<Record<string, CredentialSource>>;
	/** 沙盒模式的名字：内置的三种之一，或命名权限配置的名字。 */
	sandboxMode: SandboxMode;
	/** 沙盒按哪个内置模式建立：选用命名权限配置时是它在这个工作区上的模式。 */
	baseSandboxMode: BuiltinSandboxMode;
	/** 选用命名权限配置时，它在这个工作区上解析出的路径和域名。 */
	permissionProfile?: ResolvedProfile;
	approvalPolicy: ApprovalPolicy;
	/** 审批策略为 `granular` 时七个类别是否询问。 */
	granular?: GranularApproval;
	permissionProfiles: Readonly<Record<string, PermissionProfile>>;
	environment: Readonly<Record<string, string>>;
	budget: RunLimits;
	denyRead: readonly string[];
	denyWrite: readonly string[];
	/** 启动参数指定的权限规则文件（`--rules FILE`），绝对路径；内容在打开 session 时读取和校验。 */
	ruleFiles: readonly string[];
	/** 启用的工具，按它们在系统指令和工具声明里的顺序：默认启用的在前，`[tools]` 打开的可选工具在后。 */
	tools: readonly string[];
	/** 交互界面的显示设置（`[ui]`），Host 只读取和合并，由前端使用。 */
	ui: UiSettings;
	/** 访问模型服务用的 HTTP 代理，由 CLI 入口应用。 */
	proxy?: string;
	/** 启动时要告诉用户的事：仓库配置里被忽略的键和更松的值。 */
	warnings: readonly string[];
}

/** 解析配置用到的环境。 */
export interface ResolveContext {
	/** Host 根目录的真实路径，用户级配置在它下面。 */
	root: string;
	/** 工作区的真实路径。 */
	workspace: string;
	/** 项目根目录的真实路径，仓库配置在它下面的 `.ospreycode/`。 */
	projectRoot: string;
	/** 项目根目录是不是 git 仓库：默认的沙盒模式按它选。 */
	git: boolean;
	/** Host 环境里的 HOME。 */
	home: string | undefined;
	/** 内置的模型清单。 */
	catalog: readonly ModelEntry[];
	/** runtime 提供的全部工具的名字，按声明的顺序；默认启用的之外都是可选工具。 */
	toolNames: readonly string[];
	/** Host 自己和它依赖的包（包括 Node）的安装目录：命名权限配置把它们所在的目录设成 `deny` 时保持可读。 */
	install: readonly string[];
}

/** 默认启用的工具，也是它们在系统指令和工具声明里的顺序。 */
export const defaultTools: readonly string[] = [
	"read",
	"edit",
	"write",
	"shell",
	"request_permissions",
];

function parseFile(
	raw: Record<string, unknown> | undefined,
	path: string,
	context: LayerContext,
): ParsedLayer {
	if (raw === undefined) return { layer: {}, ignored: [] };
	try {
		return parseConfigTable(raw, context);
	} catch (error) {
		if (!(error instanceof KeyError)) throw error;
		throw new ConfigError(`${path}：${error.key} ${error.message}`);
	}
}

function startupLayer(options: SessionOptions): ConfigLayer {
	const { budget } = options;
	const layer: ConfigLayer = {
		model: options.model,
		reasoning_effort: options.reasoningEffort,
		sandbox_mode: options.sandboxMode,
		approval_policy: options.approvalPolicy,
		approval_granular: options.granular,
		models: options.models === undefined ? undefined : { ...options.models },
		credentials:
			options.credentials === undefined
				? undefined
				: { ...options.credentials },
		budget:
			budget === undefined
				? undefined
				: {
						max_cost_usd: budget.maxCostUsd,
						max_requests: budget.maxRequests,
						max_duration_ms: budget.maxDurationMs,
					},
		deny_read:
			options.denyRead === undefined ? undefined : [...options.denyRead],
		deny_write:
			options.denyWrite === undefined ? undefined : [...options.denyWrite],
		environment:
			options.environment === undefined
				? undefined
				: { ...options.environment },
	};
	try {
		return checkStartupLayer(withoutUndefined(layer));
	} catch (error) {
		if (!(error instanceof KeyError)) throw error;
		throw new ConfigError(`启动参数：${error.key} ${error.message}`);
	}
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	) as T;
}

function union(
	lower: readonly string[] | undefined,
	higher: readonly string[] | undefined,
) {
	return [...new Set([...(lower ?? []), ...(higher ?? [])])];
}

/** 内置默认值打底、合并过的配置：有默认值的项和各个表都已经有值。 */
interface MergedLayer extends ConfigLayer {
	reasoning_effort: ReasoningEffort;
	sandbox_mode: string;
	approval_policy: ApprovalPolicy;
	approval_granular: Partial<Record<GranularCategory, boolean>>;
	permissions: Record<string, PermissionProfile>;
	environment: Record<string, string>;
	budget: Required<BudgetLayer>;
	models: Record<string, ModelFields>;
	credentials: Record<string, CredentialSource>;
	deny_read: string[];
	deny_write: string[];
	tools: Record<string, boolean>;
	ui: Required<UiLayer>;
}

function mergeModels(
	lower: Record<string, ModelFields>,
	higher: Record<string, ModelFields> | undefined,
): Record<string, ModelFields> {
	const result = { ...lower };
	for (const [id, fields] of Object.entries(higher ?? {})) {
		const previous = result[id];
		result[id] =
			previous === undefined ? fields : mergeModelFields(previous, fields);
	}
	return result;
}

/** 表按键合并，标量由高层整体替换；禁止的路径取并集。同一个凭据 ID 只取一个来源，不合并字段。 */
function mergeLayers(lower: MergedLayer, higher: ConfigLayer): MergedLayer {
	return {
		...lower,
		...withoutUndefined(higher),
		approval_granular: {
			...lower.approval_granular,
			...higher.approval_granular,
		},
		permissions: { ...lower.permissions, ...higher.permissions },
		environment: { ...lower.environment, ...higher.environment },
		budget: { ...lower.budget, ...withoutUndefined(higher.budget ?? {}) },
		models: mergeModels(lower.models, higher.models),
		credentials: { ...lower.credentials, ...higher.credentials },
		deny_read: union(lower.deny_read, higher.deny_read),
		deny_write: union(lower.deny_write, higher.deny_write),
		tools: { ...lower.tools, ...higher.tools },
		ui: { ...lower.ui, ...higher.ui },
	};
}

const askAll = Object.fromEntries(
	granularCategories.map((category) => [category, true]),
) as Record<GranularCategory, boolean>;

const budgetKeys: Record<keyof BudgetLayer, string> = {
	max_cost_usd: "budget.max_cost_usd",
	max_requests: "budget.max_requests",
	max_duration_ms: "budget.max_duration",
};

/**
 * 仓库配置只能收紧：沙盒模式只能改成 `read-only`，用户级配置选用了命名权限配置时不改（换成
 * `read-only` 会放开它禁止读的路径）；审批策略从 `on-request`、`granular` 到 `never`
 * 越来越严，`[approval_granular]` 只能关闭类别（`on-request` 相当于七个类别都询问）；上限只能调低；
 * 禁止的路径取并集。更松的值忽略，记进 `warnings`。
 */
function applyRepo(
	lower: MergedLayer,
	repo: ConfigLayer,
	file: string,
	warnings: string[],
): MergedLayer {
	const result: MergedLayer = { ...lower };
	const ignore = (key: string, reason: string) =>
		warnings.push(`${file}：${key} ${reason}，已忽略`);
	if (repo.reasoning_effort !== undefined) {
		result.reasoning_effort = repo.reasoning_effort;
	}
	result.tools = { ...lower.tools, ...repo.tools };
	result.ui = { ...lower.ui, ...repo.ui };
	if (repo.sandbox_mode !== undefined) {
		if (repo.sandbox_mode !== "read-only") {
			ignore("sandbox_mode", "在仓库配置里只能设为 read-only");
		} else if (Object.hasOwn(lower.permissions, lower.sandbox_mode)) {
			ignore(
				"sandbox_mode",
				`用户级配置选用了命名权限配置 ${lower.sandbox_mode}，换成 read-only 会放开它禁止读的路径`,
			);
		} else {
			result.sandbox_mode = "read-only";
		}
	}

	let policy = lower.approval_policy;
	let table = { ...lower.approval_granular };
	const toGranular = () => {
		policy = "granular";
		table = { ...askAll };
	};
	if (repo.approval_policy === "never") {
		policy = "never";
	} else if (repo.approval_policy === "granular") {
		if (policy === "never") ignore("approval_policy", "比 never 更松");
		else if (policy === "on-request") toGranular();
	} else if (repo.approval_policy === "on-request" && policy !== "on-request") {
		ignore("approval_policy", `比 ${policy} 更松`);
	}
	for (const [name, ask] of Object.entries(repo.approval_granular ?? {})) {
		const category = name as GranularCategory;
		if (policy === "never") continue;
		if (ask) {
			const asking = policy === "on-request" || table[category] === true;
			if (!asking) {
				ignore(
					joinKey("approval_granular", category),
					"在仓库配置里只能关闭类别",
				);
			}
			continue;
		}
		if (policy === "on-request") toGranular();
		table[category] = false;
	}
	result.approval_policy = policy;
	result.approval_granular = table;

	const budget = { ...lower.budget };
	for (const [name, value] of Object.entries(repo.budget ?? {})) {
		const field = name as keyof BudgetLayer;
		const current: Limit = budget[field];
		if (value === current) continue;
		if (value !== null && (current === null || value < current)) {
			budget[field] = value;
		} else {
			ignore(budgetKeys[field], "在仓库配置里只能调低");
		}
	}
	result.budget = budget;
	result.deny_read = union(lower.deny_read, repo.deny_read);
	result.deny_write = union(lower.deny_write, repo.deny_write);
	return result;
}

function completeModels(
	catalog: readonly ModelEntry[],
	merged: Record<string, ModelFields>,
	sourceOf: (id: string) => string,
): ModelEntry[] {
	const fields: Record<string, ModelFields> = {};
	for (const { id, ...entry } of catalog) fields[id] = entry;
	const all = mergeModels(fields, merged);
	return Object.entries(all).map(([id, item]) => {
		try {
			return completeModel(id, item, joinKey("models", id));
		} catch (error) {
			if (!(error instanceof ModelConfigError)) throw error;
			throw new ConfigError(`${sourceOf(id)}：${error.key} ${error.message}`);
		}
	});
}

/**
 * 按启动参数、仓库配置、用户级配置、内置默认值的顺序合并出 session 的配置。配置文件加载出错、
 * 必需的项没有写、写的值不存在时抛出 `ConfigError`，带文件路径和出错的键。
 */
export function resolveSessionConfig(
	options: SessionOptions,
	context: ResolveContext,
): SessionConfig {
	const { root, projectRoot, home } = context;
	const warnings: string[] = [];
	const optionalTools = context.toolNames.filter(
		(name) => !defaultTools.includes(name),
	);
	const userFile = join(root, "config.toml");
	const user = parseFile(readUserToml(userFile), userFile, {
		kind: "user",
		projectRoot,
		home,
		optionalTools,
	});
	const repoFile = repoConfigPath(projectRoot);
	const repo = parseFile(readRepoToml(repoFile, projectRoot), repoFile, {
		kind: "repo",
		projectRoot,
		home,
		optionalTools,
	});
	if (repo.ignored.length > 0) {
		warnings.push(
			`${repoFile}：${repo.ignored.join("、")} 只认用户级配置和启动参数，已忽略`,
		);
	}
	const startup = startupLayer(options);
	const defaults: MergedLayer = {
		reasoning_effort: "medium",
		sandbox_mode: context.git ? "workspace-write" : "read-only",
		approval_policy: "on-request",
		approval_granular: {},
		permissions: {},
		environment: {},
		budget: { max_cost_usd: 10, max_requests: 200, max_duration_ms: null },
		models: {},
		credentials: {},
		deny_read: [],
		deny_write: [],
		tools: {},
		ui: { show_reasoning: true },
	};
	const merged = mergeLayers(
		applyRepo(
			mergeLayers(defaults, user.layer),
			repo.layer,
			repoFile,
			warnings,
		),
		startup,
	);

	const models = completeModels(context.catalog, merged.models, (id) =>
		startup.models?.[id] !== undefined ? "启动参数" : userFile,
	);
	if (merged.model === undefined) {
		throw new ConfigError(
			`没有选用模型：用启动参数指定，或在 ${userFile} 里写 model = "<模型 ID>"`,
		);
	}
	const model = models.find((entry) => entry.id === merged.model);
	if (model === undefined) {
		throw new ConfigError(`模型清单里没有 ${merged.model}`);
	}
	if (merged.budget.max_cost_usd !== null && model.price === undefined) {
		throw new ConfigError(
			`启用了每个 run 的费用上限，但模型 ${model.id} 在清单里没有价格：在 [models.${model.id}] 里写上 price，或者关闭费用上限`,
		);
	}

	const permissionProfiles = merged.permissions;
	const sandbox = resolveSandboxMode(merged.sandbox_mode, permissionProfiles, {
		userFile,
		home,
		workspace: context.workspace,
		root,
		credentials: Object.values(merged.credentials).flatMap((source) =>
			"file" in source ? [source.file] : [],
		),
		denyRead: merged.deny_read,
		denyWrite: merged.deny_write,
		install: context.install,
	});

	const approvalPolicy = merged.approval_policy;
	let granular: GranularApproval | undefined;
	if (approvalPolicy === "granular") {
		const table = merged.approval_granular;
		const missing = granularCategories.filter((c) => table[c] === undefined);
		if (missing.length > 0) {
			throw new ConfigError(
				`审批策略为 granular 时要写明 [approval_granular] 的七个类别，缺少 ${missing.join("、")}`,
			);
		}
		granular = table as GranularApproval;
	}

	const ruleFiles = options.rules ?? [];
	const relative = ruleFiles.find((path) => !isAbsolute(path));
	if (relative !== undefined) {
		throw new ConfigError(`权限规则文件要给出绝对路径：${relative}`);
	}

	const { budget } = merged;
	return {
		workspace: context.workspace,
		projectRoot,
		model,
		models,
		reasoningEffort: merged.reasoning_effort,
		credentials: merged.credentials,
		...sandbox,
		approvalPolicy,
		...(granular === undefined ? {} : { granular }),
		permissionProfiles,
		environment: merged.environment,
		budget: {
			maxCostUsd: budget.max_cost_usd,
			maxRequests: budget.max_requests,
			maxDurationMs: budget.max_duration_ms,
		},
		denyRead: merged.deny_read,
		denyWrite: merged.deny_write,
		ruleFiles,
		tools: [
			...defaultTools,
			...optionalTools.filter((name) => merged.tools[name] === true),
		],
		ui: { showReasoning: merged.ui.show_reasoning },
		...(merged.proxy === undefined ? {} : { proxy: merged.proxy }),
		warnings,
	};
}
