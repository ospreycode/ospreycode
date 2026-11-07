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
import { redact } from "../redaction/redact.js";
import type { EventSink } from "../sessions/emitter.js";
import { addUsage, emptyUsage, type Run } from "../sessions/run.js";

/** 模型代理用到的依赖。 */
export interface ModelProxyOptions {
	/** 这个 session 允许使用的模型。 */
	entry: ModelEntry;
	/** 模型服务的凭据，只在 Host 的内存里。 */
	apiKey: string;
	fetch: typeof globalThis.fetch;
	streamModel: StreamModel;
	events: EventSink;
}

/**
 * 转发 runtime 的模型请求：只允许配置中的模型，用 `api` 转换协议、附加凭据后发出，
 * 把流式事件按背压交回 runtime，并记下用量。凭据不出现在错误信息和事件里。
 */
export class ModelProxy {
	#options: ModelProxyOptions;

	constructor(options: ModelProxyOptions) {
		this.#options = options;
	}

	async request(
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
		run: Run,
	): Promise<ModelRequestResult> {
		const { entry, apiKey, events } = this.#options;
		if (params.request.model !== entry.id) {
			// runtime 只会请求启动配置里的模型，请求别的模型说明它被攻破或有缺陷
			throw new ProtocolError(
				`runtime 请求了配置之外的模型：${params.request.model}`,
			);
		}
		const signal = AbortSignal.any([context.signal, run.signal]);
		let message: AssistantMessage | undefined;
		let error: ModelErrorInfo | undefined;
		try {
			for await (const event of this.#options.streamModel(
				entry,
				params.request,
				{
					messageId: params.message_id,
					apiKey,
					fetch: this.#options.fetch,
					signal,
				},
			)) {
				if (event.type === "end") {
					message = event.message;
					error = event.error;
					break;
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
			message = this.#emptyReply(params);
			error = {
				category: "invalid_request",
				message: thrown instanceof Error ? thrown.message : String(thrown),
			};
		}
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
					error: { ...error, message: redact(error.message, [apiKey]) },
				};
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
