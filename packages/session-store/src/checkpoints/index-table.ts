import type { DatabaseSync } from "node:sqlite";
import { StorageError } from "../storage/database.js";
import type { InputRange, Position } from "../tree/index.js";
import { currentPosition, onSegments, pathSegments } from "../tree/paths.js";
import {
	type Checkpoint,
	type CheckpointCreated,
	type CheckpointRecord,
	type CheckpointSnapshot,
	retainedCheckpoints,
	type SnapshotRecord,
} from "./index.js";

interface CheckpointRow {
	input_event_id: string;
	kind: "task" | "steering";
	run_id: string;
	seq: number;
	before_run_id: string | null;
	before_seq: number | null;
	cleaned: number;
	snapshots: string;
}

function rows(db: DatabaseSync, sessionId: string): CheckpointRow[] {
	return db
		.prepare(
			"SELECT input_event_id, kind, run_id, seq, before_run_id, before_seq, cleaned, snapshots FROM checkpoints WHERE session_id = ? ORDER BY rowid",
		)
		.all(sessionId) as unknown as CheckpointRow[];
}

function insert(
	db: DatabaseSync,
	sessionId: string,
	record: CheckpointRecord,
): void {
	db.prepare(
		"INSERT INTO checkpoints (session_id, input_event_id, kind, run_id, seq, before_run_id, before_seq, cleaned, snapshots) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		sessionId,
		record.input_event_id,
		record.kind,
		record.position.run_id,
		record.position.seq,
		record.before?.run_id ?? null,
		record.before?.seq ?? null,
		record.cleaned ? 1 : 0,
		JSON.stringify(record.snapshots),
	);
}

/** 只留最近 `retainedCheckpoints` 个检查点的快照：只取决于检查点建立的先后，重建索引得到同样的结果。 */
function markCleaned(db: DatabaseSync, sessionId: string): void {
	db.prepare(
		"UPDATE checkpoints SET cleaned = 1 WHERE session_id = ? AND cleaned = 0 AND rowid NOT IN (SELECT rowid FROM checkpoints WHERE session_id = ? ORDER BY rowid DESC LIMIT ?)",
	).run(sessionId, sessionId, retainedCheckpoints);
}

/** 建立一个检查点：输入事件要已经写在这个 run 里。 */
export function createCheckpoint(
	db: DatabaseSync,
	sessionId: string,
	runId: string,
	created: CheckpointCreated,
): void {
	const input = db
		.prepare(
			"SELECT seq FROM events WHERE session_id = ? AND run_id = ? AND event_id = ?",
		)
		.get(sessionId, runId, created.input_event_id) as
		| { seq: number }
		| undefined;
	if (input === undefined) {
		throw new StorageError(
			`检查点对应的输入事件 ${created.input_event_id} 不在 run ${runId} 里`,
		);
	}
	insert(db, sessionId, {
		input_event_id: created.input_event_id,
		kind: created.kind,
		position: { run_id: runId, seq: input.seq },
		before: created.before,
		cleaned: false,
		snapshots: [],
	});
	markCleaned(db, sessionId);
}

/** 把一次快照记到它所属的检查点名下。 */
export function recordSnapshot(
	db: DatabaseSync,
	sessionId: string,
	snapshot: CheckpointSnapshot,
): void {
	const row = db
		.prepare(
			"SELECT snapshots FROM checkpoints WHERE session_id = ? AND input_event_id = ?",
		)
		.get(sessionId, snapshot.input_event_id) as
		| { snapshots: string }
		| undefined;
	if (row === undefined) {
		throw new StorageError(
			`session ${sessionId} 没有检查点 ${snapshot.input_event_id}`,
		);
	}
	const { input_event_id: _, ...record } = snapshot;
	db.prepare(
		"UPDATE checkpoints SET snapshots = ? WHERE session_id = ? AND input_event_id = ?",
	).run(
		JSON.stringify([
			...(JSON.parse(row.snapshots) as SnapshotRecord[]),
			record,
		]),
		sessionId,
		snapshot.input_event_id,
	);
}

/** 用分叉时父 session 的检查点索引顶替这个 session 的整个索引。 */
export function inheritCheckpoints(
	db: DatabaseSync,
	sessionId: string,
	checkpoints: readonly CheckpointRecord[],
): void {
	clearCheckpoints(db, sessionId);
	for (const record of checkpoints) insert(db, sessionId, record);
	markCleaned(db, sessionId);
}

export function clearCheckpoints(db: DatabaseSync, sessionId: string): void {
	db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(sessionId);
}

/** 检查点在影子仓库里的引用名。 */
function snapshotRef(sessionId: string, inputEventId: string): string {
	return `${sessionId}/${inputEventId}`;
}

/** 一个 session 的全部检查点，按建立的先后。 */
export function listCheckpoints(
	db: DatabaseSync,
	sessionId: string,
): Checkpoint[] {
	const current = currentPosition(db, sessionId);
	const path = current === null ? [] : pathSegments(db, sessionId, current);
	return rows(db, sessionId).map((row) => {
		const position: Position = { run_id: row.run_id, seq: row.seq };
		const snapshots = JSON.parse(row.snapshots) as SnapshotRecord[];
		const cleaned = row.cleaned === 1;
		return {
			input_event_id: row.input_event_id,
			kind: row.kind,
			position,
			before:
				row.before_run_id === null
					? null
					: { run_id: row.before_run_id, seq: row.before_seq as number },
			cleaned,
			snapshots,
			on_path: onSegments(path, position),
			snapshot_ref:
				cleaned || !snapshots.some((snapshot) => snapshot.commit !== null)
					? null
					: snapshotRef(sessionId, row.input_event_id),
		};
	});
}

/** 每次用户输入在它所在的 run 里的序号范围。 */
export function listInputs(db: DatabaseSync, sessionId: string): InputRange[] {
	const all = rows(db, sessionId);
	return all.map((row) => {
		const next = all
			.filter((other) => other.run_id === row.run_id && other.seq > row.seq)
			.reduce<number | null>(
				(least, other) =>
					least === null || other.seq < least ? other.seq : least,
				null,
			);
		return {
			input_event_id: row.input_event_id,
			kind: row.kind,
			run_id: row.run_id,
			from_seq: row.seq,
			to_seq: next === null ? null : next - 1,
		};
	});
}

/**
 * `refs` 里不再被 `workspace` 这个工作区的任何 session 引用的检查点引用名：
 * 检查点的快照已清理，或者 session 已经删除。
 */
export function unreferencedRefs(
	db: DatabaseSync,
	workspace: string,
	refs: readonly string[],
): string[] {
	const live = new Set(
		(
			db
				.prepare(
					"SELECT c.session_id, c.input_event_id FROM checkpoints c JOIN sessions s USING (session_id) WHERE s.workspace = ? AND c.cleaned = 0",
				)
				.all(workspace) as unknown as {
				session_id: string;
				input_event_id: string;
			}[]
		).map((row) => snapshotRef(row.session_id, row.input_event_id)),
	);
	return refs.filter((ref) => !live.has(ref));
}
