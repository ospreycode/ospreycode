import { protocolSchemas } from "@ospreycode/agent-runtime";
import type { RawPart } from "@ospreycode/api";
import type {
	ImageBlock,
	TextBlock,
	UserContent,
} from "@ospreycode/api/protocol";
import Type from "typebox";

/**
 * session 记录里的一张图片。事件里只留引用，字节（base64 解码后）存成大内容：一张图片会出现在工具
 * 结果、发给模型的消息和这条消息在目标协议里的原文里，按引用保存就只存一份。
 */
export interface StoredImage {
	type: "stored_image";
	media_type: ImageBlock["media_type"];
	/** 图片字节的 SHA-256，也是大内容的键。 */
	sha256: string;
}

/** `message.sent` 和 `tool_call.completed` 里 user 消息和工具结果的一块内容，在 session 记录里的形式。 */
export type StoredContent = TextBlock | StoredImage;

/** `protocol.raw` 的片段里一张图片的位置：取回时这里是这份大内容的 base64。 */
export interface RawImage {
	image_sha256: string;
}

/**
 * `protocol.raw` 的一个片段在 session 记录里的形式：没有图片的是原文；有图片的按图片的 base64
 * 切开，各段原文和图片的位置依次排列。
 */
export type RawPiece = string | (string | RawImage)[];

/** 把内容存成大内容，返回它的 SHA-256。 */
export type PutBlob = (data: Uint8Array) => string;

/** 从磁盘读回的 `StoredContent[]`：用之前检查一次。 */
export const storedContentSchema = Type.Array(
	Type.Union([
		protocolSchemas.textBlock,
		Type.Object(
			{
				type: Type.Literal("stored_image"),
				media_type: protocolSchemas.imageBlock.properties.media_type,
				sha256: Type.String(),
			},
			{ additionalProperties: false },
		),
	]),
);

function putImage(image: ImageBlock, put: PutBlob): string {
	return put(Buffer.from(image.data, "base64"));
}

/** 写进 session 记录的内容：图片的字节存成大内容，原位置换成引用。 */
export function storeContent(
	content: readonly UserContent[],
	put: PutBlob,
): StoredContent[] {
	return content.map((block) =>
		block.type === "image"
			? {
					type: "stored_image",
					media_type: block.media_type,
					sha256: putImage(block, put),
				}
			: block,
	);
}

/** 从 session 记录读回的内容：按引用取回图片的字节，换回图片块。 */
export function loadContent(
	content: readonly StoredContent[],
	get: (sha256: string) => Uint8Array,
): UserContent[] {
	return content.map((block) => {
		if (block.type !== "stored_image") return block;
		const bytes = get(block.sha256);
		return {
			type: "image",
			media_type: block.media_type,
			data: Buffer.from(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			).toString("base64"),
		};
	});
}

/**
 * 写进 session 记录的原文片段。`images` 是这部分原文所属的消息里的图片：它们的 base64 原样出现在
 * 片段里，切出来存成大内容。
 */
export function storePieces(
	pieces: RawPart["pieces"],
	images: readonly ImageBlock[],
	put: PutBlob,
): RawPiece[] {
	return pieces.map((piece) => {
		let segments: (string | RawImage)[] = [piece];
		for (const image of images) {
			segments = segments.flatMap((segment) => {
				if (typeof segment !== "string" || !segment.includes(image.data)) {
					return [segment];
				}
				const reference = { image_sha256: putImage(image, put) };
				return segment
					.split(image.data)
					.flatMap((text, index) => (index === 0 ? [text] : [reference, text]));
			});
		}
		return segments.length === 1 ? piece : segments;
	});
}
