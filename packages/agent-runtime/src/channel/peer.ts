import type { Duplex } from "node:stream";
import {
	ChannelClosedError,
	type ChannelErrorBody,
	ChannelRequestError,
	ProtocolError,
} from "./errors.js";
import { encodeMessage, LineDecoder } from "./framing.js";
import type { RequestSpec, StreamNotification } from "./protocol.js";

/** 按 schema 检查对方发来的消息，不符合时抛出 `ProtocolError`。Host 用它检查沙盒内发来的每条消息。 */
export interface MessageValidator {
	/** 对方发来的请求的参数。 */
	request(method: string, params: unknown): void;
	/** 对方发来的通知的参数（`cancel` 和流式通知除外）。 */
	notification(method: string, params: unknown): void;
	/** 对方对我方请求的成功响应。 */
	result(method: string, result: unknown): void;
}

/** `ChannelPeer` 的选项。 */
export interface PeerOptions {
	/** 对方会发来的流式通知的方法名。 */
	streamMethods: readonly string[];
	/** 不传时不按 schema 检查：runtime 不重复检查 Host 发来的消息。 */
	validator?: MessageValidator;
	/**
	 * 通道失效：对方发来不合规的消息（`ProtocolError`），或者处理请求、通知的函数抛出了
	 * `ChannelRequestError` 以外的错误。调用之后连接随即关闭。
	 */
	onFailure: (error: Error) => void;
}

/** 发出请求时的选项。 */
export interface RequestOptions<Stream> {
	/** 中止时向对方发 `cancel`，仍等待对方的最终响应。 */
	signal?: AbortSignal;
	/** 收到属于这个请求的流式通知。 */
	onStream?: (notification: Stream) => void;
}

type WithoutRequestId<Stream> = Stream extends {
	method: infer Method;
	params: infer Params;
}
	? { method: Method; params: Omit<Params, "request_id"> }
	: never;

/** 处理对方请求时可以用的上下文。 */
export interface HandlerContext<Stream> {
	/** 对方取消了这个请求，或者通道关闭了。被取消的请求仍要回复一次最终响应。 */
	signal: AbortSignal;
	/** 发一条属于这个请求的流式通知；写入受阻时等到 `drain` 再返回，调用方据此暂停读取上游。 */
	stream(notification: WithoutRequestId<Stream>): Promise<void>;
}

type Handler = (
	params: never,
	context: HandlerContext<never>,
) => Promise<unknown>;

interface Pending {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	onStream: ((notification: never) => void) | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorBody(value: unknown): ChannelErrorBody {
	if (
		!isObject(value) ||
		(value.code !== "cancelled" && value.code !== "no_active_task") ||
		typeof value.message !== "string" ||
		Object.keys(value).some((key) => !["code", "message", "data"].includes(key))
	) {
		throw new ProtocolError("错误响应的 error 字段不对");
	}
	return value as unknown as ChannelErrorBody;
}

/**
 * 通道的一端。消息照 JSON-RPC 2.0 分请求、响应和通知三种形状，不带 `jsonrpc` 字段，不用 batch；
 * 两个方向都能发请求，`id` 是各方向自增的整数。流式结果是带 `request_id` 的通知，以该请求唯一的
 * 最终响应结束。通道不设超时和心跳，对端退出靠 EOF 发现。
 *
 * `Out`、`In` 是我方发出和对方发来的请求，`OutNotifications`、`InNotifications` 是两个方向的通知。
 */
export class ChannelPeer<
	Out extends Record<keyof Out, RequestSpec>,
	In extends Record<keyof In, RequestSpec>,
	OutNotifications extends Record<keyof OutNotifications, object>,
	InNotifications extends Record<keyof InNotifications, object>,
> {
	/** 通道关闭时兑现。 */
	readonly closed: Promise<void>;
	#stream: Duplex;
	#options: PeerOptions;
	#decoder = new LineDecoder();
	#nextId = 1;
	#lastIncomingId = 0;
	#pending = new Map<number, Pending>();
	#handlers = new Map<string, Handler>();
	#listeners = new Map<string, (params: never) => void>();
	#running = new Map<number, AbortController>();
	#isClosed = false;
	#closeCause: Error | undefined;
	#resolveClosed!: () => void;

	constructor(stream: Duplex, options: PeerOptions) {
		this.#stream = stream;
		this.#options = options;
		this.closed = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
		stream.on("data", (chunk: Buffer) => this.#receive(chunk));
		stream.on("error", (error) => {
			// 对端进程退出时写入会报 EPIPE 一类的错误，随后的 close 收尾
			this.#closeCause = error;
		});
		stream.on("close", () => this.#shutdown());
	}

	/** 发出请求，返回最终响应；对方以错误响应结束时抛出 `ChannelRequestError`。 */
	request<Method extends keyof Out & string>(
		method: Method,
		params: Out[Method]["params"],
		options: RequestOptions<Out[Method]["stream"]> = {},
	): Promise<Out[Method]["result"]> {
		if (this.#isClosed) {
			return Promise.reject(new ChannelClosedError("通道已关闭"));
		}
		const { signal, onStream } = options;
		if (signal?.aborted === true) {
			return Promise.reject(
				new ChannelRequestError("cancelled", "请求在发出之前已取消"),
			);
		}
		const id = this.#nextId++;
		const result = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, {
				method,
				resolve,
				reject,
				onStream: onStream as Pending["onStream"],
			});
		});
		if (signal !== undefined) {
			const onAbort = () => {
				if (this.#pending.has(id)) {
					void this.#send({ method: "cancel", params: { request_id: id } });
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			result.then(cleanup, cleanup);
		}
		void this.#send({ id, method, params });
		return result as Promise<Out[Method]["result"]>;
	}

	/** 发一条通知。 */
	notify<Method extends keyof OutNotifications & string>(
		method: Method,
		params: OutNotifications[Method],
	): Promise<void> {
		if (this.#isClosed) {
			return Promise.reject(new ChannelClosedError("通道已关闭"));
		}
		return this.#send({ method, params });
	}

	/** 注册对方某种请求的处理函数。抛出 `ChannelRequestError` 回复错误响应。 */
	handle<Method extends keyof In & string>(
		method: Method,
		handler: (
			params: In[Method]["params"],
			context: HandlerContext<In[Method]["stream"]>,
		) => Promise<In[Method]["result"]>,
	): void {
		this.#handlers.set(method, handler as Handler);
	}

	/** 注册对方某种通知的处理函数。 */
	on<Method extends keyof InNotifications & string>(
		method: Method,
		listener: (params: InNotifications[Method]) => void,
	): void {
		this.#listeners.set(method, listener as (params: never) => void);
	}

	/** 结束我方的写入。对方读到 EOF 后关闭，通道随之关闭。 */
	close(): void {
		this.#stream.end();
	}

	#receive(chunk: Buffer): void {
		if (this.#isClosed) return;
		try {
			for (const message of this.#decoder.push(chunk)) {
				this.#dispatch(message);
			}
		} catch (error) {
			this.#fail(error as Error);
		}
	}

	#dispatch(message: unknown): void {
		if (!isObject(message)) {
			throw new ProtocolError("消息不是 JSON 对象");
		}
		const keys = Object.keys(message).sort().join(",");
		if (keys === "id,method,params") {
			this.#onRequest(message.id, message.method, message.params);
		} else if (keys === "method,params") {
			this.#onNotification(message.method, message.params);
		} else if (keys === "id,result") {
			const [id, pending] = this.#pendingFor(message.id);
			this.#options.validator?.result(pending.method, message.result);
			this.#pending.delete(id);
			pending.resolve(message.result);
		} else if (keys === "error,id") {
			const [id, pending] = this.#pendingFor(message.id);
			const body = errorBody(message.error);
			this.#pending.delete(id);
			pending.reject(
				new ChannelRequestError(body.code, body.message, body.data),
			);
		} else {
			throw new ProtocolError(`消息的字段不对：${keys}`);
		}
	}

	#onRequest(id: unknown, method: unknown, params: unknown): void {
		if (
			typeof id !== "number" ||
			!Number.isSafeInteger(id) ||
			id <= this.#lastIncomingId
		) {
			throw new ProtocolError(`请求的 id 不是递增的整数：${String(id)}`);
		}
		this.#lastIncomingId = id;
		if (typeof method !== "string" || !isObject(params)) {
			throw new ProtocolError("请求的 method 或 params 不对");
		}
		const handler = this.#handlers.get(method);
		if (handler === undefined) {
			throw new ProtocolError(`未知的请求：${method}`);
		}
		this.#options.validator?.request(method, params);
		const controller = new AbortController();
		this.#running.set(id, controller);
		const context: HandlerContext<StreamNotification> = {
			signal: controller.signal,
			stream: (notification) =>
				this.#send({
					method: notification.method,
					params: { request_id: id, ...notification.params },
				}),
		};
		// 处理函数同步抛出的错误也要变成错误响应，不能让通道失效
		new Promise<unknown>((resolve) =>
			resolve(handler(params as never, context as HandlerContext<never>)),
		)
			.then(
				(result) => this.#send({ id, result }),
				(error: unknown) => {
					if (!(error instanceof ChannelRequestError)) throw error;
					return this.#send({ id, error: error.toBody() });
				},
			)
			.catch((error: unknown) => this.#fail(error as Error))
			.finally(() => this.#running.delete(id));
	}

	#onNotification(method: unknown, params: unknown): void {
		if (typeof method !== "string" || !isObject(params)) {
			throw new ProtocolError("通知的 method 或 params 不对");
		}
		if (method === "cancel") {
			const requestId = params.request_id;
			if (typeof requestId !== "number" || Object.keys(params).length !== 1) {
				throw new ProtocolError("cancel 的参数不对");
			}
			// 请求可能刚好已经回复，这时没有要取消的
			this.#running.get(requestId)?.abort();
			return;
		}
		if (this.#options.streamMethods.includes(method)) {
			const pending =
				typeof params.request_id === "number"
					? this.#pending.get(params.request_id)
					: undefined;
			if (pending === undefined) {
				throw new ProtocolError(`流式通知 ${method} 没有对应的请求`);
			}
			pending.onStream?.({ method, params } as never);
			return;
		}
		const listener = this.#listeners.get(method);
		if (listener === undefined) {
			throw new ProtocolError(`未知的通知：${method}`);
		}
		this.#options.validator?.notification(method, params);
		listener(params as never);
	}

	#pendingFor(id: unknown): [number, Pending] {
		const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
		if (pending === undefined) {
			throw new ProtocolError(`响应没有对应的请求：${String(id)}`);
		}
		return [id as number, pending];
	}

	async #send(message: object): Promise<void> {
		// 通道关闭后对方已经不在，处理函数迟到的响应没有人收
		if (this.#isClosed) return;
		if (this.#stream.write(encodeMessage(message))) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				this.#stream.off("drain", done);
				this.#stream.off("close", done);
				resolve();
			};
			this.#stream.on("drain", done);
			this.#stream.on("close", done);
		});
	}

	#fail(error: Error): void {
		if (this.#isClosed) return;
		this.#options.onFailure(error);
		this.#stream.destroy();
	}

	#shutdown(): void {
		if (this.#isClosed) return;
		this.#isClosed = true;
		for (const pending of this.#pending.values()) {
			pending.reject(
				new ChannelClosedError("通道已关闭", { cause: this.#closeCause }),
			);
		}
		this.#pending.clear();
		for (const controller of this.#running.values()) controller.abort();
		this.#resolveClosed();
	}
}
