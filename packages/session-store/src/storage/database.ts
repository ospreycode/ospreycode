import { chmodSync, closeSync, openSync, rmSync } from "node:fs";
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
	current_seq INTEGER,
	parent_session_id TEXT,
	fork_run_id TEXT,
	fork_seq INTEGER
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
${treeAndCheckpointTables()}`;

function treeAndCheckpointTables(): string {
	return `
CREATE TABLE abandoned_positions (
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	PRIMARY KEY (session_id, run_id, seq)
) STRICT;

CREATE TABLE checkpoints (
	session_id TEXT NOT NULL REFERENCES sessions (session_id),
	input_event_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('task', 'steering')),
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	before_run_id TEXT,
	before_seq INTEGER,
	cleaned INTEGER NOT NULL DEFAULT 0,
	snapshots TEXT NOT NULL DEFAULT '[]',
	PRIMARY KEY (session_id, input_event_id)
) STRICT;
`;
}

/** 按顺序执行的迁移：下标 N 的一项把第 N+1 版的库改成第 N+2 版。 */
const migrations: readonly string[] = [
	`
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN fork_run_id TEXT;
ALTER TABLE sessions ADD COLUMN fork_seq INTEGER;
${treeAndCheckpointTables()}`,
];

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

/** 迁移前的备份放在库的旁边，文件名带旧的格式版本。 */
function backupPath(path: string, version: number): string {
	return `${path}.v${version}.bak`;
}

/** 删掉迁移失败时留下的备份：它们是迁移之前的整个库，彻底删除要把它们算进去。 */
export function removeBackups(path: string): void {
	for (let version = 1; version < storageVersion; version++) {
		rmSync(backupPath(path, version), { force: true });
	}
}

function migrate(db: DatabaseSync, path: string, from: number): void {
	const backup = backupPath(path, from);
	// 备份和库一样只对当前用户可读写；VACUUM INTO 要求目标不存在或是空文件
	closeSync(openSync(backup, "w", 0o600));
	db.prepare("VACUUM INTO ?").run(backup);
	writeTransaction(db, () => {
		// 另一个 Host 可能刚迁移完，以事务里读到的版本为准
		for (let version = userVersion(db); version < storageVersion; version++) {
			db.exec(migrations[version - 1] as string);
		}
		db.exec(`PRAGMA user_version = ${storageVersion}`);
	});
	removeBackups(path);
}

/**
 * 打开一个项目的 session 记录库，不存在时以 0600 创建：WAL、busy timeout 5 秒、`synchronous=FULL`、
 * `secure_delete=ON`。格式版本记在 `PRAGMA user_version`：比程序旧时先在同一目录备份再迁移，
 * 成功后删除备份；比程序新时报错、不打开。
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
		const version = writeTransaction(db, () => {
			const found = userVersion(db);
			if (found === 0) {
				db.exec(schema);
				db.exec(`PRAGMA user_version = ${storageVersion}`);
				return storageVersion;
			}
			return found;
		});
		if (version > storageVersion) {
			throw new StorageError(
				`${path} 的存储格式版本是 ${version}，这个版本的程序只认识 ${storageVersion}`,
			);
		}
		if (version < storageVersion) migrate(db, path, version);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
