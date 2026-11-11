import type { DatabaseSync } from "node:sqlite";
import { dropUnreferencedBlobs } from "../blobs/index.js";
import type { ForkOrigin, Position } from "../tree/index.js";
import { forkOrigin } from "../tree/paths.js";
import { writeTransaction } from "./database.js";

/** 删除 session 时改记到一个分叉名下的事件。 */
export interface ReownedEvents {
	/** 接手这些事件的分叉。 */
	session_id: string;
	/** 改记的事件，每个 run 一段序号。 */
	segments: { run_id: string; from_seq: number; to_seq: number }[];
}

/** 删除一个 session 的结果。 */
export interface DeletedSession {
	session_id: string;
	/** 被删 session 的工作区：它的检查点引用在这个工作区的影子仓库里。 */
	workspace: string;
	/** 直接从它分出去的分叉各自接手了哪些事件；以这些事件为来源的记忆要跟着改记。 */
	reowned: ReownedEvents[];
}

/**
 * 一个分叉接手被删 session 的事件：从分叉位置沿路径往根走，仍属于被删 session 的事件改记到分叉名下，
 * 遇到已经属于别的 session 的事件就停下，改为从那个 session 的那个位置分叉。
 */
function reown(
	db: DatabaseSync,
	deleted: string,
	child: string,
	from: Position,
): ReownedEvents {
	const segments: ReownedEvents["segments"] = [];
	let origin: ForkOrigin | null = null;
	for (let at: Position | null = from; at !== null; ) {
		const owned = db
			.prepare(
				"SELECT min(seq) AS least, max(seq) AS most FROM events WHERE session_id = ? AND run_id = ? AND seq <= ?",
			)
			.get(deleted, at.run_id, at.seq) as {
			least: number | null;
			most: number | null;
		};
		if (owned.least !== null) {
			db.prepare(
				"UPDATE events SET session_id = ? WHERE session_id = ? AND run_id = ? AND seq <= ?",
			).run(child, deleted, at.run_id, at.seq);
			segments.push({
				run_id: at.run_id,
				from_seq: owned.least,
				to_seq: owned.most as number,
			});
		}
		// 这个 run 更靠前的事件已经属于别的 session：更早处理的另一个分叉，或被删 session 自己的父 session
		const other = db
			.prepare(
				"SELECT session_id, seq FROM events WHERE run_id = ? AND seq <= ? AND session_id NOT IN (?, ?) ORDER BY seq DESC LIMIT 1",
			)
			.get(at.run_id, at.seq, deleted, child) as
			| { session_id: string; seq: number }
			| undefined;
		if (other !== undefined) {
			origin = {
				parent_session_id: other.session_id,
				position: { run_id: at.run_id, seq: other.seq },
			};
			break;
		}
		const run = db
			.prepare("SELECT base_run_id, base_seq FROM runs WHERE run_id = ?")
			.get(at.run_id) as {
			base_run_id: string | null;
			base_seq: number | null;
		};
		db.prepare(
			"UPDATE runs SET session_id = ? WHERE session_id = ? AND run_id = ?",
		).run(child, deleted, at.run_id);
		at =
			run.base_run_id === null
				? null
				: { run_id: run.base_run_id, seq: run.base_seq as number };
	}
	db.prepare(
		"UPDATE sessions SET parent_session_id = ?, fork_run_id = ?, fork_seq = ? WHERE session_id = ?",
	).run(
		origin?.parent_session_id ?? null,
		origin?.position.run_id ?? null,
		origin?.position.seq ?? null,
		child,
	);
	return { session_id: child, segments };
}

/**
 * 彻底删除一个 session：分叉仍引用的事件先改记到分叉名下，再删掉其余的事件、索引和只被它引用的大内容，
 * 都在一个事务里。只处理直接从它分出去的分叉，按创建的先后；分叉的分叉经过自己的父 session 读到这些事件。
 */
export function deleteSession(
	db: DatabaseSync,
	sessionId: string,
): DeletedSession {
	const deleted = writeTransaction(db, () => {
		// 确认它存在
		forkOrigin(db, sessionId);
		const { workspace } = db
			.prepare("SELECT workspace FROM sessions WHERE session_id = ?")
			.get(sessionId) as { workspace: string };
		const children = db
			.prepare(
				"SELECT session_id, fork_run_id, fork_seq FROM sessions WHERE parent_session_id = ? ORDER BY rowid",
			)
			.all(sessionId) as unknown as {
			session_id: string;
			fork_run_id: string;
			fork_seq: number;
		}[];
		const reowned = children.map((child) =>
			reown(db, sessionId, child.session_id, {
				run_id: child.fork_run_id,
				seq: child.fork_seq,
			}),
		);
		for (const table of [
			"events",
			"runs",
			"abandoned_positions",
			"checkpoints",
			"blob_refs",
		]) {
			db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
		}
		dropUnreferencedBlobs(db);
		db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
		return { session_id: sessionId, workspace, reowned };
	});
	// 被删的内容还在 WAL 里，截断它；别的连接正在读时截不断，下一次检查点会覆盖
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	return deleted;
}
