/**
 * session 记录的存储格式版本，记在数据库的 `PRAGMA user_version`。第 2 版加了分叉的来源、
 * 被放弃的位置和检查点索引；打开第 1 版的库时自动迁移。
 */
export const storageVersion = 2;

/** 事件的来源：Host 自己产生的，或 runtime 经通道上报、Host 核实后写入的。 */
export type EventSource = "host" | "runtime";

/**
 * session 记录里的一个事件。公共字段由本包规定，`type` 和 `data` 由产生它的包定义，本包不理解内容；
 * 例外是本包自己定义的几种事件（会话树和检查点索引靠它们维护），见 `runStartedType`、
 * `positionMovedType`、`checkpointCreatedType`、`checkpointSnapshotType`、
 * `checkpointsInheritedType` 和 `eventRedactedType`。
 * 来源和关联标识由 Host 按通道核实后写入，不采信沙盒内填写的值。
 */
export interface StoredEvent {
	/** 产生事件的一方生成，Host 只在所属 run 内判断重复。 */
	event_id: string;
	session_id: string;
	run_id: string;
	/** run 内从 1 开始递增的序号。 */
	seq: number;
	/** ISO 8601 格式的 UTC 时间。 */
	time: string;
	source: EventSource;
	/** 不属于任何 task 的 run（如后台的记忆提取）为空。 */
	task_id: string | null;
	/** 不属于任何 task 的 run 为空。 */
	agent_id: string | null;
	type: string;
	/** `data` 的格式版本，由定义这类事件的包给出。 */
	version: number;
	data: unknown;
}

/**
 * 按事件脱敏的记录：`data` 是 `EventRedaction`，格式版本是写入时的 `storageVersion`。
 * 它和被覆盖的事件在同一个事务里写入（`SessionWriter.redact`）。
 */
export const eventRedactedType = "event.redacted";

/** `event.redacted` 的内容：哪些事件的内容被占位内容覆盖了。 */
export interface EventRedaction {
	events: { run_id: string; seq: number }[];
}
