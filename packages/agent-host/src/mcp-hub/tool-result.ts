import { writeFileSync } from "node:fs";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { ImageBlock, UserContent } from "@ospreycode/api/protocol";
import type { McpContent, McpToolResult } from "@ospreycode/mcp";
import { modelOutputLimit } from "../processes/command.js";

const imageTypes: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/** 一块内容里给模型的文字；图片单独处理。 */
function textOf(block: Exclude<McpContent, { type: "image" }>): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "audio":
			return `[audio content omitted: ${block.mimeType}]`;
		case "resource_link":
			return `[resource link: ${block.uri}${block.description === undefined ? "" : ` — ${block.description}`}]`;
		case "resource":
			// 内嵌的二进制资源模型读不了，只留下它是什么
			return (
				block.text ??
				`[binary resource omitted: ${block.uri}${block.mimeType === undefined ? "" : ` (${block.mimeType})`}]`
			);
	}
}

/**
 * 把 MCP 工具的结果换成交给模型的工具结果。文字合计超过前台命令输出的同一个上限时，完整的文字
 * 写到 `outputFile`，交给模型的保留开头和结尾各一半，中间写明省略的字节数和文件路径；模型支持的
 * 图片原样保留，其他内容只留一句说明。没有内容块、只有 `structuredContent` 时给出它的 JSON。
 */
export function mcpToolResult(
	result: McpToolResult,
	outputFile: string,
): ToolResult {
	const texts: string[] = [];
	const images: ImageBlock[] = [];
	for (const block of result.content) {
		if (block.type !== "image") {
			texts.push(textOf(block));
		} else if (imageTypes.has(block.mimeType)) {
			images.push({
				type: "image",
				media_type: block.mimeType as ImageBlock["media_type"],
				data: block.data,
			});
		} else {
			texts.push(`[image omitted: unsupported type ${block.mimeType}]`);
		}
	}
	if (result.content.length === 0 && result.structuredContent !== undefined) {
		texts.push(JSON.stringify(result.structuredContent));
	}
	let text = texts.join("\n");
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length > modelOutputLimit) {
		writeFileSync(outputFile, bytes, { mode: 0o600 });
		const half = modelOutputLimit / 2;
		// 截在字节上可能留下半个字符：解码时换成替代字符，不影响其余内容
		text = `${bytes.subarray(0, half).toString("utf8")}\n[... ${bytes.length - modelOutputLimit} bytes omitted; the full output is in ${outputFile}]\n${bytes.subarray(bytes.length - half).toString("utf8")}`;
	}
	const content: UserContent[] = [
		...(text === "" && images.length > 0
			? []
			: [{ type: "text" as const, text }]),
		...images,
	];
	return { status: result.isError ? "failed" : "succeeded", content };
}
