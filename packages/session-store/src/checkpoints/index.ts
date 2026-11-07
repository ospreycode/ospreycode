import type { Position } from "../tree/index.js";

/**
 * 检查点：每次用户输入时的还原点，是 session 记录里的位置加对应的快照。
 * 快照本身在 Host 的影子仓库里，这里只记引用。
 */
export interface Checkpoint {
	/** 对应的用户输入事件。 */
	input_event_id: string;
	position: Position;
	/** 这次输入之后第一次工具调用之前的快照在影子仓库里的引用名；还没有快照或快照已清理时为空。 */
	snapshot_ref: string | null;
	/** 之后改动的路径，包括新建的文件（还原时要删除它们），相对工作区。 */
	changed_paths: string[];
}
