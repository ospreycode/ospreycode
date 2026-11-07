import { parseSse } from "../client/sse.js";
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
	ErrorCategory,
	Message,
	ModelErrorInfo,
	ModelRequest,
	Origin,
	RefusalDetails,
	StopReason,
	StreamEvent,
	Usage,
	UserContent,
} from "../protocol/index.js";

/** P1 起固定发送的 API 版本，换版本按破坏性改动处理。 */
export const anthropicVersion = "2026-10-21";

/** 流在这么久没有数据时按网络中断处理。 */
const idleTimeoutMs = 300_000;

type Json = Record<string, unknown>;

function cacheControl(
	retention: ModelRequest["cache_retention"],
): Json | undefined {
	if (retention === "none") return undefined;
	return retention === "long"
		? { type: "ephemeral", ttl: "1h" }
		: { type: "ephemeral" };
}

/** 在最后一个块上加缓存断点：断点只在组装请求时加，不进内部消息。 */
function withBreakpoint(blocks: Json[], control: Json | undefined): Json[] {
	const last = blocks.at(-1);
	if (control === undefined || last === undefined) return blocks;
	return [...blocks.slice(0, -1), { ...last, cache_control: control }];
}

function userBlock(block: UserContent): Json {
	return block.type === "text"
		? { type: "text", text: block.text }
		: {
				type: "image",
				source: {
					type: "base64",
					media_type: block.media_type,
					data: block.data,
				},
			};
}

function assistantBlock(block: AssistantContent): Json[] {
	switch (block.type) {
		case "text":
			return [{ type: "text", text: block.text }];
		case "tool_call":
			return [
				{
					type: "tool_use",
					id: block.call_id,
					name: block.name,
					input: JSON.parse(block.arguments),
				},
			];
		case "reasoning":
			// 其他协议的推理内容带不过来；同协议内换模型时原样带回，由服务端丢弃读不了的
			if (block.origin.protocol !== "anthropic.messages") return [];
			return block.redacted
				? [{ type: "redacted_thinking", data: block.opaque }]
				: [{ type: "thinking", thinking: block.text, signature: block.opaque }];
	}
}

function convertMessages(messages: readonly Message[]): Json[] {
	const out: { role: string; content: Json[] }[] = [];
	// 工具结果和紧跟其后的用户输入并进同一条 user 消息
	const appendUser = (blocks: Json[]) => {
		const last = out.at(-1);
		if (last?.role === "user") last.content.push(...blocks);
		else out.push({ role: "user", content: blocks });
	};
	for (const message of messages) {
		switch (message.role) {
			case "system":
				out.push({
					role: "system",
					content: message.content.map((b) => ({ type: "text", text: b.text })),
				});
				break;
			case "user":
				appendUser(message.content.map(userBlock));
				break;
			case "tool_result":
				appendUser([
					{
						type: "tool_result",
						tool_use_id: message.call_id,
						content: message.content.map(userBlock),
						is_error: message.is_error,
					},
				]);
				break;
			case "assistant":
				out.push({
					role: "assistant",
					content: message.content.flatMap((block) => assistantBlock(block)),
				});
				break;
		}
	}
	return out;
}

/** 做前缀校验的模型在开着推理时，请求带上这个 beta，并显式要求校验失败时报错。 */
const prefixCheckBeta = "thinking-binding-controls-2026-08-01";

/** 这次请求要不要显式开启前缀校验：Haiku 5.5 关掉推理时不能设这个字段。 */
function checksPrefix(entry: ModelEntry, effort: ResolvedEffort | undefined) {
	return entry.prefix_check === true && effort?.value !== "disabled";
}

/** 把内部协议的请求转换成 Messages API 的请求体。同样的内部请求每次生成相同的请求体。 */
export function anthropicRequestBody(
	entry: ModelEntry,
	request: ModelRequest,
): Json {
	const [first, ...rest] = request.messages;
	if (first?.role !== "system") {
		throw new Error("内部请求的第一条消息必须是系统指令");
	}
	if (request.sampling !== undefined) {
		throw new Error(`Anthropic API ${anthropicVersion} 不接受采样参数`);
	}
	const control = cacheControl(request.cache_retention);
	const messages = convertMessages(rest).map((message, i, all) =>
		i === all.length - 1
			? {
					...message,
					content: withBreakpoint(message.content as Json[], control),
				}
			: message,
	);
	const body: Json = {
		model: entry.model,
		max_tokens: request.max_tokens ?? entry.max_output_tokens,
		system: withBreakpoint(
			first.content.map((b) => ({ type: "text", text: b.text })),
			control,
		),
		messages,
		stream: true,
	};
	const effort = resolveEffort(entry, request.reasoning_effort);
	if (effort !== undefined) {
		if (effort.value === "disabled") {
			body.thinking = { type: "disabled" };
		} else {
			body.thinking = { type: "adaptive" };
			body.output_config = { effort: effort.value };
		}
	}
	// 不设时结果取决于账号的创建日期：较早的账号上失效的推理块会被悄悄送给模型并计费
	if (checksPrefix(entry, effort)) body.prefix_mismatch_behavior = "error";
	if (request.tools.length > 0) {
		body.tools = withBreakpoint(
			request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			})),
			control,
		);
		body.tool_choice = { type: request.tool_choice };
	}
	return body;
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
		if (
			/^messages\.\d+\.content\.\d+: Invalid `signature` in `thinking` block\. The block is bound to a different conversation\./.test(
				message,
			)
		) {
			return info("reasoning_prefix_mismatch");
		}
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
	  };

function toContent(block: BlockState, origin: Origin): AssistantContent {
	switch (block.type) {
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
class ReplyBuilder {
	model: string;
	usage: Usage = {
		input: 0,
		output: 0,
		cache_read: 0,
		cache_write: 0,
		reasoning: 0,
	};
	stopReason: StopReason | undefined;
	refusal: RefusalDetails | undefined;
	#blocks: BlockState[] = [];
	#entry: ModelEntry;
	#request: ModelRequest;
	#messageId: string;

	constructor(entry: ModelEntry, request: ModelRequest, messageId: string) {
		this.#entry = entry;
		this.#request = request;
		this.#messageId = messageId;
		this.model = entry.model;
	}

	start(index: number, block: Json): StreamEvent | undefined {
		switch (block.type) {
			case "text":
				this.#blocks[index] = { type: "text", text: String(block.text ?? "") };
				return undefined;
			case "thinking":
				this.#blocks[index] = { type: "thinking", text: "", signature: "" };
				return undefined;
			case "redacted_thinking":
				this.#blocks[index] = {
					type: "redacted_thinking",
					data: String(block.data),
				};
				return undefined;
			case "tool_use":
				this.#blocks[index] = {
					type: "tool_use",
					id: String(block.id),
					name: String(block.name),
					json: "",
					input: block.input,
				};
				return {
					type: "tool_call_start",
					index,
					call_id: String(block.id),
					name: String(block.name),
				};
			default:
				throw new Error(
					`Messages API 返回了没有列出的内容块：${String(block.type)}`,
				);
		}
	}

	delta(index: number, delta: Json): StreamEvent | undefined {
		const block = this.#blocks[index];
		if (block === undefined) throw new Error(`内容块 ${index} 还没有开始`);
		if (delta.type === "text_delta" && block.type === "text") {
			block.text += String(delta.text);
			return { type: "text_delta", index, text: String(delta.text) };
		}
		if (delta.type === "thinking_delta" && block.type === "thinking") {
			block.text += String(delta.thinking);
			return { type: "reasoning_delta", index, text: String(delta.thinking) };
		}
		if (delta.type === "signature_delta" && block.type === "thinking") {
			block.signature += String(delta.signature);
			return undefined;
		}
		if (delta.type === "input_json_delta" && block.type === "tool_use") {
			block.json += String(delta.partial_json);
			return {
				type: "tool_call_delta",
				index,
				arguments: String(delta.partial_json),
			};
		}
		throw new Error(
			`内容块 ${index}（${block.type}）收到了不认识的增量：${String(delta.type)}`,
		);
	}

	stop(index: number): StreamEvent | undefined {
		return this.#blocks[index]?.type === "tool_use"
			? { type: "tool_call_end", index }
			: undefined;
	}

	addUsage(raw: Json): StreamEvent {
		const number = (key: string, fallback: number) =>
			typeof raw[key] === "number" ? (raw[key] as number) : fallback;
		const details = raw.output_tokens_details as Json | undefined;
		this.usage = {
			input: number("input_tokens", this.usage.input),
			output: number("output_tokens", this.usage.output),
			cache_read: number("cache_read_input_tokens", this.usage.cache_read),
			cache_write: number(
				"cache_creation_input_tokens",
				this.usage.cache_write,
			),
			// 推理 token 算在 output_tokens 里，另列为子项
			reasoning:
				typeof details?.thinking_tokens === "number"
					? details.thinking_tokens
					: this.usage.reasoning,
		};
		return { type: "usage", usage: this.#usageWithCost() };
	}

	#usageWithCost(): Usage {
		const { price } = this.#entry;
		return price === undefined
			? this.usage
			: { ...this.usage, cost_usd: computeCost(price, this.usage, new Date()) };
	}

	message(stopReason: StopReason): AssistantMessage {
		const origin = {
			protocol: "anthropic.messages" as const,
			service: this.#entry.service,
			model: this.model,
		};
		const content = this.#blocks.map((block) => toContent(block, origin));
		const effort = resolveEffort(this.#entry, this.#request.reasoning_effort);
		const message: AssistantMessage = {
			role: "assistant",
			message_id: this.#messageId,
			content,
			protocol: "anthropic.messages",
			service: this.#entry.service,
			requested_model: this.#entry.id,
			model: this.model,
			reasoning_effort: this.#request.reasoning_effort,
			...(effort === undefined ? {} : { reasoning_effort_sent: effort.value }),
			stop_reason: stopReason,
			usage: this.#usageWithCost(),
		};
		if (this.refusal !== undefined) message.refusal = this.refusal;
		return message;
	}
}

function errorEnd(builder: ReplyBuilder, error: ModelErrorInfo): StreamEvent {
	return { type: "end", message: builder.message("error"), error };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 用 Messages API 发出一次流式请求。出错和取消也以 `end` 结束，不抛出约定中的失败。 */
export async function* streamAnthropicMessages(
	entry: ModelEntry,
	request: ModelRequest,
	options: StreamOptions,
): AsyncGenerator<StreamEvent> {
	const builder = new ReplyBuilder(entry, request, options.messageId);
	const idle = new AbortController();
	let timer = setTimeout(() => idle.abort(), idleTimeoutMs);
	const signal = AbortSignal.any([options.signal, idle.signal]);
	try {
		let response: Response;
		try {
			response = await options.fetch(`${entry.base_url}/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					"anthropic-version": anthropicVersion,
					"x-api-key": options.apiKey,
					...(checksPrefix(
						entry,
						resolveEffort(entry, request.reasoning_effort),
					)
						? { "anthropic-beta": prefixCheckBeta }
						: {}),
				},
				body: JSON.stringify(anthropicRequestBody(entry, request)),
				signal,
			});
		} catch (error) {
			if (options.signal.aborted) {
				yield { type: "end", message: builder.message("cancelled") };
				return;
			}
			yield errorEnd(builder, {
				category: "network",
				message: describe(error),
			});
			return;
		}
		if (!response.ok || response.body === null) {
			yield errorEnd(
				builder,
				classifyAnthropicError(
					response.status,
					await response.text(),
					response.headers.get("retry-after"),
				),
			);
			return;
		}
		let stopped = false;
		try {
			for await (const { event, data } of parseSse(response.body)) {
				clearTimeout(timer);
				timer = setTimeout(() => idle.abort(), idleTimeoutMs);
				if (event === "ping") continue;
				const payload = JSON.parse(data) as Json;
				let out: StreamEvent | undefined;
				switch (event) {
					case "message_start": {
						const message = payload.message as Json;
						builder.model = String(message.model);
						builder.addUsage(message.usage as Json);
						out = { type: "start", model: builder.model };
						break;
					}
					case "content_block_start":
						out = builder.start(
							payload.index as number,
							payload.content_block as Json,
						);
						break;
					case "content_block_delta":
						out = builder.delta(payload.index as number, payload.delta as Json);
						break;
					case "content_block_stop":
						out = builder.stop(payload.index as number);
						break;
					case "message_delta": {
						const delta = payload.delta as Json;
						const reason = stopReasons[String(delta.stop_reason)];
						if (reason === undefined) {
							throw new Error(
								`Messages API 返回了不认识的停止原因：${String(delta.stop_reason)}`,
							);
						}
						builder.stopReason = reason;
						const details = delta.stop_details as Json | null | undefined;
						if (reason === "refusal" && typeof details?.category === "string") {
							builder.refusal = {
								category: details.category,
								...(typeof details.explanation === "string"
									? { explanation: details.explanation }
									: {}),
							};
						}
						out = builder.addUsage(payload.usage as Json);
						break;
					}
					case "message_stop":
						stopped = true;
						break;
					case "error": {
						const error = payload.error as Json;
						yield errorEnd(builder, {
							category: streamErrorCategory(error.type),
							message: String(error.message),
						});
						return;
					}
					default:
						throw new Error(`Messages API 返回了不认识的事件：${event}`);
				}
				if (out !== undefined) yield out;
			}
		} catch (error) {
			if (options.signal.aborted) {
				yield { type: "end", message: builder.message("cancelled") };
				return;
			}
			if (idle.signal.aborted) {
				yield errorEnd(builder, {
					category: "network",
					message: `流超过 ${idleTimeoutMs / 1000} 秒没有数据`,
				});
				return;
			}
			if (
				error instanceof TypeError ||
				(error as Error).name === "AbortError"
			) {
				yield errorEnd(builder, {
					category: "network",
					message: describe(error),
				});
				return;
			}
			throw error;
		}
		if (!stopped || builder.stopReason === undefined) {
			yield errorEnd(builder, {
				category: "network",
				message: "流在 message_stop 之前结束",
			});
			return;
		}
		yield { type: "end", message: builder.message(builder.stopReason) };
	} finally {
		clearTimeout(timer);
	}
}
