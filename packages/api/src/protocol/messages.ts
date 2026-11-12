import type { ReasoningEffort } from "./request.js";
import type { StopReason } from "./stream.js";
import type { Usage } from "./usage.js";

/** 支持的模型协议，名字写在模型清单里。 */
export type ProtocolName =
	| "openai.chat"
	| "openai.responses"
	| "anthropic.messages"
	| "google.generate-content";

/** 一段协议专有内容的来源，换模型或协议时据此决定能不能原样带回。 */
export interface Origin {
	protocol: ProtocolName;
	/** 模型服务，取模型清单里的服务名。 */
	service: string;
	/** 实际回答的模型。 */
	model: string;
}

/**
 * 一段文字的引用（服务端工具搜到或读到的来源）：Anthropic 文本块上的 `citations`，
 * OpenAI Responses `output_text` 上的 `annotations`。其他包不解释它。
 */
export interface Citations {
	/** 原协议里引用数组的 JSON 原文，里面的加密字段要原样带回。 */
	raw: string;
	origin: Origin;
}

/** 文本块。 */
export interface TextBlock {
	type: "text";
	text: string;
	/** OpenAI Responses 写在 assistant 消息上的 `phase`，只带回同一协议，转换到其他协议时去掉。 */
	phase?: string;
	/** 模型回复里这段文字的引用，只带回同一协议和服务。 */
	citations?: Citations;
}

/** 图片块，保存实际发送的字节：重新编码较早的图片会让之后的推理内容失效。 */
export interface ImageBlock {
	type: "image";
	media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	/** base64 编码的图片字节。 */
	data: string;
}

/** 模型发起的一次工具调用。Host 分配的 `tool_call_id` 记在工具调用事件里，和这里的 `call_id` 对应。 */
export interface ToolCallBlock {
	type: "tool_call";
	/** 模型返回的调用编号，工具结果用它和调用对应。换协议时按目标协议改写，保留对应关系。 */
	call_id: string;
	name: string;
	/** 模型写出的参数原文，可能不是合法的 JSON，由执行工具的一方解析和校验。 */
	arguments: string;
}

/**
 * 推理内容：Anthropic 的 `thinking`、`redacted_thinking` 块，OpenAI Responses 的 reasoning item，
 * Chat Completions 兼容服务的 `reasoning_content` 一类字段。同一模型继续对话时原样带回。
 */
export interface ReasoningBlock {
	type: "reasoning";
	/** 可读的推理文本或摘要，可以为空。 */
	text: string;
	/** 推理内容被服务端隐去，只剩 `opaque`。 */
	redacted: boolean;
	/** 不透明的签名或加密数据：Anthropic 的 `signature` 或隐去的 `data`，Responses 的 `encrypted_content`。 */
	opaque?: string;
	/** Responses 的 reasoning item 编号。 */
	item_id?: string;
	origin: Origin;
}

/**
 * 服务端回退的分界（Anthropic 的 `fallback` 块）：之前的内容由 `from` 写出，之后的由 `to` 接着写。
 * 原样留在原位，只发回同一协议和服务；最后一个分界之前的推理内容和工具调用作废。
 */
export interface FallbackBlock {
	type: "fallback";
	from: string;
	to: string;
	/** 产生它的协议和服务，`model` 是接着回答的模型。 */
	origin: Origin;
}

/**
 * 只原样往返的内容块：服务端工具的调用和结果（Anthropic 的 `server_tool_use`、
 * `web_search_tool_result`、`web_fetch_tool_result`，OpenAI Responses 的 `web_search_call`）。
 * 留在原位，只发回同一协议和服务；其他包不解释 `raw`，不为它执行工具，也不回工具结果。
 */
export interface OpaqueBlock {
	type: "opaque";
	/** 这个块在原协议里的类型。 */
	kind: string;
	/** 给人看的一行说明，如搜索的关键词或读取的地址。 */
	summary?: string;
	/** 这个块在原协议里的 JSON 原文。 */
	raw: string;
	origin: Origin;
}

/** user 消息和工具结果里可以放的内容块。 */
export type UserContent = TextBlock | ImageBlock;

/** 模型回复里的内容块。 */
export type AssistantContent =
	| TextBlock
	| ReasoningBlock
	| ToolCallBlock
	| FallbackBlock
	| OpaqueBlock;

/**
 * system 级的指令：会话的第一条消息是系统指令，之后出现的是会话中追加的指令
 * （Anthropic 的中途 `role: "system"` 消息，OpenAI 的 `developer` 消息）。
 */
export interface SystemMessage {
	role: "system";
	/** runtime 生成的消息编号。 */
	message_id: string;
	content: TextBlock[];
}

/** 用户的话，以及 runtime 放进 user 消息的、标明来源的内容（规则文件、后台通知等）。 */
export interface UserMessage {
	role: "user";
	message_id: string;
	content: UserContent[];
}

/** 拒绝回答的详情：Anthropic 的 `stop_details`；OpenAI 的内容过滤只有类别。 */
export interface RefusalDetails {
	category: string;
	explanation?: string;
	/** 服务建议改用的模型。 */
	recommended_model?: string;
}

/** 模型的一条回复，记下所用的协议、服务、模型和推理强度。 */
export interface AssistantMessage {
	role: "assistant";
	message_id: string;
	content: AssistantContent[];
	protocol: ProtocolName;
	service: string;
	/** 请求的模型，模型清单里的 ID。 */
	requested_model: string;
	/** 实际回答的模型：服务端的回退可能换一个模型回答，计价和推理内容的归属都按它。 */
	model: string;
	/** 请求的推理强度级别。 */
	reasoning_effort: ReasoningEffort;
	/** 实际发出的推理强度取值；没有发推理字段时为空。 */
	reasoning_effort_sent?: string;
	stop_reason: StopReason;
	/** `stop_reason` 为 `refusal` 时的详情。 */
	refusal?: RefusalDetails;
	usage: Usage;
}

/** 一次工具调用的结果，紧跟在发起调用的回复之后。 */
export interface ToolResultMessage {
	role: "tool_result";
	message_id: string;
	/** 对应的 `ToolCallBlock.call_id`。 */
	call_id: string;
	/** Host 分配的编号；调用还没登记就被取消时为空。 */
	tool_call_id?: string;
	content: UserContent[];
	is_error: boolean;
}

/** 内部协议的消息。 */
export type Message =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolResultMessage;
