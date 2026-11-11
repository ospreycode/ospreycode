import type { Position } from "../tree/index.js";

/**
 * 建立检查点的事件类型：每次用户输入一个，紧跟在输入事件之后、写在同一个 run 里，
 * `data` 是 `CheckpointCreated`。
 */
export const checkpointCreatedType = "checkpoint.created";

/**
 * 记下一次快照的事件类型：`data` 是 `CheckpointSnapshot`。快照记在当时最新的检查点名下，
 * 可以写在 task 的 run 里，也可以写在不属于任何 task 的 run 里（如空闲时结束的后台命令）。
 */
export const checkpointSnapshotType = "checkpoint.snapshot";

/**
 * 分叉沿用父 session 检查点索引的事件类型：分叉的第一个事件，`data` 是 `CheckpointsInherited`，
 * 写在不属于任何 task 的 run 里。它顶替这个 session 已有的整个检查点索引。
 */
export const checkpointsInheritedType = "checkpoints.inherited";

/** 每个 session 保留最近多少个检查点的快照；更早的标为"快照已清理"。 */
export const retainedCheckpoints = 100;

/** `checkpoint.created` 的内容。 */
export interface CheckpointCreated {
	/** 用户输入事件的 `event_id`，这个事件要已经写在同一个 run 里。 */
	input_event_id: string;
	kind: "task" | "steering";
	/** 这次输入之前的位置：回退到这个检查点就是把当前位置移到这里；session 的第一次输入之前为空。 */
	before: Position | null;
}

/** 一次快照的记录。快照本身在 Host 的影子仓库里，这里只记提交和改动的路径。 */
export interface SnapshotRecord {
	/** 影子仓库里的提交；这次快照没有做成（出错，或新增的内容超过上限）时为空。 */
	commit: string | null;
	/** 和这个 session 的上一次快照相比改动的路径（包括新建和删除的文件），相对工作区。 */
	paths: string[];
	/** 改动来自 agent 的工具调用、撤销，还是别处（用户、别的程序）。 */
	origin: "agent" | "undo" | "external";
	/** 改动算在哪次工具调用名下。 */
	tool_call_id?: string;
	/** 没有保存进这次快照的文件（超过单个文件的大小上限），撤销时列为无快照。 */
	omitted?: string[];
	/** 快照没有做成的原因。 */
	failure?: string;
}

/** `checkpoint.snapshot` 的内容。 */
export interface CheckpointSnapshot extends SnapshotRecord {
	/** 所属检查点的输入事件，这个检查点要在这个 session 的索引里。 */
	input_event_id: string;
}

/** 检查点索引里的一条记录。 */
export interface CheckpointRecord {
	/** 对应的用户输入事件。 */
	input_event_id: string;
	kind: "task" | "steering";
	/** 输入事件的位置。 */
	position: Position;
	/** 这次输入之前的位置；session 的第一次输入之前为空。 */
	before: Position | null;
	/** 快照已清理：还可以回退对话，不能还原代码。 */
	cleaned: boolean;
	/** 这个检查点名下的各次快照，按时间顺序；第一条是这次输入之后第一次工具调用之前的快照。 */
	snapshots: SnapshotRecord[];
}

/** `checkpoints.inherited` 的内容：分叉时父 session 的整个检查点索引，按建立的先后。 */
export interface CheckpointsInherited {
	checkpoints: CheckpointRecord[];
}

/**
 * 检查点：每次用户输入时的还原点，是 session 记录里的位置加对应的快照。
 * 快照本身在 Host 的影子仓库里，这里只记引用。
 */
export interface Checkpoint extends CheckpointRecord {
	/** 在不在 session 当前的路径上；只有路径上的检查点可以作为回退对话的目标。 */
	on_path: boolean;
	/**
	 * 这个检查点在影子仓库里的引用名（`<session_id>/<input_event_id>`，不带 Host 加的前缀）；
	 * 还没有快照或快照已清理时为空。
	 */
	snapshot_ref: string | null;
}
