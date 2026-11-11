import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { prepareContent, type SecretDetector } from "../core/content.js";
import {
	type FileReference,
	MemoryConflictError,
	type MemoryContent,
	type MemoryKind,
	MemoryNotFoundError,
	type MemoryOrigin,
	type MemoryRecord,
	MemoryRejectedError,
	type MemoryScope,
	type MemorySources,
	MemoryStateError,
	type MemoryStatus,
	type MemoryTarget,
	type MemoryVersion,
	type SessionSource,
} from "../core/record.js";
import { searchRecords } from "../long-term/search.js";
import {
	MemoryStorageError,
	openDatabase,
	writeTransaction,
} from "../storage/database.js";
import { exportJsonl, exportMarkdown } from "../storage/export.js";

/** 打开一个范围的记忆库要给出的东西。本包没有默认的存储位置。 */
export interface MemoryStoreOptions {
	/** 这个范围的数据库文件。范围落实在文件上：一个文件里只有一个范围的记忆。 */
	path: string;
	scope: MemoryScope;
	/** 判断文本里有没有疑似密钥的内容；命中的内容不写入。 */
	containsSecret: SecretDetector;
}

/** 要写入的一条记忆和它的来源。 */
export interface NewMemory extends MemoryContent {
	sources: MemorySources;
}

/** 模型提议或后台提取出来的候选。 */
export interface NewCandidate extends NewMemory {
	/** 候选针对一条现有记忆时：纠正它，或者把它标记过期。 */
	target?: MemoryTarget;
}

/** 确认候选或纠正记忆时改掉的内容，没写的保持原样。 */
export type MemoryEdit = Partial<MemoryContent>;

interface MemoryRow {
	id: string;
	status: MemoryStatus;
	version: number;
	kind: MemoryKind;
	title: string;
	body: string;
	origin: MemoryOrigin;
	sources: string;
	target_id: string | null;
	target_action: MemoryTarget["action"] | null;
	target_version: number | null;
	created_at: string;
	confirmed_at: string | null;
	last_used_at: string | null;
}

interface VersionRow {
	memory_id: string;
	version: number;
	kind: MemoryKind;
	title: string;
	body: string;
	origin: MemoryOrigin;
	sources: string;
	created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isFileReference(value: unknown): value is FileReference {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		(value.line === undefined || typeof value.line === "number") &&
		(value.sha256 === undefined || typeof value.sha256 === "string")
	);
}

function isSessionSource(value: unknown): value is SessionSource {
	return (
		isRecord(value) &&
		typeof value.session_id === "string" &&
		isStringArray(value.event_ids) &&
		typeof value.deleted === "boolean"
	);
}

/** 从库里读回的来源：存储文件是信任边界，格式不对就报错。 */
function parseSources(text: string, id: string): MemorySources {
	const value: unknown = JSON.parse(text);
	if (
		!isRecord(value) ||
		!Array.isArray(value.sessions) ||
		!value.sessions.every(isSessionSource) ||
		!Array.isArray(value.files) ||
		!value.files.every(isFileReference) ||
		(value.commit !== undefined && typeof value.commit !== "string")
	) {
		throw new MemoryStorageError(`记忆 ${id} 的来源不是本包写入的格式`);
	}
	return {
		sessions: value.sessions,
		files: value.files,
		...(value.commit === undefined ? {} : { commit: value.commit }),
	};
}

/** 把来源里某个 session 的那一项换掉；`change` 返回空就是去掉这一项。没有这个 session 时返回空。 */
function changeSession(
	sources: MemorySources,
	sessionId: string,
	change: (source: SessionSource) => SessionSource[],
): MemorySources | undefined {
	if (!sources.sessions.some((source) => source.session_id === sessionId)) {
		return undefined;
	}
	return {
		...sources,
		sessions: sources.sessions.flatMap((source) =>
			source.session_id === sessionId ? change(source) : [source],
		),
	};
}

/**
 * 一个范围的记忆库。读、写、改、删都只在这一个数据库文件里，不可能碰到别的范围或别的项目。
 * 改一条现有的记忆要带上读到它时的版本号，库里的版本对不上就抛 `MemoryConflictError`，
 * 不会悄悄覆盖别的进程的改动。
 */
export class MemoryStore {
	readonly scope: MemoryScope;
	#db: DatabaseSync;
	#containsSecret: SecretDetector;

	private constructor(db: DatabaseSync, options: MemoryStoreOptions) {
		this.#db = db;
		this.scope = options.scope;
		this.#containsSecret = options.containsSecret;
	}

	/** 打开一个范围的记忆库，文件不存在时创建（0600）。 */
	static open(options: MemoryStoreOptions): MemoryStore {
		return new MemoryStore(openDatabase(options.path), options);
	}

	/** 关闭数据库连接。 */
	close(): void {
		this.#db.close();
	}

	#record(row: MemoryRow): MemoryRecord {
		return {
			id: row.id,
			scope: this.scope,
			kind: row.kind,
			title: row.title,
			body: row.body,
			status: row.status,
			origin: row.origin,
			sources: parseSources(row.sources, row.id),
			version: row.version,
			created_at: row.created_at,
			...(row.confirmed_at === null ? {} : { confirmed_at: row.confirmed_at }),
			...(row.last_used_at === null ? {} : { last_used_at: row.last_used_at }),
			...(row.target_id === null || row.target_action === null
				? {}
				: { target: { id: row.target_id, action: row.target_action } }),
		};
	}

	#row(id: string): MemoryRow | undefined {
		return this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
			| MemoryRow
			| undefined;
	}

	/** 读出要改的那一行，核对版本号。要在写事务里调用。 */
	#expect(id: string, version: number): MemoryRow {
		const row = this.#row(id);
		if (row === undefined) throw new MemoryNotFoundError(id);
		if (row.version !== version) {
			throw new MemoryConflictError(id, version, row.version);
		}
		return row;
	}

	/** 按版本号更新一行：没有改到就是别的进程先改了。 */
	#update(
		row: MemoryRow,
		changes: Partial<Omit<MemoryRow, "id" | "version">>,
	): void {
		const columns = Object.keys(changes);
		const values = Object.values(changes) as SQLInputValue[];
		const result = this.#db
			.prepare(
				`UPDATE memories SET version = version + 1${columns
					.map((column) => `, ${column} = ?`)
					.join("")} WHERE id = ? AND version = ?`,
			)
			.run(...values, row.id, row.version);
		if (result.changes === 0) {
			const current = this.#row(row.id);
			if (current === undefined) throw new MemoryNotFoundError(row.id);
			throw new MemoryConflictError(row.id, row.version, current.version);
		}
	}

	#insertVersion(
		id: string,
		version: number,
		content: MemoryContent,
		origin: MemoryOrigin,
		sources: string,
		time: string,
	): void {
		this.#db
			.prepare(
				"INSERT INTO versions (memory_id, version, kind, title, body, origin, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				version,
				content.kind,
				content.title,
				content.body,
				origin,
				sources,
				time,
			);
	}

	#newId(): string {
		// 编号要进索引，每条都占上下文，所以用短的：范围的首字母加 8 位十六进制
		for (;;) {
			const id = `${this.scope === "project" ? "p" : "u"}-${randomBytes(4).toString("hex")}`;
			if (this.#row(id) === undefined) return id;
		}
	}

	#insert(
		content: MemoryContent,
		fields: {
			status: MemoryStatus;
			origin: MemoryOrigin;
			sources: MemorySources;
			confirmed: boolean;
			target?: MemoryTarget & { version: number };
		},
	): MemoryRecord {
		const id = this.#newId();
		const time = new Date().toISOString();
		const sources = JSON.stringify(fields.sources);
		this.#db
			.prepare(
				"INSERT INTO memories (id, status, version, kind, title, body, origin, sources, target_id, target_action, target_version, created_at, confirmed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				fields.status,
				content.kind,
				content.title,
				content.body,
				fields.origin,
				sources,
				fields.target?.id ?? null,
				fields.target?.action ?? null,
				fields.target?.version ?? null,
				time,
				fields.confirmed ? time : null,
			);
		this.#insertVersion(id, 1, content, fields.origin, sources, time);
		return this.#get(id);
	}

	#get(id: string): MemoryRecord {
		const row = this.#row(id);
		if (row === undefined) throw new MemoryNotFoundError(id);
		return this.#record(row);
	}

	/**
	 * 用户直接添加一条记忆：马上生效，内容记为来自用户。含疑似密钥、为空或过长时抛
	 * `MemoryRejectedError`。
	 */
	add(memory: NewMemory): MemoryRecord {
		const content = prepareContent(memory, this.#containsSecret);
		return writeTransaction(this.#db, () =>
			this.#insert(content, {
				status: "active",
				origin: "user",
				sources: memory.sources,
				confirmed: true,
			}),
		);
	}

	/**
	 * 记下一条候选：状态是待确认，内容记为来自不可信内容，确认之前不进索引、检索不到。
	 * 库里已经有标题和正文都相同的候选或生效记忆时返回那一条，不重复记。通不过入库检查，
	 * 或者候选针对的记忆不存在时抛 `MemoryRejectedError`。
	 */
	propose(candidate: NewCandidate): MemoryRecord {
		const content = prepareContent(candidate, this.#containsSecret);
		const { target } = candidate;
		return writeTransaction(this.#db, () => {
			const same = this.#db
				.prepare(
					"SELECT * FROM memories WHERE title = ? AND body = ? AND status IN ('pending', 'active') AND target_id IS ? AND target_action IS ?",
				)
				.get(
					content.title,
					content.body,
					target?.id ?? null,
					target?.action ?? null,
				) as MemoryRow | undefined;
			if (same !== undefined) return this.#record(same);
			if (target === undefined) {
				return this.#insert(content, {
					status: "pending",
					origin: "untrusted",
					sources: candidate.sources,
					confirmed: false,
				});
			}
			const targeted = this.#row(target.id);
			if (targeted === undefined || targeted.status === "pending") {
				throw new MemoryRejectedError(
					"target",
					`候选针对的记忆 ${target.id} 不存在`,
				);
			}
			return this.#insert(content, {
				status: "pending",
				origin: "untrusted",
				sources: candidate.sources,
				confirmed: false,
				target: { ...target, version: targeted.version },
			});
		});
	}

	/**
	 * 确认一条候选，返回生效的那条记忆。`edit` 是用户确认时改掉的内容，改过的内容记为来自用户。
	 * 候选针对现有记忆时，改动落在那条记忆上（成为它的新版本，或者把它标记过期），候选本身删除；
	 * 那条记忆在候选提出之后又被改过时抛 `MemoryConflictError`。
	 */
	confirm(id: string, version: number, edit?: MemoryEdit): MemoryRecord {
		return writeTransaction(this.#db, () => {
			const row = this.#expect(id, version);
			if (row.status !== "pending") {
				throw new MemoryStateError(`记忆 ${id} 不是待确认的候选`);
			}
			const edited = edit !== undefined && Object.keys(edit).length > 0;
			const content = edited
				? prepareContent({ ...row, ...edit }, this.#containsSecret)
				: { kind: row.kind, title: row.title, body: row.body };
			const origin = edited ? "user" : row.origin;
			const time = new Date().toISOString();
			if (row.target_id === null) {
				this.#update(row, {
					status: "active",
					...content,
					origin,
					confirmed_at: time,
				});
				if (edited) {
					this.#insertVersion(
						id,
						row.version + 1,
						content,
						origin,
						row.sources,
						time,
					);
				}
				return this.#get(id);
			}
			const target = this.#row(row.target_id);
			if (target === undefined) throw new MemoryNotFoundError(row.target_id);
			if (target.version !== row.target_version) {
				throw new MemoryConflictError(
					target.id,
					row.target_version ?? 0,
					target.version,
				);
			}
			if (row.target_action === "expire") {
				if (target.status !== "active") {
					throw new MemoryStateError(`记忆 ${target.id} 不是生效的记忆`);
				}
				this.#update(target, { status: "expired" });
			} else {
				this.#update(target, {
					status: "active",
					...content,
					origin,
					sources: row.sources,
					confirmed_at: time,
				});
				this.#insertVersion(
					target.id,
					target.version + 1,
					content,
					origin,
					row.sources,
					time,
				);
			}
			this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id);
			return this.#get(target.id);
		});
	}

	/** 拒绝一条候选：候选和它的内容一起删除。 */
	reject(id: string, version: number): void {
		writeTransaction(this.#db, () => {
			const row = this.#expect(id, version);
			if (row.status !== "pending") {
				throw new MemoryStateError(`记忆 ${id} 不是待确认的候选`);
			}
			this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		});
		this.#checkpoint();
	}

	/**
	 * 纠正一条记忆：生成新版本，内容记为来自用户，旧版本保留到彻底删除为止。不再使用和已过期的
	 * 记忆纠正后重新生效。`sources` 是纠正后的内容的来源。
	 */
	correct(
		id: string,
		version: number,
		edit: MemoryEdit,
		sources: MemorySources,
	): MemoryRecord {
		return writeTransaction(this.#db, () => {
			const row = this.#expect(id, version);
			if (row.status === "pending") {
				throw new MemoryStateError(
					`记忆 ${id} 还是待确认的候选，修改后确认即可`,
				);
			}
			const content = prepareContent({ ...row, ...edit }, this.#containsSecret);
			const time = new Date().toISOString();
			const stored = JSON.stringify(sources);
			this.#update(row, {
				status: "active",
				...content,
				origin: "user",
				sources: stored,
				confirmed_at: time,
			});
			this.#insertVersion(id, row.version + 1, content, "user", stored, time);
			return this.#get(id);
		});
	}

	/** 回滚：把一个保留下来的旧版本的内容作为新版本，记忆重新生效。 */
	rollback(id: string, version: number, to: number): MemoryRecord {
		return writeTransaction(this.#db, () => {
			const row = this.#expect(id, version);
			if (row.status === "pending") {
				throw new MemoryStateError(`记忆 ${id} 还是待确认的候选，没有旧版本`);
			}
			const old = this.#db
				.prepare("SELECT * FROM versions WHERE memory_id = ? AND version = ?")
				.get(id, to) as VersionRow | undefined;
			if (old === undefined) {
				throw new MemoryStateError(`记忆 ${id} 没有保留版本 ${to} 的内容`);
			}
			const time = new Date().toISOString();
			const content = { kind: old.kind, title: old.title, body: old.body };
			this.#update(row, {
				status: "active",
				...content,
				origin: old.origin,
				sources: old.sources,
				confirmed_at: time,
			});
			this.#insertVersion(
				id,
				row.version + 1,
				content,
				old.origin,
				old.sources,
				time,
			);
			return this.#get(id);
		});
	}

	#transition(
		id: string,
		version: number,
		from: MemoryStatus,
		to: MemoryStatus,
	): MemoryRecord {
		return writeTransaction(this.#db, () => {
			const row = this.#expect(id, version);
			if (row.status !== from) {
				throw new MemoryStateError(
					`记忆 ${id} 现在的状态是 ${row.status}，做不了这个操作`,
				);
			}
			this.#update(row, { status: to });
			return this.#get(id);
		});
	}

	/** 不再使用：不进索引、检索不到，可以用 `restore` 恢复。 */
	retire(id: string, version: number): MemoryRecord {
		return this.#transition(id, version, "active", "retired");
	}

	/** 恢复一条不再使用的记忆。 */
	restore(id: string, version: number): MemoryRecord {
		return this.#transition(id, version, "retired", "active");
	}

	/** 标记过期：内容曾经成立、现在不成立。不进索引、检索不到，纠正后重新生效。 */
	expire(id: string, version: number): MemoryRecord {
		return this.#transition(id, version, "active", "expired");
	}

	/**
	 * 彻底删除：清除记忆、全部版本和来源，以及针对它的候选。`secure_delete` 让 SQLite 把腾出的
	 * 页面清零，随后截断 WAL。没有这条记忆时抛 `MemoryNotFoundError`。
	 */
	purge(id: string): void {
		writeTransaction(this.#db, () => {
			if (this.#row(id) === undefined) throw new MemoryNotFoundError(id);
			this.#db
				.prepare("DELETE FROM memories WHERE id = ? OR target_id = ?")
				.run(id, id);
		});
		this.#checkpoint();
	}

	/**
	 * 把 WAL 里的内容写回数据库文件并截断 WAL：删掉的内容不留在 WAL 里。别的进程正在读这个库时
	 * 截断不了，留到之后的检查点。
	 */
	#checkpoint(): void {
		this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	/** 按编号读一条记忆，任何状态都能读到；没有时返回空。 */
	get(id: string): MemoryRecord | undefined {
		const row = this.#row(id);
		return row === undefined ? undefined : this.#record(row);
	}

	/** 全部记忆，按添加的先后；给了 `status` 时只要这个状态的。 */
	list(status?: MemoryStatus): MemoryRecord[] {
		const rows = (status === undefined
			? this.#db.prepare("SELECT * FROM memories ORDER BY rowid").all()
			: this.#db
					.prepare("SELECT * FROM memories WHERE status = ? ORDER BY rowid")
					.all(status)) as unknown as MemoryRow[];
		return rows.map((row) => this.#record(row));
	}

	/** 一条记忆保留下来的内容版本，从旧到新。 */
	history(id: string): MemoryVersion[] {
		const rows = this.#db
			.prepare("SELECT * FROM versions WHERE memory_id = ? ORDER BY version")
			.all(id) as unknown as VersionRow[];
		return rows.map((row) => ({
			version: row.version,
			kind: row.kind,
			title: row.title,
			body: row.body,
			origin: row.origin,
			sources: parseSources(row.sources, id),
			created_at: row.created_at,
		}));
	}

	/** 在生效的记忆里检索，最多返回 `limit` 条，规则见 `searchRecords`。 */
	search(query: string, limit: number): MemoryRecord[] {
		return searchRecords(this.list("active"), query, limit);
	}

	/** 记下这些记忆刚被用到。不改版本号：它不是内容的改动，不该让别人的更新冲突。 */
	touch(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const time = new Date().toISOString();
		writeTransaction(this.#db, () => {
			const update = this.#db.prepare(
				"UPDATE memories SET last_used_at = ? WHERE id = ?",
			);
			for (const id of ids) update.run(time, id);
		});
	}

	/** 导出全部记忆（含候选和停用的），Markdown 或 JSONL。导出的文件由用户保管，不在删除范围内。 */
	export(format: "markdown" | "jsonl"): string {
		const records = this.list();
		return format === "markdown"
			? exportMarkdown(records)
			: exportJsonl(records);
	}

	/** 对库里每一份来源（现在的内容和各个旧版本）应用 `change`，返回空的保持不动。 */
	#rewriteSources(
		change: (sources: MemorySources) => MemorySources | undefined,
	): void {
		const memories = this.#db
			.prepare("SELECT id, sources FROM memories")
			.all() as unknown as Pick<MemoryRow, "id" | "sources">[];
		const updateMemory = this.#db.prepare(
			"UPDATE memories SET sources = ? WHERE id = ?",
		);
		for (const row of memories) {
			const changed = change(parseSources(row.sources, row.id));
			if (changed !== undefined) {
				updateMemory.run(JSON.stringify(changed), row.id);
			}
		}
		const versions = this.#db
			.prepare("SELECT memory_id, version, sources FROM versions")
			.all() as unknown as Pick<
			VersionRow,
			"memory_id" | "version" | "sources"
		>[];
		const updateVersion = this.#db.prepare(
			"UPDATE versions SET sources = ? WHERE memory_id = ? AND version = ?",
		);
		for (const row of versions) {
			const changed = change(parseSources(row.sources, row.memory_id));
			if (changed !== undefined) {
				updateVersion.run(JSON.stringify(changed), row.memory_id, row.version);
			}
		}
	}

	/**
	 * 来源 session 的一部分事件被改记到另一个 session 名下（父 session 被删除时，分叉仍引用的
	 * 事件）：来源跟着事件改记。
	 */
	reassignSources(
		sessionId: string,
		eventIds: readonly string[],
		toSessionId: string,
	): void {
		const moving = new Set(eventIds);
		writeTransaction(this.#db, () => {
			this.#rewriteSources((sources) => {
				const from = sources.sessions.find(
					(source) => source.session_id === sessionId,
				);
				const moved = from?.event_ids.filter((id) => moving.has(id)) ?? [];
				if (moved.length === 0) return undefined;
				const rest = changeSession(sources, sessionId, (source) => {
					const kept = source.event_ids.filter((id) => !moving.has(id));
					return kept.length === 0 ? [] : [{ ...source, event_ids: kept }];
				});
				if (rest === undefined) throw new Error("来源里没有要改记的 session");
				const existing = rest.sessions.find(
					(source) => source.session_id === toSessionId,
				);
				return {
					...rest,
					sessions:
						existing === undefined
							? [
									...rest.sessions,
									{
										session_id: toSessionId,
										event_ids: moved,
										deleted: false,
									},
								]
							: rest.sessions.map((source) =>
									source === existing
										? { ...source, event_ids: [...source.event_ids, ...moved] }
										: source,
								),
				};
			});
		});
	}

	/**
	 * 来源 session 到期被清理：记忆保留，来源里这个 session 的事件标为"来源已删除"。
	 * 到期只是存储管理，用户并没有表示不要这些内容。
	 */
	markSessionExpired(sessionId: string): void {
		writeTransaction(this.#db, () => {
			this.#rewriteSources((sources) =>
				changeSession(sources, sessionId, (source) => [
					{ ...source, event_ids: [], deleted: true },
				]),
			);
		});
	}

	/**
	 * 用户删除了来源 session：内容只来自这个 session 的版本一起彻底删除，现在的内容也只来自它的
	 * 记忆整条删除，返回被整条删除的记忆的编号。还有别的来源 session 的只去掉这一项来源。
	 * 被改记到分叉名下的事件要先用 `reassignSources` 改记。
	 */
	forgetSession(sessionId: string): string[] {
		const purged = writeTransaction(this.#db, () => {
			const gone = (sources: MemorySources) => {
				const rest = changeSession(sources, sessionId, () => []);
				return rest !== undefined && rest.sessions.length === 0;
			};
			const versions = this.#db
				.prepare("SELECT memory_id, version, sources FROM versions")
				.all() as unknown as Pick<
				VersionRow,
				"memory_id" | "version" | "sources"
			>[];
			const removeVersion = this.#db.prepare(
				"DELETE FROM versions WHERE memory_id = ? AND version = ?",
			);
			for (const row of versions) {
				if (gone(parseSources(row.sources, row.memory_id))) {
					removeVersion.run(row.memory_id, row.version);
				}
			}
			const memories = this.#db
				.prepare("SELECT id, sources FROM memories")
				.all() as unknown as Pick<MemoryRow, "id" | "sources">[];
			const ids = memories
				.filter((row) => gone(parseSources(row.sources, row.id)))
				.map((row) => row.id);
			const remove = this.#db.prepare(
				"DELETE FROM memories WHERE id = ? OR target_id = ?",
			);
			for (const id of ids) remove.run(id, id);
			this.#rewriteSources((sources) =>
				changeSession(sources, sessionId, () => []),
			);
			return ids;
		});
		this.#checkpoint();
		return purged;
	}

	/**
	 * 认领一个来源 session 的后台提取，认领到了返回 true。已经提取过，或者被别的还在运行的 Host
	 * 认领着时返回 false；认领者已经不在（`isStale` 判断）时接手。`owner` 是调用方的进程身份，
	 * 原样保存。
	 */
	claimExtraction(
		sessionId: string,
		owner: string,
		isStale: (owner: string) => boolean,
	): boolean {
		return writeTransaction(this.#db, () => {
			const row = this.#db
				.prepare("SELECT state, owner FROM extractions WHERE session_id = ?")
				.get(sessionId) as { state: string; owner: string } | undefined;
			if (row !== undefined) {
				if (row.state === "done" || !isStale(row.owner)) return false;
				this.#db
					.prepare("DELETE FROM extractions WHERE session_id = ?")
					.run(sessionId);
			}
			this.#db
				.prepare(
					"INSERT INTO extractions (session_id, state, owner, claimed_at) VALUES (?, 'claimed', ?, ?)",
				)
				.run(sessionId, owner, new Date().toISOString());
			return true;
		});
	}

	/** 把认领的来源 session 标为已提取，之后不再处理。 */
	completeExtraction(sessionId: string): void {
		const result = this.#db
			.prepare(
				"UPDATE extractions SET state = 'done' WHERE session_id = ? AND state = 'claimed'",
			)
			.run(sessionId);
		if (result.changes === 0) {
			throw new Error(`session ${sessionId} 的提取没有被认领`);
		}
	}

	/** 放弃认领（提取被取消）：这个 session 之后还可以再提取。 */
	releaseExtraction(sessionId: string): void {
		this.#db
			.prepare(
				"DELETE FROM extractions WHERE session_id = ? AND state = 'claimed'",
			)
			.run(sessionId);
	}
}
