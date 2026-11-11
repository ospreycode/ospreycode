export { clientMetadataDocument } from "../auth/metadata.js";
export {
	createOAuthSession,
	type OAuthClientConfig,
	type OAuthSession,
	type OAuthSessionOptions,
} from "../auth/session.js";
export type { OAuthStore } from "../auth/store.js";
export type {
	McpConnection,
	McpConnectOptions,
} from "../client/connection.js";
export {
	McpError,
	type McpErrorDetails,
	type McpErrorKind,
} from "../protocol/errors.js";
export type {
	ElicitationAnswer,
	ElicitationHandler,
	ElicitationRequest,
	HttpServerDefinition,
	JsonValue,
	McpContent,
	McpServerDefinition,
	McpTool,
	McpToolResult,
	StdioServerDefinition,
} from "../protocol/types.js";
export type { ProtocolVerdict } from "../protocol/verdict.js";
export {
	connectHttp,
	type HttpTarget,
	type McpAuth,
} from "../transports/http.js";
export { connectStdio, type StdioLaunch } from "../transports/stdio.js";
