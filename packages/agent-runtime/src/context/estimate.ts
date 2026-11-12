import type {
	AssistantContent,
	AssistantMessage,
	ImageBlock,
	Message,
	ProtocolName,
	ToolDeclaration,
	Usage,
	UserContent,
} from "@ospreycode/api/protocol";
import type { ModelInfo } from "../channel/protocol.js";

/**
 * 文字按 UTF-8 字节数除以 1.7 估算 token：这是实测各类内容里偏低最多的（Claude 5.5 上带缩进的 JSON），
 * 估算偏低会超出上下文窗口，偏高只是早一点停下。见 docs/packages/api.md 的 token 计数。
 */
const bytesPerToken = 1.7;

/**
 * 判断是不是临界时用的乐观值：英文和代码通常在每 token 4 字节左右。按 1.7 要压缩、按它不用时，
 * 才值得请 Host 用计数接口数一次。
 */
const optimisticBytesPerToken = 4;

/** 会话里的图片长边不超过 2000 像素，读不出尺寸时按这个上限算。 */
export const maxImageSide = 2000;

function tokensOf(text: string, divisor: number): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / divisor);
}

export function textTokens(text: string): number {
	return tokensOf(text, bytesPerToken);
}

interface Size {
	width: number;
	height: number;
}

/** 从 PNG、GIF、JPEG、WebP 的文件头读出像素尺寸。 */
export function imageSize(bytes: Uint8Array): Size | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...bytes.subarray(start, start + length));
	if (bytes.length >= 24 && ascii(1, 3) === "PNG") {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (bytes.length >= 10 && ascii(0, 3) === "GIF") {
		return {
			width: view.getUint16(6, true),
			height: view.getUint16(8, true),
		};
	}
	if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
		const chunk = ascii(12, 4);
		if (chunk === "VP8 ") {
			return {
				width: view.getUint16(26, true) & 0x3fff,
				height: view.getUint16(28, true) & 0x3fff,
			};
		}
		if (chunk === "VP8L") {
			const bits = view.getUint32(21, true);
			return {
				width: (bits & 0x3fff) + 1,
				height: ((bits >> 14) & 0x3fff) + 1,
			};
		}
		if (chunk === "VP8X") {
			const u24 = (at: number) =>
				(bytes[at] ?? 0) |
				((bytes[at + 1] ?? 0) << 8) |
				((bytes[at + 2] ?? 0) << 16);
			return { width: u24(24) + 1, height: u24(27) + 1 };
		}
		return undefined;
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		// 逐段跳过，找到帧头（SOF0 到 SOF15，除去 DHT、JPG、DAC）
		let at = 2;
		while (at + 9 <= bytes.length) {
			if (bytes[at] !== 0xff) return undefined;
			const marker = bytes[at + 1] ?? 0;
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					width: view.getUint16(at + 7),
					height: view.getUint16(at + 5),
				};
			}
			at += 2 + view.getUint16(at + 2);
		}
	}
	return undefined;
}

/** 图片按各家的公式估算 token。 */
export function imageTokens(protocol: ProtocolName, image: ImageBlock): number {
	const size = imageSize(Buffer.from(image.data, "base64")) ?? {
		width: maxImageSide,
		height: maxImageSide,
	};
	if (protocol === "anthropic.messages") {
		// 长边缩到 1568 像素，按宽乘高除以 750
		const scaled = scale(size, 1568 / Math.max(size.width, size.height));
		return Math.ceil((scaled.width * scaled.height) / 750);
	}
	// Gemini 3 起的模型按默认的分辨率，每张图片固定 1120 个 token
	if (protocol === "google.generate-content") return 1120;
	// 先缩进 2048×2048，再把短边缩到 768，按 512 像素的块数乘 170 再加 85
	const fitted = scale(size, 2048 / Math.max(size.width, size.height));
	const shrunk = scale(fitted, 768 / Math.min(fitted.width, fitted.height));
	return (
		85 + 170 * Math.ceil(shrunk.width / 512) * Math.ceil(shrunk.height / 512)
	);
}

/** 按比例缩小到整像素，只缩不放。 */
function scale(size: Size, ratio: number): Size {
	const factor = Math.min(1, ratio);
	return {
		width: Math.round(size.width * factor),
		height: Math.round(size.height * factor),
	};
}

function contentTokens(
	protocol: ProtocolName,
	content: readonly UserContent[],
	divisor: number,
): number {
	return content.reduce(
		(total, block) =>
			total +
			(block.type === "text"
				? tokensOf(block.text, divisor)
				: imageTokens(protocol, block)),
		0,
	);
}

function usageTokens(usage: Usage): number {
	return usage.input + usage.output + usage.cache_read + usage.cache_write;
}

function blockTokens(block: AssistantContent, divisor: number): number {
	switch (block.type) {
		case "text":
		case "reasoning":
			return tokensOf(block.text, divisor);
		case "tool_call":
			return tokensOf(block.name + block.arguments, divisor);
		case "fallback":
			return 0;
		case "opaque":
			return tokensOf(block.raw, divisor);
	}
}

/** 服务端工具的内容块。带着它们的回复，输入用量是服务端几次采样的累计，不是上下文的长度。 */
function opaqueTokens(message: AssistantMessage, divisor: number): number {
	return message.content.reduce(
		(total, block) =>
			total + (block.type === "opaque" ? blockTokens(block, divisor) : 0),
		0,
	);
}

/** 一条消息的估算；回复按它报告的输出 token 计（含推理），没有用量时按内容估算。 */
function messageTokens(
	protocol: ProtocolName,
	message: Message,
	divisor: number,
): number {
	if (message.role !== "assistant") {
		return contentTokens(protocol, message.content, divisor);
	}
	// 服务端工具的结果不是模型的输出，另外估算
	if (message.usage.output > 0) {
		return message.usage.output + opaqueTokens(message, divisor);
	}
	return message.content.reduce(
		(total, block) => total + blockTokens(block, divisor),
		0,
	);
}

/** Host 用模型服务的计数接口数出来的上下文长度，之后的估算拿它当锚点。 */
export interface CountedContext {
	/** 数到哪条消息为止（含这一条，也含工具声明）。 */
	message_id: string;
	/** 是给哪个模型数的：换了模型就不能用。 */
	model: string;
	tokens: number;
}

/** 估算上下文时的选项。 */
export interface EstimateOptions {
	/** Host 数过的长度；它数到的消息比最后一条能当锚点的回复更靠后时用它。 */
	counted?: CountedContext;
	/** 锚点之后的文字按每 token 4 字节估算，不按 1.7：判断是不是临界时用。 */
	optimistic?: boolean;
}

/**
 * 这次请求的上下文估算：以最后一条由当前模型正常结束、没有服务端工具内容块的回复报告的用量为锚点，
 * 加上之后新增内容的估算；Host 数过更靠后的位置时以它为锚点。没有锚点时估算全部内容，工具声明也算进去。
 */
export function estimateContext(
	model: ModelInfo,
	messages: readonly Message[],
	tools: readonly ToolDeclaration[],
	options: EstimateOptions = {},
): number {
	const divisor = options.optimistic ? optimisticBytesPerToken : bytesPerToken;
	const { counted } = options;
	const reply = messages.findLastIndex(
		(message) =>
			message.role === "assistant" &&
			message.requested_model === model.id &&
			message.stop_reason !== "error" &&
			message.stop_reason !== "cancelled" &&
			usageTokens(message.usage) > 0 &&
			!message.content.some((block) => block.type === "opaque"),
	);
	const count =
		counted?.model === model.id
			? messages.findLastIndex(
					(message) => message.message_id === counted.message_id,
				)
			: -1;
	const anchor = Math.max(reply, count);
	const after = messages
		.slice(anchor + 1)
		.reduce(
			(total, message) =>
				total + messageTokens(model.protocol, message, divisor),
			0,
		);
	if (counted !== undefined && count !== -1 && count === anchor) {
		return counted.tokens + after;
	}
	const head = messages[anchor];
	return head?.role === "assistant"
		? usageTokens(head.usage) + after
		: tokensOf(JSON.stringify(tools), divisor) + after;
}

/** 输入的容量：上下文长度，模型另有输入上限时取较小的那个。 */
export function inputCapacity(model: ModelInfo): number {
	return Math.min(
		model.context_window,
		model.max_input_tokens ?? model.context_window,
	);
}

/** 估算超过容量的这个比例就要压缩；`openai.chat` 的兼容服务没有计数接口，留得更多。 */
export function contextThreshold(model: ModelInfo): number {
	return model.protocol === "openai.chat" ? 0.85 : 0.9;
}
