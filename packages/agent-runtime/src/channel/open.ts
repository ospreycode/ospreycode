import type { Duplex } from "node:stream";
import type {
	Message,
	ModelRequest,
	UserContent,
} from "@ospreycode/api/protocol";
import { ChannelPeer, type RequestOptions } from "./peer.js";
import {
	type HostNotifications,
	type HostRequests,
	hostStreamMethods,
	type ImageReadResult,
	type ModelRequestParams,
	type RecordedEvent,
	type RecordReadResult,
	type RequestMessage,
	type RuntimeNotifications,
	type RuntimeRequests,
	type ToolCallCompleteParams,
} from "./protocol.js";
import { SentImages } from "./sent-images.js";

/**
 * runtime 里发出的请求：和通道上的一样，只是模型请求带的是完整的图片块，`record/read` 读回的
 * `message.sent` 里也是；和引用的互换在通道里做。
 */
type LocalRequests = Omit<RuntimeRequests, "model/request"> & {
	"model/request": Omit<RuntimeRequests["model/request"], "params"> & {
		params: LocalModelRequestParams;
	};
};

interface LocalModelRequestParams {
	message_id: string;
	request: ModelRequest;
}

/** runtime 一侧的通道。 */
export type RuntimeChannel = ChannelPeer<
	LocalRequests,
	HostRequests,
	RuntimeNotifications,
	HostNotifications
>;

/** Host 一侧的通道。 */
export type HostChannel = ChannelPeer<
	HostRequests,
	RuntimeRequests,
	HostNotifications,
	RuntimeNotifications
>;

/**
 * runtime 一侧的通道：loop 和工具照常用完整的图片块，通道上的消息里图片都是引用，图片每张单独过
 * 一次通道。Host 收到过的图片有三个来源：提交的工具结果里的，模型请求发出之前用 `image/put` 交过去的，
 * 重启后读 session 记录时用 `image/read` 取回来的。
 */
class RuntimePeer extends ChannelPeer<
	LocalRequests,
	HostRequests,
	RuntimeNotifications,
	HostNotifications
> {
	#images = new SentImages();

	override async request<Method extends keyof LocalRequests & string>(
		method: Method,
		params: LocalRequests[Method]["params"],
		options: RequestOptions<LocalRequests[Method]["stream"]> = {},
	): Promise<LocalRequests[Method]["result"]> {
		// 按方法名分出来之后，参数和响应的类型编译器推不出来，下面各处按协议里这个方法的类型写明
		if (method === "model/request") {
			const { message_id, request } = params as LocalModelRequestParams;
			// 一张一条消息：图片放在请求里的话，一条用户消息带几张大图就超过单条消息的上限
			for (const image of this.#images.undelivered(request.messages)) {
				await super.request("image/put", { image });
				this.#images.delivered([image]);
			}
			const referred: ModelRequestParams = {
				message_id,
				request: { ...request, messages: this.#images.refer(request.messages) },
			};
			// 基类按通道上的格式发出，类型上它的参数仍是带图片块的那一种
			return super.request(method, referred as never, options);
		}
		const result = await super.request(method, params, options);
		if (method === "tool_call/complete") {
			this.#images.delivered((params as ToolCallCompleteParams).result.content);
		}
		if (method === "record/read") {
			const { events, ...rest } = result as RecordReadResult;
			const restored: RecordedEvent[] = [];
			for (const event of events) {
				if (event.type !== "message.sent") {
					restored.push(event);
					continue;
				}
				const { message } = event.data as { message: RequestMessage };
				restored.push({
					...event,
					data: { message: await this.#restore(message) },
				});
			}
			return { ...rest, events: restored };
		}
		return result;
	}

	/** 读回的消息里的引用换回图片块：图片逐张向 Host 取。 */
	async #restore(message: RequestMessage): Promise<Message> {
		if (message.role !== "user" && message.role !== "tool_result") {
			return message;
		}
		const content: UserContent[] = [];
		for (const block of message.content) {
			if (block.type !== "sent_image") {
				content.push(block);
				continue;
			}
			const { image }: ImageReadResult = await super.request("image/read", {
				sha256: block.sha256,
			});
			content.push(image);
		}
		this.#images.delivered(content);
		return { ...message, content };
	}
}

/** 在 runtime 一侧打开通道。runtime 不按 schema 检查 Host 发来的消息。 */
export function openRuntimeChannel(
	stream: Duplex,
	onFailure: (error: Error) => void,
): RuntimeChannel {
	return new RuntimePeer(stream, {
		streamMethods: hostStreamMethods,
		onFailure,
	});
}
