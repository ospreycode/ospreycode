// `Session` 和 `SessionOptions` 的签名里用到的类型：前端只依赖本包也写得出回答、策略和模式的类型
export type { ReasoningEffort } from "@ospreycode/api/protocol";
// MCP server 的定义、elicitation 的回答和登录失败的错误由 mcp 包定义，扩展管理的签名里用到
export {
	type ElicitationAnswer,
	McpError,
	type McpErrorKind,
	type McpServerDefinition,
} from "@ospreycode/mcp";
// 记忆的记录和它的错误类型由 memory 包定义，`Session.memory` 的签名里用到
export {
	MemoryConflictError,
	type MemoryContent,
	type MemoryEdit,
	type MemoryKind,
	MemoryNotFoundError,
	type MemoryOrigin,
	type MemoryRecord,
	MemoryRejectedError,
	type MemoryScope,
	type MemorySources,
	MemoryStateError,
	type MemoryStatus,
	type MemoryTarget,
	type MemoryVersion,
	type SessionSource,
} from "@ospreycode/memory";
export type {
	ApprovalAnswer,
	ApprovalPolicy,
	GranularApproval,
	SandboxMode,
} from "@ospreycode/sandbox";
export { SandboxUnavailableError } from "@ospreycode/sandbox/backends";
export {
	type BudgetOptions,
	ConfigError,
	type RunLimits,
	type SessionConfig,
	type SessionOptions,
	type UiSettings,
} from "./config/session-config.js";
export {
	type CredentialContext,
	CredentialError,
	type CredentialSource,
	readCredential,
} from "./credentials/sources.js";
export type {
	CredentialStatus,
	CredentialStatusOptions,
} from "./credentials/status.js";
export { type CredentialStore, macosKeychain } from "./credentials/store.js";
export {
	ExtensionAdmin,
	type ExtensionList,
	type McpCredentialOptions,
} from "./extensions/admin.js";
export type {
	ExtensionInfo,
	ExtensionKind,
	ExtensionOrigin,
	ExtensionStatus,
} from "./extensions/catalog.js";
export type {
	ElicitationAnswered,
	ElicitationRequested,
	HooksRan,
	ServerApprovalDecided,
	ServerApprovalRequested,
} from "./extensions/events.js";
export type {
	PluginFileChange,
	PluginInfo,
	PluginOrigin,
	PluginStage,
} from "./extensions/plugins.js";
export type { InstalledPlugin, PluginSource } from "./extensions/trust.js";
export type { HookEvent } from "./hooks/config.js";
export {
	clientMetadataUrl,
	type McpCredentialKind,
	oauthClientName,
} from "./mcp-hub/credentials.js";
export type { McpServerState, McpServerStatus } from "./mcp-hub/hub.js";
export type {
	ExtractionOutcome,
	MemoryCandidate,
	MemoryCandidates,
	MemoryChange,
	MemoryExtractionEnded,
	MemoryExtractionStarted,
	MemoryRetrieved,
	MemoryUpdated,
} from "./memory/events.js";
export type {
	AddedMemory,
	MemoryDetail,
	MemoryManager,
	PurgedMemory,
	RemainingSource,
} from "./memory/session-memory.js";
export type { MemoryOptions, MemorySettings } from "./memory/settings.js";
export type { BackgroundCommandInfo } from "./processes/background.js";
export type {
	SandboxRunOptions,
	SandboxRunResult,
	SandboxStdio,
} from "./processes/sandbox-run.js";
export type { ClearCacheOptions } from "./project/cache.js";
export { WorkspaceError } from "./project/workspace.js";
export { containsSecret, redact } from "./redaction/redact.js";
export {
	type DoctorCheck,
	type DoctorOptions,
	doctor,
} from "./sdk/doctor.js";
export type {
	ApprovalDecidedEvent,
	ApprovalRequestedEvent,
	BackgroundDeliveredEvent,
	BackgroundEndedEvent,
	BackgroundNotificationEvent,
	BackgroundStartedEvent,
	ContextCompactedEvent,
	ElicitationAnsweredEvent,
	ElicitationRequestedEvent,
	ErrorEvent,
	EventBase,
	FollowUpPausedEvent,
	HooksRanEvent,
	HostEvent,
	InputDequeuedEvent,
	InputInsertedEvent,
	InputQueuedEvent,
	MemoryCandidatesEvent,
	MemoryExtractionEndedEvent,
	MemoryExtractionStartedEvent,
	MemoryRetrievedEvent,
	MemoryUpdatedEvent,
	MessageCompletedEvent,
	ModelChangedEvent,
	ModelDeltaEvent,
	ReasoningEffortChangedEvent,
	RunStartedEvent,
	ServerApprovalDecidedEvent,
	ServerApprovalRequestedEvent,
	SessionEndedEvent,
	SessionEndReason,
	SessionStartedEvent,
	StartupErrorEvent,
	Stored,
	TaskEndedEvent,
	TaskScope,
	TaskStartedEvent,
	ToolCallCompletedEvent,
	ToolCallOutputEvent,
	ToolCallStartedEvent,
	WarningEvent,
} from "./sdk/events.js";
export { eventFormatVersion } from "./sdk/events.js";
export {
	type CancelSignal,
	exitCodeFor,
	inJsonOutput,
	startupErrorEvent,
	startupExitCode,
	toJsonLine,
} from "./sdk/format.js";
export {
	createHost,
	type ForkSessionOptions,
	type Host,
	type HostOptions,
	type OpenSessionOptions,
	type ProjectInfo,
	type ResumeSessionOptions,
	type Session,
} from "./sdk/host.js";
export {
	hostEventSchema,
	isHostEvent,
	startupErrorEventSchema,
} from "./sdk/schema.js";
export type { BudgetLimit } from "./sessions/budget.js";
export type {
	BranchInfo,
	CheckpointInfo,
	UndoResult,
} from "./sessions/checkpoints.js";
export type {
	ApprovalDecided,
	ApprovalRequested,
	BackgroundEnded,
	BackgroundEndReason,
	BackgroundKind,
	BackgroundNotified,
	BackgroundStarted,
	ModelChanged,
	ProcessExited,
	ProcessKind,
	ProcessStarted,
	ProtocolRaw,
	ReasoningEffortChanged,
	TaskEnded,
	TaskOutcome,
	TaskSource,
	TaskStarted,
} from "./sessions/events.js";
export {
	AgentStartError,
	InputBlockedError,
	SessionBlockedError,
	SessionCommandError,
	SessionResumeError,
} from "./sessions/host-session.js";
export { newId } from "./sessions/ids.js";
export type {
	BackgroundDelivered,
	FollowUpPaused,
	InputDequeued,
	InputInsertedRecord,
	InputQueued,
	InputQueueSnapshot,
	QueuedInput,
} from "./sessions/inputs.js";
export type { ListSessionsOptions, SessionInfo } from "./sessions/list.js";
export type {
	DeletedSessions,
	DeleteSessionOptions,
	SessionRef,
} from "./sessions/maintenance.js";
export type {
	RedactEventsOptions,
	RedactionSummary,
} from "./sessions/redaction.js";
export type {
	RawImage,
	RawPiece,
	StoredContent,
	StoredImage,
} from "./sessions/stored-images.js";
export type { UserInput } from "./sessions/user-input.js";
export { version } from "./version.js";
export { SnapshotError } from "./workspace/git.js";
export type {
	ChangesDiff,
	RestoredChanges,
} from "./workspace/session-snapshots.js";
