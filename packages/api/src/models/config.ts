import type { ProtocolName, ReasoningEffort } from "../protocol/index.js";
import type {
	ChatCompat,
	ModelEntry,
	ModelPrice,
	ModelPricePeriod,
	ModelPriceTier,
	ThinkingLevelMap,
} from "./entry.js";

/**
 * 模型清单的条目写得不对。`key` 是出错的位置，写成 TOML 的键路径，如 `models.my-model.base_url`；
 * 调用方在前面加上文件路径后报给用户。
 */
export class ModelConfigError extends Error {
	override name = "ModelConfigError";
	readonly key: string;

	constructor(key: string, message: string) {
		super(message);
		this.key = key;
	}
}

/**
 * 用户配置里 `[models.<ID>]` 的字段：新增模型时写全，覆盖内置清单的条目时只写要改的字段。
 * 各层按字段合并（表按键合并，数组整体替换）之后再用 `completeModel` 检查是否齐全。
 */
export type ModelFields = Partial<Omit<ModelEntry, "id" | "price">> & {
	price?: Partial<ModelPrice>;
};

const protocols: readonly ProtocolName[] = [
	"openai.chat",
	"openai.responses",
	"anthropic.messages",
];

const efforts: readonly ReasoningEffort[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const rateKeys = ["input", "output", "cache_read", "cache_write"] as const;

const required = [
	"protocol",
	"service",
	"base_url",
	"model",
	"context_window",
	"max_output_tokens",
] as const;

const flags = [
	"images",
	"system_updates",
	"tool_updates",
	"prefix_check",
] as const;

const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function joinKey(parent: string, key: string): string {
	const part = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
	return `${parent}.${part}`;
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
	if (!isTable(value)) throw new ModelConfigError(key, "要是一个表");
	return value;
}

function positiveInteger(value: unknown, key: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new ModelConfigError(key, "要是正整数");
	}
	return value as number;
}

function nonEmptyString(value: unknown, key: string): string {
	if (typeof value !== "string" || value === "") {
		throw new ModelConfigError(key, "要是非空的字符串");
	}
	return value;
}

function amount(value: unknown, key: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ModelConfigError(key, "要是不小于 0 的数");
	}
	return value;
}

function oneOf<T extends string>(
	value: unknown,
	key: string,
	choices: readonly T[],
): T {
	if (!choices.includes(value as T)) {
		throw new ModelConfigError(key, `要是 ${choices.join("、")} 之一`);
	}
	return value as T;
}

/** 服务地址只用 https；本机上的推理服务可以用 http。去掉末尾的斜杠。 */
function baseUrl(value: unknown, key: string): string {
	const url = URL.parse(nonEmptyString(value, key));
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
		url?.hostname ?? "",
	);
	if (
		url === null ||
		!(url.protocol === "https:" || (url.protocol === "http:" && loopback))
	) {
		throw new ModelConfigError(
			key,
			"要是 https 地址；只有本机上的服务可以用 http",
		);
	}
	if (url.username !== "" || url.password !== "") {
		throw new ModelConfigError(key, "不能带用户名和密码，凭据另外配置");
	}
	if (url.search !== "" || url.hash !== "") {
		throw new ModelConfigError(key, "不能带查询参数和片段");
	}
	return url.href.replace(/\/+$/, "");
}

function rates<T extends string>(
	value: Record<string, unknown>,
	key: string,
	extra: readonly T[],
): Partial<Record<(typeof rateKeys)[number], number>> {
	const result: Partial<Record<(typeof rateKeys)[number], number>> = {};
	for (const [name, item] of Object.entries(value)) {
		const itemKey = joinKey(key, name);
		if ((extra as readonly string[]).includes(name)) continue;
		const rate = oneOf(name, itemKey, rateKeys);
		result[rate] = amount(item, itemKey);
	}
	return result;
}

function completeRates(
	value: Partial<Record<(typeof rateKeys)[number], number>>,
	key: string,
) {
	const missing = rateKeys.filter((name) => value[name] === undefined);
	if (missing.length > 0) {
		throw new ModelConfigError(key, `要写全 ${missing.join("、")}`);
	}
	return value as Record<(typeof rateKeys)[number], number>;
}

function tiers(value: unknown, key: string): ModelPriceTier[] {
	if (!Array.isArray(value)) throw new ModelConfigError(key, "要是表的数组");
	return value.map((item, i) => {
		const itemKey = `${key}[${i}]`;
		const tier = table(item, itemKey);
		return {
			above_input_tokens: positiveInteger(
				tier.above_input_tokens,
				joinKey(itemKey, "above_input_tokens"),
			),
			...completeRates(rates(tier, itemKey, ["above_input_tokens"]), itemKey),
		};
	});
}

function clock(value: unknown, key: string): string {
	if (typeof value !== "string" || !/^([01]\d|2[0-4]):[0-5]\d$/.test(value)) {
		throw new ModelConfigError(key, "要写成 HH:MM 的 UTC 时刻");
	}
	return value;
}

function periods(value: unknown, key: string): ModelPricePeriod[] {
	if (!Array.isArray(value)) throw new ModelConfigError(key, "要是表的数组");
	return value.map((item, i) => {
		const itemKey = `${key}[${i}]`;
		const period = table(item, itemKey);
		const known = ["days", "from", "to", "factor"];
		const unknown = Object.keys(period).find((name) => !known.includes(name));
		if (unknown !== undefined) {
			throw new ModelConfigError(joinKey(itemKey, unknown), "不认识的键");
		}
		const days = period.days;
		if (
			!Array.isArray(days) ||
			days.some((day) => !weekdays.includes(day as string))
		) {
			throw new ModelConfigError(
				joinKey(itemKey, "days"),
				`要是星期的数组，取 ${weekdays.join("、")}`,
			);
		}
		const from = clock(period.from, joinKey(itemKey, "from"));
		const to = clock(period.to, joinKey(itemKey, "to"));
		if (from >= to) {
			throw new ModelConfigError(joinKey(itemKey, "to"), "要晚于 from");
		}
		return {
			days: days.map((day) => weekdays.indexOf(day as string)),
			from,
			to,
			factor: amount(period.factor, joinKey(itemKey, "factor")),
		};
	});
}

function price(value: unknown, key: string): Partial<ModelPrice> {
	const fields = table(value, key);
	const result: Partial<ModelPrice> = rates(fields, key, ["tiers", "periods"]);
	if (fields.tiers !== undefined) {
		result.tiers = tiers(fields.tiers, joinKey(key, "tiers"));
	}
	if (fields.periods !== undefined) {
		result.periods = periods(fields.periods, joinKey(key, "periods"));
	}
	return result;
}

function thinkingLevelMap(value: unknown, key: string): ThinkingLevelMap {
	const result: ThinkingLevelMap = {};
	for (const [name, item] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		result[oneOf(name, itemKey, efforts)] = nonEmptyString(item, itemKey);
	}
	return result;
}

function boolean(value: unknown, key: string): boolean {
	if (typeof value !== "boolean")
		throw new ModelConfigError(key, "要是 true 或 false");
	return value;
}

function compat(value: unknown, key: string): ChatCompat {
	const result: ChatCompat = {};
	for (const [name, item] of Object.entries(table(value, key))) {
		const itemKey = joinKey(key, name);
		switch (name) {
			case "reasoning_field":
				result.reasoning_field = oneOf(item, itemKey, [
					"reasoning_content",
					"reasoning",
					"reasoning_details",
				] as const);
				break;
			case "thinking_format":
				result.thinking_format = oneOf(item, itemKey, [
					"reasoning_effort",
					"openrouter",
				] as const);
				break;
			case "max_tokens_field":
				result.max_tokens_field = oneOf(item, itemKey, [
					"max_tokens",
					"max_completion_tokens",
				] as const);
				break;
			case "developer_role":
			case "stream_usage":
			case "store":
			case "strict_tools":
				result[name] = boolean(item, itemKey);
				break;
			default:
				throw new ModelConfigError(itemKey, "不认识的键");
		}
	}
	return result;
}

/** 校验 `[models.<ID>]` 的字段，`key` 是这个表在配置文件里的位置。 */
export function parseModelFields(value: unknown, key: string): ModelFields {
	const fields: ModelFields = {};
	for (const [name, field] of Object.entries(table(value, key))) {
		const fieldKey = joinKey(key, name);
		switch (name) {
			case "protocol":
				fields.protocol = oneOf(field, fieldKey, protocols);
				break;
			case "service":
				if (
					typeof field !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(field)
				) {
					throw new ModelConfigError(
						fieldKey,
						"要是只含字母、数字、下划线、句点和连字符的名字",
					);
				}
				fields.service = field;
				break;
			case "base_url":
				fields.base_url = baseUrl(field, fieldKey);
				break;
			case "model":
				fields.model = nonEmptyString(field, fieldKey);
				break;
			case "context_window":
			case "max_input_tokens":
			case "max_output_tokens":
				fields[name] = positiveInteger(field, fieldKey);
				break;
			case "price":
				fields.price = price(field, fieldKey);
				break;
			case "thinking_level_map":
				fields.thinking_level_map = thinkingLevelMap(field, fieldKey);
				break;
			case "compat":
				fields.compat = compat(field, fieldKey);
				break;
			default:
				if ((flags as readonly string[]).includes(name)) {
					fields[name as (typeof flags)[number]] = boolean(field, fieldKey);
					break;
				}
				throw new ModelConfigError(fieldKey, "不认识的键");
		}
	}
	return fields;
}

/** 合并两层模型字段：表按键合并，标量和数组由高层整体替换。 */
export function mergeModelFields(
	lower: ModelFields,
	higher: ModelFields,
): ModelFields {
	const merged: ModelFields = { ...lower, ...higher };
	for (const name of ["price", "compat", "thinking_level_map"] as const) {
		if (lower[name] !== undefined && higher[name] !== undefined) {
			Object.assign(merged, { [name]: { ...lower[name], ...higher[name] } });
		}
	}
	return merged;
}

/**
 * 各层合并之后，检查一个模型的字段是否齐全，返回清单条目。`key` 是这个模型在配置里的位置。
 */
export function completeModel(
	id: string,
	fields: ModelFields,
	key: string,
): ModelEntry {
	const missing = required.filter((name) => fields[name] === undefined);
	if (missing.length > 0) {
		throw new ModelConfigError(
			key,
			`内置清单里没有这个模型，要写全 ${missing.join("、")}`,
		);
	}
	const entry = { id, ...fields } as ModelEntry;
	if (entry.max_output_tokens > entry.context_window) {
		throw new ModelConfigError(
			joinKey(key, "max_output_tokens"),
			"不能超过 context_window",
		);
	}
	if (
		entry.max_input_tokens !== undefined &&
		entry.max_input_tokens > entry.context_window
	) {
		throw new ModelConfigError(
			joinKey(key, "max_input_tokens"),
			"不能超过 context_window",
		);
	}
	if (fields.price !== undefined) {
		completeRates(fields.price, joinKey(key, "price"));
	}
	return entry;
}
