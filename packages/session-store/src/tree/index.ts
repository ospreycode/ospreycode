/**
 * 在会话树上开始一个 run 的事件类型：它的 `data` 是 `RunRecord`，格式版本是 `storageVersion`。
 * 这是本包唯一读取内容的事件，按它维护 run 的接续关系。
 */
export const runStartedType = "run.started";

/** 会话树上的一个位置：某个 run 里序号为 `seq` 的事件之后。 */
export interface Position {
	run_id: string;
	seq: number;
}

/**
 * 一个 run 在会话树上的记录。重启、恢复、回退和分叉都是"从某个位置开始一个新的 run"。
 * 子 agent 的 run 另带父 agent 和启动它的工具调用。不属于任何 task 的 run 不进入会话树的路径，
 * 也不能作为别的 run 的 `base`。
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
	/** 下一次用户输入之前的最后一个序号；输入所在的 task 还在运行时为空。 */
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
