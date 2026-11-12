import type {
	AgentConfig,
	BlobReadParams,
	BlobReadResult,
	Empty,
	HandlerContext,
	HooksRunParams,
	HooksRunResult,
	HostChannel,
	ImagePutParams,
	ImageReadParams,
	ImageReadResult,
	InitializeParams,
	InputTakeResult,
	MemoryProposeParams,
	MemoryProposeResult,
	MemoryReadParams,
	MemoryReadResult,
	MemorySearchParams,
	MemorySearchResult,
	ModelCountTokensParams,
	ModelCountTokensResult,
	ModelRequestParams,
	ModelRequestResult,
	RecordAppendParams,
	RecordReadParams,
	RecordReadResult,
	RuntimeRequests,
	SkillLoadParams,
	SkillLoadResult,
	SubagentSendParams,
	SubagentSendResult,
	SubagentStartParams,
	SubagentStartResult,
	SubagentStopParams,
	SubagentStopResult,
	TaskEndParams,
	TaskEndResult,
	ToolCallCompleteParams,
	ToolCallCompleteResult,
	ToolCallRegisterParams,
	ToolCallRegisterResult,
	ToolCallRunParams,
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
	modelCountTokens(
		params: ModelCountTokensParams,
		context: HandlerContext<never>,
	): Promise<ModelCountTokensResult>;
	toolCallRun(
		params: ToolCallRunParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolCallRunResult>;
	toolCallRegister(
		params: ToolCallRegisterParams,
	): Promise<ToolCallRegisterResult>;
	toolCallComplete(
		params: ToolCallCompleteParams,
	): Promise<ToolCallCompleteResult>;
	recordAppend(params: RecordAppendParams): void;
	inputTake(): Promise<InputTakeResult>;
	recordRead(params: RecordReadParams): Promise<RecordReadResult>;
	blobRead(params: BlobReadParams): Promise<BlobReadResult>;
	imagePut(params: ImagePutParams): Promise<Empty>;
	imageRead(params: ImageReadParams): Promise<ImageReadResult>;
	memorySearch(params: MemorySearchParams): Promise<MemorySearchResult>;
	memoryRead(params: MemoryReadParams): Promise<MemoryReadResult>;
	memoryPropose(params: MemoryProposeParams): Promise<MemoryProposeResult>;
	skillLoad(params: SkillLoadParams): Promise<SkillLoadResult>;
	hooksRun(params: HooksRunParams): Promise<HooksRunResult>;
	subagentStart(params: SubagentStartParams): Promise<SubagentStartResult>;
	subagentSend(params: SubagentSendParams): Promise<SubagentSendResult>;
	subagentStop(params: SubagentStopParams): Promise<SubagentStopResult>;
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
	channel.handle("model/count_tokens", (params, context) =>
		handlers.modelCountTokens(params, context),
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
	channel.handle("input/take", () => handlers.inputTake());
	channel.handle("record/read", (params) => handlers.recordRead(params));
	channel.handle("blob/read", (params) => handlers.blobRead(params));
	channel.handle("image/put", (params) => handlers.imagePut(params));
	channel.handle("image/read", (params) => handlers.imageRead(params));
	channel.handle("memory/search", (params) => handlers.memorySearch(params));
	channel.handle("memory/read", (params) => handlers.memoryRead(params));
	channel.handle("memory/propose", (params) => handlers.memoryPropose(params));
	channel.handle("skill/load", (params) => handlers.skillLoad(params));
	channel.handle("hooks/run", (params) => handlers.hooksRun(params));
	channel.handle("subagent/start", (params) => handlers.subagentStart(params));
	channel.handle("subagent/send", (params) => handlers.subagentSend(params));
	channel.handle("subagent/stop", (params) => handlers.subagentStop(params));
}
