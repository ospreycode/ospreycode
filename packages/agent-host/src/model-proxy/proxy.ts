import {
	ChannelRequestError,
	type HandlerContext,
	type ModelRequestParams,
	type ModelRequestResult,
	ProtocolError,
	type ReceivedImages,
	type RuntimeRequests,
} from "@ospreycode/agent-runtime";
import type { ModelEntry, RawPart, StreamModel } from "@ospreycode/api";
import type {
	AssistantMessage,
	ImageBlock,
	ModelErrorInfo,
	ModelRequest,
	ReasoningEffort,
} from "@ospreycode/api/protocol";
import type { LoadedCredential } from "../credentials/sources.js";
import type { EventSink } from "../sessions/emitter.js";
import { addUsage, emptyUsage, type Run } from "../sessions/run.js";
import { RawCache } from "./raws.js";

/** 模型代理用到的依赖。 */
export interface ModelProxyOptions {
	/** 用作提示缓存的键：按通道确定，不采信 runtime 填写的值。 */
	sessionId: string;
	/** 这个 session 允许使用的模型。 */
	entry: ModelEntry;
	/** 模型服务的凭据，只在 Host 的内存里。 */
	credential: LoadedCredential;
	fetch: typeof globalThis.fetch;
	streamModel: StreamModel;
	events: EventSink;
	/** 这个 session 收到过的图片：模型请求的消息里只有它们的引用（见 agent-runtime 的通道）。 */
	images: ReceivedImages;
	/** 去掉文本里的凭据和疑似密钥：服务返回的错误信息可能带着它们。 */
	scrub: (text: string) => string;
	/** 读到新的凭据值时登记，之后的日志和错误信息都去掉它。 */
	onSecret: (value: string) => void;
	/** 每次发出请求之前检查这个 run 的上限；返回 false 时 run 已经因为超出上限而停止。 */
	admit: (run: Run) => Promise<boolean>;
}

interface Attempt {
	message: AssistantMessage | undefined;
	error: ModelErrorInfo | undefined;
}

/** 发给模型的请求：通道上的引用已经换回图片。 */
interface SentRequest {
	message_id: string;
	request: ModelRequest;
}

/** runtime 能请求的一个模型和它的凭据。 */
interface AllowedModel {
	entry: ModelEntry;
	credential: LoadedCredential;
}

/**
 * 转发 runtime 的模型请求：只允许配置中的模型，用 `api` 转换协议、附加凭据后发出，
 * 把流式事件按背压交回 runtime，并记下用量。凭据不出现在错误信息和事件里。
 */
export class ModelProxy {
	#options: ModelProxyOptions;
	#raws = new RawCache();
	/** 已经记进 session 记录的消息：重启后的 runtime 重建的历史沿用原来的编号，不会重复记。 */
	#recorded = new Set<string>();
	/**
	 * Host 在启动配置或 `config/update` 里告诉过 runtime 的模型。会话中换过模型后，之前的模型仍然
	 * 接受：换模型的通知到达 runtime 之前，它可能已经用原来的模型发出了请求。
	 */
	#models = new Map<string, AllowedModel>();
	/** 上一次模型请求用的模型和推理强度：变了就记一条事件。 */
	#last: { model: string; reasoning_effort: ReasoningEffort } | undefined;

	constructor(options: ModelProxyOptions) {
		this.#options = options;
		this.setModel(options.entry, options.credential);
	}

	/**
	 * 换上切换后的模型，或重新加载的模型定义和凭据；保存的原文和已经记过的消息不动。
	 * 要在把它告诉 runtime 之前调用。
	 */
	setModel(entry: ModelEntry, credential: LoadedCredential): void {
		this.#models.set(entry.id, { entry, credential });
	}

	/** 这次请求的模型或推理强度和上一次不同：记在这次请求之前，换的是从这次请求起用的值。 */
	#recordChanges(run: Run, request: ModelRequest): void {
		const last = this.#last;
		const { model, reasoning_effort } = request;
		this.#last = { model, reasoning_effort };
		if (last === undefined) return;
		if (last.model !== model) {
			this.#options.events.stored(run, {
				type: "model.changed",
				model,
				previous_model: last.model,
			});
		}
		if (last.reasoning_effort !== reasoning_effort) {
			this.#options.events.stored(run, {
				type: "reasoning_effort.changed",
				reasoning_effort,
				previous_reasoning_effort: last.reasoning_effort,
			});
		}
	}

	async request(
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
		run: Run,
	): Promise<ModelRequestResult> {
		const { events, images } = this.#options;
		const model = this.#models.get(params.request.model);
		if (model === undefined) {
			// runtime 只会请求 Host 告诉过它的模型，请求别的模型说明它被攻破或有缺陷
			throw new ProtocolError(
				`runtime 请求了配置之外的模型：${params.request.model}`,
			);
		}
		const { credential } = model;
		const request: ModelRequest = {
			...params.request,
			messages: images.restore(params.request.messages),
		};
		this.#recordChanges(run, request);
		// 请求一到就记下新出现的消息：之后这次请求被上限拦下或中途取消，runtime 的历史里也已经有它们
		for (const message of request.messages) {
			if (this.#recorded.has(message.message_id)) continue;
			this.#recorded.add(message.message_id);
			if (message.role === "assistant") continue;
			events.messageSent(run, message);
		}
		const signal = AbortSignal.any([context.signal, run.signal]);
		const sent = { message_id: params.message_id, request };
		let attempt = await this.#attempt(model, sent, context, run, signal);
		// 凭据来自文件时，用户可能刚换了密钥：重新读取一次，值变了才重发
		if (attempt.error?.category === "authentication" && credential.reread) {
			const fresh = credential.reread();
			if (fresh !== credential.value) {
				credential.value = fresh;
				this.#options.onSecret(fresh);
				attempt = await this.#attempt(model, sent, context, run, signal);
			}
		}
		const { message, error } = attempt;
		if (message === undefined) {
			throw new Error("模型的流没有以 end 结束");
		}
		run.usage = addUsage(run.usage, message.usage);
		this.#recorded.add(message.message_id);
		events.stored(run, { type: "message.completed", message });
		if (message.stop_reason === "cancelled") {
			throw new ChannelRequestError("cancelled", "模型请求已取消", {
				usage: message.usage,
			});
		}
		return error === undefined
			? { message }
			: {
					message,
					error: { ...error, message: this.#options.scrub(error.message) },
				};
	}

	async #attempt(
		{ entry, credential }: AllowedModel,
		params: SentRequest,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
		run: Run,
		signal: AbortSignal,
	): Promise<Attempt> {
		const { events } = this.#options;
		if (!(await this.#options.admit(run))) {
			throw new ChannelRequestError("cancelled", "超出了这个 run 的上限");
		}
		run.budget.count();
		try {
			for await (const event of this.#options.streamModel(
				entry,
				params.request,
				{
					messageId: params.message_id,
					apiKey: credential.value,
					fetch: this.#options.fetch,
					signal,
					cacheKey: this.#options.sessionId,
					raws: this.#raws.store((part) =>
						events.protocolRaw(run, part, partImages(params.request, part)),
					),
				},
			)) {
				if (event.type === "end") {
					return { message: event.message, error: event.error };
				}
				events.streaming(run, {
					type: "model.delta",
					message_id: params.message_id,
					event,
				});
				await context.stream({ method: "model/event", params: { event } });
			}
		} catch (thrown) {
			// 转换模块遇到了没有列出的内容，或服务返回了不合规的数据：这次请求按请求格式错误失败
			return {
				message: emptyReply(entry, params),
				error: {
					category: "invalid_request",
					message: thrown instanceof Error ? thrown.message : String(thrown),
				},
			};
		}
		return { message: undefined, error: undefined };
	}
}

/** 一部分原文所属的消息里的图片：消息的原文里带着它们的 base64。 */
function partImages(request: ModelRequest, part: RawPart): ImageBlock[] {
	const message = request.messages.find(
		({ message_id }) => message_id === part.message_id,
	);
	return message?.role === "user" || message?.role === "tool_result"
		? message.content.filter((block) => block.type === "image")
		: [];
}

function emptyReply(entry: ModelEntry, params: SentRequest): AssistantMessage {
	return {
		role: "assistant",
		message_id: params.message_id,
		content: [],
		protocol: entry.protocol,
		service: entry.service,
		requested_model: entry.id,
		model: entry.model,
		reasoning_effort: params.request.reasoning_effort,
		stop_reason: "error",
		usage: emptyUsage(),
	};
}
