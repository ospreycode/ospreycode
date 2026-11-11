import type { CountOptions, TokenCount } from "../client/count.js";
import {
	buildReply,
	runCount,
	runStream,
	type StreamParser,
	zeroUsage,
} from "../client/request.js";
import type { SseEvent } from "../client/sse.js";
import type { StreamOptions } from "../client/stream.js";
import { type ModelEntry, resolveEffort } from "../models/entry.js";
import type {
	AssistantContent,
	Message,
	ModelErrorInfo,
	ModelRequest,
	Origin,
	RefusalDetails,
	StopReason,
	StreamEvent,
	SystemMessage,
	TextBlock,
	UserContent,
} from "../protocol/index.js";
import { classifyOpenAIError, openaiCodeCategory } from "./openai-errors.js";
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

/** Responses 没有版本头，保存的原文按接口路径的版本区分。 */
export const openaiResponsesApiVersion = "v1";

const nameLimit = 64;
const callIdLimit = 64;

type Json = Record<string, unknown>;

function scopeOf(entry: ModelEntry) {
	return {
		protocol: "openai.responses" as const,
		service: entry.service,
		api_version: openaiResponsesApiVersion,
	};
}

function systemText(message: SystemMessage): string {
	return message.content.map((block) => block.text).join("\n\n");
}

function inputPart(block: UserContent): Json {
	return block.type === "text"
		? { type: "input_text", text: block.text }
		: { type: "input_image", image_url: dataUrl(block), detail: "auto" };
}

/** 工具结果只有文字时写成字符串，带图片时写成内容数组：`function_call_output` 能直接带图片。 */
function toolOutput(entry: ModelEntry, content: readonly UserContent[]) {
	const fitted = fitImages(entry, content);
	return fitted.every((block): block is TextBlock => block.type === "text")
		? fitted.map((block) => block.text).join("\n")
		: fitted.map(inputPart);
}

function assistantItems(
	entry: ModelEntry,
	block: AssistantContent,
	names: ToolNames,
): string[] {
	switch (block.type) {
		case "text":
			return [
				JSON.stringify({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: block.text, annotations: [] }],
					status: "completed",
					...(block.phase === undefined ? {} : { phase: block.phase }),
				}),
			];
		case "reasoning":
			// 加密的推理内容只有产生它的服务能解密；同一服务上换模型时原样带回，由服务端略去读不了的
			if (
				block.origin.protocol !== "openai.responses" ||
				block.origin.service !== entry.service
			) {
				return [];
			}
			return [
				JSON.stringify({
					type: "reasoning",
					...(block.item_id === undefined ? {} : { id: block.item_id }),
					summary:
						block.text === ""
							? []
							: [{ type: "summary_text", text: block.text }],
					...(block.opaque === undefined
						? {}
						: { encrypted_content: block.opaque }),
				}),
			];
		case "tool_call":
			return [
				JSON.stringify({
					type: "function_call",
					call_id: fitIdentifier(block.call_id, callIdLimit),
					name: names.wire(block.name),
					arguments: block.arguments,
				}),
			];
		case "fallback":
			return [];
	}
}

/** 一条内部消息在 Responses 里的 input item。 */
function messageItems(
	entry: ModelEntry,
	message: Message,
	names: ToolNames,
): string[] {
	switch (message.role) {
		case "system":
			return [
				JSON.stringify({
					role: "developer",
					content: message.content.map((block) => ({
						type: "input_text",
						text: block.text,
					})),
				}),
			];
		case "user":
			return [
				JSON.stringify({
					role: "user",
					content: fitImages(entry, message.content).map(inputPart),
				}),
			];
		case "tool_result":
			return [
				JSON.stringify({
					type: "function_call_output",
					call_id: fitIdentifier(message.call_id, callIdLimit),
					output: toolOutput(entry, message.content),
				}),
			];
		case "assistant":
			return message.content.flatMap((block) =>
				assistantItems(entry, block, names),
			);
	}
}

/** 拼请求体用到的、内部协议以外的东西。 */
export type RequestContext = Pick<StreamOptions, "cacheKey" | "raws">;

/**
 * `count` 为真时拼的是计数接口的请求体：内容和 `responses.create` 的相同，只留计数接口接受的
 * `model`、`instructions`、`input`、`tools`、`tool_choice` 和 `reasoning`。
 */
function render(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext,
	count = false,
): string {
	const [first, ...rest] = request.messages;
	if (first?.role !== "system") {
		throw new Error("内部请求的第一条消息必须是系统指令");
	}
	if (request.sampling?.top_k !== undefined) {
		throw new Error("Responses API 不接受 top_k");
	}
	const scope = scopeOf(entry);
	const { raws } = context;
	// 不能在中途追加 developer 消息的模型，把之后的系统级指令并入开头的指令
	const fold = entry.system_updates !== true;
	const instructions = [
		first,
		...(fold
			? rest.filter((m): m is SystemMessage => m.role === "system")
			: []),
	]
		.map(systemText)
		.join("\n\n");
	const [instructionsRaw] = renderPart(
		raws,
		scope,
		{
			part: "system",
			message_id: first.message_id,
			content_sha256: contentSha256(entry, instructions),
		},
		() => [JSON.stringify(instructions)],
	);
	const names = new ToolNames(
		request.tools.map((tool) => tool.name),
		nameLimit,
	);
	const input = rest
		.filter((message) => !(fold && message.role === "system"))
		.flatMap((message) =>
			renderPart(
				raws,
				scope,
				{
					part: "message",
					message_id: message.message_id,
					content_sha256: contentSha256(entry, messageHashInput(message)),
				},
				() => messageItems(entry, message, names),
			),
		);
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
								name: names.wire(tool.name),
								description: tool.description,
								parameters: tool.parameters,
								// 不写时 Responses 会把 schema 规范化成 strict 模式
								strict: false,
							}),
						),
				);
	const effort = resolveEffort(entry, request.reasoning_effort);
	const reasoning =
		effort === undefined
			? undefined
			: effort.value === "none"
				? { effort: "none" }
				: { effort: effort.value, summary: "auto" };
	const { sampling } = request;
	const content: [string, string | undefined][] = [
		["model", JSON.stringify(entry.model)],
		["instructions", instructionsRaw],
		["input", jsonArray(input)],
		["tools", tools === undefined ? undefined : jsonArray(tools)],
		[
			"tool_choice",
			tools === undefined ? undefined : JSON.stringify(request.tool_choice),
		],
		[
			"reasoning",
			reasoning === undefined ? undefined : JSON.stringify(reasoning),
		],
	];
	if (count) return jsonObject(content);
	return jsonObject([
		...content,
		// store: false 时默认就返回加密的推理内容，这里显式写明
		[
			"include",
			reasoning?.effort === "none" || reasoning === undefined
				? undefined
				: '["reasoning.encrypted_content"]',
		],
		["temperature", sampling?.temperature?.toString()],
		["top_p", sampling?.top_p?.toString()],
		[
			"max_output_tokens",
			String(request.max_tokens ?? entry.max_output_tokens),
		],
		// 断点用服务端默认的隐式断点；prompt_cache_options 不是每个部署都接受，不发
		[
			"prompt_cache_key",
			request.cache_retention !== "none" && context.cacheKey !== undefined
				? JSON.stringify(context.cacheKey)
				: undefined,
		],
		["store", "false"],
		["stream", "true"],
	]);
}

/**
 * 把内部协议的请求转换成 Responses API 的请求体原文。保存过原文的部分原样拼接，其余按内部消息转换；
 * 同样的内部请求每次得到相同的请求体。不使用服务端保存的对话（`store: false`、不带 `previous_response_id`）。
 */
export function openaiResponsesRequestBody(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext = {},
): string {
	return render(entry, request, context);
}

function count(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/** 把 Responses API 的流拼成内部协议的回复，回复里的 item 按收到的形式交给调用方保存。 */
class ResponsesParser implements StreamParser {
	#entry: ModelEntry;
	#request: ModelRequest;
	#options: StreamOptions;
	#names: ToolNames;
	#model: string;
	#started = false;
	#content: AssistantContent[] = [];
	#items: (string | undefined)[] = [];
	/** `output_index` 对应的内容块下标。 */
	#slots = new Map<number, number>();
	#usage = zeroUsage();
	#final: { status: string; reason: unknown } | undefined;

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
		const payload = JSON.parse(data) as Json;
		switch (payload.type) {
			case "response.created":
			case "response.in_progress":
				return this.#start(payload.response as Json);
			case "response.output_item.added":
				return this.#added(
					payload.output_index as number,
					payload.item as Json,
				);
			case "response.output_text.delta":
			case "response.refusal.delta":
				return this.#delta(
					payload.output_index as number,
					"text",
					payload.delta,
				);
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta":
				return this.#delta(
					payload.output_index as number,
					"reasoning",
					payload.delta,
				);
			case "response.function_call_arguments.delta":
				return this.#delta(
					payload.output_index as number,
					"tool_call",
					payload.delta,
				);
			case "response.output_item.done":
				return this.#done(payload.output_index as number, payload.item as Json);
			case "response.completed":
			case "response.incomplete":
				return this.#completed(payload.response as Json);
			case "response.failed": {
				const error = (payload.response as Json).error as Json | null;
				return {
					category: openaiCodeCategory(error?.code),
					message: String(error?.message ?? "Responses API 报告请求失败"),
				};
			}
			case "error":
				return {
					category: openaiCodeCategory(payload.code),
					message: String(payload.message),
				};
			default:
				// 内容部分的开始和结束、整段文字的 done、中转服务加的 metadata 等，不带新的内容
				return [];
		}
	}

	#origin(): Origin {
		return {
			protocol: "openai.responses",
			service: this.#entry.service,
			model: this.#model,
		};
	}

	#start(response: Json): StreamEvent[] {
		this.#model = String(response.model);
		if (this.#started) return [];
		this.#started = true;
		return [{ type: "start", model: this.#model }];
	}

	#added(outputIndex: number, item: Json): StreamEvent[] {
		const index = this.#content.length;
		this.#slots.set(outputIndex, index);
		switch (item.type) {
			case "reasoning":
				this.#content.push({
					type: "reasoning",
					text: "",
					redacted: false,
					origin: this.#origin(),
				});
				return [];
			case "message":
				this.#content.push({ type: "text", text: "" });
				return [];
			case "function_call": {
				const callId = String(item.call_id);
				const name = this.#names.original(String(item.name));
				this.#content.push({
					type: "tool_call",
					call_id: callId,
					name,
					arguments: "",
				});
				return [{ type: "tool_call_start", index, call_id: callId, name }];
			}
			default:
				throw new Error(
					`Responses API 返回了没有列出的 item：${String(item.type)}`,
				);
		}
	}

	#slot(outputIndex: number): number {
		const index = this.#slots.get(outputIndex);
		if (index === undefined) {
			throw new Error(`output_index ${outputIndex} 的 item 还没有开始`);
		}
		return index;
	}

	#delta(
		outputIndex: number,
		type: "text" | "reasoning" | "tool_call",
		delta: unknown,
	): StreamEvent[] {
		const index = this.#slot(outputIndex);
		const block = this.#content[index];
		const text = String(delta);
		if (block?.type !== type) {
			throw new Error(`内容块 ${index} 不是 ${type}，收到了它的增量`);
		}
		switch (block.type) {
			case "text":
				block.text += text;
				return [{ type: "text_delta", index, text }];
			case "reasoning":
				block.text += text;
				return [{ type: "reasoning_delta", index, text }];
			case "tool_call":
				block.arguments += text;
				return [{ type: "tool_call_delta", index, arguments: text }];
		}
	}

	#done(outputIndex: number, item: Json): StreamEvent[] {
		const events = this.#slots.has(outputIndex)
			? []
			: this.#added(outputIndex, item);
		const index = this.#slot(outputIndex);
		const block = this.#content[index];
		this.#items[index] = JSON.stringify(item);
		switch (block?.type) {
			case "reasoning": {
				const summary = (item.summary as Json[]).map((part) =>
					String(part.text),
				);
				const content = ((item.content as Json[] | undefined) ?? []).map(
					(part) => String(part.text),
				);
				this.#content[index] = {
					type: "reasoning",
					text: (summary.length > 0 ? summary : content).join("\n\n"),
					redacted: false,
					...(typeof item.encrypted_content === "string"
						? { opaque: item.encrypted_content }
						: {}),
					item_id: String(item.id),
					origin: block.origin,
				};
				return events;
			}
			case "text": {
				const text = (item.content as Json[])
					.map((part) => {
						if (part.type === "output_text") return String(part.text);
						if (part.type === "refusal") return String(part.refusal);
						throw new Error(
							`Responses API 返回了没有列出的内容：${String(part.type)}`,
						);
					})
					.join("");
				this.#content[index] = {
					type: "text",
					text,
					...(typeof item.phase === "string" ? { phase: item.phase } : {}),
				};
				return events;
			}
			case "tool_call":
				this.#content[index] = { ...block, arguments: String(item.arguments) };
				return [...events, { type: "tool_call_end", index }];
			default:
				throw new Error(`内容块 ${index} 的类型和 item 对不上`);
		}
	}

	#completed(response: Json): StreamEvent[] {
		this.#model = String(response.model);
		const usage = response.usage as Json | null;
		if (usage !== null) {
			const input = usage.input_tokens_details as Json | undefined;
			const cached = count(input?.cached_tokens);
			const written = count(input?.cache_write_tokens);
			this.#usage = {
				// input_tokens 含缓存读写，换成三项互不包含的口径
				input: Math.max(0, count(usage.input_tokens) - cached - written),
				output: count(usage.output_tokens),
				cache_read: cached,
				cache_write: written,
				reasoning: count(
					(usage.output_tokens_details as Json | undefined)?.reasoning_tokens,
				),
			};
		}
		const incomplete = response.incomplete_details as Json | null;
		this.#final = {
			status: String(response.status),
			reason: incomplete?.reason,
		};
		return [];
	}

	finish() {
		if (this.#final === undefined) return undefined;
		const { status, reason } = this.#final;
		let stopReason: StopReason;
		let refusal: RefusalDetails | undefined;
		if (status === "completed") {
			stopReason = this.#content.some((block) => block.type === "tool_call")
				? "tool_use"
				: "end_turn";
		} else if (status === "incomplete" && reason === "max_output_tokens") {
			stopReason = "max_tokens";
		} else if (status === "incomplete" && reason === "content_filter") {
			// 过滤器截断了输出：按拒绝处理，作废本轮输出
			stopReason = "refusal";
			refusal = { category: "content_filter" };
		} else {
			throw new Error(
				`Responses API 返回了不认识的结束状态：${status} ${String(reason ?? "")}`,
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
		const events: StreamEvent[] = [{ type: "usage", usage: message.usage }];
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
		} else if (this.#items.length === this.#content.length) {
			const items = this.#items.filter(
				(item): item is string => item !== undefined,
			);
			if (items.length === this.#content.length) {
				this.#options.raws?.put({
					...scopeOf(this.#entry),
					part: "message",
					message_id: this.#options.messageId,
					content_sha256: contentSha256(this.#entry, messageHashInput(message)),
					pieces: items,
				});
			}
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

/** 用 Responses API 发出一次流式请求。出错和取消也以 `end` 结束，不抛出约定中的失败。 */
export function streamOpenAIResponses(
	entry: ModelEntry,
	request: ModelRequest,
	options: StreamOptions,
): AsyncGenerator<StreamEvent> {
	return runStream(
		options,
		{
			url: `${entry.base_url}/responses`,
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Bearer ${options.apiKey}`,
			},
			body: render(entry, request, options),
		},
		classifyOpenAIError,
		new ResponsesParser(entry, request, options),
	);
}

/** 用 `POST /v1/responses/input_tokens` 数这次请求的输入 token。 */
export function countOpenAIResponses(
	entry: ModelEntry,
	request: ModelRequest,
	options: CountOptions,
): Promise<TokenCount> {
	return runCount(
		options,
		{
			url: `${entry.base_url}/responses/input_tokens`,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.apiKey}`,
			},
			body: render(entry, request, options, true),
		},
		classifyOpenAIError,
	);
}
