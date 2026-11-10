import type {
	AgentConfig,
	Empty,
	HandlerContext,
	HostChannel,
	InitializeParams,
	ModelRequestParams,
	ModelRequestResult,
	RecordAppendParams,
	RuntimeRequests,
	TaskEndParams,
	TaskEndResult,
	ToolCallCompleteParams,
	ToolCallParams,
	ToolCallRegisterParams,
	ToolCallRegisterResult,
	ToolCallRunResult,
} from "@ospreycode/agent-runtime";

/** 通道上 runtime 发来的每种请求和通知由谁处理。请求属于哪个 session 由通道决定，不采信请求里写的标识。 */
export interface ChannelHandlers {
	initialize(params: InitializeParams): Promise<AgentConfig>;
	taskEnd(params: TaskEndParams): Promise<TaskEndResult>;
	modelRequest(
		params: ModelRequestParams,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
	): Promise<ModelRequestResult>;
	toolCallRun(
		params: ToolCallParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolCallRunResult>;
	toolCallRegister(
		params: ToolCallRegisterParams,
	): Promise<ToolCallRegisterResult>;
	toolCallComplete(params: ToolCallCompleteParams): Promise<Empty>;
	recordAppend(params: RecordAppendParams): void;
}

/** 在 Host 一侧的通道上注册 runtime 的全部操作。 */
export function serveChannel(
	channel: HostChannel,
	handlers: ChannelHandlers,
): void {
	channel.handle("initialize", (params) => handlers.initialize(params));
	channel.handle("task/end", (params) => handlers.taskEnd(params));
	channel.handle("model/request", (params, context) =>
		handlers.modelRequest(params, context),
	);
	channel.handle("tool_call/run", (params, context) =>
		handlers.toolCallRun(params, context),
	);
	channel.handle("tool_call/register", (params) =>
		handlers.toolCallRegister(params),
	);
	channel.handle("tool_call/complete", (params) =>
		handlers.toolCallComplete(params),
	);
	channel.on("record/append", (params) => handlers.recordAppend(params));
}
