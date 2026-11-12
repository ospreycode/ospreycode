import { computeCost } from "../models/cost.js";
import { type ModelEntry, resolveEffort } from "../models/entry.js";
import type {
	AssistantContent,
	AssistantMessage,
	ModelErrorInfo,
	ModelRequest,
	RefusalDetails,
	StopReason,
	StreamEvent,
	Usage,
} from "../protocol/index.js";
import { authorize, CredentialFormatError } from "./auth.js";
import type { CountOptions, TokenCount } from "./count.js";
import { parseSse, type SseEvent } from "./sse.js";
import type { StreamOptions } from "./stream.js";

/** 流在这么久没有数据时按网络中断处理。 */
export const idleTimeoutMs = 300_000;

/** 一次 HTTP 请求：请求体是已经拼好的 JSON 原文。认证的请求头不在这里，发出之前按模型条目加上。 */
export interface HttpRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** 按协议处理流里的事件，拼出内部协议的回复。 */
export interface StreamParser {
	/** 处理一个 SSE 事件，产出内部事件；流里报告的错误以 `ModelErrorInfo` 返回。 */
	event(event: SseEvent): StreamEvent[] | ModelErrorInfo;
	/** 流读完时最后的事件和回复；没有收到正常结束的标志时返回空，按网络中断处理。 */
	finish(): { events: StreamEvent[]; message: AssistantMessage } | undefined;
	/** 出错或取消时已收到的部分。 */
	partial(stopReason: "error" | "cancelled"): AssistantMessage;
}

/** 按状态码和服务的错误码归类 HTTP 错误。`retryAfter` 是服务建议的等待秒数（`retry-after` 的值）。 */
export type ErrorClassifier = (
	status: number,
	body: string,
	retryAfter: string | null,
) => ModelErrorInfo;

/** 服务建议的等待秒数。Azure OpenAI 另给毫秒数的 `retry-after-ms`，有它时用它。 */
function retryAfter(headers: Headers): string | null {
	const ms = headers.get("retry-after-ms");
	return ms === null ? headers.get("retry-after") : String(Number(ms) / 1000);
}

/** 凭据放不进请求（格式和条目的 `auth` 对不上）时的错误：和服务返回 401 归在同一类。 */
function credentialFailure(error: CredentialFormatError): ModelErrorInfo {
	return { category: "authentication", message: error.message };
}

/** 错误的说明。`fetch` 只报"fetch failed"，真正的原因（连接超时、连接被重置等）在 `cause` 里，一并写出。 */
function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const { cause } = error;
	if (!(cause instanceof Error)) return error.message;
	// 几个地址都连不上时原因是一个没有信息的 AggregateError，只有错误码
	const reason =
		cause.message || (cause as NodeJS.ErrnoException).code || cause.name;
	return `${error.message}: ${reason}`;
}

/**
 * 发出请求并逐个处理 SSE 事件，以唯一的 `end` 结束：服务报错、网络中断、空闲超时和取消都体现在
 * `end` 里，不抛出。只有转换模块的缺陷和没有列出的内容才抛出。
 */
export async function* runStream(
	entry: ModelEntry,
	options: StreamOptions,
	http: HttpRequest,
	classify: ErrorClassifier,
	parser: StreamParser,
): AsyncGenerator<StreamEvent> {
	const idle = new AbortController();
	let timer = setTimeout(() => idle.abort(), idleTimeoutMs);
	const signal = AbortSignal.any([options.signal, idle.signal]);
	const fail = (error: ModelErrorInfo): StreamEvent => ({
		type: "end",
		message: parser.partial("error"),
		error,
	});
	const cancelled = (): StreamEvent => ({
		type: "end",
		message: parser.partial("cancelled"),
	});
	try {
		let headers: Record<string, string>;
		try {
			headers = authorize(entry, options.apiKey, http, new Date());
		} catch (error) {
			if (!(error instanceof CredentialFormatError)) throw error;
			yield fail(credentialFailure(error));
			return;
		}
		let response: Response;
		try {
			response = await options.fetch(http.url, {
				method: "POST",
				headers,
				body: http.body,
				signal,
			});
		} catch (error) {
			yield options.signal.aborted
				? cancelled()
				: fail({ category: "network", message: describe(error) });
			return;
		}
		if (!response.ok || response.body === null) {
			yield fail(
				classify(
					response.status,
					await response.text(),
					retryAfter(response.headers),
				),
			);
			return;
		}
		try {
			for await (const sse of parseSse(response.body)) {
				clearTimeout(timer);
				timer = setTimeout(() => idle.abort(), idleTimeoutMs);
				const result = parser.event(sse);
				if (!Array.isArray(result)) {
					yield fail(result);
					return;
				}
				yield* result;
			}
		} catch (error) {
			if (options.signal.aborted) {
				yield cancelled();
				return;
			}
			if (idle.signal.aborted) {
				yield fail({
					category: "network",
					message: `流超过 ${idleTimeoutMs / 1000} 秒没有数据`,
				});
				return;
			}
			if (
				error instanceof TypeError ||
				(error as Error).name === "AbortError"
			) {
				yield fail({ category: "network", message: describe(error) });
				return;
			}
			throw error;
		}
		const finished = parser.finish();
		if (finished === undefined) {
			yield fail({ category: "network", message: "流在结束标志之前断开" });
			return;
		}
		yield* finished.events;
		yield { type: "end", message: finished.message };
	} finally {
		clearTimeout(timer);
	}
}

/** 计数请求这么久没有结果按网络超时处理：它不流式返回，没有"空闲"可言。 */
export const countTimeoutMs = 60_000;

/**
 * 发出一次计数请求，读出响应里的 token 数（`field`，各家的字段名不同）。服务报错、网络中断、
 * 超时和取消都体现在结果里，不抛出。
 */
export async function runCount(
	entry: ModelEntry,
	options: CountOptions,
	http: HttpRequest,
	classify: ErrorClassifier,
	field = "input_tokens",
): Promise<TokenCount> {
	const timeout = AbortSignal.timeout(countTimeoutMs);
	const network = (message: string): TokenCount => ({
		error: { category: "network", message },
	});
	let headers: Record<string, string>;
	try {
		headers = authorize(entry, options.apiKey, http, new Date());
	} catch (error) {
		if (!(error instanceof CredentialFormatError)) throw error;
		return { error: credentialFailure(error) };
	}
	let status: number;
	let body: string;
	let wait: string | null;
	try {
		const response = await options.fetch(http.url, {
			method: "POST",
			headers,
			body: http.body,
			signal: AbortSignal.any([options.signal, timeout]),
		});
		status = response.status;
		wait = retryAfter(response.headers);
		body = await response.text();
	} catch (error) {
		if (options.signal.aborted) return { cancelled: true };
		return network(
			timeout.aborted
				? `计数请求超过 ${countTimeoutMs / 1000} 秒没有结果`
				: describe(error),
		);
	}
	if (status < 200 || status >= 300) {
		return { error: classify(status, body, wait) };
	}
	let count: unknown;
	try {
		count = (JSON.parse(body) as Record<string, unknown>)[field];
	} catch {
		// 中转服务和网关可能用 200 返回 HTML 一类的页面，和下面缺字段的情况一样处理
		count = undefined;
	}
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
		return network(`计数接口的响应里没有 ${field}`);
	}
	return { input_tokens: count };
}

/** 没有用量时的初值。 */
export function zeroUsage(): Usage {
	return { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
}

/** 一条回复里各协议共用的部分。 */
export interface ReplyFields {
	content: AssistantContent[];
	/** 实际回答的模型。 */
	model: string;
	stop_reason: StopReason;
	/** 已经带 `cost_usd` 时不再按清单的价格计算（如 Anthropic 按 `usage.iterations` 逐次计价）。 */
	usage: Usage;
	refusal?: RefusalDetails;
}

/** 拼出内部协议的回复：记下所用的协议、服务、模型、请求和实际发出的推理强度，按清单的价格计费。 */
export function buildReply(
	entry: ModelEntry,
	request: ModelRequest,
	messageId: string,
	fields: ReplyFields,
): AssistantMessage {
	const effort = resolveEffort(entry, request.reasoning_effort);
	const usage =
		fields.usage.cost_usd !== undefined || entry.price === undefined
			? fields.usage
			: {
					...fields.usage,
					cost_usd: computeCost(entry.price, fields.usage, new Date()),
				};
	return {
		role: "assistant",
		message_id: messageId,
		content: fields.content,
		protocol: entry.protocol,
		service: entry.service,
		requested_model: entry.id,
		model: fields.model,
		reasoning_effort: request.reasoning_effort,
		...(effort === undefined ? {} : { reasoning_effort_sent: effort.value }),
		stop_reason: fields.stop_reason,
		...(fields.refusal === undefined ? {} : { refusal: fields.refusal }),
		usage,
	};
}
