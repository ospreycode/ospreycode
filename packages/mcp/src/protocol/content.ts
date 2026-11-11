import type {
	CallToolResult,
	ContentBlock,
	Tool,
} from "@modelcontextprotocol/client";
import type { JsonValue, McpContent, McpTool, McpToolResult } from "./types.js";

/** 把 SDK 的工具定义换成本包的类型，只留本项目用到的字段。 */
export function toMcpTool(tool: Tool): McpTool {
	return {
		name: tool.name,
		...(tool.title !== undefined && { title: tool.title }),
		...(tool.description !== undefined && { description: tool.description }),
		// 线上的 JSON，SDK 的类型把没列出的关键字标成 unknown
		inputSchema: tool.inputSchema as { [key: string]: JsonValue },
		...(tool.annotations !== undefined && { annotations: tool.annotations }),
	};
}

function toMcpContent(block: ContentBlock): McpContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
		case "audio":
			return { type: block.type, data: block.data, mimeType: block.mimeType };
		case "resource_link":
			return {
				type: "resource_link",
				uri: block.uri,
				name: block.name,
				...(block.description !== undefined && {
					description: block.description,
				}),
				...(block.mimeType !== undefined && { mimeType: block.mimeType }),
			};
		case "resource":
			return {
				type: "resource",
				uri: block.resource.uri,
				...(block.resource.mimeType !== undefined && {
					mimeType: block.resource.mimeType,
				}),
				...("text" in block.resource
					? { text: block.resource.text }
					: { blob: block.resource.blob }),
			};
	}
}

/** 把 SDK 的工具结果换成本包的类型。 */
export function toMcpToolResult(result: CallToolResult): McpToolResult {
	return {
		content: result.content.map(toMcpContent),
		...(result.structuredContent !== undefined && {
			// 线上的 JSON
			structuredContent: result.structuredContent as JsonValue,
		}),
		isError: result.isError === true,
	};
}
