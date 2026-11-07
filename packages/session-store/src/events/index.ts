/** session 记录的存储格式版本，记在数据库的 `PRAGMA user_version`。 */
export const storageVersion = 1;

/** 事件的来源：Host 自己产生的，或 runtime 经通道上报、Host 核实后写入的。 */
export type EventSource = "host" | "runtime";

/**
 * session 记录里的一个事件。公共字段由本包规定，`type` 和 `data` 由产生它的包定义，本包不理解内容。
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
