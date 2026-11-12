import type { CountOptions, TokenCount } from "../client/count.js";
import {
	buildReply,
	type ErrorClassifier,
	runCount,
	runStream,
	type StreamParser,
	zeroUsage,
} from "../client/request.js";
import type { SseEvent } from "../client/sse.js";
import type { StreamOptions } from "../client/stream.js";
import { computeCost, serverToolsCost } from "../models/cost.js";
import {
	type ModelEntry,
	type ResolvedEffort,
	resolveEffort,
	type ServerToolName,
} from "../models/entry.js";
import type {
	AssistantContent,
	AssistantMessage,
	BlockRef,
	ErrorCategory,
	Message,
	ModelErrorInfo,
	ModelRequest,
	OpaqueBlock,
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
	inputRaw,
	jsonArray,
	jsonObject,
	messageHashInput,
	renderPart,
	sameService,
	ToolNames,
} from "./wire.js";

/** P1 起固定发送的 API 版本，换版本按破坏性改动处理。 */
export const anthropicVersion = "2026-10-21";

const nameLimit = 128;
const callIdLimit = 64;

type Json = Record<string, unknown>;

/**
 * 服务端工具在 Messages API 里的定义。用不带动态过滤的基础版本：之后的版本默认经代码执行的容器
 * 调用，要保存和带回容器的编号；基础版本也是 Vertex 和 Azure 托管的 Foundry 上唯一能用的。
 */
const serverToolWire: Record<ServerToolName, string> = {
	web_search: '{"type":"web_search_20250305","name":"web_search"}',
	web_fetch: '{"type":"web_fetch_20250910","name":"web_fetch"}',
};

/** 服务端工具的调用：结果可能要到下一条回复的开头才有。 */
const serverToolUse = "server_tool_use";

/** 服务端工具的结果块，整块随 `content_block_start` 到达。 */
const serverToolResults = new Set([
	"web_search_tool_result",
	"web_fetch_tool_result",
]);

/** `usage.server_tool_use` 里的计数对应的工具名。 */
const serverToolCounters: Record<string, ServerToolName> = {
	web_search_requests: "web_search",
	web_fetch_requests: "web_fetch",
};

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
			(block.type === "reasoning" ||
				block.type === "fallback" ||
				block.type === "opaque") &&
			!sameService(entry, "anthropic.messages", block.origin)
		) {
			return [];
		}
		return [{ index, block }];
	});
}

/** 不透明块原文里的一个字符串字段：`server_tool_use` 的 `id`，结果块的 `tool_use_id`。 */
function opaqueField(block: OpaqueBlock, name: string): string {
	return String((JSON.parse(block.raw) as Json)[name]);
}

/** 这条回复里已经有结果的服务端工具调用的编号。 */
function resolvedServerCalls(message: Message | undefined): Set<string> {
	const ids = new Set<string>();
	if (message?.role !== "assistant") return ids;
	for (const block of message.content) {
		if (block.type === "opaque" && serverToolResults.has(block.kind)) {
			ids.add(opaqueField(block, "tool_use_id"));
		}
	}
	return ids;
}

/** 这条回复里服务端工具调用的编号。 */
function serverCalls(message: Message | undefined): Set<string> {
	const ids = new Set<string>();
	if (message?.role !== "assistant") return ids;
	for (const block of message.content) {
		if (block.type === "opaque" && block.kind === serverToolUse) {
			ids.add(opaqueField(block, "id"));
		}
	}
	return ids;
}

/**
 * 一条回复里不能带回的服务端工具内容块的下标：调用和结果要成对。
 * - 调用在自己这条回复里没有结果时，后面只能是"工具结果，然后是带着它的结果的下一条回复"，或者历史
 *   到此为止（服务端在下一次请求里执行它）。多一段文字服务端就返回 400：被取消的 task 之后用户接着
 *   输入、工具执行期间插入了 steering 时会出现。
 * - 结果对应的调用要在自己这条回复里，或者在只隔着工具结果的上一条回复里。调用所在的块作废之后
 *   （回退、按事件脱敏）会剩下没有调用的结果。
 */
function unpairedServerBlocks(
	entry: ModelEntry,
	messages: readonly Message[],
	at: number,
): Set<number> {
	const message = messages[at];
	const unpaired = new Set<number>();
	if (message?.role !== "assistant") return unpaired;
	let next = at + 1;
	while (messages[next]?.role === "tool_result") next += 1;
	const follower = messages[next];
	let previous = at - 1;
	while (messages[previous]?.role === "tool_result") previous -= 1;
	const resolved = resolvedServerCalls(message);
	const later = resolvedServerCalls(follower);
	const calls = serverCalls(message);
	const earlier = serverCalls(messages[previous]);
	for (const { index, block } of sentBlocks(entry, message)) {
		if (block.type !== "opaque") continue;
		if (block.kind === serverToolUse) {
			const id = opaqueField(block, "id");
			if (resolved.has(id) || follower === undefined || later.has(id)) continue;
			unpaired.add(index);
		} else {
			const id = opaqueField(block, "tool_use_id");
			if (!calls.has(id) && !earlier.has(id)) unpaired.add(index);
		}
	}
	return unpaired;
}

function assistantBlock(
	entry: ModelEntry,
	block: AssistantContent,
	names: ToolNames,
): string {
	switch (block.type) {
		case "text":
			// 引用里的 encrypted_index 要原样带回，按收到的原文拼回去
			return block.citations !== undefined &&
				sameService(entry, "anthropic.messages", block.citations.origin)
				? jsonObject([
						["type", '"text"'],
						["text", JSON.stringify(block.text)],
						["citations", block.citations.raw],
					])
				: JSON.stringify({ type: "text", text: block.text });
		case "opaque":
			return block.raw;
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
				assistantBlock(entry, block, names),
			);
	}
}

/** 这次请求启用的服务端工具的定义。启用了条目没有列出的工具、和客户端工具重名，都是调用方的缺陷。 */
function serverToolDefinitions(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext,
): string[] {
	return (context.serverTools ?? []).map((name) => {
		if (entry.server_tools?.includes(name) !== true) {
			throw new Error(`模型 ${entry.id} 没有服务端工具 ${name}`);
		}
		if (request.tools.some((tool) => tool.name === name)) {
			throw new Error(`客户端工具和启用的服务端工具重名：${name}`);
		}
		return serverToolWire[name];
	});
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

/**
 * `count` 为真时拼的是计数接口的请求体：内容和创建消息的相同，去掉计数接口不接受的 `max_tokens`、
 * `prefix_mismatch_behavior`、`fallbacks`、`stream` 和服务端工具的定义。
 */
function render(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext,
	count = false,
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
	const sent = rest.filter((message) => !(fold && message.role === "system"));
	for (const [at, message] of sent.entries()) {
		const rendered = renderPart(
			raws,
			scope,
			{
				part: "message",
				message_id: message.message_id,
				content_sha256: contentSha256(entry, messageHashInput(message)),
			},
			() => messagePieces(entry, message, names),
		);
		if (message.role === "assistant") {
			// 保存的原文是整条回复的；不成对的服务端工具内容块取决于前后的消息，在这里去掉
			const unpaired = unpairedServerBlocks(entry, sent, at);
			const kept = sentBlocks(entry, message)
				.map(({ index }, i) => ({ index, piece: rendered[i] }))
				.filter(({ index }) => !unpaired.has(index));
			// 推理块全部来自别的服务、只剩空的回复不发：服务要求每条消息都有内容
			if (kept.length === 0) continue;
			wire.push({
				role: message.role,
				results: [],
				blocks: kept.map(({ piece }) => {
					if (piece === undefined) {
						throw new Error(
							`回复 ${message.message_id} 保存的原文和它的内容块对不上`,
						);
					}
					return piece;
				}),
				refs: kept.map(({ index }) => ({
					message_id: message.message_id,
					index,
				})),
			});
			continue;
		}
		const pieces = rendered;
		if (message.role === "system") {
			if (pieces.length === 0) continue;
			wire.push({
				role: message.role,
				results: [],
				blocks: [...pieces],
				refs: pieces.map(() => undefined),
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
	// 计数接口不接受服务端工具
	const serverTools = count
		? []
		: serverToolDefinitions(entry, request, context);
	const tools =
		request.tools.length === 0 && serverTools.length === 0
			? undefined
			: renderPart(
					raws,
					scope,
					{
						part: "tools",
						// 没有启用服务端工具时哈希和以前一样，已经保存的原文照用
						content_sha256: contentSha256(
							entry,
							serverTools.length === 0
								? request.tools
								: { tools: request.tools, server_tools: context.serverTools },
						),
					},
					() => [
						...request.tools.map((tool) =>
							JSON.stringify({
								name: names.wire(tool.name),
								description: tool.description,
								input_schema: tool.parameters,
							}),
						),
						...serverTools,
					],
				);
	const effort = resolveEffort(entry, request.reasoning_effort);
	const vertex = entry.vertex === true;
	return {
		body: jsonObject([
			// Vertex 上版本写在请求体里，模型写在地址里；只有计数接口的请求体留着 model
			[
				"anthropic_version",
				vertex ? JSON.stringify(anthropicVersion) : undefined,
			],
			["model", vertex && !count ? undefined : JSON.stringify(entry.model)],
			[
				"max_tokens",
				count
					? undefined
					: String(request.max_tokens ?? entry.max_output_tokens),
			],
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
				!count && checksPrefix(entry, effort) ? '"error"' : undefined,
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
				count || fallbacksOf(entry).length === 0
					? undefined
					: JSON.stringify(
							fallbacksOf(entry).map((fallback) => ({ model: fallback.model })),
						),
			],
			["stream", count ? undefined : "true"],
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
	| { type: "text"; text: string; citations: unknown[] }
	/** 服务端工具的块：`block` 是开始时收到的整块，`json` 是之后 `input_json_delta` 拼出的 `input`。 */
	| { type: "opaque"; kind: string; block: Json; json: string }
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

/** 服务端工具调用的一行说明：工具名加搜索的关键词或读取的地址。结果块不另写。 */
function serverToolSummary(block: Json, input: Json): string {
	const detail = input.query ?? input.url;
	return typeof detail === "string"
		? `${String(block.name)}: ${detail}`
		: String(block.name);
}

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
			return {
				type: "text",
				text: block.text,
				...(block.citations.length === 0
					? {}
					: {
							citations: { raw: JSON.stringify(block.citations), origin },
						}),
			};
		case "opaque": {
			// 调用的 input 是流里 `partial_json` 拼出的原文，没有增量时是块开始时给出的；其余字段按收到的带回
			const input =
				block.kind !== serverToolUse
					? undefined
					: block.json === ""
						? JSON.stringify(block.block.input ?? {})
						: inputRaw(block.json);
			const summary =
				input === undefined
					? undefined
					: serverToolSummary(block.block, JSON.parse(input) as Json);
			return {
				type: "opaque",
				kind: block.kind,
				...(summary === undefined ? {} : { summary }),
				raw: jsonObject([
					...Object.entries(block.block)
						.filter(([key]) => key !== "input")
						.map(([key, value]): [string, string] => [
							key,
							JSON.stringify(value),
						]),
					["input", input],
				]),
				origin,
			};
		}
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
	/** 这次请求启用了服务端工具：没启用时响应里出现它们的内容块照旧报错。 */
	#serverTools: boolean;
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
		this.#serverTools = (options.serverTools ?? []).length > 0;
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
			case "vertex-block-event": {
				// Vertex 上 Google 的内容分类器中断了流：按拒绝处理
				if (this.#entry.vertex !== true) {
					throw new Error(`Messages API 返回了不认识的事件：${event}`);
				}
				const feedback = payload.promptFeedback as Json | undefined;
				this.#stopReason = "refusal";
				this.#refusal = {
					category: String(feedback?.blockReason ?? "blocked"),
				};
				this.#stopped = true;
				return [];
			}
			default:
				throw new Error(`Messages API 返回了不认识的事件：${event}`);
		}
	}

	#start(index: number, block: Json): StreamEvent[] {
		switch (block.type) {
			case "text":
				this.#blocks[index] = {
					type: "text",
					text: String(block.text ?? ""),
					citations: Array.isArray(block.citations) ? [...block.citations] : [],
				};
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
			default: {
				const kind = String(block.type);
				if (
					this.#serverTools &&
					(kind === serverToolUse || serverToolResults.has(kind))
				) {
					this.#blocks[index] = { type: "opaque", kind, block, json: "" };
					return [];
				}
				throw new Error(`Messages API 返回了没有列出的内容块：${kind}`);
			}
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
		if (delta.type === "citations_delta" && block.type === "text") {
			block.citations.push(delta.citation);
			return [];
		}
		if (
			delta.type === "input_json_delta" &&
			block.type === "opaque" &&
			block.kind === serverToolUse
		) {
			block.json += String(delta.partial_json);
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
			...this.#serverToolUsage(raw.server_tool_use as Json | null | undefined),
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
		const sum = (key: "input" | "output" | "cache_read" | "cache_write") =>
			(this.#iterations ?? []).reduce(
				(total, item) => total + item.usage[key],
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

	/**
	 * 服务端工具计费的次数：`message_delta` 里的是累计值，后到的覆盖先到的；这一份用量里没有时
	 * 沿用已有的。失败的搜索不计费，所以不按内容块的个数算。
	 */
	#serverToolUsage(raw: Json | null | undefined): Pick<Usage, "server_tools"> {
		if (raw === null || raw === undefined) {
			return this.#usage.server_tools === undefined
				? {}
				: { server_tools: this.#usage.server_tools };
		}
		const counts: Record<string, number> = {};
		for (const [counter, name] of Object.entries(serverToolCounters)) {
			const calls = raw[counter];
			if (typeof calls === "number" && calls > 0) counts[name] = calls;
		}
		return Object.keys(counts).length === 0 ? {} : { server_tools: counts };
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
		// 服务端工具按次计费，价格是服务的，不随作答的模型变：按条目自己的价格算一次
		let cost =
			this.#entry.price === undefined
				? 0
				: serverToolsCost(this.#entry.price, this.#usage);
		for (const item of iterations) {
			const price = this.#price(item.model);
			if (price === undefined) return this.#usage;
			const { input, output, cache_read, cache_write, reasoning } = item.usage;
			cost += computeCost(
				price,
				{ input, output, cache_read, cache_write, reasoning },
				now,
			);
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
		// 分界之前的服务端工具调用成对留下，没有结果的不能再发回
		const resolved = resolvedServerCalls(message);
		const dropped = content.flatMap((block, index) =>
			index < boundary &&
			(block.type === "reasoning" ||
				block.type === "tool_call" ||
				(block.type === "opaque" &&
					block.kind === serverToolUse &&
					!resolved.has(opaqueField(block, "id"))))
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

/** API 版本的请求头；Vertex 上版本写在请求体里，不发这个头。 */
function versionHeader(entry: ModelEntry): Record<string, string> {
	return entry.vertex === true ? {} : { "anthropic-version": anthropicVersion };
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
		entry,
		options,
		{
			url:
				entry.vertex === true
					? `${entry.base_url}/${entry.model}:streamRawPredict`
					: `${entry.base_url}/messages`,
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				...versionHeader(entry),
				...(beta.length === 0 ? {} : { "anthropic-beta": beta.join(",") }),
			},
			body,
		},
		locating(refs),
		new MessagesParser(entry, request, options),
	);
}

/**
 * 用 `POST /v1/messages/count_tokens` 数这次请求的输入 token。请求体和创建消息的相同，前缀校验和
 * 回退的 beta 字段连同它们的 header 都不带：计数接口不接受。
 */
export function countAnthropicMessages(
	entry: ModelEntry,
	request: ModelRequest,
	options: CountOptions,
): Promise<TokenCount> {
	return runCount(
		entry,
		options,
		{
			url:
				entry.vertex === true
					? `${entry.base_url}/count-tokens:rawPredict`
					: `${entry.base_url}/messages/count_tokens`,
			headers: {
				"content-type": "application/json",
				...versionHeader(entry),
			},
			body: render(entry, request, options, true).body,
		},
		classifyAnthropicError,
	);
}
