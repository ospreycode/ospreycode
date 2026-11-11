import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { digestsIn, putBlob, readBlob, referencedBy } from "../blobs/index.js";
import type { Checkpoint } from "../checkpoints/index.js";
import {
	listCheckpoints,
	listInputs,
	unreferencedRefs,
} from "../checkpoints/index-table.js";
import type { StoredEvent } from "../events/index.js";
import {
	openDatabase,
	removeBackups,
	StorageError,
	writeTransaction,
} from "../storage/database.js";
import { type DeletedSession, deleteSession } from "../storage/delete.js";
import { exportLines, type Redactor } from "../storage/export.js";
import { indexEvent, redactionRecord } from "../storage/indexing.js";
import {
	type EventRow,
	eventColumns,
	ownEvents,
	rebuildIndexes,
	toEvent,
} from "../storage/rebuild.js";
import type {
	ForkOrigin,
	InputRange,
	Position,
	RunRecord,
	SessionMetadata,
} from "../tree/index.js";
import {
	abandonedPositions,
	currentPosition,
	forkOrigin,
	inTree,
	lineage,
	onSegments,
	ownRuns,
	pathSegments,
	segmentRows,
} from "../tree/paths.js";

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

/** 按事件脱敏时一个事件的新内容。 */
export interface EventReplacement extends Position {
	/** 顶替原内容的占位内容，格式由定义这类事件的包决定。 */
	data: unknown;
}

/** 按事件脱敏会波及的范围。 */
export interface RedactionScope {
	/** 这些事件引用的大内容。 */
	blobs: string[];
	/** 也引用了这些大内容的其他 session（如分叉）。 */
	sessions: string[];
}

interface SessionRow {
	session_id: string;
	workspace: string;
	created_at: string;
	last_written_at: string;
	title: string | null;
	parent_session_id: string | null;
	fork_run_id: string | null;
	fork_seq: number | null;
}

const sessionColumns =
	"session_id, workspace, created_at, last_written_at, title, parent_session_id, fork_run_id, fork_seq";

function toMetadata(row: SessionRow): SessionMetadata {
	return {
		session_id: row.session_id,
		workspace: row.workspace,
		created_at: row.created_at,
		last_written_at: row.last_written_at,
		title: row.title,
		...(row.parent_session_id === null
			? {}
			: {
					fork: {
						parent_session_id: row.parent_session_id,
						position: {
							run_id: row.fork_run_id as string,
							seq: row.fork_seq as number,
						},
					},
				}),
	};
}

/** 找一个事件：这个 session 自己的，或者分叉沿用的那段路径上的。 */
function eventData(
	db: DatabaseSync,
	sessionId: string,
	position: Position,
): { session_id: string; data: string } {
	const sessions = lineage(db, sessionId);
	const values: SQLInputValue[] = [position.run_id, position.seq, ...sessions];
	const row = db
		.prepare(
			`SELECT session_id, data FROM events WHERE run_id = ? AND seq = ? AND session_id IN (${sessions.map(() => "?").join(", ")})`,
		)
		.get(...values) as { session_id: string; data: string } | undefined;
	if (
		row === undefined ||
		(row.session_id !== sessionId && !inTree(db, sessionId, position))
	) {
		throw new StorageError(
			`session ${sessionId} 里没有事件 ${position.run_id}:${position.seq}`,
		);
	}
	return row;
}

/**
 * 一个项目的 session 记录（每个项目一个 SQLite 文件）。读取不需要写锁；写入经 `SessionWriter`，
 * 它持有这个 session 的写锁。存储文件只对当前用户可读写。
 */
export class SessionStore {
	#db: DatabaseSync;
	#path: string;

	private constructor(db: DatabaseSync, path: string) {
		this.#db = db;
		this.#path = path;
	}

	/**
	 * 打开或创建一个项目的记录库，位置由调用方给出。格式版本比程序旧时先备份再迁移，
	 * 比程序新时抛出 `StorageError`。
	 */
	static open(path: string): SessionStore {
		return new SessionStore(openDatabase(path), path);
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

	/**
	 * 从 `origin` 分叉出一个新的 session：只记下父 session 和截止的位置，不复制事件；当前位置就是分叉的位置，
	 * 标题沿用父 session 的，路径上的事件引用的大内容记上分叉自己的引用。检查点索引由调用方接着用
	 * `checkpoints.inherited` 事件写入。
	 */
	async fork(
		session: NewSession,
		origin: ForkOrigin,
		lock: SessionLocker,
	): Promise<SessionWriter> {
		const held = await lock(session.session_id);
		try {
			writeTransaction(this.#db, () => {
				const parent = origin.parent_session_id;
				if (!inTree(this.#db, parent, origin.position)) {
					throw new StorageError(
						`位置 ${origin.position.run_id}:${origin.position.seq} 不在 session ${parent} 的会话树里`,
					);
				}
				this.#db
					.prepare(
						"INSERT INTO sessions (session_id, workspace, created_at, last_written_at, title, current_run_id, current_seq, parent_session_id, fork_run_id, fork_seq) SELECT ?, ?, ?, ?, title, ?, ?, ?, ?, ? FROM sessions WHERE session_id = ?",
					)
					.run(
						session.session_id,
						session.workspace,
						session.created_at,
						session.created_at,
						origin.position.run_id,
						origin.position.seq,
						parent,
						origin.position.run_id,
						origin.position.seq,
						parent,
					);
				const sessions = lineage(this.#db, parent);
				const digests = new Set<string>();
				for (const segment of pathSegments(this.#db, parent, origin.position)) {
					for (const row of segmentRows<{ data: string }>(
						this.#db,
						sessions,
						segment,
						"data",
					)) {
						for (const digest of digestsIn(row.data)) digests.add(digest);
					}
				}
				const refer = this.#db.prepare(
					"INSERT OR IGNORE INTO blob_refs (sha256, session_id) VALUES (?, ?)",
				);
				for (const digest of referencedBy(this.#db, sessions, digests)) {
					refer.run(digest, session.session_id);
				}
			});
		} catch (error) {
			held.release();
			throw error;
		}
		return new SessionWriter(this.#db, session.session_id, held);
	}

	/** 取得一个已有 session 的写锁，返回接着写的 `SessionWriter`；恢复 session 时用。 */
	async resume(sessionId: string, lock: SessionLocker): Promise<SessionWriter> {
		this.session(sessionId);
		return new SessionWriter(this.#db, sessionId, await lock(sessionId));
	}

	/** 全部 session 的元数据，最近写过的在前。 */
	sessions(): SessionMetadata[] {
		return (
			this.#db
				.prepare(
					`SELECT ${sessionColumns} FROM sessions ORDER BY last_written_at DESC`,
				)
				.all() as unknown as SessionRow[]
		).map(toMetadata);
	}

	/** 一个 session 的元数据；没有这个 session 时抛出 `StorageError`。 */
	session(sessionId: string): SessionMetadata {
		const row = this.#db
			.prepare(`SELECT ${sessionColumns} FROM sessions WHERE session_id = ?`)
			.get(sessionId) as SessionRow | undefined;
		if (row === undefined) {
			throw new StorageError(`没有这个 session：${sessionId}`);
		}
		return toMetadata(row);
	}

	/** 从这个 session 分出去的全部分叉（包括分叉的分叉），按创建的先后。 */
	forks(sessionId: string): string[] {
		this.session(sessionId);
		return (
			this.#db
				.prepare(
					"WITH RECURSIVE descendants (session_id) AS (SELECT session_id FROM sessions WHERE parent_session_id = ? UNION SELECT s.session_id FROM sessions s JOIN descendants d ON s.parent_session_id = d.session_id) SELECT s.session_id FROM sessions s JOIN descendants USING (session_id) ORDER BY s.rowid",
				)
				.all(sessionId) as unknown as { session_id: string }[]
		).map((row) => row.session_id);
	}

	/**
	 * 自己的事件内容里出现过 `text` 的 session，按创建的先后。在事件内容的 JSON 文本里逐字匹配，
	 * 不解析：调用方用它在整个项目里找带着某个编号的事件，再只读这些 session。`text` 为空，或者
	 * 含有在 JSON 字符串里要转义的字符（匹配不上）时抛出 `StorageError`。
	 */
	sessionsMentioning(text: string): string[] {
		if (text === "" || JSON.stringify(text) !== `"${text}"`) {
			throw new StorageError("要找的文字为空，或者含有在 JSON 里要转义的字符");
		}
		return (
			this.#db
				.prepare(
					"SELECT s.session_id FROM sessions s WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id AND instr(e.data, ?) > 0) ORDER BY s.rowid",
				)
				.all(text) as unknown as { session_id: string }[]
		).map((row) => row.session_id);
	}

	/** 一个 session 自己的全部事件，按写入的顺序；分叉沿用的父 session 事件不在里面，按路径读取。 */
	events(sessionId: string): StoredEvent[] {
		return ownEvents(this.#db, sessionId);
	}

	/** 这个 session 自己在会话树上的全部 run，按开始的顺序。 */
	runs(sessionId: string): RunRecord[] {
		return ownRuns(this.#db, sessionId);
	}

	/**
	 * session 的当前位置：会话树路径上最后一个事件；还没有事件、或回退到第一次输入之前时为空。
	 * 分叉还没有自己的事件时是分叉的位置。
	 */
	position(sessionId: string): Position | null {
		return currentPosition(this.#db, sessionId);
	}

	/** 回退时被放弃的位置，按放弃的先后；可以用 `position.moved` 事件再移回去。 */
	abandoned(sessionId: string): Position[] {
		return abandonedPositions(this.#db, sessionId);
	}

	/**
	 * 从会话树的根到 `until` 这条路径上的事件：沿着每个 run 的 `base` 往回找，每个 run 只取到接续点为止。
	 * 恢复、重启和回退后发给模型的历史都按它重建。分叉的路径包括父 session 里分叉位置之前的那一段。
	 */
	pathEvents(sessionId: string, until: Position): StoredEvent[] {
		const sessions = lineage(this.#db, sessionId);
		const [, parent] = sessions;
		if (parent !== undefined) {
			const origin = forkOrigin(this.#db, sessionId) as ForkOrigin;
			const own = this.runs(sessionId).some(
				(run) => run.run_id === until.run_id,
			);
			if (
				!own &&
				!onSegments(pathSegments(this.#db, parent, origin.position), until)
			) {
				throw new StorageError(
					`位置 ${until.run_id}:${until.seq} 不在 session ${sessionId} 的会话树里`,
				);
			}
		}
		return pathSegments(this.#db, sessionId, until).flatMap((segment) =>
			segmentRows<EventRow>(this.#db, sessions, segment, eventColumns).map(
				toEvent,
			),
		);
	}

	/** 一个 session 的全部检查点，按建立的先后；分叉沿用的也在里面。 */
	checkpoints(sessionId: string): Checkpoint[] {
		return listCheckpoints(this.#db, sessionId);
	}

	/** 每次用户输入（task 的输入和 steering）在它所在的 run 里的序号范围，按输入的先后。 */
	inputs(sessionId: string): InputRange[] {
		this.session(sessionId);
		return listInputs(this.#db, sessionId);
	}

	/**
	 * `refs` 里不再被 `workspace` 这个工作区的任何 session 引用的检查点引用名（检查点的快照已清理，
	 * 或 session 已删除）。调用方列出影子仓库里现有的引用，删掉这里返回的那些。
	 */
	unreferencedSnapshots(workspace: string, refs: readonly string[]): string[] {
		return unreferencedRefs(this.#db, workspace, refs);
	}

	/** 按引用读取大内容；只能读这个 session 引用过的。 */
	blob(sessionId: string, digest: string): Uint8Array {
		const data = readBlob(this.#db, sessionId, digest);
		if (data === undefined) {
			throw new StorageError(`session ${sessionId} 没有引用大内容 ${digest}`);
		}
		return data;
	}

	/** 对这些事件按事件脱敏会覆盖哪些大内容，又有哪些别的 session 也引用了它们。 */
	redactionScope(
		sessionId: string,
		events: readonly Position[],
	): RedactionScope {
		const digests = new Set<string>();
		for (const position of events) {
			const { data } = eventData(this.#db, sessionId, position);
			for (const digest of digestsIn(data)) digests.add(digest);
		}
		const blobs = referencedBy(this.#db, [sessionId], digests);
		const others = this.#db.prepare(
			"SELECT session_id FROM blob_refs WHERE sha256 = ? AND session_id != ?",
		);
		const sessions = new Set(
			blobs.flatMap((digest) =>
				(
					others.all(digest, sessionId) as unknown as { session_id: string }[]
				).map((row) => row.session_id),
			),
		);
		return { blobs, sessions: [...sessions] };
	}

	/**
	 * 一个 session 的导出内容，每项是 JSONL 的一行：第一行是元数据和存储格式版本，之后每行一个事件，
	 * 分叉先导出它沿用的父 session 前缀。大内容以 base64 内嵌在第一次引用它的事件那一行的 `blobs` 里。
	 * `redact` 作用在事件内容的每个字符串和能按 UTF-8 解码的大内容上，把密钥这类内容换成占位。
	 */
	export(sessionId: string, redact: Redactor): Generator<string> {
		const metadata = this.session(sessionId);
		const inherited =
			metadata.fork === undefined
				? []
				: this.pathEvents(
						metadata.fork.parent_session_id,
						metadata.fork.position,
					);
		return exportLines(
			this.#db,
			metadata,
			[...inherited, ...this.events(sessionId)],
			redact,
		);
	}

	/**
	 * 彻底删除一个 session：事件、索引、只被它引用的大内容和迁移失败时留下的备份。删除前取得它的写锁
	 * （有 Host 正打开它时抛出错误）。直接从它分出去的分叉仍引用的事件先改记到分叉名下，结果里列出改记了哪些。
	 */
	async delete(
		sessionId: string,
		lock: SessionLocker,
	): Promise<DeletedSession> {
		this.session(sessionId);
		const held = await lock(sessionId);
		try {
			const deleted = deleteSession(this.#db, sessionId);
			removeBackups(this.#path);
			return deleted;
		} finally {
			held.release();
		}
	}

	/**
	 * 从事件表重建会话树和检查点索引。调用方要保证这时没有别的写入者：重建在一个事务里，
	 * 等不到锁的写入会失败。
	 */
	rebuild(): void {
		rebuildIndexes(this.#db);
	}

	close(): void {
		this.#db.close();
	}
}

/** 一个 session 的写入者：持有它的写锁，只追加（唯一的例外是按事件脱敏）。 */
export class SessionWriter {
	readonly sessionId: string;
	#db: DatabaseSync;
	#lock: SessionLock;

	/** 由 `SessionStore` 的 `create`、`fork` 和 `resume` 创建。 */
	constructor(db: DatabaseSync, sessionId: string, lock: SessionLock) {
		this.#db = db;
		this.sessionId = sessionId;
		this.#lock = lock;
	}

	#insert(event: StoredEvent): void {
		if (event.session_id !== this.sessionId) {
			throw new StorageError(
				`写入者属于 session ${this.sessionId}，事件属于 ${event.session_id}`,
			);
		}
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
				`INSERT INTO events (session_id, run_id, seq, event_id, time, source, task_id, agent_id, type, version, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...values);
		indexEvent(this.#db, event);
		this.#db
			.prepare("UPDATE sessions SET last_written_at = ? WHERE session_id = ?")
			.run(event.time, this.sessionId);
	}

	/**
	 * 追加一个事件，在一个事务里提交。本包定义的事件（`run.started`、`position.moved`、检查点的几种事件）
	 * 同时更新会话树和检查点索引；属于 task 的事件把当前位置移到它。
	 * 同一个 run 里重复的 `event_id` 或序号抛出错误。
	 */
	append(event: StoredEvent): void {
		writeTransaction(this.#db, () => this.#insert(event));
	}

	/**
	 * 按 SHA-256 保存一份大内容（只存一份，记下这个 session 引用了它），返回十六进制的摘要。
	 * 这个摘要的内容被按事件脱敏覆盖过时，换回这次给出的字节。
	 */
	putBlob(data: Uint8Array): string {
		return writeTransaction(this.#db, () =>
			putBlob(this.#db, this.sessionId, data),
		);
	}

	/** 记下标题（第一条用户输入的第一行）；已经有标题时不改。 */
	setTitle(title: string): void {
		this.#db
			.prepare(
				"UPDATE sessions SET title = ? WHERE session_id = ? AND title IS NULL",
			)
			.run(title, this.sessionId);
	}

	/**
	 * 按事件脱敏：在一个事务里用 `replacements` 里的占位内容覆盖这些事件的内容，用 `placeholder`
	 * 覆盖它们引用的大内容，并追加 `record`（`event.redacted` 事件，`data` 列出同样的这些事件）。
	 * 事件要是这个 session 自己的，或者分叉沿用的那段路径上的。返回被覆盖的大内容的摘要；
	 * 它们还被别的 session 引用时那些 session 读到的也是占位内容，调用前用 `redactionScope` 查清楚。
	 * 给了 `title` 时在同一个事务里把这个 session 的标题换成它：标题取自用户输入的第一行，
	 * 那条输入被覆盖时标题里还留着原文。
	 */
	redact(
		record: StoredEvent,
		replacements: readonly EventReplacement[],
		placeholder: Uint8Array,
		title?: string,
	): string[] {
		const listed = redactionRecord(record).events;
		if (
			listed.length !== replacements.length ||
			listed.some(
				(position, index) =>
					position.run_id !== replacements[index]?.run_id ||
					position.seq !== replacements[index]?.seq,
			)
		) {
			throw new StorageError("脱敏事件列出的事件和要覆盖的事件不一致");
		}
		const overwritten = writeTransaction(this.#db, () => {
			const digests = new Set<string>();
			for (const replacement of replacements) {
				const found = eventData(this.#db, this.sessionId, replacement);
				for (const digest of digestsIn(found.data)) digests.add(digest);
				this.#db
					.prepare(
						"UPDATE events SET data = ? WHERE session_id = ? AND run_id = ? AND seq = ?",
					)
					.run(
						JSON.stringify(replacement.data),
						found.session_id,
						replacement.run_id,
						replacement.seq,
					);
			}
			const blobs = referencedBy(this.#db, [this.sessionId], digests);
			for (const digest of blobs) {
				this.#db
					.prepare("UPDATE blobs SET data = ? WHERE sha256 = ?")
					.run(placeholder, digest);
			}
			if (title !== undefined) {
				this.#db
					.prepare("UPDATE sessions SET title = ? WHERE session_id = ?")
					.run(title, this.sessionId);
			}
			this.#insert(record);
			return blobs;
		});
		// 原来的内容还在 WAL 里，截断它
		this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		return overwritten;
	}

	/** 释放写锁。 */
	close(): void {
		this.#lock.release();
	}
}
