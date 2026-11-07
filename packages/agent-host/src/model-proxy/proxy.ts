import {
	ChannelRequestError,
	type HandlerContext,
	type ModelRequestParams,
	type ModelRequestResult,
	ProtocolError,
	type RuntimeRequests,
} from "@ospreycode/agent-runtime";
import type { ModelEntry, StreamModel } from "@ospreycode/api";
import type {
	AssistantMessage,
	ModelErrorInfo,
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

/**
 * 转发 runtime 的模型请求：只允许配置中的模型，用 `api` 转换协议、附加凭据后发出，
 * 把流式事件按背压交回 runtime，并记下用量。凭据不出现在错误信息和事件里。
 */
export class ModelProxy {
	#options: ModelProxyOptions;
	#raws = new RawCache();

	constructor(options: ModelProxyOptions) {
		this.#options = options;
	}

	async request(
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
		run: Run,
	): Promise<ModelRequestResult> {
		const { entry, credential, events } = this.#options;
		if (params.request.model !== entry.id) {
			// runtime 只会请求启动配置里的模型，请求别的模型说明它被攻破或有缺陷
			throw new ProtocolError(
				`runtime 请求了配置之外的模型：${params.request.model}`,
			);
		}
		const signal = AbortSignal.any([context.signal, run.signal]);
		let attempt = await this.#attempt(params, context, run, signal);
		// 凭据来自文件时，用户可能刚换了密钥：重新读取一次，值变了才重发
		if (attempt.error?.category === "authentication" && credential.reread) {
			const fresh = credential.reread();
			if (fresh !== credential.value) {
				credential.value = fresh;
				this.#options.onSecret(fresh);
				attempt = await this.#attempt(params, context, run, signal);
			}
		}
		const { message, error } = attempt;
		if (message === undefined) {
			throw new Error("模型的流没有以 end 结束");
		}
		run.usage = addUsage(run.usage, message.usage);
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
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
		run: Run,
		signal: AbortSignal,
	): Promise<Attempt> {
		const { entry, credential, events } = this.#options;
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
					raws: this.#raws.store((part) => events.protocolRaw(run, part)),
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
				message: this.#emptyReply(params),
				error: {
					category: "invalid_request",
					message: thrown instanceof Error ? thrown.message : String(thrown),
				},
			};
		}
		return { message: undefined, error: undefined };
	}

	#emptyReply(params: ModelRequestParams): AssistantMessage {
		const { entry } = this.#options;
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
}
