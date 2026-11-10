import type { TextBlock, UserContent } from "@ospreycode/api/protocol";
import type {
	ImageReference,
	InputContent,
	MentionBlock,
} from "../channel/protocol.js";
import type { ToolContext } from "../tool-executor/local-tool.js";
import {
	isFileSystemError,
	resolveTarget,
	ToolFailure,
} from "../tools/files.js";
import { listDirectory } from "../tools/ls.js";
import { readContent } from "../tools/read.js";
import { ImageError, scaleImage } from "./image.js";

/** 提及的内容前后各一行标记：模型据此知道这段内容来自哪个路径，不是用户写的话。 */
function wrap(
	tag: "file" | "directory",
	path: string,
	body: string,
): TextBlock {
	return {
		type: "text",
		text: `<${tag} path=${JSON.stringify(path)}>\n${body}\n</${tag}>`,
	};
}

async function expandMention(
	mention: MentionBlock,
	context: ToolContext,
): Promise<UserContent[]> {
	try {
		const path = await resolveTarget(mention.path, context.workspace);
		try {
			const content = await readContent(
				path,
				{ path: mention.path },
				context.records,
			);
			// 图片文件读出来是一行格式和尺寸的说明加图片块：说明放进标记，图片紧跟在后面
			return content.map((block) =>
				block.type === "text" ? wrap("file", mention.path, block.text) : block,
			);
		} catch (error) {
			if (!isFileSystemError(error) || error.code !== "EISDIR") throw error;
			return [wrap("directory", mention.path, await listDirectory(path))];
		}
	} catch (error) {
		// 读不了的原因写在原位置：用户提到了它，模型要知道它没有读到
		if (!(error instanceof ToolFailure) && !isFileSystemError(error)) {
			throw error;
		}
		return [
			wrap(
				"file",
				mention.path,
				`[Could not read this path: ${error.message}]`,
			),
		];
	}
}

/** 附带的图片取来字节后缩放；用不了时在原位置写明原因，模型要知道这里本来有一张图片。 */
async function expandImage(
	reference: ImageReference,
	readBlob: (sha256: string) => Promise<Uint8Array>,
): Promise<UserContent> {
	try {
		return await scaleImage(await readBlob(reference.sha256));
	} catch (error) {
		if (!(error instanceof ImageError)) throw error;
		return {
			type: "text",
			text: `[An image was attached here but could not be used: ${error.message}]`,
		};
	}
}

/**
 * 把通道上的用户输入展开成发给模型的内容：`@` 提及的文件换成它的内容（图片文件是图片块），目录换成
 * 列表，附带的图片换成缩放后的图片块，位置不变。提及用 `read` 工具的同一实现读取，所以同样记作
 * 一次读取，之后可以直接编辑；读取的检查由操作系统在打开文件时完成。展开不登记为工具调用：这次
 * 读取不是模型发起的。`readBlob` 按 SHA-256 向 Host 取图片的原始字节。
 */
export async function expandInput(
	content: readonly InputContent[],
	context: ToolContext,
	readBlob: (sha256: string) => Promise<Uint8Array>,
): Promise<UserContent[]> {
	const expanded = await Promise.all(
		content.map(async (block): Promise<UserContent[]> => {
			if (block.type === "mention") return expandMention(block, context);
			if (block.type === "image_ref") {
				return [await expandImage(block, readBlob)];
			}
			return [block];
		}),
	);
	return expanded.flat();
}
