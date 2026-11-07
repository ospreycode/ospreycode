import { createHash } from "node:crypto";
import type { RawKey, RawStore } from "../client/raw.js";
import type { ModelEntry } from "../models/entry.js";
import type {
	ImageBlock,
	Message,
	ProtocolName,
	UserContent,
} from "../protocol/index.js";

/** 键按字典序、不带空白的 JSON：同样的值总是得到同样的文本，用来算内容哈希。 */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const fields = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${fields.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * 一部分内容的哈希，把模型清单里影响转换结果的字段一起算进去：这些字段变了，保存的原文就不能再用。
 */
export function contentSha256(entry: ModelEntry, value: unknown): string {
	return sha256(
		canonicalJson({
			model: entry.model,
			system_updates: entry.system_updates ?? false,
			compat: entry.compat ?? null,
			value,
		}),
	);
}

/** 一条消息里影响转换结果的部分：回复的用量、停止原因这类字段不算。 */
export function messageHashInput(message: Message): unknown {
	return message.role === "assistant"
		? {
				role: message.role,
				content: message.content,
				protocol: message.protocol,
				service: message.service,
			}
		: message;
}

/** 按给定的顺序拼出 JSON 对象，值是已经序列化好的原文，跳过空的。 */
export function jsonObject(fields: [string, string | undefined][]): string {
	return `{${fields
		.filter((field): field is [string, string] => field[1] !== undefined)
		.map(([key, value]) => `${JSON.stringify(key)}:${value}`)
		.join(",")}}`;
}

export function jsonArray(items: readonly string[]): string {
	return `[${items.join(",")}]`;
}

/**
 * 把工具名或调用编号改成目标协议接受的写法：`[A-Za-z0-9_-]` 以外的字符改成下划线，超长时截断并加
 * 原文的 8 位哈希。已经合规的原样保留，同一个原文总是得到同样的结果。
 */
export function fitIdentifier(value: string, maxLength: number): string {
	const safe = value.replace(/[^A-Za-z0-9_-]/g, "_");
	if (safe.length <= maxLength) return safe;
	return `${safe.slice(0, maxLength - 9)}_${sha256(value).slice(0, 8)}`;
}

/** 一次请求里工具名的改写和反查：模型返回的名字要换回内部的名字。 */
export class ToolNames {
	#maxLength: number;
	#fromWire = new Map<string, string>();

	constructor(names: readonly string[], maxLength: number) {
		this.#maxLength = maxLength;
		for (const name of names) {
			const wire = fitIdentifier(name, maxLength);
			const taken = this.#fromWire.get(wire);
			if (taken !== undefined && taken !== name) {
				throw new Error(`工具 ${taken} 和 ${name} 改写后重名：${wire}`);
			}
			this.#fromWire.set(wire, name);
		}
	}

	/** 工具名在目标协议里的写法；历史里已经不在工具集里的工具同样改写。 */
	wire(name: string): string {
		return fitIdentifier(name, this.#maxLength);
	}

	/** 模型调用的工具名换回内部的名字；没有声明过的原样交给 runtime，由它报告不认识的工具。 */
	original(wire: string): string {
		return this.#fromWire.get(wire) ?? wire;
	}
}

/** 图片的 data URL。 */
export function dataUrl(image: ImageBlock): string {
	return `data:${image.media_type};base64,${image.data}`;
}

/** 不读图片的模型收到图片时换成的文字。 */
export const imageOmitted =
	"[image omitted: the current model does not accept images]";

/** 按模型能不能读图片，把图片换成文字占位。 */
export function fitImages(
	entry: ModelEntry,
	content: readonly UserContent[],
): UserContent[] {
	return entry.images === true
		? [...content]
		: content.map((block) =>
				block.type === "image" ? { type: "text", text: imageOmitted } : block,
			);
}

/**
 * 转换一部分内容：调用方保存过同样内容的原文时原样取回，否则转换后交给调用方保存。
 * 原文按片段保存，每段是一个 JSON 值的原文，调用方原样拼接。
 */
export function renderPart(
	store: RawStore | undefined,
	scope: { protocol: ProtocolName; service: string; api_version: string },
	part: Omit<RawKey, "protocol" | "service" | "api_version">,
	convert: () => string[],
): string[] {
	const key: RawKey = { ...scope, ...part };
	const saved = store?.get(key);
	if (saved !== undefined) return saved;
	const pieces = convert();
	store?.put({ ...key, pieces });
	return pieces;
}
