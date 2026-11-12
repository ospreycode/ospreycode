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
	AssistantMessage,
	ErrorCategory,
	ImageBlock,
	ModelErrorInfo,
	ModelRequest,
	Origin,
	ReasoningBlock,
	RefusalDetails,
	StreamEvent,
	SystemMessage,
	TextBlock,
	ToolResultMessage,
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
} from "./wire.js";

/** `generateContent` 没有版本头，保存的原文按接口路径的版本区分。 */
export const googleGenerateContentApiVersion = "v1";

const protocol = "google.generate-content";
const nameLimit = 128;
const callIdLimit = 64;

/**
 * 官方文档给的占位签名：一轮里每一步的第一个 `functionCall` 没有签名时请求返回 400，
 * 别的模型留下的调用没有签名，写上它跳过校验。
 */
const skipSignature = "skip_thought_signature_validator";

/** `functionResponse.parts` 接受的图片类型：官方文档只列了这三种，写明没列出的类型返回 400。 */
const responseImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

type Json = Record<string, unknown>;

function scopeOf(entry: ModelEntry) {
	return {
		protocol,
		service: entry.service,
		api_version: googleGenerateContentApiVersion,
	} as const;
}

/**
 * 工具名在 Gemini 里的写法：按内部协议的规则改写之后，首字符还必须是字母或下划线，是数字或连字符时
 * 在前面加一个下划线，加了之后超长的同样截断并加哈希。
 */
function wireName(name: string): string {
	const fitted = fitIdentifier(name, nameLimit);
	return /^[A-Za-z_]/.test(fitted)
		? fitted
		: fitIdentifier(`_${name}`, nameLimit);
}

/** 一次请求里工具名的改写和反查：和 `ToolNames` 的行为相同，只多了首字符的规则。 */
class FunctionNames {
	#fromWire = new Map<string, string>();

	constructor(names: readonly string[]) {
		for (const name of names) {
			const wire = wireName(name);
			const taken = this.#fromWire.get(wire);
			if (taken !== undefined && taken !== name) {
				throw new Error(`工具 ${taken} 和 ${name} 改写后重名：${wire}`);
			}
			this.#fromWire.set(wire, name);
		}
	}

	/** 工具名在 Gemini 里的写法；历史里已经不在工具集里的工具同样改写。 */
	wire(name: string): string {
		return wireName(name);
	}

	/** 模型调用的工具名换回内部的名字；没有声明过的原样交给 runtime，由它报告不认识的工具。 */
	original(wire: string): string {
		return this.#fromWire.get(wire) ?? wire;
	}
}

function userPart(block: UserContent): Json {
	return block.type === "text"
		? { text: block.text }
		: { inlineData: { mimeType: block.media_type, data: block.data } };
}

/**
 * 一条回复在 Gemini 里的 part。签名要回到收到它的那个 part 上：文字为空的推理块就是紧跟其后那个
 * `text` 或 `functionCall` part 上的签名，后面接不上这两种 part 时，它原来在一个空的 `text` part 上。
 * 推理内容只带回同一服务；回退的分界和不透明块是别的协议的东西，不发。
 */
function modelParts(
	entry: ModelEntry,
	message: AssistantMessage,
	names: FunctionNames,
): string[] {
	const parts: string[] = [];
	let signature: string | undefined;
	let called = false;
	const flush = () => {
		if (signature === undefined) return;
		parts.push(JSON.stringify({ text: "", thoughtSignature: signature }));
		signature = undefined;
	};
	for (const block of message.content) {
		switch (block.type) {
			case "reasoning":
				if (!sameService(entry, protocol, block.origin)) break;
				flush();
				if (block.text === "") {
					signature = block.opaque;
					break;
				}
				parts.push(
					JSON.stringify({
						text: block.text,
						thought: true,
						...(block.opaque === undefined
							? {}
							: { thoughtSignature: block.opaque }),
					}),
				);
				break;
			case "text":
				if (block.text === "") break;
				parts.push(
					JSON.stringify({
						text: block.text,
						...(signature === undefined ? {} : { thoughtSignature: signature }),
					}),
				);
				signature = undefined;
				break;
			case "tool_call": {
				// 第一个调用的签名所在的推理块可能被作废了，也可能这条回复来自别的模型
				const own = signature ?? (called ? undefined : skipSignature);
				parts.push(
					jsonObject([
						[
							"functionCall",
							jsonObject([
								["name", JSON.stringify(names.wire(block.name))],
								["args", inputRaw(block.arguments)],
								[
									"id",
									JSON.stringify(fitIdentifier(block.call_id, callIdLimit)),
								],
							]),
						],
						[
							"thoughtSignature",
							own === undefined ? undefined : JSON.stringify(own),
						],
					]),
				);
				signature = undefined;
				called = true;
				break;
			}
			case "fallback":
			case "opaque":
				break;
		}
	}
	flush();
	return parts;
}

/**
 * 一条工具结果的片段：第一段是 `functionResponse` part，文字放 `response.output`，出错时放
 * `response.error`（官方 SDK 约定的两个键），图片放在它的 `parts` 里；其余是 `functionResponse.parts`
 * 不接受的图片，移到这组结果之后。
 */
function toolResultPieces(
	entry: ModelEntry,
	message: ToolResultMessage,
	name: string,
): string[] {
	const content = fitImages(entry, message.content);
	const text = content
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = content.filter(
		(block): block is ImageBlock => block.type === "image",
	);
	const nested = images.filter((image) =>
		responseImageTypes.has(image.media_type),
	);
	const moved = images.filter(
		(image) => !responseImageTypes.has(image.media_type),
	);
	return [
		JSON.stringify({
			functionResponse: {
				id: fitIdentifier(message.call_id, callIdLimit),
				name,
				response: message.is_error ? { error: text } : { output: text },
				...(nested.length === 0 ? {} : { parts: nested.map(userPart) }),
			},
		}),
		...moved.map((image) => JSON.stringify(userPart(image))),
	];
}

/** 一条发出的 content：`functionResponse` 的 part 排在最前面，之后才是用户的话和移出来的图片。 */
interface WireContent {
	role: "user" | "model";
	responses: string[];
	parts: string[];
}

/**
 * `count` 为真时拼的是 `countTokens` 的请求体：同一份内容包在 `generateContentRequest` 里，
 * 另带 `model`（真实请求里模型只写在地址上）。
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
	if (request.sampling !== undefined) {
		throw new Error("Gemini API 不接受采样参数");
	}
	const [serverTool] = context.serverTools ?? [];
	if (serverTool !== undefined) {
		throw new Error(`模型 ${entry.id} 没有服务端工具 ${serverTool}`);
	}
	const scope = scopeOf(entry);
	const { raws } = context;
	// Gemini 只有 systemInstruction 一处能放系统指令，之后追加的系统级指令总是并进去
	const system = [
		first,
		...rest.filter((m): m is SystemMessage => m.role === "system"),
	];
	const systemParts = renderPart(
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
				message.content.map((block) => JSON.stringify({ text: block.text })),
			),
	);
	const names = new FunctionNames(request.tools.map((tool) => tool.name));
	const contents: WireContent[] = [];
	// `functionResponse` 要带上调用的名字：记下历史里到这里为止每个调用编号对应的工具名
	const called = new Map<string, string>();
	for (const message of rest) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "tool_call") called.set(block.call_id, block.name);
			}
			const parts = renderPart(
				raws,
				scope,
				{
					part: "message",
					message_id: message.message_id,
					content_sha256: contentSha256(entry, messageHashInput(message)),
				},
				() => modelParts(entry, message, names),
			);
			// 推理块全部来自别的服务、什么 part 都不剩的回复不发：content 不能没有 part
			if (parts.length > 0) {
				contents.push({ role: "model", responses: [], parts });
			}
			continue;
		}
		let user = contents.at(-1);
		if (user?.role !== "user") {
			user = { role: "user", responses: [], parts: [] };
			contents.push(user);
		}
		if (message.role === "user") {
			user.parts.push(
				...renderPart(
					raws,
					scope,
					{
						part: "message",
						message_id: message.message_id,
						content_sha256: contentSha256(entry, messageHashInput(message)),
					},
					() =>
						fitImages(entry, message.content).map((block) =>
							JSON.stringify(userPart(block)),
						),
				),
			);
			continue;
		}
		const name = called.get(message.call_id);
		if (name === undefined) {
			throw new Error(
				`工具结果 ${message.message_id} 对应的调用 ${message.call_id} 不在历史里`,
			);
		}
		const pieces = renderPart(
			raws,
			scope,
			{
				part: "message",
				message_id: message.message_id,
				// 调用的名字不在这条消息里，但决定转换结果，一起算进哈希
				content_sha256: contentSha256(entry, { message, name }),
			},
			() => toolResultPieces(entry, message, names.wire(name)),
		);
		// 调用和结果不能交错：这组结果按调用的顺序排在这条 content 的最前面
		user.responses.push(...pieces.slice(0, 1));
		user.parts.push(...pieces.slice(1));
	}
	const declarations =
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
								// 标准的 JSON Schema 放这个字段；`parameters` 是 OpenAPI 的子集
								parametersJsonSchema: tool.parameters,
							}),
						),
				);
	const effort = resolveEffort(entry, request.reasoning_effort);
	const fields: [string, string | undefined][] = [
		["systemInstruction", jsonObject([["parts", jsonArray(systemParts)]])],
		[
			"contents",
			jsonArray(
				contents.map((content) =>
					jsonObject([
						["role", JSON.stringify(content.role)],
						["parts", jsonArray([...content.responses, ...content.parts])],
					]),
				),
			),
		],
		[
			"tools",
			declarations === undefined
				? undefined
				: jsonArray([
						jsonObject([["functionDeclarations", jsonArray(declarations)]]),
					]),
		],
		// 不发时是 AUTO
		[
			"toolConfig",
			declarations !== undefined && request.tool_choice === "none"
				? '{"functionCallingConfig":{"mode":"NONE"}}'
				: undefined,
		],
		[
			"generationConfig",
			JSON.stringify({
				maxOutputTokens: request.max_tokens ?? entry.max_output_tokens,
				// 只发 thinkingLevel：thinkingBudget 在 Gemini 4 上已经弃用，两个一起发返回 400
				...(effort === undefined
					? {}
					: {
							thinkingConfig: {
								thinkingLevel: effort.value,
								includeThoughts: true,
							},
						}),
			}),
		],
	];
	return count
		? jsonObject([
				[
					"generateContentRequest",
					jsonObject([
						["model", JSON.stringify(`models/${entry.model}`)],
						...fields,
					]),
				],
			])
		: jsonObject(fields);
}

/**
 * 把内部协议的请求转换成 `streamGenerateContent` 的请求体原文。保存过原文的部分原样拼接，其余按内部消息
 * 转换；同样的内部请求每次得到相同的请求体（Gemini 的缓存按前缀自动命中）。系统级指令全部并入
 * `systemInstruction`，连续的工具结果和其后的用户输入并成一条 content，思考签名回到收到它的 part 上。
 */
export function googleGenerateContentRequestBody(
	entry: ModelEntry,
	request: ModelRequest,
	context: RequestContext = {},
): string {
	return render(entry, request, context);
}

function count(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/**
 * `usageMetadata` 换成内部的口径：`promptTokenCount` 含缓存命中的部分，工具用掉的提示另算；
 * 思考的 token 不在 `candidatesTokenCount` 里。缓存是服务端自动做的，不另收写入的钱。
 */
function usageOf(raw: Json): Usage {
	const cached = count(raw.cachedContentTokenCount);
	const thoughts = count(raw.thoughtsTokenCount);
	return {
		input:
			count(raw.promptTokenCount) - cached + count(raw.toolUsePromptTokenCount),
		output: count(raw.candidatesTokenCount) + thoughts,
		cache_read: cached,
		cache_write: 0,
		reasoning: thoughts,
	};
}

/**
 * 按状态码归类，HTTP 错误和流中途的错误共用。`error` 是错误体里的 `error` 对象，没有可读的错误信息时
 * 用 `raw` 的开头代替。上下文超长没有专门的错误码，只能按官方文档给出的两句话识别。
 */
function classify(
	status: number,
	error: Json | undefined,
	raw: string,
	retryAfter: string | null,
): ModelErrorInfo {
	const message =
		typeof error?.message === "string" ? error.message : raw.slice(0, 500);
	const details = Array.isArray(error?.details)
		? (error.details as (Json | null)[])
		: [];
	let category: ErrorCategory;
	if (
		status === 401 ||
		// 密钥无效是 400 INVALID_ARGUMENT，只能从 details 里的 ErrorInfo 看出来
		(status === 400 &&
			details.some((detail) => detail?.reason === "API_KEY_INVALID"))
	) {
		category = "authentication";
	} else if (status === 403 || status === 404) category = "permission";
	else if (status === 402) category = "billing";
	else if (status === 413) category = "request_too_large";
	else if (status === 429) category = "rate_limit";
	else if (
		(status === 500 && message.includes("Your input context is too long")) ||
		(status === 504 && message.includes("too large to be processed in time"))
	) {
		category = "context_overflow";
	} else if (status >= 500) category = "overloaded";
	else category = "invalid_request";
	const seconds = Number(retryAfter);
	return retryAfter !== null &&
		Number.isFinite(seconds) &&
		category === "rate_limit"
		? { category, message, retry_after_ms: seconds * 1000 }
		: { category, message };
}

function classifyGoogleError(
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
	return classify(status, error, body, retryAfter);
}

/** 按拒绝处理的 `finishReason`；`IMAGE_` 开头的几种也算。 */
const refusalReasons = new Set([
	"SAFETY",
	"RECITATION",
	"LANGUAGE",
	"BLOCKLIST",
	"PROHIBITED_CONTENT",
	"SPII",
]);

/** 流是怎样结束的。正常结束时是不是"要调用工具"，要看回复里有没有工具调用。 */
type Finish =
	| { stop: "end_turn" | "max_tokens" }
	| { stop: "refusal"; refusal: RefusalDetails };

/** 把 `streamGenerateContent` 的流拼成内部协议的回复：每个事件是一个完整的 `GenerateContentResponse`。 */
class GenerateContentParser implements StreamParser {
	#entry: ModelEntry;
	#request: ModelRequest;
	#options: StreamOptions;
	#names: FunctionNames;
	#model: string;
	#started = false;
	#content: AssistantContent[] = [];
	/**
	 * 最后一个内容块，如果它还能接上不带签名的同类 part：带签名的 part 不能和别的 part 合并，
	 * 否则签名回不到原来的位置。
	 */
	#open: TextBlock | ReasoningBlock | undefined;
	#usage = zeroUsage();
	#finish: Finish | undefined;

	constructor(
		entry: ModelEntry,
		request: ModelRequest,
		options: StreamOptions,
	) {
		this.#entry = entry;
		this.#request = request;
		this.#options = options;
		this.#names = new FunctionNames(request.tools.map((tool) => tool.name));
		this.#model = entry.model;
	}

	event({ data }: SseEvent): StreamEvent[] | ModelErrorInfo {
		const payload = JSON.parse(data) as Json;
		if (typeof payload.error === "object" && payload.error !== null) {
			// 流中途的错误和 HTTP 错误的格式相同，状态码在 error.code 里
			const error = payload.error as Json;
			return classify(Number(error.code), error, data, null);
		}
		const events: StreamEvent[] = [];
		if (typeof payload.modelVersion === "string") {
			this.#model = payload.modelVersion;
		}
		if (!this.#started) {
			this.#started = true;
			events.push({ type: "start", model: this.#model });
		}
		// 每一份都是到当时为止的累计，后到的覆盖先到的
		if (
			typeof payload.usageMetadata === "object" &&
			payload.usageMetadata !== null
		) {
			this.#usage = usageOf(payload.usageMetadata as Json);
		}
		// 提示本身被拦下时没有候选，只有 blockReason
		const blocked = (payload.promptFeedback as Json | undefined)?.blockReason;
		if (typeof blocked === "string") {
			this.#finish = { stop: "refusal", refusal: { category: blocked } };
		}
		const candidate = (payload.candidates as Json[] | undefined)?.[0];
		if (candidate === undefined) return events;
		const parts =
			((candidate.content as Json | undefined)?.parts as Json[] | undefined) ??
			[];
		for (const part of parts) events.push(...this.#part(part));
		const { finishReason, finishMessage } = candidate;
		if (typeof finishReason !== "string") return events;
		if (finishReason === "STOP") {
			this.#finish = { stop: "end_turn" };
		} else if (
			finishReason === "MAX_TOKENS" ||
			finishReason === "CONTINUATION"
		) {
			// 不做长输出续接：万一出现 CONTINUATION，按达到输出上限处理
			this.#finish = { stop: "max_tokens" };
		} else if (
			refusalReasons.has(finishReason) ||
			finishReason.startsWith("IMAGE_")
		) {
			this.#finish = { stop: "refusal", refusal: { category: finishReason } };
		} else {
			return {
				category: "invalid_request",
				message:
					typeof finishMessage === "string"
						? `Gemini 以 ${finishReason} 结束：${finishMessage}`
						: `Gemini 以 ${finishReason} 结束`,
			};
		}
		return events;
	}

	#origin(): Origin {
		return { protocol, service: this.#entry.service, model: this.#model };
	}

	#push(block: AssistantContent): number {
		this.#open = undefined;
		return this.#content.push(block) - 1;
	}

	/** 签名作为它所在 part 前面的一个空文字推理块保存，下一次请求时写回紧跟其后的 part。 */
	#sign(signature: string): void {
		this.#push({
			type: "reasoning",
			text: "",
			redacted: false,
			opaque: signature,
			origin: this.#origin(),
		});
	}

	#part(part: Json): StreamEvent[] {
		const signature =
			typeof part.thoughtSignature === "string"
				? part.thoughtSignature
				: undefined;
		if (typeof part.text === "string") {
			return part.thought === true
				? this.#thought(part.text, signature)
				: this.#text(part.text, signature);
		}
		if (typeof part.functionCall === "object" && part.functionCall !== null) {
			return this.#call(part.functionCall as Json, signature);
		}
		throw new Error(
			`Gemini API 返回了没有列出的 part：${Object.keys(part).join("、")}`,
		);
	}

	/** 思考摘要是滚动着一段段到达的：连续的、都不带签名的并成一个推理块，带签名的自成一块。 */
	#thought(text: string, signature: string | undefined): StreamEvent[] {
		const open = this.#open;
		if (signature === undefined) {
			if (text === "") return [];
			if (open?.type === "reasoning") {
				open.text += text;
				return [
					{ type: "reasoning_delta", index: this.#content.length - 1, text },
				];
			}
		}
		const block: ReasoningBlock = {
			type: "reasoning",
			text,
			redacted: false,
			...(signature === undefined ? {} : { opaque: signature }),
			origin: this.#origin(),
		};
		const index = this.#push(block);
		if (signature === undefined) this.#open = block;
		return text === "" ? [] : [{ type: "reasoning_delta", index, text }];
	}

	#text(text: string, signature: string | undefined): StreamEvent[] {
		if (signature !== undefined) this.#sign(signature);
		// 没有函数调用的回复，签名可能在流末尾一个空的 text part 上：只留签名，不建空的文本块
		if (text === "") return [];
		const open = this.#open;
		if (open?.type === "text") {
			open.text += text;
			return [{ type: "text_delta", index: this.#content.length - 1, text }];
		}
		const block: TextBlock = { type: "text", text };
		const index = this.#push(block);
		if (signature === undefined) this.#open = block;
		return [{ type: "text_delta", index, text }];
	}

	/** `functionCall` 整个到达，不分段：开始、参数和结束三个事件一起发。 */
	#call(call: Json, signature: string | undefined): StreamEvent[] {
		if (signature !== undefined) this.#sign(signature);
		const index = this.#content.length;
		// Gemini 3 起每个调用都带 id；没有时生成一个，工具结果靠它和调用对上
		const callId =
			typeof call.id === "string" && call.id !== ""
				? call.id
				: `${this.#options.messageId}_${index}`;
		const name = this.#names.original(String(call.name));
		const args = JSON.stringify(call.args ?? {});
		this.#push({
			type: "tool_call",
			call_id: callId,
			name,
			arguments: args,
		});
		return [
			{ type: "tool_call_start", index, call_id: callId, name },
			{ type: "tool_call_delta", index, arguments: args },
			{ type: "tool_call_end", index },
		];
	}

	finish() {
		// 没有结束标志，收到带 finishReason 的候选（或 blockReason）才算正常结束
		if (this.#finish === undefined) return undefined;
		const finish = this.#finish;
		const message = buildReply(
			this.#entry,
			this.#request,
			this.#options.messageId,
			{
				content: this.#content,
				model: this.#model,
				// Gemini 没有表示"要调用工具"的 finishReason
				stop_reason:
					finish.stop === "end_turn" &&
					this.#content.some((block) => block.type === "tool_call")
						? "tool_use"
						: finish.stop,
				usage: this.#usage,
				...(finish.stop === "refusal" ? { refusal: finish.refusal } : {}),
			},
		);
		const events: StreamEvent[] = [{ type: "usage", usage: message.usage }];
		// 过滤器可能在输出部分内容之后才拦下，本轮的全部输出都不再发回
		if (finish.stop === "refusal") {
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

/** 用 `streamGenerateContent` 发出一次流式请求。出错和取消也以 `end` 结束，不抛出约定中的失败。 */
export function streamGoogleGenerateContent(
	entry: ModelEntry,
	request: ModelRequest,
	options: StreamOptions,
): AsyncGenerator<StreamEvent> {
	return runStream(
		entry,
		options,
		{
			// 不带 alt=sse 时返回的是一个 JSON 数组，不是事件流
			url: `${entry.base_url}/models/${entry.model}:streamGenerateContent?alt=sse`,
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: render(entry, request, options),
		},
		classifyGoogleError,
		new GenerateContentParser(entry, request, options),
	);
}

/**
 * 用 `countTokens` 数这次请求的输入 token。请求体是包在 `generateContentRequest` 里的同一份内容：
 * 只发 `contents` 的写法数不到系统指令和工具声明。
 */
export function countGoogleGenerateContent(
	entry: ModelEntry,
	request: ModelRequest,
	options: CountOptions,
): Promise<TokenCount> {
	return runCount(
		entry,
		options,
		{
			url: `${entry.base_url}/models/${entry.model}:countTokens`,
			headers: { "content-type": "application/json" },
			body: render(entry, request, options, true),
		},
		classifyGoogleError,
		"totalTokens",
	);
}
