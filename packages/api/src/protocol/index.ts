export type { ErrorCategory, ModelErrorInfo } from "./errors.js";
export type {
	AssistantContent,
	AssistantMessage,
	ImageBlock,
	Message,
	Origin,
	ProtocolName,
	ReasoningBlock,
	RefusalDetails,
	SystemMessage,
	TextBlock,
	ToolCallBlock,
	ToolResultMessage,
	UserContent,
	UserMessage,
} from "./messages.js";
export type {
	ModelRequest,
	ReasoningEffort,
	SamplingParameters,
	ToolDeclaration,
} from "./request.js";
export type {
	BlockRef,
	Invalidation,
	InvalidationReason,
	StopReason,
	StreamEvent,
} from "./stream.js";
export type { Usage } from "./usage.js";

/** 内部协议的格式版本：会话记录保存内部协议的消息，格式变化时加一并提供迁移。 */
export const protocolVersion = 1;
