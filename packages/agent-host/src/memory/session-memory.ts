import { join, relative } from "node:path";
import type {
	MemoryConfig,
	MemoryEntry,
	MemoryIndex,
	MemoryProposeParams,
	MemoryProposeResult,
	MemoryReadParams,
	MemoryReadResult,
	MemoryReference,
	MemorySearchParams,
	MemorySearchResult,
} from "@ospreycode/agent-runtime";
import {
	buildIndex,
	describeSources,
	type MemoryContent,
	type MemoryEdit,
	MemoryNotFoundError,
	type MemoryRecord,
	MemoryRejectedError,
	type MemoryScope,
	type MemoryStore,
	type MemoryVersion,
	type SessionSource,
	searchLimit,
	searchRecords,
} from "@ospreycode/memory";
import { isInside } from "../project/paths.js";
import type {
	MemoryCandidate,
	MemoryChange,
	MemoryRetrieved,
	MemoryUpdated,
} from "./events.js";
import { readHeadCommit } from "./git-head.js";
import type { MemorySettings } from "./settings.js";

/** 索引的长度上限（token）。 */
const indexTokens = 2500;

/** 按 UTF-8 字节数除以 1.7 估算 token 数，和 api 的 token 计数同一个算法。 */
function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 1.7);
}

/** 一条记忆和它保留下来的内容版本（从旧到新）。 */
export interface MemoryDetail {
	record: MemoryRecord;
	history: MemoryVersion[];
}

/** 用户直接添加的一条记忆。 */
export interface AddedMemory extends MemoryContent {
	scope: MemoryScope;
}

/**
 * 查看、纠正和删除记忆（`/memory`）。两种范围用同一组操作，编号的前缀（`p-`、`u-`）说明它在哪个
 * 范围里。会改动的操作都带上调用方看到的版本号：记忆在那之后被别的进程改过时抛
 * `MemoryConflictError`，不悄悄覆盖。没有这条记忆时抛 `MemoryNotFoundError`，状态不对时抛
 * `MemoryStateError`，内容含疑似密钥、为空或过长时抛 `MemoryRejectedError`。每次改动发出
 * `memory.updated`，下一个 task 开始时告诉模型。
 */
export interface MemoryManager {
	/** 两种范围里的全部记忆，project 的在前；每条都带状态，待确认的候选和停用的也在里面。 */
	list(): MemoryRecord[];
	/** 一条记忆的正文、来源和保留下来的旧版本；没有时为空。 */
	get(id: string): MemoryDetail | undefined;
	/** 直接添加：马上生效，内容记为来自用户。 */
	add(memory: AddedMemory): MemoryRecord;
	/** 确认一条候选；`edit` 是确认时改掉的内容，改过的内容记为来自用户。返回生效的那条记忆。 */
	confirm(id: string, version: number, edit?: MemoryEdit): MemoryRecord;
	/** 拒绝一条候选：候选和它的内容一起删除。 */
	reject(id: string, version: number): void;
	/** 纠正：生成新版本，旧版本保留到彻底删除为止；已过期的记忆纠正后重新生效。 */
	correct(id: string, version: number, edit: MemoryEdit): MemoryRecord;
	/** 回滚到一个保留下来的旧版本。 */
	rollback(id: string, version: number, to: number): MemoryRecord;
	/** 不再使用：不进索引、检索不到，可以恢复。 */
	retire(id: string, version: number): MemoryRecord;
	/** 恢复一条不再使用的记忆。 */
	restore(id: string, version: number): MemoryRecord;
	/** 标记过期：内容曾经成立、现在不成立。 */
	expire(id: string, version: number): MemoryRecord;
	/**
	 * 彻底删除：清除记忆、全部版本和来源，以及针对它的候选，并把它留在 session 记录里的内容脱敏：
	 * 它和它的各个版本引用过的来源事件，和按记忆的编号找到的标题和正文的副本（索引、"记忆更新"、
	 * 自动注入的正文、检索结果、候选列表）。范围同 `Host.redactEvents`，存着同一份内容的别的
	 * session 一起覆盖；user 记忆在每个登记过的项目里找。脱敏不了的 session 留在结果的 `remaining`
	 * 里，记忆照样删除。模型在回复里复述的内容不在其内。
	 */
	purge(id: string): Promise<PurgedMemory>;
}

/** 彻底删除一条记忆之后，它的内容没能从记录里脱敏的一个 session。 */
export interface RemainingSource {
	session_id: string;
	/** 这个 session 的工作区：之后在它下面执行 `session redact`。来源所在的 session 找不到时没有。 */
	workspace?: string;
	/**
	 * 还留在记录里的来源事件；没有来源在这个 session 里时为空。之后连同记忆的编号交给
	 * `Host.redactEvents`（`eventIds` 和 `memoryIds`）。
	 */
	event_ids: string[];
	/** 为什么没有脱敏：session 正被打开着（包括调用方自己的这个），或者找过的项目里没有它。 */
	reason: string;
}

/** 彻底删除一条记忆的结果。 */
export interface PurgedMemory {
	/** 记录被脱敏覆盖的 session：来源事件或记忆的内容所在的，和存着同一份内容的（如分叉）。 */
	redacted: string[];
	remaining: RemainingSource[];
}

/** 彻底删除的一条记忆：它留在 session 记录里的内容靠这些找。 */
export interface PurgedRecord {
	memory_id: string;
	/** user 记忆的索引进过别的项目的 session，要在每个登记过的项目里找。 */
	scope: MemoryScope;
	/** 它和它的各个版本引用过的来源事件，按 session。 */
	sources: SessionSource[];
}

/** `SessionMemory` 用到的依赖。 */
export interface SessionMemoryOptions {
	/** 这个项目的记忆库和 user 记忆库，session 结束时由它关闭。 */
	project: MemoryStore;
	user: MemoryStore;
	settings: MemorySettings;
	sessionId: string;
	/** 项目根目录的真实路径：引用的文件相对它保存。 */
	projectRoot: string;
	/** 用户改了一条记忆。 */
	onUpdated: (change: MemoryUpdated) => void;
}

/**
 * 一个 session 里的长期记忆：把生效记忆的索引交给 runtime，处理通道上的检索、读取和提议，
 * 给前端提供查看、纠正和删除的操作。
 */
export class SessionMemory {
	readonly settings: MemorySettings;
	#options: SessionMemoryOptions;
	#closed = false;
	/** 这个 session 里已经随 `memory.candidates` 列出过的候选。 */
	#announced = new Set<string>();
	/** 登记了、还没提交内容的 `memory_propose` 调用：所在的 run 和 `tool_call.started` 的事件编号。 */
	#registered: { runId: string; eventId: string } | undefined;

	constructor(options: SessionMemoryOptions) {
		this.#options = options;
		this.settings = options.settings;
	}

	get project(): MemoryStore {
		return this.#options.project;
	}

	get user(): MemoryStore {
		return this.#options.user;
	}

	/** 关闭两个记忆库。 */
	close(): void {
		this.#closed = true;
		this.#options.project.close();
		this.#options.user.close();
	}

	/**
	 * 交给前端的那组操作；session 关闭后调用抛错。`redactMemory` 把彻底删除的记忆留在 session
	 * 记录里的内容脱敏：记录不归本模块管，由 Host 传入。
	 */
	manager(
		redactMemory: (purged: PurgedRecord) => Promise<PurgedMemory>,
	): MemoryManager {
		const open =
			<Args extends unknown[], Result>(run: (...args: Args) => Result) =>
			(...args: Args): Result => {
				if (this.#closed) throw new Error("session 已关闭");
				return run(...args);
			};
		return {
			list: open(() => this.#list()),
			get: open((id) => this.#get(id)),
			add: open((memory) => this.#add(memory)),
			confirm: open((id, version, edit) => this.#confirm(id, version, edit)),
			reject: open((id, version) => this.#reject(id, version)),
			correct: open((id, version, edit) => this.#correct(id, version, edit)),
			rollback: open((id, version, to) => this.#rollback(id, version, to)),
			retire: open((id, version) => this.#retire(id, version)),
			restore: open((id, version) => this.#restore(id, version)),
			expire: open((id, version) => this.#expire(id, version)),
			purge: open(async (id) => redactMemory(this.#purge(id))),
		};
	}

	#store(scope: MemoryScope): MemoryStore {
		return scope === "project" ? this.#options.project : this.#options.user;
	}

	/** 编号的前缀说明它在哪个范围里；不是这两种前缀的编号哪个库里都没有。 */
	#storeOf(id: string): MemoryStore {
		if (id.startsWith("p-")) return this.#options.project;
		if (id.startsWith("u-")) return this.#options.user;
		throw new MemoryNotFoundError(id);
	}

	/** 按编号读一条记忆，任何状态；编号不是这两种前缀，或者库里没有时为空。 */
	#lookup(id: string): MemoryRecord | undefined {
		if (id.startsWith("p-")) return this.#options.project.get(id);
		if (id.startsWith("u-")) return this.#options.user.get(id);
		return undefined;
	}

	#active(): MemoryRecord[] {
		return [
			...this.#options.project.list("active"),
			...this.#options.user.list("active"),
		];
	}

	/** 带内容哈希的引用，路径换成绝对路径：runtime 在 agent 沙盒里照它核对。 */
	#references(record: MemoryRecord): MemoryReference[] {
		return record.sources.files.flatMap((file) =>
			file.sha256 === undefined
				? []
				: [
						{
							path: join(this.#options.projectRoot, file.path),
							sha256: file.sha256,
						},
					],
		);
	}

	#entry(record: MemoryRecord): MemoryEntry {
		return {
			id: record.id,
			scope: record.scope,
			kind: record.kind,
			title: record.title,
			body: record.body,
			source: describeSources(record),
			references: this.#references(record),
		};
	}

	/** 当前生效记忆的索引。 */
	index(): MemoryIndex {
		const active = this.#active();
		const byId = new Map(active.map((record) => [record.id, record]));
		const index = buildIndex(active, {
			maxTokens: indexTokens,
			countTokens: estimateTokens,
		});
		return {
			omitted: index.omitted,
			entries: index.entries.map((entry) => ({
				id: entry.id,
				version: entry.version,
				line: entry.line,
				references: this.#references(byId.get(entry.id) as MemoryRecord),
			})),
		};
	}

	/** 交给 runtime 的记忆配置：注入方式给索引时带上当前的索引。 */
	config(): MemoryConfig {
		const { write, retrieval } = this.settings;
		return {
			write,
			retrieval,
			...(retrieval === "index" || retrieval === "both"
				? { index: this.index() }
				: {}),
		};
	}

	/** `memory_propose` 的调用登记了：之后提交的候选以这次调用为来源。 */
	proposeRegistered(runId: string, eventId: string): void {
		this.#registered = { runId, eventId };
	}

	/** `memory/search`：在两种范围生效的记忆里检索，返回的条目记下最近使用时间。 */
	search(params: MemorySearchParams): {
		result: MemorySearchResult;
		retrieved: MemoryRetrieved;
	} {
		const found = searchRecords(this.#active(), params.query, searchLimit);
		this.#touch(found);
		return {
			result: { memories: found.map((record) => this.#entry(record)) },
			retrieved: {
				operation: "search",
				query: params.query,
				memory_ids: found.map((record) => record.id),
			},
		};
	}

	/** `memory/read`：按编号读一条生效的记忆。 */
	read(params: MemoryReadParams): {
		result: MemoryReadResult;
		retrieved: MemoryRetrieved;
	} {
		const { id } = params;
		const record = this.#lookup(id);
		const found = record?.status === "active" ? [record] : [];
		this.#touch(found);
		return {
			result: {
				memory: found[0] === undefined ? null : this.#entry(found[0]),
			},
			retrieved: {
				operation: "read",
				query: id,
				memory_ids: found.map((item) => item.id),
			},
		};
	}

	#touch(records: readonly MemoryRecord[]): void {
		for (const scope of ["project", "user"] as const) {
			const ids = records
				.filter((record) => record.scope === scope)
				.map((record) => record.id);
			if (ids.length > 0) this.#store(scope).touch(ids);
		}
	}

	/**
	 * `memory/propose`：记一条待确认的候选，来源是这个 session 里登记过的那次 `memory_propose`
	 * 调用。没有记下时返回原因，交给模型。没有登记就提交说明 runtime 有缺陷或被攻破，返回空。
	 */
	propose(
		params: MemoryProposeParams,
		runId: string,
	): MemoryProposeResult | undefined {
		const registered = this.#registered;
		if (registered === undefined || registered.runId !== runId) {
			return undefined;
		}
		this.#registered = undefined;
		const { projectRoot, sessionId } = this.#options;
		const { replaces } = params;
		let scope = params.scope;
		if (replaces !== undefined) {
			const replaced = this.#lookup(replaces);
			if (replaced?.status !== "active") {
				return {
					recorded: false,
					reason: `No memory in effect has the id ${replaces}.`,
				};
			}
			// 纠正落在原来那条记忆上，范围跟着它
			scope = replaced.scope;
		}
		const outside = params.files.find(
			(file) => !isInside(file.path, projectRoot),
		);
		if (outside !== undefined) {
			return {
				recorded: false,
				reason: `${outside.path} is outside the project root, so a later session cannot check it. Leave it out of files.`,
			};
		}
		const commit = readHeadCommit(projectRoot);
		try {
			const record = this.#store(scope).propose({
				kind: params.kind,
				title: params.title,
				body: params.body,
				sources: {
					sessions: [
						{
							session_id: sessionId,
							event_ids: [registered.eventId],
							deleted: false,
						},
					],
					// user 记忆跨项目使用，相对某个项目根目录的路径在别处核对不了
					files:
						scope === "project"
							? params.files.map((file) => ({
									path: relative(projectRoot, file.path),
									...(file.line === undefined ? {} : { line: file.line }),
									sha256: file.sha256,
								}))
							: [],
					...(commit === undefined ? {} : { commit }),
				},
				...(replaces === undefined
					? {}
					: { target: { id: replaces, action: "correct" as const } }),
			});
			if (record.status === "active") {
				return {
					recorded: false,
					reason: `The memory [${record.id}] already says exactly this.`,
				};
			}
			return { recorded: true, id: record.id };
		} catch (error) {
			if (!(error instanceof MemoryRejectedError)) throw error;
			return { recorded: false, reason: rejection(error) };
		}
	}

	/** 两种范围里这个 session 还没列出过的待确认候选；取走就算列出过了。 */
	takeCandidates(): MemoryCandidate[] {
		const pending = [
			...this.#options.project.list("pending"),
			...this.#options.user.list("pending"),
		].filter((record) => !this.#announced.has(record.id));
		for (const record of pending) this.#announced.add(record.id);
		return pending.map((record) => {
			const sources = record.sources.sessions.flatMap(
				(source) => source.event_ids,
			);
			return {
				id: record.id,
				version: record.version,
				scope: record.scope,
				kind: record.kind,
				title: record.title,
				...(record.target === undefined ? {} : { target: record.target }),
				...(sources.length === 0 ? {} : { source_event_ids: sources }),
			};
		});
	}

	#updated(
		change: MemoryChange,
		record: Pick<MemoryRecord, "id" | "scope">,
		targetId?: string,
	): void {
		this.#options.onUpdated({
			change,
			scope: record.scope,
			memory_id: record.id,
			...(targetId === undefined ? {} : { target_id: targetId }),
		});
	}

	#list(): MemoryRecord[] {
		return [...this.#options.project.list(), ...this.#options.user.list()];
	}

	#get(id: string): MemoryDetail | undefined {
		const record = this.#lookup(id);
		return record === undefined
			? undefined
			: { record, history: this.#store(record.scope).history(id) };
	}

	#add(memory: AddedMemory): MemoryRecord {
		const commit = readHeadCommit(this.#options.projectRoot);
		const record = this.#store(memory.scope).add({
			kind: memory.kind,
			title: memory.title,
			body: memory.body,
			// 用户亲手输入的内容不以哪个 session 为来源：删除 session 不带走它
			sources: {
				sessions: [],
				files: [],
				...(commit === undefined || memory.scope === "user" ? {} : { commit }),
			},
		});
		this.#updated("added", record);
		return record;
	}

	#confirm(id: string, version: number, edit?: MemoryEdit): MemoryRecord {
		const target = this.#lookup(id)?.target;
		const record = this.#storeOf(id).confirm(id, version, edit);
		this.#updated("confirmed", { id, scope: record.scope }, target?.id);
		return record;
	}

	#reject(id: string, version: number): void {
		const store = this.#storeOf(id);
		store.reject(id, version);
		this.#updated("rejected", { id, scope: store.scope });
	}

	#correct(id: string, version: number, edit: MemoryEdit): MemoryRecord {
		const commit = readHeadCommit(this.#options.projectRoot);
		const store = this.#storeOf(id);
		// 纠正后的内容是用户写的：不再以原来的 session 和文件为来源
		const record = store.correct(id, version, edit, {
			sessions: [],
			files: [],
			...(commit === undefined || store.scope === "user" ? {} : { commit }),
		});
		this.#updated("corrected", record);
		return record;
	}

	#rollback(id: string, version: number, to: number): MemoryRecord {
		const record = this.#storeOf(id).rollback(id, version, to);
		this.#updated("rolled_back", record);
		return record;
	}

	#retire(id: string, version: number): MemoryRecord {
		const record = this.#storeOf(id).retire(id, version);
		this.#updated("retired", record);
		return record;
	}

	#restore(id: string, version: number): MemoryRecord {
		const record = this.#storeOf(id).restore(id, version);
		this.#updated("restored", record);
		return record;
	}

	#expire(id: string, version: number): MemoryRecord {
		const record = this.#storeOf(id).expire(id, version);
		this.#updated("expired", record);
		return record;
	}

	#purge(id: string): PurgedRecord {
		const store = this.#storeOf(id);
		const record = store.get(id);
		if (record === undefined) throw new MemoryNotFoundError(id);
		const events = new Map<string, Set<string>>();
		for (const { sources } of [record, ...store.history(id)]) {
			for (const source of sources.sessions) {
				if (source.deleted) continue;
				const ids = events.get(source.session_id) ?? new Set();
				for (const eventId of source.event_ids) ids.add(eventId);
				events.set(source.session_id, ids);
			}
		}
		store.purge(id);
		this.#updated("purged", { id, scope: store.scope });
		return {
			memory_id: id,
			scope: store.scope,
			sources: [...events].map(([session_id, ids]) => ({
				session_id,
				event_ids: [...ids],
				deleted: false,
			})),
		};
	}
}

/** 候选没有通过入库检查的原因，交给模型。 */
function rejection(error: MemoryRejectedError): string {
	switch (error.reason) {
		case "secret":
			return "The proposal looks like it contains a secret or credential. Memories must not contain them.";
		case "empty":
			return "The title and the body must not be empty.";
		case "title_too_long":
			return "The title is longer than 120 characters.";
		case "body_too_long":
			return "The body is longer than 2000 characters.";
		case "target":
			return "The memory given in replaces does not exist.";
	}
}
