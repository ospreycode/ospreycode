import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** 记忆库的存储格式版本，记在 `PRAGMA user_version`。 */
export const memoryStorageVersion = 1;

/** 存储格式和程序不匹配，数据库文件不能按要求打开，或者读回的内容不是本包写的格式。 */
export class MemoryStorageError extends Error {
	override name = "MemoryStorageError";
}

// memories 里是每条记忆现在的内容；versions 留着每个内容版本的全文，包括现在的这一版。
// extractions 记后台提取的认领和"已提取"标记，只在 project 范围的库里用。
const schema = `
CREATE TABLE memories (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'retired', 'expired')),
	version INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'lesson')),
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	origin TEXT NOT NULL CHECK (origin IN ('user', 'untrusted')),
	sources TEXT NOT NULL,
	target_id TEXT,
	target_action TEXT CHECK (target_action IN ('correct', 'expire')),
	target_version INTEGER,
	created_at TEXT NOT NULL,
	confirmed_at TEXT,
	last_used_at TEXT
) STRICT;

CREATE TABLE versions (
	memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	origin TEXT NOT NULL,
	sources TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (memory_id, version)
) STRICT;

CREATE TABLE extractions (
	session_id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('claimed', 'done')),
	owner TEXT NOT NULL,
	claimed_at TEXT NOT NULL
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
 * 打开一个范围的记忆库，不存在时以 0600 创建：WAL、busy timeout 5 秒、`synchronous=FULL`、
 * `secure_delete=ON`。格式版本记在 `PRAGMA user_version`，和程序不一样时报错、不打开。
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
			throw new MemoryStorageError(`${path} 用不了 WAL（${journal_mode}）`);
		}
		db.exec("PRAGMA synchronous = FULL");
		db.exec("PRAGMA secure_delete = ON");
		writeTransaction(db, () => {
			const version = userVersion(db);
			if (version === 0) {
				db.exec(schema);
				db.exec(`PRAGMA user_version = ${memoryStorageVersion}`);
			} else if (version !== memoryStorageVersion) {
				throw new MemoryStorageError(
					`${path} 的存储格式版本是 ${version}，这个版本的程序只认识 ${memoryStorageVersion}`,
				);
			}
		});
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
