import { createHash } from "node:crypto";
import type {
	ImageBlock,
	Message,
	UserContent,
} from "@ospreycode/api/protocol";
import { ProtocolError } from "./errors.js";
import type { RequestMessage } from "./protocol.js";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 图片字节（base64 解码后）的 SHA-256，十六进制：通道两端按它认同一张图片。 */
function digest(image: ImageBlock): string {
	return sha256(Buffer.from(image.data, "base64"));
}

/** 消息里放图片的内容：user 消息和工具结果的。 */
function imageContent(message: Message): readonly UserContent[] {
	return message.role === "user" || message.role === "tool_result"
		? message.content
		: [];
}

/**
 * runtime 一侧：记下 Host 已经收到过哪些图片。loop 和工具用的都是完整的图片块，发到通道上的消息里
 * 图片都换成引用，Host 还没收到过的先单独交过去。
 */
export class SentImages {
	#delivered = new Set<string>();
	/** 同一个图片块只算一次摘要：历史里的块每次请求都要看一遍。 */
	#digests = new WeakMap<ImageBlock, string>();

	#digest(image: ImageBlock): string {
		const known = this.#digests.get(image);
		if (known !== undefined) return known;
		const computed = digest(image);
		this.#digests.set(image, computed);
		return computed;
	}

	/** Host 已经收到了这些内容里的图片。 */
	delivered(content: readonly UserContent[]): void {
		for (const block of content) {
			if (block.type === "image") this.#delivered.add(this.#digest(block));
		}
	}

	/** 这些消息里 Host 还没有收到过的图片，内容相同的只算一张。 */
	undelivered(messages: readonly Message[]): ImageBlock[] {
		const images = new Map<string, ImageBlock>();
		for (const block of messages.flatMap(imageContent)) {
			if (block.type !== "image") continue;
			const sha256 = this.#digest(block);
			if (!this.#delivered.has(sha256)) images.set(sha256, block);
		}
		return [...images.values()];
	}

	/** 发到通道上的消息：图片都换成引用。 */
	refer(messages: readonly Message[]): RequestMessage[] {
		return messages.map((message): RequestMessage => {
			if (message.role !== "user" && message.role !== "tool_result") {
				return message;
			}
			const content = message.content.map((block) =>
				block.type === "image"
					? { type: "sent_image" as const, sha256: this.#digest(block) }
					: block,
			);
			return { ...message, content };
		});
	}
}

/**
 * Host 一侧：留着收到过的图片，把消息里的引用换回原来的图片块。要留到 session 结束：runtime 重启后
 * 按 session 记录重建历史，之前发过的图片仍然只带引用。
 */
export class ReceivedImages {
	#images = new Map<string, ImageBlock>();

	/**
	 * 记下这些内容里的图片：`image/put` 交来的，和工具结果里的。图片是空的，或者 base64 不是规范写法
	 * 时抛出 `ProtocolError`：Host 按字节保存图片，取回时重新编码，写法不规范的换不回原样。
	 */
	remember(content: readonly UserContent[]): void {
		for (const block of content) {
			if (block.type !== "image") continue;
			const bytes = Buffer.from(block.data, "base64");
			if (bytes.length === 0 || bytes.toString("base64") !== block.data) {
				throw new ProtocolError("图片是空的，或者 base64 不是规范写法");
			}
			this.#images.set(sha256(bytes), block);
		}
	}

	/** 收到过的一张图片。没有收到过时抛出 `ProtocolError`。 */
	image(sha256: string): ImageBlock {
		const image = this.#images.get(sha256);
		if (image === undefined) {
			throw new ProtocolError(`引用了没有收到过的图片：${sha256}`);
		}
		return image;
	}

	/** 把消息里的引用换回图片块。引用了没有收到过的图片时抛出 `ProtocolError`。 */
	restore(messages: readonly RequestMessage[]): Message[] {
		return messages.map((message): Message => {
			if (message.role !== "user" && message.role !== "tool_result") {
				return message;
			}
			const content = message.content.map((block) =>
				block.type === "sent_image" ? this.image(block.sha256) : block,
			);
			return { ...message, content };
		});
	}

	/**
	 * 交回给 runtime 的消息（session 记录里的 `message.sent`）：记下里面的图片，换成引用，runtime 用
	 * `image/read` 逐张取回。
	 */
	refer(message: Message): RequestMessage {
		if (message.role !== "user" && message.role !== "tool_result") {
			return message;
		}
		this.remember(message.content);
		const content = message.content.map((block) =>
			block.type === "image"
				? { type: "sent_image" as const, sha256: digest(block) }
				: block,
		);
		return { ...message, content };
	}
}
