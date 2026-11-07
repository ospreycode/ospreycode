import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
	completeModel,
	type ModelFields,
	mergeModelFields,
} from "../src/models/config.ts";
import type {
	ChatCompat,
	ModelEntry,
	ModelPrice,
	ModelPricePeriod,
	ModelPriceTier,
	ThinkingLevelMap,
} from "../src/models/entry.ts";
import type { ProtocolName, ReasoningEffort } from "../src/protocol/index.ts";
import {
	fallbackModels,
	modelCorrections,
	modelsDevCommit,
	type ServiceSpec,
	services,
} from "./model-corrections.ts";

type Table = Record<string, unknown>;

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const output = join(packageDir, "src", "models", "catalog.ts");

/** models.dev 里每种协议对应的接口表名。 */
const apiNames: Record<ProtocolName, string> = {
	"anthropic.messages": "messages",
	"openai.responses": "responses",
	"openai.chat": "chat-completions",
};

const levels: ReasoningEffort[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

class SourceError extends Error {
	constructor(where: string, message: string) {
		super(`${where}：${message}`);
	}
}

function isTable(value: unknown): value is Table {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(value: unknown, where: string): Table {
	if (!isTable(value)) throw new SourceError(where, "要是一个表");
	return value;
}

function optionalTable(value: unknown, where: string): Table {
	return value === undefined ? {} : table(value, where);
}

function number(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new SourceError(
			where,
			`要是不小于 0 的数，现在是 ${JSON.stringify(value)}`,
		);
	}
	return value;
}

function flag(value: unknown, where: string): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw new SourceError(where, "要是布尔值");
	return value;
}

function strings(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new SourceError(where, "要是字符串的数组");
	}
	return value;
}

/**
 * 读固定 commit 下的一个源文件，经 GitHub 的 REST 接口（未登录时每小时 60 次，够跑一遍；
 * 设了 `GITHUB_TOKEN` 时用它登录，限额更高）。
 */
async function source(path: string): Promise<string> {
	const token = process.env.GITHUB_TOKEN;
	const response = await fetch(
		`https://api.github.com/repos/anomalyco/models.dev/contents/${path}?ref=${modelsDevCommit}`,
		{
			headers: {
				accept: "application/vnd.github.raw+json",
				...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
			},
		},
	);
	if (!response.ok) {
		throw new Error(
			`读取 ${path} 失败：${response.status} ${await response.text()}`,
		);
	}
	return response.text();
}

async function readToml(path: string): Promise<Table> {
	return parse(await source(path)) as Table;
}

function mergeDeep(base: Table, over: Table): Table {
	const result: Table = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const previous = result[key];
		result[key] =
			isTable(previous) && isTable(value) ? mergeDeep(previous, value) : value;
	}
	return result;
}

/**
 * 一个服务上的模型：服务文件引用了规范定义（`base_model`）时照 models.dev 的 generate-v2 合并：
 * 能力和上限按层深度合并，输入类型没写时沿用规范定义，其余字段以服务文件为准。
 */
async function loadModel(provider: string, id: string): Promise<Table> {
	const file = await readToml(`providers/${provider}/models/${id}.toml`);
	if (file.base_model_omit !== undefined) {
		throw new SourceError(
			`${provider}/${id}`,
			"用了 base_model_omit，生成脚本还不支持",
		);
	}
	if (typeof file.base_model !== "string") return file;
	const base = await readToml(`models/${file.base_model}.toml`);
	return {
		...base,
		...file,
		capabilities: mergeDeep(
			optionalTable(base.capabilities, `${file.base_model}.capabilities`),
			optionalTable(file.capabilities, `${provider}/${id}.capabilities`),
		),
		limit: mergeDeep(
			optionalTable(base.limit, `${file.base_model}.limit`),
			optionalTable(file.limit, `${provider}/${id}.limit`),
		),
		modalities: file.modalities ?? base.modalities,
	};
}

/**
 * 推理强度的映射：models.dev 列出的 effort 取值按同名级别发出；关闭推理在 Anthropic 是 `disabled`
 * （有 `toggle` 的模型才能关），在 OpenAI 和兼容服务是 `none`。
 */
function thinkingLevelMap(
	reasoning: Table,
	protocol: ProtocolName,
	where: string,
): ThinkingLevelMap | undefined {
	if (reasoning.supported !== true) return undefined;
	if (reasoning.effort === undefined) {
		throw new SourceError(
			where,
			"推理不用 effort 控制（按 token 预算），不收录",
		);
	}
	const effort = strings(reasoning.effort, `${where}.effort`);
	const unknown = effort.find(
		(value) => value !== "none" && !levels.includes(value as ReasoningEffort),
	);
	if (unknown !== undefined) {
		throw new SourceError(where, `不认识的推理强度 ${unknown}`);
	}
	const map: ThinkingLevelMap = {};
	if (protocol === "anthropic.messages") {
		if (reasoning.toggle === true) map.off = "disabled";
	} else if (effort.includes("none") || reasoning.toggle === true) {
		map.off = "none";
	}
	for (const level of levels) if (effort.includes(level)) map[level] = level;
	return map;
}

function rates(input: Table, outputPrice: number, where: string) {
	const cache = optionalTable(input.cache, `${where}.cache`);
	const write = cache.write;
	const inputPrice = number(input.price, `${where}.price`);
	return {
		input: inputPrice,
		output: outputPrice,
		cache_read:
			cache.read === undefined
				? inputPrice
				: number(cache.read, `${where}.cache.read`),
		// 没列出写入价格的服务不对写入单独计费（OpenAI 5.6 之前、DeepSeek 的隐式缓存）
		cache_write:
			write === undefined
				? 0
				: isTable(write)
					? number(write["5m"], `${where}.cache.write.5m`)
					: number(write, `${where}.cache.write`),
	};
}

function contextThreshold(when: unknown, where: string): number {
	const context = table(table(when, where).context, `${where}.context`);
	return number(context.gt, `${where}.context.gt`);
}

/** DeepSeek 写法的分时段倍数：UTC 的星期几加几段时刻。节假日判断不了，按高峰价估，预算更保守。 */
function periodsOf(
	when: Table,
	factor: number,
	where: string,
): ModelPricePeriod[] {
	const known = ["utc_days", "not", "any"];
	const unknown = Object.keys(when).find((key) => !known.includes(key));
	if (unknown !== undefined)
		throw new SourceError(where, `不认识的条件 ${unknown}`);
	const days = strings(
		table(when.utc_days, `${where}.utc_days`).in,
		`${where}.utc_days.in`,
	).map((day) => {
		const index = weekdays.indexOf(day);
		if (index === -1) throw new SourceError(where, `不认识的星期 ${day}`);
		return index;
	});
	if (!Array.isArray(when.any)) throw new SourceError(where, "any 要是数组");
	return when.any.map((range, i) => {
		const all = table(range, `${where}.any[${i}]`).all;
		if (!Array.isArray(all) || all.length !== 2) {
			throw new SourceError(where, "每段时刻要是 gte 和 lt 两个条件");
		}
		const [from, to] = all.map((bound) =>
			table(table(bound, where).utc_hours, `${where}.utc_hours`),
		) as [Table, Table];
		return {
			days,
			from: String(from.gte),
			to: String(to.lt),
			factor,
		};
	});
}

function priceOf(cost: unknown, where: string): ModelPrice | undefined {
	if (cost === undefined) return undefined;
	const text = table(table(cost, where).text, `${where}.text`);
	const input = table(text.input, `${where}.text.input`);
	const output = table(text.output, `${where}.text.output`);
	const outputPrice = number(output.price, `${where}.text.output.price`);
	if (output.reasoning !== undefined && output.reasoning !== outputPrice) {
		throw new SourceError(
			where,
			"推理 token 的价格和输出不同，价格结构表达不了",
		);
	}
	const base = rates(input, outputPrice, `${where}.text.input`);
	const outputTiers = new Map<number, number>();
	for (const [i, override] of (
		(output.overrides as unknown[]) ?? []
	).entries()) {
		const item = table(override, `${where}.text.output.overrides[${i}]`);
		outputTiers.set(
			contextThreshold(item.when, `${where}.text.output.overrides[${i}].when`),
			number(item.price, `${where}.text.output.overrides[${i}].price`),
		);
	}
	const tiers: ModelPriceTier[] = ((input.overrides as unknown[]) ?? []).map(
		(override, i) => {
			const item = table(override, `${where}.text.input.overrides[${i}]`);
			const threshold = contextThreshold(
				item.when,
				`${where}.text.input.overrides[${i}].when`,
			);
			const tierOutput = outputTiers.get(threshold);
			if (tierOutput === undefined) {
				throw new SourceError(where, `输入和输出的分档对不上：${threshold}`);
			}
			return {
				above_input_tokens: threshold,
				...rates(item, tierOutput, `${where}.text.input.overrides[${i}]`),
			};
		},
	);
	const periods: ModelPricePeriod[] = [];
	for (const [i, multiplier] of (
		((table(cost, where).multipliers as unknown[]) ?? []) as unknown[]
	).entries()) {
		const itemWhere = `${where}.multipliers[${i}]`;
		const item = table(multiplier, itemWhere);
		const when = table(item.when, `${itemWhere}.when`);
		// 服务档位和数据驻留只在请求里选了才生效，本项目不发这两种选项
		if (when.service_tier !== undefined || when.region !== undefined) continue;
		const factor = isTable(item.factor)
			? number(item.factor.text, `${itemWhere}.factor.text`)
			: number(item.factor, `${itemWhere}.factor`);
		periods.push(...periodsOf(when, factor, `${itemWhere}.when`));
	}
	return {
		...base,
		...(tiers.length === 0 ? {} : { tiers }),
		...(periods.length === 0 ? {} : { periods }),
	};
}

function toEntry(
	service: string,
	spec: ServiceSpec,
	id: string,
	model: Table,
): ModelEntry {
	const where = `${spec.provider}/${id}`;
	if (model.status === "deprecated") throw new SourceError(where, "已弃用");
	const capabilities = table(model.capabilities, `${where}.capabilities`);
	const tools = table(capabilities.tools, `${where}.capabilities.tools`);
	if (tools.supported !== true) throw new SourceError(where, "不能调用工具");
	const apiName = apiNames[spec.protocol];
	const apis =
		model.api === undefined ? undefined : table(model.api, `${where}.api`);
	if (apis !== undefined && apis[apiName] === undefined) {
		throw new SourceError(where, `没有 ${apiName} 接口`);
	}
	const api = optionalTable(apis?.[apiName], `${where}.api.${apiName}`);
	const apiCapabilities = optionalTable(
		api.capabilities,
		`${where}.api.${apiName}.capabilities`,
	);
	const apiTools = optionalTable(
		apiCapabilities.tools,
		`${where}.api.${apiName}.capabilities.tools`,
	);
	const limit = table(model.limit, `${where}.limit`);
	const modalities = table(model.modalities, `${where}.modalities`);
	const fields: ModelFields = {
		protocol: spec.protocol,
		service,
		base_url: spec.base_url,
		model: id,
		context_window: number(limit.context, `${where}.limit.context`),
		...(limit.input === undefined
			? {}
			: { max_input_tokens: number(limit.input, `${where}.limit.input`) }),
		max_output_tokens: number(limit.output, `${where}.limit.output`),
		images: strings(modalities.input, `${where}.modalities.input`).some(
			(type) => type.startsWith("image/"),
		),
		system_updates: flag(
			apiCapabilities.system_updates ?? capabilities.system_updates,
			`${where}.system_updates`,
		),
		tool_updates: flag(
			apiTools.updates ?? tools.updates,
			`${where}.tools.updates`,
		),
	};
	const map = thinkingLevelMap(
		optionalTable(capabilities.reasoning, `${where}.capabilities.reasoning`),
		spec.protocol,
		where,
	);
	if (map !== undefined) fields.thinking_level_map = map;
	const price = priceOf(model.cost, `${where}.cost`);
	if (price !== undefined) fields.price = price;
	if (spec.protocol === "openai.chat") {
		const compatibility = optionalTable(
			api.compatibility,
			`${where}.api.${apiName}.compatibility`,
		);
		const compat: ChatCompat = { ...spec.compat };
		if (compatibility.reasoning_field !== undefined) {
			compat.reasoning_field =
				compatibility.reasoning_field as ChatCompat["reasoning_field"];
		}
		if (compatibility.max_tokens_field !== undefined) {
			compat.max_tokens_field =
				compatibility.max_tokens_field as ChatCompat["max_tokens_field"];
		}
		compat.stream_usage = flag(
			capabilities.stream_usage,
			`${where}.stream_usage`,
		);
		fields.compat = compat;
	}
	return completeModel(
		id,
		mergeModelFields(fields, modelCorrections[id] ?? {}),
		`models.${id}`,
	);
}

async function main(): Promise<void> {
	const copyright = /^Copyright .*$/m.exec(await source("LICENSE"))?.[0];
	if (copyright === undefined) {
		throw new Error("models.dev 的 LICENSE 里找不到版权声明");
	}
	const entries: ModelEntry[] = [];
	for (const [service, spec] of Object.entries(services)) {
		for (const id of spec.models) {
			entries.push(
				toEntry(service, spec, id, await loadModel(spec.provider, id)),
			);
		}
	}
	for (const [id, fallbacks] of Object.entries(fallbackModels)) {
		const entry = entries.find((candidate) => candidate.id === id);
		if (entry === undefined) throw new Error(`回退表里的 ${id} 不在清单里`);
		entry.allowed_fallback_models = fallbacks.map((fallbackId) => {
			const fallback = entries.find((candidate) => candidate.id === fallbackId);
			if (fallback?.service !== entry.service) {
				throw new Error(`${id} 的回退模型 ${fallbackId} 不在同一个服务上`);
			}
			return {
				model: fallback.model,
				...(fallback.price === undefined ? {} : { price: fallback.price }),
			};
		});
	}
	writeFileSync(
		output,
		[
			"// 由 packages/api/scripts/generate-models.ts 生成，不要手改。",
			`// 数据来自 anomalyco/models.dev 的 commit ${modelsDevCommit}，叠加 scripts/model-corrections.ts 的修正。`,
			`// models.dev 以 MIT 许可证发布：${copyright}`,
			'import type { ModelEntry } from "./entry.js";',
			"",
			"/** 内置的模型清单，随本包发布；用户级配置可以按字段覆盖或新增模型。 */",
			`export const builtinModels: readonly ModelEntry[] = ${JSON.stringify(entries, null, "\t")};`,
			"",
		].join("\n"),
	);
	execFileSync(
		join(packageDir, "..", "..", "node_modules", ".bin", "biome"),
		["format", "--write", output],
		{ stdio: "inherit" },
	);
	console.log(`${entries.length} 个模型写进了 ${output}`);
}

if (import.meta.main) await main();
