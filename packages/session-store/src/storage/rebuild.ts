import type { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "../events/index.js";
import { forkOrigin, setCurrentPosition } from "../tree/paths.js";
import { writeTransaction } from "./database.js";
import { indexEvent } from "./indexing.js";

/** 事件表里的一行。 */
export interface EventRow {
	event_id: string;
	session_id: string;
	run_id: string;
	seq: number;
	time: string;
	source: "host" | "runtime";
	task_id: string | null;
	agent_id: string | null;
	type: string;
	version: number;
	data: string;
}

/** 读事件用的列，顺序和 `EventRow` 一致。 */
export const eventColumns =
	"event_id, session_id, run_id, seq, time, source, task_id, agent_id, type, version, data";

export function toEvent(row: EventRow): StoredEvent {
	return { ...row, data: JSON.parse(row.data) as unknown };
}

/** 一个 session 自己的事件，按写入的顺序。 */
export function ownEvents(db: DatabaseSync, sessionId: string): StoredEvent[] {
	return (
		db
			.prepare(
				`SELECT ${eventColumns} FROM events WHERE session_id = ? ORDER BY rowid`,
			)
			.all(sessionId) as unknown as EventRow[]
	).map(toEvent);
}

/**
 * 从事件表重建整个库的会话树和检查点索引：清空之后按写入顺序重放每个 session 的事件。
 * session 按创建的先后处理，分叉在它的父 session 之后。
 */
export function rebuildIndexes(db: DatabaseSync): void {
	writeTransaction(db, () => {
		db.exec(
			"DELETE FROM runs; DELETE FROM abandoned_positions; DELETE FROM checkpoints;",
		);
		const sessions = db
			.prepare("SELECT session_id FROM sessions ORDER BY rowid")
			.all() as unknown as { session_id: string }[];
		for (const { session_id } of sessions) {
			// 分叉还没有自己的事件时，当前位置就是分叉的位置
			setCurrentPosition(
				db,
				session_id,
				forkOrigin(db, session_id)?.position ?? null,
			);
			for (const event of ownEvents(db, session_id)) indexEvent(db, event);
		}
	});
}
