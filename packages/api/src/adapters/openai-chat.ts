import {
	buildReply,
	runStream,
	type StreamParser,
	zeroUsage,
} from "../client/request.js";
import type { SseEvent } from "../client/sse.js";
import type { StreamOptions } from "../client/stream.js";
import { type ModelEntry, resolveEffort } from "../models/entry.js";
import type {
	AssistantContent,
	AssistantMessage,
	Message,
	ModelErrorInfo,
	ModelRequest,
	ReasoningBlock,
	RefusalDetails,
	StopReason,
	StreamEvent,
	SystemMessage,
	UserContent,
} from "../protocol/index.js";
import { classifyOpenAIError, openaiCodeCategory } from "./openai-errors.js";
import type { RequestContext } from "./openai-responses.js";
import {
	contentSha256,
	dataUrl,
	fitIdentifier,
	fitImages,
	jsonArray,
	jsonObject,
	messageHashInput,
	renderPart,
	ToolNames,
} from "./wire.js";

/** Chat Completions 没有版本头，保存的原文按接口路径的版本区分。 */
export const openaiChatApiVersion = "v1";

const nameLimit = 64;
/** OpenAI 的 Chat Completions 只接受 40 个字符以内的工具调用编号。 */
const callIdLimit = 40;

/** 工具结果里的图片移到这组工具结果之后的 user 消息里，前面加上这句说明。 */
const toolImagesNote = "Attached image(s) from the tool results above:";

type Json = Record<string, unknown>;

/** 模型配置里没写的兼容项按 OpenAI 自己的 Chat Completions 的行为。 */
function compatOf(entry: ModelEntry) {
	const compat = entry.compat ?? {};
	return {
		reasoningField: compat.reasoning_field,
		thinkingFormat: compat.thinking_format ?? "reasoning_effort",
		developerRole: compat.developer_role ?? true,
		streamUsage: compat.stream_usage ?? true,
		store: compat.store ?? true,
		strictTools: compat.strict_tools ?? true,
		maxTokensField: compat.max_tokens_field ?? "max_completion_tokens",
	};
}

function scopeOf(entry: ModelEntry) {
	return {
		protocol: "openai.chat" as const,
		service: entry.service,
		api_version: openaiChatApiVersion,
	};
}

function systemText(message: SystemMessage): string {
	return message.content.map((block) => block.text).join("\n\n");
}

function imagePart(block: Extract<UserContent, { type: "image" }>): string {
	return JSON.stringify({
		type: "image_url",
		image_url: { url: dataUrl(block) },
	});
}

/** 换模型、服务或协议后不再发送推理内容：加密推理只有产生它的服务能解密。 */
function sameModel(entry: ModelEntry, block: ReasoningBlock): boolean {
	return (
		block.origin.protocol === "openai.chat" &&
		block.origin.service === entry.service &&
		block.origin.model === entry.model
	);
}

function assistantPieces(
	entry: ModelEntry,
	message: AssistantMessage,
	names: ToolNames,
): string[] {
	const text = message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
	const calls = message.content.flatMap((block) =>
		block.type === "tool_call"
			? [
					{
						id: fitIdentifier(block.call_id, callIdLimit),
						type: "function",
						function: {
							name: names.wire(block.name),
							arguments: block.arguments,
						},
					},
				]
			: [],
	);
	// 只剩推理内容或什么都没有的回复不发：服务要求 assistant 消息带内容或工具调用
	if (text === "" && calls.length === 0) return [];
	const reasoning = message.content.filter(
		(block): block is ReasoningBlock =>
			block.type === "reasoning" && sameModel(entry, block),
	);
	const field = compatOf(entry).reasoningField;
	let reasoningValue: string | undefined;
	if (reasoning.length > 0 && field === "reasoning_details") {
		reasoningValue = JSON.stringify(
			reasoning.flatMap((block) =>
				block.opaque === undefined ? [] : (JSON.parse(block.opaque) as Json[]),
			),
		);
	} else if (reasoning.length > 0 && field !== undefined) {
		reasoningValue = JSON.stringify(
			reasoning.map((block) => block.text).join("\n\n"),
		);
	}
	return [
		jsonObject([
			["role", '"assistant"'],
			["content", text === "" ? "null" : JSON.stringify(text)],
			[field ?? "", reasoningValue],
			["tool_calls", calls.length === 0 ? undefined : JSON.stringify(calls)],
		]),
	];
}

/**
 * 一条内部消息在 Chat Completions 里的形式。工具结果的第一段是 tool 消息，其余是要移到这组结果之后的
 * 图片：tool 消息只能放文字。
 */
function messagePieces(
	entry: ModelEntry,
	message: Message,
	names: ToolNames,
): string[] {
	switch (message.role) {
		case "system":
			return [
				JSON.stringify({ role: "developer", content: systemText(message) }),
			];
		case "user":
			return [
				JSON.stringify({
					role: "user",
					content: fitImages(entry, message.content).map((block) =>
						block.type === "text"
							? { type: "text", text: block.text }
							: { type: "image_url", image_url: { url: dataUrl(block) } },
					),
				}),
			];
		case "tool_result": {
			const content = fitImages(entry, message.content);
			const texts = content.flatMap((block) =>
				block.type === "text" ? [block.text] : [],
			);
			const images = content.flatMap((block) =>
				block.type === "image" ? [imagePart(block)] : [],
			);
			return [
				JSON.stringify({
					role: "tool",
					tool_call_id: fitIdentifier(message.call_id, callIdLimit),
					content:
						texts.length === 0 && images.length > 0
							? "(see attached image)"
							: texts.join("\n"),
				}),
				...images,
			];
		}
		case "assistant":
			return assistantPieces(entry, message, names);
	}
}

/**
 * 把内部协议的请求转换成 Chat Completions 的请求体原文。保存过原文的部分原样拼接，其余按内部消息转换；
 * 兼容服务和 OpenAI 的差异按模型配置的 `compat` 处理，不按服务地址猜。
 */
export function openaiChatRequestBody(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext = {},
): string {
	const [first, ...rest] = request.messages;
	if (first?.role !== "system") {
		throw new Error("内部请求的第一条消息必须是系统指令");
	}
	if (request.sampling?.top_k !== undefined) {
		throw new Error("Chat Completions 不接受 top_k");
	}
	const compat = compatOf(entry);
	const scope = scopeOf(entry);
	const { raws } = context;
	// 不能在中途追加 developer 消息的模型或服务，把之后的系统级指令并入开头的 system 消息
	const fold = entry.system_updates !== true || !compat.developerRole;
	const instructions = [
		first,
		...(fold
			? rest.filter((m): m is SystemMessage => m.role === "system")
			: []),
	]
		.map(systemText)
		.join("\n\n");
	const messages = [
		...renderPart(
			raws,
			scope,
			{
				part: "system",
				message_id: first.message_id,
				content_sha256: contentSha256(entry, instructions),
			},
			() => [JSON.stringify({ role: "system", content: instructions })],
		),
	];
	const names = new ToolNames(
		request.tools.map((tool) => tool.name),
		nameLimit,
	);
	let images: string[] = [];
	const flushImages = () => {
		if (images.length === 0) return;
		messages.push(
			jsonObject([
				["role", '"user"'],
				[
					"content",
					jsonArray([
						JSON.stringify({ type: "text", text: toolImagesNote }),
						...images,
					]),
				],
			]),
		);
		images = [];
	};
	for (const message of rest) {
		if (fold && message.role === "system") continue;
		const [head, ...tail] = renderPart(
			raws,
			scope,
			{
				part: "message",
				message_id: message.message_id,
				content_sha256: contentSha256(entry, messageHashInput(message)),
			},
			() => messagePieces(entry, message, names),
		);
		if (message.role !== "tool_result") flushImages();
		if (head !== undefined) messages.push(head);
		images.push(...tail);
	}
	flushImages();
	const tools =
		request.tools.length === 0
			? undefined
			: renderPart(
					raws,
					scope,
					{
						part: "tools",
						content_sha256: contentSha256(entry, request.tools),
					},
					() =>
						request.tools.map((tool) =>
							JSON.stringify({
								type: "function",
								function: {
									name: names.wire(tool.name),
									description: tool.description,
									parameters: tool.parameters,
									// 支持 strict 的服务总是写明：不写时各家的默认值不同
									...(compat.strictTools ? { strict: false } : {}),
								},
							}),
						),
				);
	const effort = resolveEffort(entry, request.reasoning_effort);
	const { sampling } = request;
	return jsonObject([
		["model", JSON.stringify(entry.model)],
		["messages", jsonArray(messages)],
		["tools", tools === undefined ? undefined : jsonArray(tools)],
		[
			"tool_choice",
			tools === undefined ? undefined : JSON.stringify(request.tool_choice),
		],
		[
			"reasoning_effort",
			effort !== undefined && compat.thinkingFormat === "reasoning_effort"
				? JSON.stringify(effort.value)
				: undefined,
		],
		[
			"reasoning",
			effort !== undefined && compat.thinkingFormat === "openrouter"
				? JSON.stringify({ effort: effort.value })
				: undefined,
		],
		["temperature", sampling?.temperature?.toString()],
		["top_p", sampling?.top_p?.toString()],
		[
			compat.maxTokensField,
			String(request.max_tokens ?? entry.max_output_tokens),
		],
		["store", compat.store ? "false" : undefined],
		["stream", "true"],
		[
			"stream_options",
			compat.streamUsage ? '{"include_usage":true}' : undefined,
		],
	]);
}

function count(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/** OpenRouter 按增量发回 `reasoning_details`：相邻的文字或摘要条目接起来，加密条目原样保留。 */
function appendDetail(details: Json[], detail: Json): void {
	const last = details.at(-1);
	if (detail.type === "reasoning.text" && last?.type === "reasoning.text") {
		last.text = String(last.text) + String(detail.text);
		last.signature ??= detail.signature;
		return;
	}
	if (
		detail.type === "reasoning.summary" &&
		last?.type === "reasoning.summary"
	) {
		last.summary = String(last.summary) + String(detail.summary);
		return;
	}
	details.push({ ...detail });
}

/** 把 Chat Completions 的流拼成内部协议的回复。 */
class ChatParser implements StreamParser {
	#entry: ModelEntry;
	#request: ModelRequest;
	#options: StreamOptions;
	#names: ToolNames;
	#model: string;
	#started = false;
	#content: AssistantContent[] = [];
	#reasoning: number | undefined;
	#text: number | undefined;
	/** 流里工具调用的 `index` 对应的内容块下标。 */
	#calls = new Map<number, number>();
	#details: Json[] = [];
	#usage = zeroUsage();
	#finishReason: string | undefined;

	constructor(
		entry: ModelEntry,
		request: ModelRequest,
		options: StreamOptions,
	) {
		this.#entry = entry;
		this.#request = request;
		this.#options = options;
		this.#names = new ToolNames(
			request.tools.map((tool) => tool.name),
			nameLimit,
		);
		this.#model = entry.model;
	}

	event({ data }: SseEvent): StreamEvent[] | ModelErrorInfo {
		if (data === "[DONE]") return [];
		const chunk = JSON.parse(data) as Json;
		// 兼容服务在流里报错时只发一个带 error 的 data，没有 event 字段
		const error = chunk.error as Json | undefined;
		if (error !== undefined) {
			return {
				category: openaiCodeCategory(error.code),
				message: String(error.message),
			};
		}
		const events: StreamEvent[] = [];
		if (!this.#started && typeof chunk.model === "string") {
			this.#started = true;
			this.#model = chunk.model;
			events.push({ type: "start", model: chunk.model });
		}
		if (typeof chunk.usage === "object" && chunk.usage !== null) {
			this.#addUsage(chunk.usage as Json);
		}
		const choice = (chunk.choices as Json[] | undefined)?.[0];
		if (choice === undefined) return events;
		const delta = (choice.delta ?? {}) as Json;
		events.push(...this.#reasoningDelta(delta));
		for (const key of ["content", "refusal"]) {
			const text = delta[key];
			if (typeof text !== "string" || text === "") continue;
			if (this.#text === undefined) {
				this.#text = this.#content.length;
				this.#content.push({ type: "text", text: "" });
			}
			const block = this.#content[this.#text] as { text: string };
			block.text += text;
			events.push({ type: "text_delta", index: this.#text, text });
		}
		for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
			events.push(...this.#toolCallDelta(call));
		}
		if (typeof choice.finish_reason === "string") {
			this.#finishReason = choice.finish_reason;
		}
		return events;
	}

	#reasoningBlock(): { index: number; block: ReasoningBlock } {
		if (this.#reasoning === undefined) {
			this.#reasoning = this.#content.length;
			this.#content.push({
				type: "reasoning",
				text: "",
				redacted: false,
				origin: {
					protocol: "openai.chat",
					service: this.#entry.service,
					model: this.#model,
				},
			});
		}
		return {
			index: this.#reasoning,
			block: this.#content[this.#reasoning] as ReasoningBlock,
		};
	}

	#reasoningDelta(delta: Json): StreamEvent[] {
		const field = compatOf(this.#entry).reasoningField;
		if (field === undefined) return [];
		if (field === "reasoning_details") {
			const details = delta.reasoning_details;
			if (!Array.isArray(details) || details.length === 0) return [];
			const { index, block } = this.#reasoningBlock();
			const events: StreamEvent[] = [];
			for (const detail of details as Json[]) {
				appendDetail(this.#details, detail);
				const text = detail.text ?? detail.summary;
				if (typeof text === "string" && text !== "") {
					block.text += text;
					events.push({ type: "reasoning_delta", index, text });
				}
			}
			block.opaque = JSON.stringify(this.#details);
			return events;
		}
		const text = delta[field];
		if (typeof text !== "string" || text === "") return [];
		const { index, block } = this.#reasoningBlock();
		block.text += text;
		return [{ type: "reasoning_delta", index, text }];
	}

	#toolCallDelta(call: Json): StreamEvent[] {
		const key = typeof call.index === "number" ? call.index : 0;
		const fn = (call.function ?? {}) as Json;
		const events: StreamEvent[] = [];
		let index = this.#calls.get(key);
		if (index === undefined) {
			index = this.#content.length;
			this.#calls.set(key, index);
			const callId = String(call.id);
			const name = this.#names.original(String(fn.name));
			this.#content.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments: "",
			});
			events.push({ type: "tool_call_start", index, call_id: callId, name });
		}
		const args = fn.arguments;
		if (typeof args === "string" && args !== "") {
			const block = this.#content[index] as { arguments: string };
			block.arguments += args;
			events.push({ type: "tool_call_delta", index, arguments: args });
		}
		return events;
	}

	#addUsage(usage: Json): void {
		const prompt = usage.prompt_tokens_details as Json | undefined;
		// OpenAI 写在 prompt_tokens_details.cached_tokens，DeepSeek 写在 prompt_cache_hit_tokens
		const cached = count(
			prompt?.cached_tokens ?? usage.prompt_cache_hit_tokens,
		);
		const written = count(prompt?.cache_write_tokens);
		this.#usage = {
			input: Math.max(0, count(usage.prompt_tokens) - cached - written),
			output: count(usage.completion_tokens),
			cache_read: cached,
			cache_write: written,
			reasoning: count(
				(usage.completion_tokens_details as Json | undefined)?.reasoning_tokens,
			),
		};
	}

	finish() {
		const reason = this.#finishReason;
		if (reason === undefined) return undefined;
		let stopReason: StopReason;
		let refusal: RefusalDetails | undefined;
		switch (reason) {
			case "stop":
				stopReason = "end_turn";
				break;
			case "tool_calls":
				stopReason = "tool_use";
				break;
			case "length":
				stopReason = "max_tokens";
				break;
			case "content_filter":
				// 过滤器截断了输出：按拒绝处理，作废本轮输出
				stopReason = "refusal";
				refusal = { category: "content_filter" };
				break;
			default:
				throw new Error(
					`Chat Completions 返回了不认识的 finish_reason：${reason}`,
				);
		}
		const message = buildReply(
			this.#entry,
			this.#request,
			this.#options.messageId,
			{
				content: this.#content,
				model: this.#model,
				stop_reason: stopReason,
				usage: this.#usage,
				...(refusal === undefined ? {} : { refusal }),
			},
		);
		const events: StreamEvent[] = [...this.#calls.values()].map((index) => ({
			type: "tool_call_end",
			index,
		}));
		events.push({ type: "usage", usage: message.usage });
		if (stopReason === "refusal") {
			events.push({
				type: "invalidate",
				invalidation: {
					blocks: this.#content.map((_, index) => ({
						message_id: this.#options.messageId,
						index,
					})),
					reason: "refusal",
				},
			});
		}
		return { events, message };
	}

	partial(stopReason: "error" | "cancelled") {
		return buildReply(this.#entry, this.#request, this.#options.messageId, {
			content: this.#content,
			model: this.#model,
			stop_reason: stopReason,
			usage: this.#usage,
		});
	}
}

/** 用 Chat Completions 发出一次流式请求。出错和取消也以 `end` 结束，不抛出约定中的失败。 */
export function streamOpenAIChat(
	entry: ModelEntry,
	request: ModelRequest,
	options: StreamOptions,
): AsyncGenerator<StreamEvent> {
	return runStream(
		options,
		{
			url: `${entry.base_url}/chat/completions`,
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Bearer ${options.apiKey}`,
			},
			body: openaiChatRequestBody(entry, request, options),
		},
		classifyOpenAIError,
		new ChatParser(entry, request, options),
	);
}
