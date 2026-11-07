import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type StoredEvent, storageVersion } from "../events/index.js";
import {
	openDatabase,
	StorageError,
	writeTransaction,
} from "../storage/database.js";
import {
	type Position,
	type RunRecord,
	runStartedType,
	type SessionMetadata,
} from "../tree/index.js";

/** 一个 session 的跨进程写锁。 */
export interface SessionLock {
	release(): void;
}

/**
 * 取得一个 session 的跨进程写锁；已被别的进程持有时抛出错误。同一个 session 同时只有一个写入者，
 * 锁的实现由调用方提供（Host 用 pid 文件）。
 */
export type SessionLocker = (sessionId: string) => Promise<SessionLock>;

/** 新建 session 时记下的元数据。 */
export interface NewSession {
	session_id: string;
	/** 工作区的真实路径，只能在同一路径恢复。 */
	workspace: string;
	/** ISO 8601 格式的 UTC 时间。 */
	created_at: string;
}

interface EventRow {
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

function toEvent(row: EventRow): StoredEvent {
	return { ...row, data: JSON.parse(row.data) as unknown };
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function checkRunRecord(event: StoredEvent): RunRecord {
	const record = event.data as RunRecord;
	if (
		event.version !== storageVersion ||
		record.run_id !== event.run_id ||
		record.task_id !== event.task_id ||
		record.agent_id !== event.agent_id
	) {
		throw new StorageError(
			`${runStartedType} 事件的 data 要是这个 run 的 RunRecord（版本 ${storageVersion}）`,
		);
	}
	return record;
}

/**
 * 一个项目的 session 记录（每个项目一个 SQLite 文件）。读取不需要写锁；写入经 `SessionWriter`，
 * 它持有这个 session 的写锁。存储文件只对当前用户可读写。
 */
export class SessionStore {
	#db: DatabaseSync;

	private constructor(db: DatabaseSync) {
		this.#db = db;
	}

	/** 打开或创建一个项目的记录库，位置由调用方给出。格式版本比程序新时抛出 `StorageError`。 */
	static open(path: string): SessionStore {
		return new SessionStore(openDatabase(path));
	}

	/** 新建一个 session，取得它的写锁，返回写入用的 `SessionWriter`。 */
	async create(
		session: NewSession,
		lock: SessionLocker,
	): Promise<SessionWriter> {
		const held = await lock(session.session_id);
		try {
			this.#db
				.prepare(
					"INSERT INTO sessions (session_id, workspace, created_at, last_written_at) VALUES (?, ?, ?, ?)",
				)
				.run(
					session.session_id,
					session.workspace,
					session.created_at,
					session.created_at,
				);
		} catch (error) {
			held.release();
			throw error;
		}
		return new SessionWriter(this.#db, session.session_id, held);
	}

	/** 全部 session 的元数据，最近写过的在前。 */
	sessions(): SessionMetadata[] {
		const rows = this.#db
			.prepare(
				"SELECT session_id, workspace, created_at, last_written_at, title FROM sessions ORDER BY last_written_at DESC",
			)
			.all() as unknown as SessionMetadata[];
		return rows.map((row) => ({ ...row }));
	}

	/** 一个 session 的全部事件，按写入的顺序。 */
	events(sessionId: string): StoredEvent[] {
		return (
			this.#db
				.prepare(
					"SELECT event_id, session_id, run_id, seq, time, source, task_id, agent_id, type, version, data FROM events WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as unknown as EventRow[]
		).map(toEvent);
	}

	/** 会话树上的全部 run，按开始的顺序。 */
	runs(sessionId: string): RunRecord[] {
		return (
			this.#db
				.prepare(
					"SELECT run_id, task_id, agent_id, parent_agent_id, parent_tool_call_id, base_run_id, base_seq FROM runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as unknown as {
				run_id: string;
				task_id: string | null;
				agent_id: string | null;
				parent_agent_id: string | null;
				parent_tool_call_id: string | null;
				base_run_id: string | null;
				base_seq: number | null;
			}[]
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

	/** session 的当前位置：会话树路径上最后一个事件；还没有事件时为空。 */
	position(sessionId: string): Position | null {
		const row = this.#db
			.prepare(
				"SELECT current_run_id, current_seq FROM sessions WHERE session_id = ?",
			)
			.get(sessionId) as
			| { current_run_id: string | null; current_seq: number | null }
			| undefined;
		if (row === undefined)
			throw new StorageError(`没有这个 session：${sessionId}`);
		return row.current_run_id === null
			? null
			: { run_id: row.current_run_id, seq: row.current_seq as number };
	}

	/**
	 * 从会话树的根到 `until` 这条路径上的事件：沿着每个 run 的 `base` 往回找，每个 run 只取到接续点为止。
	 * 恢复、重启和回退后发给模型的历史都按它重建。
	 */
	pathEvents(sessionId: string, until: Position): StoredEvent[] {
		const runs = new Map(this.runs(sessionId).map((run) => [run.run_id, run]));
		const segments: Position[] = [];
		for (let at: Position | null = until; at !== null; ) {
			const run = runs.get(at.run_id);
			if (run === undefined) {
				throw new StorageError(`会话树里没有 run ${at.run_id}`);
			}
			segments.unshift(at);
			at = run.base;
		}
		const select = this.#db.prepare(
			"SELECT event_id, session_id, run_id, seq, time, source, task_id, agent_id, type, version, data FROM events WHERE session_id = ? AND run_id = ? AND seq <= ? ORDER BY seq",
		);
		return segments.flatMap((segment) =>
			(
				select.all(
					sessionId,
					segment.run_id,
					segment.seq,
				) as unknown as EventRow[]
			).map(toEvent),
		);
	}

	/** 按引用读取大内容；只能读这个 session 引用过的。 */
	blob(sessionId: string, digest: string): Uint8Array {
		const row = this.#db
			.prepare(
				"SELECT data FROM blobs JOIN blob_refs USING (sha256) WHERE sha256 = ? AND session_id = ?",
			)
			.get(digest, sessionId) as { data: Uint8Array } | undefined;
		if (row === undefined) {
			throw new StorageError(`session ${sessionId} 没有引用大内容 ${digest}`);
		}
		return row.data;
	}

	close(): void {
		this.#db.close();
	}
}

/** 一个 session 的写入者：持有它的写锁，只追加。 */
export class SessionWriter {
	readonly sessionId: string;
	#db: DatabaseSync;
	#lock: SessionLock;

	/** 由 `SessionStore.create` 创建。 */
	constructor(db: DatabaseSync, sessionId: string, lock: SessionLock) {
		this.#db = db;
		this.sessionId = sessionId;
		this.#lock = lock;
	}

	/**
	 * 追加一个事件，在一个事务里提交。`run.started` 同时记进会话树；属于 task 的事件把当前位置移到它。
	 * 同一个 run 里重复的 `event_id` 或序号抛出错误。
	 */
	append(event: StoredEvent): void {
		if (event.session_id !== this.sessionId) {
			throw new StorageError(
				`写入者属于 session ${this.sessionId}，事件属于 ${event.session_id}`,
			);
		}
		const record =
			event.type === runStartedType ? checkRunRecord(event) : undefined;
		writeTransaction(this.#db, () => {
			const values: SQLInputValue[] = [
				event.session_id,
				event.run_id,
				event.seq,
				event.event_id,
				event.time,
				event.source,
				event.task_id,
				event.agent_id,
				event.type,
				event.version,
				JSON.stringify(event.data),
			];
			this.#db
				.prepare(
					"INSERT INTO events (session_id, run_id, seq, event_id, time, source, task_id, agent_id, type, version, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(...values);
			if (record !== undefined) {
				this.#db
					.prepare(
						"INSERT INTO runs (session_id, run_id, task_id, agent_id, parent_agent_id, parent_tool_call_id, base_run_id, base_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						this.sessionId,
						record.run_id,
						record.task_id,
						record.agent_id,
						record.parent_agent_id ?? null,
						record.parent_tool_call_id ?? null,
						record.base?.run_id ?? null,
						record.base?.seq ?? null,
					);
			}
			this.#db
				.prepare(
					event.task_id === null
						? "UPDATE sessions SET last_written_at = ? WHERE session_id = ?"
						: "UPDATE sessions SET last_written_at = ?, current_run_id = ?, current_seq = ? WHERE session_id = ?",
				)
				.run(
					...(event.task_id === null
						? [event.time, this.sessionId]
						: [event.time, event.run_id, event.seq, this.sessionId]),
				);
		});
	}

	/** 按 SHA-256 保存一份大内容（只存一份，记下这个 session 引用了它），返回十六进制的摘要。 */
	putBlob(data: Uint8Array): string {
		const digest = sha256(data);
		writeTransaction(this.#db, () => {
			this.#db
				.prepare("INSERT OR IGNORE INTO blobs (sha256, data) VALUES (?, ?)")
				.run(digest, data);
			this.#db
				.prepare(
					"INSERT OR IGNORE INTO blob_refs (sha256, session_id) VALUES (?, ?)",
				)
				.run(digest, this.sessionId);
		});
		return digest;
	}

	/** 记下标题（第一条用户输入的第一行）；已经有标题时不改。 */
	setTitle(title: string): void {
		this.#db
			.prepare(
				"UPDATE sessions SET title = ? WHERE session_id = ? AND title IS NULL",
			)
			.run(title, this.sessionId);
	}

	/** 释放写锁。 */
	close(): void {
		this.#lock.release();
	}
}
