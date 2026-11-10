// `Session` 和 `SessionOptions` 的签名里用到的类型：前端只依赖本包也写得出回答、策略和模式的类型
export type { ReasoningEffort } from "@ospreycode/api/protocol";
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
	ErrorEvent,
	EventBase,
	FollowUpPausedEvent,
	HostEvent,
	InputDequeuedEvent,
	InputInsertedEvent,
	InputQueuedEvent,
	MessageCompletedEvent,
	ModelChangedEvent,
	ModelDeltaEvent,
	ReasoningEffortChangedEvent,
	RunStartedEvent,
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
	type Host,
	type HostOptions,
	type OpenSessionOptions,
	type ProjectInfo,
	type Session,
} from "./sdk/host.js";
export {
	hostEventSchema,
	isHostEvent,
	startupErrorEventSchema,
} from "./sdk/schema.js";
export type { BudgetLimit } from "./sessions/budget.js";
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
	SessionCommandError,
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
	RawImage,
	RawPiece,
	StoredContent,
	StoredImage,
} from "./sessions/stored-images.js";
export type { UserInput } from "./sessions/user-input.js";
export { version } from "./version.js";
