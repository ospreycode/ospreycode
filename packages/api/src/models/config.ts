import type { ProtocolName } from "../protocol/index.js";
import type { ModelEntry, ModelPrice } from "./entry.js";

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
 * 各层按字段合并之后再用 `completeModel` 检查是否齐全。
 */
export type ModelFields = Partial<Omit<ModelEntry, "id" | "price">> & {
	price?: Partial<ModelPrice>;
};

const protocols: readonly ProtocolName[] = [
	"openai.chat",
	"openai.responses",
	"anthropic.messages",
];

const priceKeys = ["input", "output", "cache_read", "cache_write"] as const;

const required = [
	"protocol",
	"service",
	"base_url",
	"model",
	"context_window",
	"max_output_tokens",
] as const;

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

/** 校验 `[models.<ID>]` 的字段，`key` 是这个表在配置文件里的位置。 */
export function parseModelFields(value: unknown, key: string): ModelFields {
	if (!isTable(value)) throw new ModelConfigError(key, "要是一个表");
	const fields: ModelFields = {};
	for (const [name, field] of Object.entries(value)) {
		const fieldKey = joinKey(key, name);
		switch (name) {
			case "protocol":
				if (!protocols.includes(field as ProtocolName)) {
					throw new ModelConfigError(
						fieldKey,
						`要是 ${protocols.join("、")} 之一`,
					);
				}
				fields.protocol = field as ProtocolName;
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
				fields.context_window = positiveInteger(field, fieldKey);
				break;
			case "max_output_tokens":
				fields.max_output_tokens = positiveInteger(field, fieldKey);
				break;
			case "price": {
				if (!isTable(field)) throw new ModelConfigError(fieldKey, "要是一个表");
				const price: Partial<ModelPrice> = {};
				for (const [priceName, amount] of Object.entries(field)) {
					const priceKey = joinKey(fieldKey, priceName);
					if (!priceKeys.includes(priceName as (typeof priceKeys)[number])) {
						throw new ModelConfigError(priceKey, "不认识的键");
					}
					if (
						typeof amount !== "number" ||
						!Number.isFinite(amount) ||
						amount < 0
					) {
						throw new ModelConfigError(priceKey, "要是不小于 0 的数");
					}
					price[priceName as (typeof priceKeys)[number]] = amount;
				}
				fields.price = price;
				break;
			}
			default:
				throw new ModelConfigError(fieldKey, "不认识的键");
		}
	}
	return fields;
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
	if (fields.price !== undefined) {
		const absent = priceKeys.filter(
			(name) => fields.price?.[name] === undefined,
		);
		if (absent.length > 0) {
			throw new ModelConfigError(
				joinKey(key, "price"),
				`要写全 ${absent.join("、")}`,
			);
		}
	}
	return entry;
}
