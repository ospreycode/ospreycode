import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StorageError } from "../storage/database.js";
import type { ForkOrigin, Position, RunRecord } from "./index.js";

interface SessionRow {
	parent_session_id: string | null;
	fork_run_id: string | null;
	fork_seq: number | null;
	current_run_id: string | null;
	current_seq: number | null;
}

function sessionRow(db: DatabaseSync, sessionId: string): SessionRow {
	const row = db
		.prepare(
			"SELECT parent_session_id, fork_run_id, fork_seq, current_run_id, current_seq FROM sessions WHERE session_id = ?",
		)
		.get(sessionId) as SessionRow | undefined;
	if (row === undefined) {
		throw new StorageError(`没有这个 session：${sessionId}`);
	}
	return row;
}

/** 分叉的来源；不是分叉（或父 session 已经删除、事件都改记到了自己名下）时为空。 */
export function forkOrigin(
	db: DatabaseSync,
	sessionId: string,
): ForkOrigin | null {
	const row = sessionRow(db, sessionId);
	return row.parent_session_id === null
		? null
		: {
				parent_session_id: row.parent_session_id,
				position: {
					run_id: row.fork_run_id as string,
					seq: row.fork_seq as number,
				},
			};
}

/** session 的当前位置。 */
export function currentPosition(
	db: DatabaseSync,
	sessionId: string,
): Position | null {
	const row = sessionRow(db, sessionId);
	return row.current_run_id === null
		? null
		: { run_id: row.current_run_id, seq: row.current_seq as number };
}

/** 这个 session 和它的各级父 session，自己在前。 */
export function lineage(db: DatabaseSync, sessionId: string): string[] {
	const ids: string[] = [];
	for (let id: string | null = sessionId; id !== null; ) {
		ids.push(id);
		id = sessionRow(db, id).parent_session_id;
	}
	return ids;
}

interface RunRow {
	run_id: string;
	task_id: string | null;
	agent_id: string | null;
	parent_agent_id: string | null;
	parent_tool_call_id: string | null;
	base_run_id: string | null;
	base_seq: number | null;
}

/** 一个 session 自己的 run，按开始的顺序。 */
export function ownRuns(db: DatabaseSync, sessionId: string): RunRecord[] {
	return (
		db
			.prepare(
				"SELECT run_id, task_id, agent_id, parent_agent_id, parent_tool_call_id, base_run_id, base_seq FROM runs WHERE session_id = ? ORDER BY rowid",
			)
			.all(sessionId) as unknown as RunRow[]
	).map((row) => ({
		run_id: row.run_id,
		task_id: row.task_id,
		agent_id: row.agent_id,
		...(row.parent_agent_id === null
			? {}
			: { parent_agent_id: row.parent_agent_id }),
		...(row.parent_tool_call_id === null
			? {}
			: { parent_tool_call_id: row.parent_tool_call_id }),
		base:
			row.base_run_id === null
				? null
				: { run_id: row.base_run_id, seq: row.base_seq as number },
	}));
}

/**
 * 从会话树的根到 `until` 的路径，每个 run 一段、只取到下一个 run 接续的位置为止。
 * run 的标识在整个库里不重复，分叉的路径沿 `base` 走进各级父 session 的 run。
 */
export function pathSegments(
	db: DatabaseSync,
	sessionId: string,
	until: Position,
): Position[] {
	const runs = new Map(
		lineage(db, sessionId).flatMap((id) =>
			ownRuns(db, id).map((run) => [run.run_id, run] as const),
		),
	);
	const segments: Position[] = [];
	for (let at: Position | null = until; at !== null; ) {
		const run = runs.get(at.run_id);
		if (run === undefined) {
			throw new StorageError(`会话树里没有 run ${at.run_id}`);
		}
		segments.unshift(at);
		at = run.base;
	}
	return segments;
}

/** `position` 在不在这几段路径上。 */
export function onSegments(
	segments: readonly Position[],
	position: Position,
): boolean {
	return segments.some(
		(segment) =>
			segment.run_id === position.run_id && position.seq <= segment.seq,
	);
}

/** 这个 session 自己的 run 是不是子 agent 的 run：它不进入会话树的路径。 */
export function isSubagentRun(
	db: DatabaseSync,
	sessionId: string,
	runId: string,
): boolean {
	const run = db
		.prepare(
			"SELECT parent_agent_id FROM runs WHERE session_id = ? AND run_id = ?",
		)
		.get(sessionId, runId) as { parent_agent_id: string | null } | undefined;
	return run !== undefined && run.parent_agent_id !== null;
}

/**
 * `position` 在不在这个 session 的会话树里：自己的、属于 task 又不在子 agent 的 run 里的事件，
 * 或者分叉沿用的那段路径上的事件。
 */
export function inTree(
	db: DatabaseSync,
	sessionId: string,
	position: Position,
): boolean {
	const own = db
		.prepare(
			"SELECT task_id FROM events WHERE session_id = ? AND run_id = ? AND seq = ?",
		)
		.get(sessionId, position.run_id, position.seq) as
		| { task_id: string | null }
		| undefined;
	if (own !== undefined) {
		return (
			own.task_id !== null && !isSubagentRun(db, sessionId, position.run_id)
		);
	}
	const origin = forkOrigin(db, sessionId);
	return (
		origin !== null &&
		position.seq >= 1 &&
		onSegments(
			pathSegments(db, origin.parent_session_id, origin.position),
			position,
		)
	);
}

/** 一段路径上的事件行；`columns` 是要取的列。 */
export function segmentRows<Row>(
	db: DatabaseSync,
	sessions: readonly string[],
	segment: Position,
	columns: string,
): Row[] {
	const values: SQLInputValue[] = [segment.run_id, segment.seq, ...sessions];
	return db
		.prepare(
			`SELECT ${columns} FROM events WHERE run_id = ? AND seq <= ? AND session_id IN (${sessions.map(() => "?").join(", ")}) ORDER BY seq`,
		)
		.all(...values) as unknown as Row[];
}

/** 把 session 的当前位置写下来。 */
export function setCurrentPosition(
	db: DatabaseSync,
	sessionId: string,
	position: Position | null,
): void {
	db.prepare(
		"UPDATE sessions SET current_run_id = ?, current_seq = ? WHERE session_id = ?",
	).run(position?.run_id ?? null, position?.seq ?? null, sessionId);
}

/** 记下一个 run 的接续关系。 */
export function insertRun(
	db: DatabaseSync,
	sessionId: string,
	record: RunRecord,
): void {
	db.prepare(
		"INSERT INTO runs (session_id, run_id, task_id, agent_id, parent_agent_id, parent_tool_call_id, base_run_id, base_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		sessionId,
		record.run_id,
		record.task_id,
		record.agent_id,
		record.parent_agent_id ?? null,
		record.parent_tool_call_id ?? null,
		record.base?.run_id ?? null,
		record.base?.seq ?? null,
	);
}

/** 被放弃的位置，按放弃的先后。 */
export function abandonedPositions(
	db: DatabaseSync,
	sessionId: string,
): Position[] {
	return (
		db
			.prepare(
				"SELECT run_id, seq FROM abandoned_positions WHERE session_id = ? ORDER BY rowid",
			)
			.all(sessionId) as unknown as Position[]
	).map((row) => ({ run_id: row.run_id, seq: row.seq }));
}

/**
 * 把当前位置移到 `to`。原来的位置不在通往 `to` 的路径上时记为被放弃的位置；
 * `to` 本身如果是被放弃的位置，从那份清单里去掉。
 */
export function movePosition(
	db: DatabaseSync,
	sessionId: string,
	to: Position | null,
): void {
	if (to !== null && !inTree(db, sessionId, to)) {
		throw new StorageError(
			`位置 ${to.run_id}:${to.seq} 不在 session ${sessionId} 的会话树里`,
		);
	}
	const from = currentPosition(db, sessionId);
	if (to !== null) {
		db.prepare(
			"DELETE FROM abandoned_positions WHERE session_id = ? AND run_id = ? AND seq = ?",
		).run(sessionId, to.run_id, to.seq);
	}
	// 原来的位置在通往新位置或某个被放弃的位置的路径上时不是一片叶子，不用记：沿那条路径就能回到它
	const reachable =
		from !== null &&
		[...(to === null ? [] : [to]), ...abandonedPositions(db, sessionId)].some(
			(tip) => onSegments(pathSegments(db, sessionId, tip), from),
		);
	if (from !== null && !reachable) {
		db.prepare(
			"INSERT OR IGNORE INTO abandoned_positions (session_id, run_id, seq) VALUES (?, ?, ?)",
		).run(sessionId, from.run_id, from.seq);
	}
	setCurrentPosition(db, sessionId, to);
}
