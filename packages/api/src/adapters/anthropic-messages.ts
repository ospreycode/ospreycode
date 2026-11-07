import {
	buildReply,
	type ErrorClassifier,
	runStream,
	type StreamParser,
	zeroUsage,
} from "../client/request.js";
import type { SseEvent } from "../client/sse.js";
import type { StreamOptions } from "../client/stream.js";
import { computeCost } from "../models/cost.js";
import {
	type ModelEntry,
	type ResolvedEffort,
	resolveEffort,
} from "../models/entry.js";
import type {
	AssistantContent,
	AssistantMessage,
	BlockRef,
	ErrorCategory,
	Message,
	ModelErrorInfo,
	ModelRequest,
	Origin,
	RefusalDetails,
	StopReason,
	StreamEvent,
	SystemMessage,
	Usage,
	UserContent,
} from "../protocol/index.js";
import type { RequestContext } from "./openai-responses.js";
import {
	contentSha256,
	fitIdentifier,
	fitImages,
	jsonArray,
	jsonObject,
	messageHashInput,
	renderPart,
	ToolNames,
} from "./wire.js";

/** P1 起固定发送的 API 版本，换版本按破坏性改动处理。 */
export const anthropicVersion = "2026-10-21";

const nameLimit = 128;
const callIdLimit = 64;

type Json = Record<string, unknown>;

function scopeOf(entry: ModelEntry) {
	return {
		protocol: "anthropic.messages" as const,
		service: entry.service,
		api_version: anthropicVersion,
	};
}

function cacheControl(
	retention: ModelRequest["cache_retention"],
): string | undefined {
	if (retention === "none") return undefined;
	return retention === "long"
		? '{"type":"ephemeral","ttl":"1h"}'
		: '{"type":"ephemeral"}';
}

/** 在最后一段上加缓存断点：断点只在组装请求时加，不进保存的原文。 */
function withBreakpoint(
	pieces: readonly string[],
	control: string | undefined,
): string[] {
	const last = pieces.at(-1);
	if (control === undefined || last === undefined) return [...pieces];
	return [
		...pieces.slice(0, -1),
		`${last.slice(0, -1)},"cache_control":${control}}`,
	];
}

function userBlock(block: UserContent): string {
	return JSON.stringify(
		block.type === "text"
			? { type: "text", text: block.text }
			: {
					type: "image",
					source: {
						type: "base64",
						media_type: block.media_type,
						data: block.data,
					},
				},
	);
}

/**
 * 工具参数的原文：Anthropic 自己的工具调用就是流里 `partial_json` 拼出的原文，原样放进 `input`，
 * 不经 JSON 往返；模型写出的参数不是 JSON 对象时发空对象，否则这段历史再也发不出去。
 */
function inputRaw(args: string): string {
	try {
		const value = JSON.parse(args) as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return args;
		}
	} catch {
		// 参数原文不是 JSON：工具调用已经按失败处理，这里只要能发出去
	}
	return "{}";
}

/**
 * 一条回复里发回 Anthropic 的块和它们在 `content` 里的下标。推理内容只发回同一服务：
 * 同一服务上换模型时原样带回，由服务端丢弃读不了的；其他服务的签名这里验不了。
 */
function sentBlocks(
	entry: ModelEntry,
	message: AssistantMessage,
): { index: number; block: AssistantContent }[] {
	return message.content.flatMap((block, index) => {
		if (block.type === "text" && block.text === "") return [];
		if (
			(block.type === "reasoning" || block.type === "fallback") &&
			(block.origin.protocol !== "anthropic.messages" ||
				block.origin.service !== entry.service)
		) {
			return [];
		}
		return [{ index, block }];
	});
}

function assistantBlock(block: AssistantContent, names: ToolNames): string {
	switch (block.type) {
		case "text":
			return JSON.stringify({ type: "text", text: block.text });
		case "reasoning":
			return JSON.stringify(
				block.redacted
					? { type: "redacted_thinking", data: block.opaque }
					: { type: "thinking", thinking: block.text, signature: block.opaque },
			);
		case "fallback":
			// 分界原位带回：去掉它，两边的推理内容会被当成一段，服务端无法校验
			return JSON.stringify({
				type: "fallback",
				from: { model: block.from },
				to: { model: block.to },
			});
		case "tool_call":
			return jsonObject([
				["type", '"tool_use"'],
				["id", JSON.stringify(fitIdentifier(block.call_id, callIdLimit))],
				["name", JSON.stringify(names.wire(block.name))],
				["input", inputRaw(block.arguments)],
			]);
	}
}

/**
 * 一条内部消息在 Messages API 里的片段。system 和 assistant 消息是各自的内容块；user 消息和工具结果的块
 * 并进同一条 user 消息，工具结果的第一段是 `tool_result` 块，其余是要移到这组结果之后的图片：
 * `is_error` 为真的工具结果只接受文字。
 */
function messagePieces(
	entry: ModelEntry,
	message: Message,
	names: ToolNames,
): string[] {
	switch (message.role) {
		case "system":
			return message.content.map((block) =>
				JSON.stringify({ type: "text", text: block.text }),
			);
		case "user":
			return fitImages(entry, message.content).map(userBlock);
		case "tool_result": {
			const content = fitImages(entry, message.content);
			const kept = message.is_error
				? content.filter((block) => block.type === "text")
				: content;
			const moved = message.is_error
				? content.filter((block) => block.type === "image")
				: [];
			return [
				jsonObject([
					["type", '"tool_result"'],
					[
						"tool_use_id",
						JSON.stringify(fitIdentifier(message.call_id, callIdLimit)),
					],
					["content", jsonArray(kept.map(userBlock))],
					["is_error", String(message.is_error)],
				]),
				...moved.map(userBlock),
			];
		}
		case "assistant":
			return sentBlocks(entry, message).map(({ block }) =>
				assistantBlock(block, names),
			);
	}
}

/** 做前缀校验的模型在开着推理时，请求带上这个 beta，并显式要求校验失败时报错。 */
const prefixCheckBeta = "thinking-binding-controls-2026-08-01";

/** 发回退列表要带的 beta。 */
const fallbackBeta = "server-side-fallback-2026-07-01";

/** 这次请求要不要显式开启前缀校验：Haiku 5.5 关掉推理时不能设这个字段。 */
function checksPrefix(entry: ModelEntry, effort: ResolvedEffort | undefined) {
	return entry.prefix_check === true && effort?.value !== "disabled";
}

/** 允许回退的模型；没有时不发回退列表。 */
function fallbacksOf(entry: ModelEntry) {
	return entry.allowed_fallback_models ?? [];
}

function betas(entry: ModelEntry, request: ModelRequest): string[] {
	return [
		...(checksPrefix(entry, resolveEffort(entry, request.reasoning_effort))
			? [prefixCheckBeta]
			: []),
		...(fallbacksOf(entry).length > 0 ? [fallbackBeta] : []),
	];
}

/** 一条发出的消息：角色、内容块的原文，以及每个块对应的内部内容块（推理内容前缀不符时据此定位）。 */
interface WireMessage {
	role: string;
	results: string[];
	blocks: string[];
	refs: (BlockRef | undefined)[];
}

/** 请求体，以及 `messages` 里每条消息每个内容块对应的内部内容块。 */
interface Rendered {
	body: string;
	refs: (BlockRef | undefined)[][];
}

function render(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext,
): Rendered {
	const [first, ...rest] = request.messages;
	if (first?.role !== "system") {
		throw new Error("内部请求的第一条消息必须是系统指令");
	}
	if (request.sampling !== undefined) {
		throw new Error(`Anthropic API ${anthropicVersion} 不接受采样参数`);
	}
	const scope = scopeOf(entry);
	const { raws } = context;
	const control = cacheControl(request.cache_retention);
	// 不支持中途 system 消息的模型（如 Sonnet 5），把之后的系统级指令并入开头的 system
	const fold = entry.system_updates !== true;
	const system = [
		first,
		...(fold
			? rest.filter((m): m is SystemMessage => m.role === "system")
			: []),
	];
	const systemPieces = renderPart(
		raws,
		scope,
		{
			part: "system",
			message_id: first.message_id,
			content_sha256: contentSha256(
				entry,
				system.map((message) => message.content),
			),
		},
		() =>
			system.flatMap((message) =>
				message.content.map((block) =>
					JSON.stringify({ type: "text", text: block.text }),
				),
			),
	);
	const names = new ToolNames(
		request.tools.map((tool) => tool.name),
		nameLimit,
	);
	const wire: WireMessage[] = [];
	for (const message of rest) {
		if (fold && message.role === "system") continue;
		const pieces = renderPart(
			raws,
			scope,
			{
				part: "message",
				message_id: message.message_id,
				content_sha256: contentSha256(entry, messageHashInput(message)),
			},
			() => messagePieces(entry, message, names),
		);
		if (message.role === "system" || message.role === "assistant") {
			// 推理块全部来自别的服务、只剩空的回复不发：服务要求每条消息都有内容
			if (pieces.length === 0) continue;
			wire.push({
				role: message.role,
				results: [],
				blocks: [...pieces],
				refs:
					message.role === "assistant"
						? sentBlocks(entry, message).map(({ index }) => ({
								message_id: message.message_id,
								index,
							}))
						: pieces.map(() => undefined),
			});
			continue;
		}
		let user = wire.at(-1);
		if (user?.role !== "user") {
			user = { role: "user", results: [], blocks: [], refs: [] };
			wire.push(user);
		}
		// 工具结果的块排在同一条 user 消息的最前面，之后才是用户的话和移出来的图片
		if (message.role === "tool_result") {
			const [result, ...moved] = pieces;
			if (result !== undefined) user.results.push(result);
			user.blocks.push(...moved);
		} else {
			user.blocks.push(...pieces);
		}
	}
	const refs: (BlockRef | undefined)[][] = [];
	const messages = wire.map((message, i) => {
		const blocks = [...message.results, ...message.blocks];
		refs.push(
			message.role === "user" ? blocks.map(() => undefined) : message.refs,
		);
		return jsonObject([
			["role", JSON.stringify(message.role)],
			[
				"content",
				jsonArray(
					i === wire.length - 1 ? withBreakpoint(blocks, control) : blocks,
				),
			],
		]);
	});
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
								name: names.wire(tool.name),
								description: tool.description,
								input_schema: tool.parameters,
							}),
						),
				);
	const effort = resolveEffort(entry, request.reasoning_effort);
	return {
		body: jsonObject([
			["model", JSON.stringify(entry.model)],
			["max_tokens", String(request.max_tokens ?? entry.max_output_tokens)],
			["system", jsonArray(withBreakpoint(systemPieces, control))],
			["messages", jsonArray(messages)],
			[
				"thinking",
				effort === undefined
					? undefined
					: effort.value === "disabled"
						? '{"type":"disabled"}'
						: '{"type":"adaptive"}',
			],
			[
				"output_config",
				effort === undefined || effort.value === "disabled"
					? undefined
					: JSON.stringify({ effort: effort.value }),
			],
			// 不设时结果取决于账号的创建日期：较早的账号上失效的推理块会被悄悄送给模型并计费
			[
				"prefix_mismatch_behavior",
				checksPrefix(entry, effort) ? '"error"' : undefined,
			],
			[
				"tools",
				tools === undefined
					? undefined
					: jsonArray(withBreakpoint(tools, control)),
			],
			[
				"tool_choice",
				tools === undefined
					? undefined
					: JSON.stringify({ type: request.tool_choice }),
			],
			// 只给出明确的回退列表，不用由服务端选模型的 "default"：Host 要知道哪些模型可能作答
			[
				"fallbacks",
				fallbacksOf(entry).length === 0
					? undefined
					: JSON.stringify(
							fallbacksOf(entry).map((fallback) => ({ model: fallback.model })),
						),
			],
			["stream", "true"],
		]),
		refs,
	};
}

/**
 * 把内部协议的请求转换成 Messages API 的请求体原文：缓存断点加在 system、tools 和最后一条消息的末尾。
 * 保存过原文的部分原样拼接，其余按内部消息转换；同样的内部请求每次得到相同的请求体。
 */
export function anthropicRequestBody(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext = {},
): string {
	return render(entry, request, context).body;
}

const stopReasons: Record<string, StopReason> = {
	end_turn: "end_turn",
	stop_sequence: "end_turn",
	tool_use: "tool_use",
	max_tokens: "max_tokens",
	model_context_window_exceeded: "context_window_exceeded",
	pause_turn: "pause_turn",
	refusal: "refusal",
};

function streamErrorCategory(type: unknown): ErrorCategory {
	switch (type) {
		case "overloaded_error":
		case "api_error":
			return "overloaded";
		case "rate_limit_error":
			return "rate_limit";
		case "authentication_error":
			return "authentication";
		case "permission_error":
		case "not_found_error":
			return "permission";
		case "request_too_large":
			return "request_too_large";
		default:
			return "invalid_request";
	}
}

const prefixMismatch =
	/^messages\.(\d+)\.content\.(\d+): Invalid `signature` in `thinking` block\. The block is bound to a different conversation\./;

/** 按状态码和各家的错误码归类 HTTP 错误，不只看状态码。 */
export function classifyAnthropicError(
	status: number,
	body: string,
	retryAfter: string | null,
): ModelErrorInfo {
	let error: Json | undefined;
	try {
		error = (JSON.parse(body) as { error?: Json }).error;
	} catch {
		// 中转服务和网关可能返回 HTML 一类的错误页，这时只用状态码归类
		error = undefined;
	}
	const message =
		typeof error?.message === "string" ? error.message : body.slice(0, 500);
	const details = error?.details as Json | undefined;
	const info = (category: ErrorCategory): ModelErrorInfo => {
		const seconds = Number(retryAfter);
		return retryAfter !== null &&
			Number.isFinite(seconds) &&
			category === "rate_limit"
			? { category, message, retry_after_ms: seconds * 1000 }
			: { category, message };
	};
	if (status === 401) return info("authentication");
	if (status === 403 || status === 404) return info("permission");
	if (status === 413) return info("request_too_large");
	if (status === 429) {
		return info(
			details?.error_code === "enforced_spend_limit_reached"
				? "billing"
				: "rate_limit",
		);
	}
	if (status === 400) {
		if (message.includes("prompt is too long")) return info("context_overflow");
		if (message.includes("You have reached your specified API usage limits")) {
			return info("billing");
		}
		if (prefixMismatch.test(message)) return info("reasoning_prefix_mismatch");
		return info("invalid_request");
	}
	if (status >= 500) return info("overloaded");
	return info("invalid_request");
}

type BlockState =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; signature: string }
	| { type: "redacted_thinking"; data: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			json: string;
			input: unknown;
	  }
	| { type: "fallback"; from: string; to: string };

function toContent(block: BlockState, origin: Origin): AssistantContent {
	switch (block.type) {
		case "fallback":
			return {
				type: "fallback",
				from: block.from,
				to: block.to,
				origin: { ...origin, model: block.to },
			};
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return {
				type: "reasoning",
				text: block.text,
				redacted: false,
				opaque: block.signature,
				origin,
			};
		case "redacted_thinking":
			return {
				type: "reasoning",
				text: "",
				redacted: true,
				opaque: block.data,
				origin,
			};
		case "tool_use":
			// 没有参数增量时，参数就是块开始时给出的 input
			return {
				type: "tool_call",
				call_id: block.id,
				name: block.name,
				arguments: block.json === "" ? JSON.stringify(block.input) : block.json,
			};
	}
}

/** 把 Messages API 的流逐块拼成内部协议的回复。 */
class MessagesParser implements StreamParser {
	#entry: ModelEntry;
	#request: ModelRequest;
	#options: StreamOptions;
	#names: ToolNames;
	#model: string;
	#usage = zeroUsage();
	/** `usage.iterations` 里每次采样的模型和用量：回退时各次按各自模型的价格计费。 */
	#iterations: { model: string; usage: Usage }[] | undefined;
	#stopReason: StopReason | undefined;
	#refusal: RefusalDetails | undefined;
	#blocks: BlockState[] = [];
	#stopped = false;

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

	event({ event, data }: SseEvent): StreamEvent[] | ModelErrorInfo {
		if (event === "ping") return [];
		const payload = JSON.parse(data) as Json;
		switch (event) {
			case "message_start": {
				const message = payload.message as Json;
				this.#model = String(message.model);
				this.#addUsage(message.usage as Json);
				return [{ type: "start", model: this.#model }];
			}
			case "content_block_start":
				return this.#start(
					payload.index as number,
					payload.content_block as Json,
				);
			case "content_block_delta":
				return this.#delta(payload.index as number, payload.delta as Json);
			case "content_block_stop":
				return this.#blocks[payload.index as number]?.type === "tool_use"
					? [{ type: "tool_call_end", index: payload.index as number }]
					: [];
			case "message_stop":
				this.#stopped = true;
				return [];
			case "message_delta": {
				const delta = payload.delta as Json;
				const reason = stopReasons[String(delta.stop_reason)];
				if (reason === undefined) {
					throw new Error(
						`Messages API 返回了不认识的停止原因：${String(delta.stop_reason)}`,
					);
				}
				this.#stopReason = reason;
				const details = delta.stop_details as Json | null | undefined;
				if (reason === "refusal" && typeof details?.category === "string") {
					this.#refusal = {
						category: details.category,
						...(typeof details.explanation === "string"
							? { explanation: details.explanation }
							: {}),
						...(typeof details.recommended_model === "string"
							? { recommended_model: details.recommended_model }
							: {}),
					};
				}
				this.#addUsage(payload.usage as Json);
				return [{ type: "usage", usage: this.#withCost() }];
			}
			case "error": {
				const error = payload.error as Json;
				return {
					category: streamErrorCategory(error.type),
					message: String(error.message),
				};
			}
			default:
				throw new Error(`Messages API 返回了不认识的事件：${event}`);
		}
	}

	#start(index: number, block: Json): StreamEvent[] {
		switch (block.type) {
			case "text":
				this.#blocks[index] = { type: "text", text: String(block.text ?? "") };
				return [];
			case "thinking":
				this.#blocks[index] = { type: "thinking", text: "", signature: "" };
				return [];
			case "redacted_thinking":
				this.#blocks[index] = {
					type: "redacted_thinking",
					data: String(block.data),
				};
				return [];
			case "tool_use": {
				const name = this.#names.original(String(block.name));
				this.#blocks[index] = {
					type: "tool_use",
					id: String(block.id),
					name,
					json: "",
					input: block.input,
				};
				return [
					{ type: "tool_call_start", index, call_id: String(block.id), name },
				];
			}
			case "fallback": {
				// 回退之后由 to 接着写：message_start 里的 model 仍是原来的模型
				const to = String((block.to as Json).model);
				this.#blocks[index] = {
					type: "fallback",
					from: String((block.from as Json).model),
					to,
				};
				this.#model = to;
				return [];
			}
			default:
				throw new Error(
					`Messages API 返回了没有列出的内容块：${String(block.type)}`,
				);
		}
	}

	#delta(index: number, delta: Json): StreamEvent[] {
		const block = this.#blocks[index];
		if (block === undefined) throw new Error(`内容块 ${index} 还没有开始`);
		if (delta.type === "text_delta" && block.type === "text") {
			block.text += String(delta.text);
			return [{ type: "text_delta", index, text: String(delta.text) }];
		}
		if (delta.type === "thinking_delta" && block.type === "thinking") {
			block.text += String(delta.thinking);
			return [{ type: "reasoning_delta", index, text: String(delta.thinking) }];
		}
		if (delta.type === "signature_delta" && block.type === "thinking") {
			block.signature += String(delta.signature);
			return [];
		}
		if (delta.type === "input_json_delta" && block.type === "tool_use") {
			block.json += String(delta.partial_json);
			return [
				{
					type: "tool_call_delta",
					index,
					arguments: String(delta.partial_json),
				},
			];
		}
		throw new Error(
			`内容块 ${index}（${block.type}）收到了不认识的增量：${String(delta.type)}`,
		);
	}

	#addUsage(raw: Json): void {
		const number = (key: string, fallback: number) =>
			typeof raw[key] === "number" ? (raw[key] as number) : fallback;
		const details = raw.output_tokens_details as Json | undefined;
		this.#usage = {
			input: number("input_tokens", this.#usage.input),
			output: number("output_tokens", this.#usage.output),
			cache_read: number("cache_read_input_tokens", this.#usage.cache_read),
			cache_write: number(
				"cache_creation_input_tokens",
				this.#usage.cache_write,
			),
			// 推理 token 算在 output_tokens 里，另列为子项
			reasoning:
				typeof details?.thinking_tokens === "number"
					? details.thinking_tokens
					: this.#usage.reasoning,
		};
		if (!Array.isArray(raw.iterations)) return;
		// 回退时顶层的用量只含作答的那一次，各次采样的用量在 iterations 里
		this.#iterations = (raw.iterations as Json[])
			.filter(
				(item) => item.type === "message" || item.type === "fallback_message",
			)
			.map((item) => ({
				model: typeof item.model === "string" ? item.model : this.#entry.model,
				usage: {
					input: Number(item.input_tokens),
					output: Number(item.output_tokens),
					cache_read: Number(item.cache_read_input_tokens),
					cache_write: Number(item.cache_creation_input_tokens),
					reasoning: 0,
				},
			}));
		const sum = (key: keyof Usage) =>
			(this.#iterations ?? []).reduce(
				(total, item) => total + (item.usage[key] ?? 0),
				0,
			);
		this.#usage = {
			...this.#usage,
			input: sum("input"),
			output: sum("output"),
			cache_read: sum("cache_read"),
			cache_write: sum("cache_write"),
		};
		// 回退之后约一小时内，后面的轮次可能直接由回退的模型回答、没有 fallback 块
		const served = (raw.iterations as Json[]).findLast(
			(item) => item.type === "fallback_message",
		);
		if (typeof served?.model === "string") this.#model = served.model;
	}

	/** 按实际作答的模型取价格：回退的模型按清单里写的它的价格。 */
	#price(model: string) {
		return model === this.#entry.model
			? this.#entry.price
			: (fallbacksOf(this.#entry).find((fallback) => fallback.model === model)
					?.price ?? this.#entry.price);
	}

	#withCost(): Usage {
		const now = new Date();
		const iterations = this.#iterations ?? [
			{ model: this.#model, usage: this.#usage },
		];
		let cost = 0;
		for (const item of iterations) {
			const price = this.#price(item.model);
			if (price === undefined) return this.#usage;
			cost += computeCost(price, item.usage, now);
		}
		return { ...this.#usage, cost_usd: cost };
	}

	#content(): AssistantContent[] {
		const origin: Origin = {
			protocol: "anthropic.messages",
			service: this.#entry.service,
			model: this.#model,
		};
		return this.#blocks.map((block) => toContent(block, origin));
	}

	#invalidate(indices: number[], reason: "refusal" | "fallback"): StreamEvent {
		return {
			type: "invalidate",
			invalidation: {
				blocks: indices.map((index) => ({
					message_id: this.#options.messageId,
					index,
				})),
				reason,
			},
		};
	}

	finish() {
		const stopReason = this.#stopReason;
		if (!this.#stopped || stopReason === undefined) return undefined;
		const content = this.#content();
		const message = buildReply(
			this.#entry,
			this.#request,
			this.#options.messageId,
			{
				content,
				model: this.#model,
				stop_reason: stopReason,
				usage: this.#withCost(),
				...(this.#refusal === undefined ? {} : { refusal: this.#refusal }),
			},
		);
		// 拒绝可能在输出部分内容之后才到，本轮的全部输出都不再发回
		if (stopReason === "refusal") {
			return {
				events: [
					this.#invalidate(
						content.map((_, index) => index),
						"refusal",
					),
				],
				message,
			};
		}
		// 回退时文本和分界原位保留；最后一个分界之前的推理内容和工具调用不能再发回，工具调用也不执行
		const boundary = content.findLastIndex(
			(block) => block.type === "fallback",
		);
		const dropped = content.flatMap((block, index) =>
			index < boundary &&
			(block.type === "reasoning" || block.type === "tool_call")
				? [index]
				: [],
		);
		return {
			events:
				dropped.length === 0 ? [] : [this.#invalidate(dropped, "fallback")],
			message,
		};
	}

	partial(stopReason: "error" | "cancelled") {
		return buildReply(this.#entry, this.#request, this.#options.messageId, {
			content: this.#content(),
			model: this.#model,
			stop_reason: stopReason,
			usage: this.#withCost(),
		});
	}
}

/**
 * 前缀校验失败时，错误信息里的 `messages.{i}.content.{j}` 映射回这次请求里内部的块；
 * 只有 400 的消息正好是绑定到别的对话时才算前缀不符。
 */
function locating(refs: (BlockRef | undefined)[][]): ErrorClassifier {
	return (status, body, retryAfter) => {
		const info = classifyAnthropicError(status, body, retryAfter);
		if (info.category !== "reasoning_prefix_mismatch") return info;
		const [, i, j] = prefixMismatch.exec(info.message) ?? [];
		const block = refs[Number(i)]?.[Number(j)];
		return block === undefined ? info : { ...info, block };
	};
}

/** 用 Messages API 发出一次流式请求。出错和取消也以 `end` 结束，不抛出约定中的失败。 */
export function streamAnthropicMessages(
	entry: ModelEntry,
	request: ModelRequest,
	options: StreamOptions,
): AsyncGenerator<StreamEvent> {
	const { body, refs } = render(entry, request, options);
	const beta = betas(entry, request);
	return runStream(
		options,
		{
			url: `${entry.base_url}/messages`,
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				"anthropic-version": anthropicVersion,
				"x-api-key": options.apiKey,
				...(beta.length === 0 ? {} : { "anthropic-beta": beta.join(",") }),
			},
			body,
		},
		locating(refs),
		new MessagesParser(entry, request, options),
	);
}
