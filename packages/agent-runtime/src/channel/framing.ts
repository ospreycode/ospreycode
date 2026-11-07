import { ProtocolError } from "./errors.js";

/** 单条消息的字节上限，不含结尾的换行。图片和长输出按引用传，正常不会接近它。 */
export const maxMessageBytes = 16 * 1024 * 1024;

/**
 * 把收到的字节切成消息：只按字节 0x0A 分帧，整行凑齐后严格按 UTF-8 解码，再解析 JSON。
 * 不用 `readline`：`JSON.stringify` 不转义 U+2028、U+2029，`readline` 会在这两处断行。
 */
export class LineDecoder {
	#parts: Buffer[] = [];
	#size = 0;
	// ignoreBOM 让开头的 BOM 留在文本里，JSON 解析随之失败，不被悄悄去掉
	#utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

	/** 收进一段字节，返回其中凑齐的消息。 */
	push(chunk: Buffer): unknown[] {
		const messages: unknown[] = [];
		let start = 0;
		for (
			let newline = chunk.indexOf(0x0a);
			newline !== -1;
			newline = chunk.indexOf(0x0a, start)
		) {
			this.#append(chunk.subarray(start, newline));
			messages.push(this.#take());
			start = newline + 1;
		}
		this.#append(chunk.subarray(start));
		return messages;
	}

	#append(part: Buffer): void {
		if (part.length === 0) return;
		this.#size += part.length;
		if (this.#size > maxMessageBytes) {
			throw new ProtocolError(`消息超过 ${maxMessageBytes} 字节`);
		}
		this.#parts.push(part);
	}

	#take(): unknown {
		const line = Buffer.concat(this.#parts, this.#size);
		this.#parts = [];
		this.#size = 0;
		let text: string;
		try {
			text = this.#utf8.decode(line);
		} catch (error) {
			throw new ProtocolError("消息不是合法的 UTF-8", { cause: error });
		}
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new ProtocolError("消息不是合法的 JSON", { cause: error });
		}
	}
}

/** 把一条消息编码成一行。超长说明发送方有缺陷，直接抛错。 */
export function encodeMessage(message: object): Buffer {
	const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
	if (line.length - 1 > maxMessageBytes) {
		throw new Error(`要发送的消息超过 ${maxMessageBytes} 字节`);
	}
	return line;
}
