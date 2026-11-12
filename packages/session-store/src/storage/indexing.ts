import type { DatabaseSync } from "node:sqlite";
import {
	type CheckpointCreated,
	type CheckpointRecord,
	type CheckpointSnapshot,
	type CheckpointsInherited,
	checkpointCreatedType,
	checkpointSnapshotType,
	checkpointsInheritedType,
	type SnapshotRecord,
} from "../checkpoints/index.js";
import {
	createCheckpoint,
	inheritCheckpoints,
	recordSnapshot,
} from "../checkpoints/index-table.js";
import {
	type EventRedaction,
	eventRedactedType,
	type StoredEvent,
	storageVersion,
} from "../events/index.js";
import {
	type Position,
	type PositionMove,
	positionMovedType,
	type RunRecord,
	runStartedType,
} from "../tree/index.js";
import {
	insertRun,
	inTree,
	isSubagentRun,
	movePosition,
	setCurrentPosition,
} from "../tree/paths.js";
import { StorageError } from "./database.js";

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
	return (
		isFields(value) &&
		typeof value.run_id === "string" &&
		Number.isInteger(value.seq)
	);
}

function isOptionalPosition(value: unknown): value is Position | null {
	return value === null || isPosition(value);
}

function isKind(value: unknown): value is "task" | "steering" {
	return value === "task" || value === "steering";
}

function isStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isSnapshot(value: unknown): value is SnapshotRecord {
	return (
		isFields(value) &&
		(value.commit === null || typeof value.commit === "string") &&
		isStrings(value.paths) &&
		(value.origin === "agent" ||
			value.origin === "undo" ||
			value.origin === "external") &&
		(value.tool_call_id === undefined ||
			typeof value.tool_call_id === "string") &&
		(value.omitted === undefined || isStrings(value.omitted)) &&
		(value.failure === undefined || typeof value.failure === "string")
	);
}

function isCheckpointRecord(value: unknown): value is CheckpointRecord {
	return (
		isFields(value) &&
		typeof value.input_event_id === "string" &&
		isKind(value.kind) &&
		isPosition(value.position) &&
		isOptionalPosition(value.before) &&
		typeof value.cleaned === "boolean" &&
		Array.isArray(value.snapshots) &&
		value.snapshots.every(isSnapshot)
	);
}

/**
 * 本包定义的事件：`data` 的格式由 `check` 判断。事件由 Host 写入，重建索引时又从磁盘读回，
 * 两处都在这里检查一次。
 */
function checked<Data>(
	event: StoredEvent,
	check: (data: unknown) => boolean,
): Data {
	if (
		event.version < 1 ||
		event.version > storageVersion ||
		!check(event.data)
	) {
		throw new StorageError(
			`${event.type} 事件（${event.run_id}:${event.seq}）的 data 或格式版本不对`,
		);
	}
	return event.data as Data;
}

function runRecord(event: StoredEvent): RunRecord {
	const record = checked<RunRecord>(
		event,
		(data) =>
			isFields(data) &&
			data.run_id === event.run_id &&
			data.task_id === event.task_id &&
			data.agent_id === event.agent_id &&
			isOptionalPosition(data.base) &&
			// 子 agent 的 run 两个父字段都要有，属于 task，不接在会话树的任何位置之后
			(data.parent_agent_id === undefined
				? data.parent_tool_call_id === undefined
				: typeof data.parent_agent_id === "string" &&
					typeof data.parent_tool_call_id === "string" &&
					data.task_id !== null &&
					data.base === null),
	);
	return record;
}

/** 这个事件是不是按事件脱敏的记录；是的话交回它的内容。 */
export function redactionRecord(event: StoredEvent): EventRedaction {
	if (event.type !== eventRedactedType) {
		throw new StorageError(`脱敏要用 ${eventRedactedType} 事件记录`);
	}
	return checked<EventRedaction>(
		event,
		(data) =>
			isFields(data) &&
			Array.isArray(data.events) &&
			data.events.every(isPosition),
	);
}

/**
 * 按一个事件更新会话树和检查点索引。追加事件和重建索引走同一条路径，所以索引只取决于事件和它们的先后。
 */
export function indexEvent(db: DatabaseSync, event: StoredEvent): void {
	switch (event.type) {
		case runStartedType: {
			const record = runRecord(event);
			if (
				record.task_id !== null &&
				record.base !== null &&
				!inTree(db, event.session_id, record.base)
			) {
				throw new StorageError(
					`run ${record.run_id} 接续的位置 ${record.base.run_id}:${record.base.seq} 不在 session ${event.session_id} 的会话树里`,
				);
			}
			insertRun(db, event.session_id, record);
			break;
		}
		case positionMovedType:
			movePosition(
				db,
				event.session_id,
				checked<PositionMove>(
					event,
					(data) => isFields(data) && isOptionalPosition(data.to),
				).to,
			);
			break;
		case checkpointCreatedType:
			createCheckpoint(
				db,
				event.session_id,
				event.run_id,
				checked<CheckpointCreated>(
					event,
					(data) =>
						isFields(data) &&
						typeof data.input_event_id === "string" &&
						isKind(data.kind) &&
						isOptionalPosition(data.before),
				),
			);
			break;
		case checkpointSnapshotType:
			recordSnapshot(
				db,
				event.session_id,
				checked<CheckpointSnapshot>(
					event,
					(data) =>
						isFields(data) &&
						typeof data.input_event_id === "string" &&
						isSnapshot(data),
				),
			);
			break;
		case checkpointsInheritedType:
			inheritCheckpoints(
				db,
				event.session_id,
				checked<CheckpointsInherited>(
					event,
					(data) =>
						isFields(data) &&
						Array.isArray(data.checkpoints) &&
						data.checkpoints.every(isCheckpointRecord),
				).checkpoints,
			);
			break;
	}
	// 子 agent 的 run 不在会话树的路径上：它的事件和父 run 的交错写入，不移动当前位置
	if (
		event.task_id !== null &&
		!isSubagentRun(db, event.session_id, event.run_id)
	) {
		setCurrentPosition(db, event.session_id, {
			run_id: event.run_id,
			seq: event.seq,
		});
	}
}
