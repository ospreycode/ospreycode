import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { storageVersion } from "../events/index.js";

/** 存储格式和程序不匹配，或者数据库文件不能按要求打开。 */
export class StorageError extends Error {
	override name = "StorageError";
}

const schema = `
CREATE TABLE sessions (
	session_id TEXT PRIMARY KEY,
	workspace TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_written_at TEXT NOT NULL,
	title TEXT,
	current_run_id TEXT,
	current_seq INTEGER
) STRICT;

CREATE TABLE events (
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	event_id TEXT NOT NULL,
	time TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('host', 'runtime')),
	task_id TEXT,
	agent_id TEXT,
	type TEXT NOT NULL,
	version INTEGER NOT NULL,
	data TEXT NOT NULL,
	PRIMARY KEY (session_id, run_id, seq),
	UNIQUE (session_id, run_id, event_id)
) STRICT;

CREATE TABLE runs (
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	run_id TEXT NOT NULL,
	task_id TEXT,
	agent_id TEXT,
	parent_agent_id TEXT,
	parent_tool_call_id TEXT,
	base_run_id TEXT,
	base_seq INTEGER,
	PRIMARY KEY (session_id, run_id)
) STRICT;

CREATE TABLE blobs (
	sha256 TEXT PRIMARY KEY,
	data BLOB NOT NULL
) STRICT;

CREATE TABLE blob_refs (
	sha256 TEXT NOT NULL REFERENCES blobs (sha256),
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	PRIMARY KEY (sha256, session_id)
) STRICT;
`;

/** 在一个写事务里执行：写事务一律 `BEGIN IMMEDIATE`，等锁时阻塞，所以事务要短。 */
export function writeTransaction<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = run();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function userVersion(db: DatabaseSync): number {
	return (db.prepare("PRAGMA user_version").get() as { user_version: number })
		.user_version;
}

/**
 * 打开一个项目的 session 记录库，不存在时以 0600 创建：WAL、busy timeout 5 秒、`synchronous=FULL`、
 * `secure_delete=ON`。格式版本记在 `PRAGMA user_version`，比程序新时报错、不打开。
 */
export function openDatabase(path: string): DatabaseSync {
	// SQLite 按数据库文件的权限创建 -wal 和 -shm，先建好只对当前用户可读写的空文件
	closeSync(openSync(path, "a", 0o600));
	chmodSync(path, 0o600);
	const db = new DatabaseSync(path, {
		timeout: 5000,
		enableForeignKeyConstraints: true,
	});
	try {
		const { journal_mode } = db.prepare("PRAGMA journal_mode = WAL").get() as {
			journal_mode: string;
		};
		if (journal_mode !== "wal") {
			throw new StorageError(`${path} 用不了 WAL（${journal_mode}）`);
		}
		db.exec("PRAGMA synchronous = FULL");
		db.exec("PRAGMA secure_delete = ON");
		writeTransaction(db, () => {
			const version = userVersion(db);
			if (version === 0) {
				db.exec(schema);
				db.exec(`PRAGMA user_version = ${storageVersion}`);
			} else if (version !== storageVersion) {
				throw new StorageError(
					`${path} 的存储格式版本是 ${version}，这个版本的程序只认识 ${storageVersion}`,
				);
			}
		});
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
