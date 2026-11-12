/**
 * 在会话树上开始一个 run 的事件类型：它的 `data` 是 `RunRecord`，格式版本是写入时的 `storageVersion`
 * （格式没有变的旧版本照常接受）。本包按它维护 run 的接续关系。
 */
export const runStartedType = "run.started";

/**
 * 移动 session 当前位置的事件类型（回退，或切回被放弃的位置）：`data` 是 `PositionMove`，
 * 写在不属于任何 task 的 run 里。
 */
export const positionMovedType = "position.moved";

/** 会话树上的一个位置：某个 run 里序号为 `seq` 的事件之后。 */
export interface Position {
	run_id: string;
	seq: number;
}

/**
 * 一个 run 在会话树上的记录。重启、恢复、回退和分叉都是"从某个位置开始一个新的 run"。
 * 子 agent 的 run 另带父 agent 和启动它的工具调用，两个字段一起出现，`base` 为空。不属于任何 task
 * 的 run 和子 agent 的 run 都不进入会话树的路径，不能作为别的 run 的 `base`；子 agent 的 run 里的
 * 事件写入时也不移动 session 的当前位置。
 */
export interface RunRecord {
	run_id: string;
	task_id: string | null;
	agent_id: string | null;
	parent_agent_id?: string;
	parent_tool_call_id?: string;
	/** 接在哪个位置之后；session 的第一个 run 和不属于任何 task 的 run 为空。 */
	base: Position | null;
}

/**
 * `position.moved` 的内容。原来的当前位置不在通往 `to` 的路径上时记为被放弃的位置，可以再移回去。
 */
export interface PositionMove {
	/** 新的当前位置，要在这个 session 的会话树里；回退到第一次输入之前时为空。 */
	to: Position | null;
}

/** session 的当前位置，显式保存；回退时被放弃的位置保留下来，可以再切回去。 */
export interface SessionPosition {
	current: Position;
	abandoned: Position[];
}

/** 一次用户输入（task 的输入或 steering）在会话树里的范围，回退以它为分支点。 */
export interface InputRange {
	/** 用户输入事件的 `event_id`。 */
	input_event_id: string;
	kind: "task" | "steering";
	run_id: string;
	/** 输入事件的序号。 */
	from_seq: number;
	/** 同一个 run 里下一次用户输入之前的最后一个序号；之后没有别的输入时为空，范围到这个 run 的末尾。 */
	to_seq: number | null;
}

/** 分叉出的 session 记下来源：父 session 和截止的位置，不复制父 session 的事件。 */
export interface ForkOrigin {
	parent_session_id: string;
	position: Position;
}

/** 每个 session 的元数据，供会话列表和恢复使用。 */
export interface SessionMetadata {
	session_id: string;
	/** 创建时的工作区真实路径，只能在同一路径恢复。 */
	workspace: string;
	/** ISO 8601 格式的 UTC 时间。 */
	created_at: string;
	last_written_at: string;
	/** 第一条用户输入的第一行；还没有输入时为空。 */
	title: string | null;
	fork?: ForkOrigin;
}
