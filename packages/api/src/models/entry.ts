import type { ProtocolName, ReasoningEffort } from "../protocol/index.js";

/** 每百万 token 的价格（美元），四项和用量的口径相同；推理 token 按输出计价。 */
export interface ModelPriceRates {
	input: number;
	output: number;
	cache_read: number;
	/** 默认一档的缓存写入：Anthropic 的 5 分钟，OpenAI 的 30 分钟。 */
	cache_write: number;
}

/** 按提示长度分的一档价格。 */
export interface ModelPriceTier extends ModelPriceRates {
	/** 总输入（输入加缓存读写）超过这个 token 数时，整次请求按这一档计费。 */
	above_input_tokens: number;
}

/** 分时段的价格：UTC 的这些星期几、这个时段里，价格乘以 `factor`（如 DeepSeek 工作日高峰加倍）。 */
export interface ModelPricePeriod {
	/** UTC 的星期几，0 是星期日。 */
	days: number[];
	/** UTC 时刻 `HH:MM`，含 `from`、不含 `to`。 */
	from: string;
	to: string;
	factor: number;
}

/** 一个模型的价格：基础价格，加上按提示长度的分档和分时段的倍数。 */
export interface ModelPrice extends ModelPriceRates {
	tiers?: ModelPriceTier[];
	periods?: ModelPricePeriod[];
}

/**
 * 推理强度的各级别在这个模型上实际发出的取值（照 pi 的 `thinkingLevelMap`）。没写的级别不支持，请求它时
 * 先往高找、再往低找；没有这一项的模型不发推理的字段。`off` 的取值表示关闭推理：Anthropic 写 `disabled`，
 * OpenAI 和兼容服务写 `none`。
 */
export type ThinkingLevelMap = Partial<Record<ReasoningEffort, string>>;

/**
 * `openai.chat` 兼容服务和 OpenAI 自己的 Chat Completions 的差异。没写的项按 OpenAI 的行为：
 * 接受 developer 角色和 `store`，流式响应返回用量，工具支持 `strict`，最大输出长度用 `max_completion_tokens`，
 * 推理强度用顶层的 `reasoning_effort`，不返回推理内容。
 */
export interface ChatCompat {
	/** 推理内容所在的字段，带回同一模型时也放在这里。 */
	reasoning_field?: "reasoning_content" | "reasoning" | "reasoning_details";
	/** 推理强度的写法：顶层的 `reasoning_effort`，或 OpenRouter 的 `reasoning.effort`。 */
	thinking_format?: "reasoning_effort" | "openrouter";
	/** 不接受中途的 developer 消息时为 false：追加的指令并入开头的 system 消息。 */
	developer_role?: boolean;
	/** 流式响应不返回用量时为 false。 */
	stream_usage?: boolean;
	/** 不接受 `store` 字段时为 false。 */
	store?: boolean;
	/** 工具不接受 `strict` 字段时为 false。 */
	strict_tools?: boolean;
	max_tokens_field?: "max_tokens" | "max_completion_tokens";
}

/**
 * 模型清单的一个条目：模型用哪个协议、在哪个服务上、能力和价格。runtime 只发清单里的 ID，
 * 地址、协议和价格一律以清单为准。能力标记没写时按不支持处理。
 */
export interface ModelEntry {
	/** 清单里的 ID，runtime 的请求里写的就是它。 */
	id: string;
	protocol: ProtocolName;
	/** 模型服务名，也是这个服务的凭据的 ID。 */
	service: string;
	/** 服务的接口地址，如 `https://api.anthropic.com/v1`。 */
	base_url: string;
	/** 发给服务的模型名。 */
	model: string;
	context_window: number;
	/** 输入的上限；比 `context_window` 小时另外限制输入。 */
	max_input_tokens?: number;
	max_output_tokens: number;
	/** 没有价格时不计费用。 */
	price?: ModelPrice;
	/** 能读图片。 */
	images?: boolean;
	thinking_level_map?: ThinkingLevelMap;
	/** 能在对话中途追加 system 级的指令（Anthropic 的中途 system 消息、OpenAI 的 developer 消息）。 */
	system_updates?: boolean;
	/** 能在对话中途增减工具。 */
	tool_updates?: boolean;
	/**
	 * Anthropic 会检查推理内容之前的内容有没有被改过（Claude 5.1 起的模型）：请求带上
	 * `thinking-binding-controls-2026-08-01` 和 `prefix_mismatch_behavior: "error"`。
	 */
	prefix_check?: boolean;
	/** `openai.chat` 的兼容差异。 */
	compat?: ChatCompat;
}

const levels: readonly ReasoningEffort[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 实际发出的推理强度：级别和它在这个模型上的取值。 */
export interface ResolvedEffort {
	level: ReasoningEffort;
	value: string;
}

/**
 * 按模型的 `thinking_level_map` 取请求的推理强度：不支持的级别先往高找、再往低找（pi 的
 * `clampThinkingLevel`）。模型没有推理强度的映射时返回空，不发推理的字段。
 */
export function resolveEffort(
	entry: ModelEntry,
	requested: ReasoningEffort,
): ResolvedEffort | undefined {
	const map = entry.thinking_level_map;
	if (map === undefined) return undefined;
	const index = levels.indexOf(requested);
	const order = [...levels.slice(index), ...levels.slice(0, index).reverse()];
	for (const level of order) {
		const value = map[level];
		if (value !== undefined) return { level, value };
	}
	return undefined;
}
