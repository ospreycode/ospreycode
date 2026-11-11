/** JSON 值。 */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** 解析好的 server 定义（agent-plugins 解析 mcp.json 后给出）。 */
export type McpServerDefinition = StdioServerDefinition | HttpServerDefinition;

/** 本地 server：启动一个进程，经 stdin 和 stdout 通信。 */
export interface StdioServerDefinition {
	transport: "stdio";
	/** 可执行文件：绝对路径，或交给 PATH 查找的命令名。 */
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
}

/** 远程 server：Streamable HTTP。 */
export interface HttpServerDefinition {
	transport: "streamable-http";
	/** WHATWG URL 解析后的 href。 */
	url: string;
	headers: Record<string, string>;
}

/** server 提供的一个工具。 */
export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	/** JSON Schema，原样返回。 */
	inputSchema: { [key: string]: JsonValue };
	/** server 自己声明的属性，不可信，只作数据返回。 */
	annotations?: {
		title?: string;
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

/** 工具结果里的一块内容。 */
export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| {
			type: "resource_link";
			uri: string;
			name: string;
			description?: string;
			mimeType?: string;
	  }
	| {
			type: "resource";
			uri: string;
			mimeType?: string;
			text?: string;
			blob?: string;
	  };

/** 一次工具调用的结果。 */
export interface McpToolResult {
	content: McpContent[];
	structuredContent?: JsonValue;
	/** 工具自己报告的失败。协议、传输、超时和取消的失败不在这里，而是抛 `McpError`。 */
	isError: boolean;
}

/** server 经 form 模式的 elicitation 向用户要的输入。 */
export interface ElicitationRequest {
	/** server 给用户看的说明。 */
	message: string;
	/** requestedSchema，原样返回。 */
	schema: { [key: string]: JsonValue };
}

/** 用户对 elicitation 的答复。 */
export type ElicitationAnswer =
	| {
			action: "accept";
			content: Record<string, string | number | boolean | string[]>;
	  }
	| { action: "decline" }
	| { action: "cancel" };

/**
 * form 模式 elicitation 的处理函数。`context.signal` 在这次询问作废时中止：
 * 发起它的工具调用被取消，或者 server 撤回了请求；这时答复不再有用，可以收起界面。
 */
export type ElicitationHandler = (
	request: ElicitationRequest,
	context: { signal: AbortSignal },
) => Promise<ElicitationAnswer>;
