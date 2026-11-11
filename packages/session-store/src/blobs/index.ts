import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** 大内容的键：字节的 SHA-256，十六进制。 */
export function digestOf(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

const digestPattern = /[0-9a-f]{64}/g;

/**
 * 事件内容里出现的、像摘要的字符串。本包不理解事件的内容，事件引用了哪些大内容只能这样找；
 * 摘要是内容的哈希，碰巧相同的字符串只会多算一份引用。
 */
export function digestsIn(data: string): Set<string> {
	return new Set(data.match(digestPattern));
}

/**
 * 保存一份大内容并记下 `sessionId` 引用了它。同一个键已经有内容而字节不同时（按事件脱敏覆盖过）换成新的：
 * 那是用户重新给出的内容。
 */
export function putBlob(
	db: DatabaseSync,
	sessionId: string,
	data: Uint8Array,
): string {
	const digest = digestOf(data);
	db.prepare(
		"INSERT INTO blobs (sha256, data) VALUES (?, ?) ON CONFLICT (sha256) DO UPDATE SET data = excluded.data WHERE data != excluded.data",
	).run(digest, data);
	db.prepare(
		"INSERT OR IGNORE INTO blob_refs (sha256, session_id) VALUES (?, ?)",
	).run(digest, sessionId);
	return digest;
}

/** `digests` 里 `sessions` 中某一个引用过的那些。 */
export function referencedBy(
	db: DatabaseSync,
	sessions: readonly string[],
	digests: Iterable<string>,
): string[] {
	const select = db.prepare(
		`SELECT 1 FROM blob_refs WHERE sha256 = ? AND session_id IN (${sessions.map(() => "?").join(", ")}) LIMIT 1`,
	);
	return [...digests].filter((digest) => {
		const values: SQLInputValue[] = [digest, ...sessions];
		return select.get(...values) !== undefined;
	});
}

/** 读一份大内容；`sessionId` 没有引用过它时为空。 */
export function readBlob(
	db: DatabaseSync,
	sessionId: string,
	digest: string,
): Uint8Array | undefined {
	const row = db
		.prepare(
			"SELECT data FROM blobs JOIN blob_refs USING (sha256) WHERE sha256 = ? AND session_id = ?",
		)
		.get(digest, sessionId) as { data: Uint8Array } | undefined;
	return row?.data;
}

/** 删掉不再被任何 session 引用的大内容。 */
export function dropUnreferencedBlobs(db: DatabaseSync): void {
	db.exec(
		"DELETE FROM blobs WHERE sha256 NOT IN (SELECT sha256 FROM blob_refs)",
	);
}
