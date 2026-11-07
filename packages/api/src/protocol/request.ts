import type { Message } from "./messages.js";

/**
 * 推理强度。`off` 表示不发推理的字段；模型不支持请求的级别时先往高找、再往低找，
 * 映射写在模型清单的 `thinkingLevelMap` 里。
 */
export type ReasoningEffort =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/** 交给模型的工具声明。所有模型用同一套声明，名称和 schema 超出某个协议的限制时由转换模块改写。 */
export interface ToolDeclaration {
	name: string;
	description: string;
	/** JSON Schema 格式的参数。 */
	parameters: Record<string, unknown>;
}

/** 采样参数，依次合并模型的默认值、按推理强度设的值和请求里的值。 */
export interface SamplingParameters {
	temperature?: number;
	top_p?: number;
	top_k?: number;
}

/**
 * runtime 发出的一次模型请求。地址、协议、价格、限制和兼容配置一律取 Host 的模型清单，
 * 提示缓存的键由 Host 按通道填写，都不在请求里。
 */
export interface ModelRequest {
	/** 模型清单里的 ID。 */
	model: string;
	reasoning_effort: ReasoningEffort;
	/** 推理预算（token），只对按预算控制推理的模型有效。 */
	reasoning_budget?: number;
	/** 最大输出长度；不写时取清单里的值，再按上下文长度减去估计的输入和余量截短。 */
	max_tokens?: number;
	sampling?: SamplingParameters;
	tool_choice: "auto" | "none";
	/** 提示缓存的保留时间：不缓存、各家的默认档或较长的一档。 */
	cache_retention: "none" | "short" | "long";
	/** 发给模型的完整历史，第一条是系统指令。 */
	messages: Message[];
	tools: ToolDeclaration[];
	metadata?: Record<string, string>;
}
