import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import {
	type DeletedSession,
	type Redactor,
	type SessionLock,
	type SessionMetadata,
	SessionStore,
} from "@ospreycode/session-store";
import { userLayer } from "../credentials/status.js";
import {
	expireSessionSources,
	forgetSessionSources,
	type MemoryPaths,
	memoryPaths,
	openMemoryStore,
	type ReassignedEvents,
} from "../memory/session-sources.js";
import type { ProcessIdentity } from "../processes/info.js";
import { clearProjectCache } from "../project/cache.js";
import type { Registry } from "../project/identity.js";
import {
	acquireWorkspaceLock,
	tryAcquireExclusiveLock,
	type WorkspaceLock,
} from "../project/locks.js";
import { registeredProject } from "../project/lookup.js";
import {
	sessionPaths,
	snapshotDirectory,
	WorkspaceError,
} from "../project/workspace.js";

/** 用户级配置里没有 `session_retention_days` 时 session 记录保存的天数。 */
const defaultRetentionDays = 30;

const dayMs = 86_400_000;

/** 指明一个 session：它所在项目里的任意一个目录，和它的标识。 */
export interface SessionRef {
	/** 这个目录所在的项目里找；不必是创建这个 session 时的工作区。 */
	directory: string;
	sessionId: string;
}

/** 删除哪个 session。 */
export interface DeleteSessionOptions extends SessionRef {
	/** 把从它分出去的分叉（包括分叉的分叉）一起删除；不给时分叉留着，它们仍引用的事件改记到它们名下。 */
	withForks?: boolean;
}

/** 一次删除的结果。 */
export interface DeletedSessions {
	/** 删掉的 session，按删除的先后：分叉在前，指定的 session 在最后。 */
	sessions: string[];
	/** 内容只来自这些 session、因此一起删掉的长期记忆的编号。 */
	memories: string[];
}

/** 维护 session 记录时用到的 Host 的位置和身份。 */
export interface MaintenanceContext {
	/** Host 根目录的真实路径。 */
	root: string;
	/** Host 根目录下的 `data/`。 */
	data: string;
	registry: Registry;
	/** 这个 Host 进程的身份，写进锁文件。 */
	owner: ProcessIdentity;
	/** 一个 session 的写锁的位置。 */
	sessionLock: (sessionId: string) => string;
}

function storePath(data: string, projectId: string): string {
	return join(data, "projects", projectId, "sessions.sqlite");
}

/** 一个项目打开着的 session 记录；用完由调用方关闭 `store`。 */
export interface ProjectStore {
	projectId: string;
	path: string;
	store: SessionStore;
}

/** 打开目录所在项目的 session 记录；项目没有登记过，或者还没有打开过 session 时为空。 */
function openProjectStore(
	context: MaintenanceContext,
	directory: string,
): ProjectStore | undefined {
	const projectId = registeredProject(context.registry, directory);
	if (projectId === undefined) return undefined;
	const path = storePath(context.data, projectId);
	// 登记了项目但还没有打开过 session 时没有这个文件，SessionStore.open 会新建一个
	if (!existsSync(path)) return undefined;
	return { projectId, path, store: SessionStore.open(path) };
}

/**
 * 逐个打开项目的 session 记录，每个用完由调用方关闭。给了 `directory` 时只有它所在的项目，不给时
 * 是每个登记过的项目；还没有打开过 session 的项目没有记录，跳过。
 */
export function* registeredStores(
	context: MaintenanceContext,
	directory?: string,
): Generator<ProjectStore> {
	if (directory !== undefined) {
		const project = openProjectStore(context, directory);
		if (project !== undefined) yield project;
		return;
	}
	for (const { project_id: projectId } of context.registry.projects()) {
		const path = storePath(context.data, projectId);
		if (!existsSync(path)) continue;
		yield { projectId, path, store: SessionStore.open(path) };
	}
}

/** 打开 session 所在项目的记录并确认有这个 session；没有时抛出 `WorkspaceError`。 */
export function openSessionStore(
	context: MaintenanceContext,
	ref: SessionRef,
): ProjectStore {
	const project = openProjectStore(context, ref.directory);
	if (project !== undefined) {
		const found = project.store
			.sessions()
			.some((session) => session.session_id === ref.sessionId);
		if (found) return project;
		project.store.close();
	}
	throw new WorkspaceError(
		`这个项目里没有 session ${ref.sessionId}：用 ospreycode session list 查看`,
	);
}

/**
 * 取得这些 session 的写锁，要么都取得，要么一个也不留。有一个正被 Host 打开着时抛出
 * `WorkspaceError`，`purpose` 写进错误信息，说明是什么事做不了。
 */
export function lockSessions(
	context: MaintenanceContext,
	sessionIds: readonly string[],
	purpose: string,
): Map<string, SessionLock> {
	const held = new Map<string, SessionLock>();
	try {
		for (const id of sessionIds) {
			const lock = tryAcquireExclusiveLock(
				context.sessionLock(id),
				context.owner,
			);
			if (lock === undefined) {
				throw new WorkspaceError(
					`session ${id} 正被一个 Host 进程打开着，不能${purpose}：先关闭它`,
				);
			}
			held.set(id, lock);
		}
	} catch (error) {
		for (const lock of held.values()) lock.release();
		throw error;
	}
	return held;
}

/** 在已经取得的写锁里彻底删除一个 session。锁交给 `store.delete` 之后由它释放，没交出去的在这里释放。 */
async function deleteLocked(
	store: SessionStore,
	sessionId: string,
	lock: SessionLock,
): Promise<DeletedSession> {
	let handedOver = false;
	try {
		return await store.delete(sessionId, async () => {
			handedOver = true;
			return lock;
		});
	} finally {
		if (!handedOver) lock.release();
	}
}

/** 删除时改记到分叉名下的事件的 `event_id`：删除之后它们已经是分叉自己的事件。 */
function reassignedEvents(
	store: SessionStore,
	deleted: DeletedSession,
): ReassignedEvents[] {
	return deleted.reowned
		.filter((fork) => fork.segments.length > 0)
		.map((fork) => ({
			toSessionId: fork.session_id,
			eventIds: store
				.events(fork.session_id)
				.filter((event) =>
					fork.segments.some(
						(segment) =>
							segment.run_id === event.run_id &&
							event.seq >= segment.from_seq &&
							event.seq <= segment.to_seq,
					),
				)
				.map((event) => event.event_id),
		}));
}

/**
 * 一个 session 到期被清理：以它为来源的记忆保留。改记到分叉名下的事件在来源里跟着改记，
 * 其余的来源标为"来源已删除"。
 */
function expireSources(
	paths: MemoryPaths,
	sessionId: string,
	reassigned: readonly ReassignedEvents[],
): void {
	for (const scope of ["project", "user"] as const) {
		// 文件不存在说明从没用过长期记忆，不去创建
		if (reassigned.length === 0 || !existsSync(paths[scope])) continue;
		const memory = openMemoryStore(paths[scope], scope);
		try {
			for (const { eventIds, toSessionId } of reassigned) {
				memory.reassignSources(sessionId, eventIds, toSessionId);
			}
		} finally {
			memory.close();
		}
	}
	expireSessionSources(paths, sessionId);
}

function removeSessionDirectories(root: string, sessionId: string): void {
	for (const dir of Object.values(sessionPaths(root, sessionId))) {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * 一个工作区的 session 都删除之后，删掉它的整个影子仓库目录。删之前取得工作区锁：正有 session
 * 在这个工作区（或和它互相包含的工作区）打开时不删，留给之后打开的 session 清理不再被引用的快照。
 */
async function removeSnapshots(
	context: MaintenanceContext,
	project: ProjectStore,
	workspace: string,
): Promise<void> {
	let lock: WorkspaceLock;
	try {
		lock = await acquireWorkspaceLock(
			join(context.data, "locks"),
			workspace,
			context.owner,
		);
	} catch (error) {
		if (error instanceof WorkspaceError) return;
		throw error;
	}
	try {
		// 取得锁之前可能刚有一个 session 在这个工作区新建又关闭
		if (!hasSession(project.store, workspace)) {
			rmSync(snapshotDirectory(context.root, project.projectId, workspace), {
				recursive: true,
				force: true,
			});
		}
	} finally {
		lock.release();
	}
}

function hasSession(store: SessionStore, workspace: string): boolean {
	return store.sessions().some((session) => session.workspace === workspace);
}

/**
 * 删除 session 之后清理不再有用的东西：`workspaces` 是被删的 session 的工作区，没有别的 session 的
 * 删掉影子仓库；项目的 session 都删除了的清空构建缓存。
 */
async function removeLeftovers(
	context: MaintenanceContext,
	project: ProjectStore,
	workspaces: ReadonlySet<string>,
): Promise<void> {
	for (const workspace of workspaces) {
		if (!hasSession(project.store, workspace)) {
			await removeSnapshots(context, project, workspace);
		}
	}
	if (project.store.sessions().length === 0) {
		clearProjectCache(context.root, project.projectId);
	}
}

/**
 * 从这个 session 分出去的全部分叉（包括分叉的分叉），按创建的先后。项目里没有这个 session、
 * 目录不存在时抛出 `WorkspaceError`。
 */
export function sessionForks(
	context: MaintenanceContext,
	ref: SessionRef,
): string[] {
	const { store } = openSessionStore(context, ref);
	try {
		return store.forks(ref.sessionId);
	} finally {
		store.close();
	}
}

/**
 * 彻底删除一个 session：记录、临时目录和输出文件，只来自它的长期记忆；它的工作区没有别的 session
 * 时删掉影子仓库，项目的 session 都删除了时清空构建缓存。要删的 session 先全部取得写锁再动手，
 * 有一个正被 Host 打开着时抛出 `WorkspaceError`，什么也不删。
 */
export async function deleteSession(
	context: MaintenanceContext,
	options: DeleteSessionOptions,
): Promise<DeletedSessions> {
	const project = openSessionStore(context, options);
	const { store, projectId } = project;
	try {
		// 分叉按创建的先后列出，倒过来删：轮到一个 session 时从它分出去的都已经删掉，没有事件要改记
		const targets =
			options.withForks === true
				? [...store.forks(options.sessionId).reverse(), options.sessionId]
				: [options.sessionId];
		const held = lockSessions(context, targets, "删除");
		const paths = memoryPaths(context.data, projectId);
		const workspaces = new Set<string>();
		const memories: string[] = [];
		try {
			for (const [id, lock] of held) {
				// 交出去的锁从表里去掉：中途出错时，还没轮到的在下面释放
				held.delete(id);
				const deleted = await deleteLocked(store, id, lock);
				workspaces.add(deleted.workspace);
				removeSessionDirectories(context.root, id);
				memories.push(
					...forgetSessionSources(paths, id, reassignedEvents(store, deleted)),
				);
			}
		} finally {
			for (const lock of held.values()) lock.release();
		}
		await removeLeftovers(context, project, workspaces);
		return { sessions: targets, memories };
	} finally {
		store.close();
	}
}

/**
 * 一个 session 的导出内容，每项是 JSONL 的一行，密钥这类内容由 `scrub` 换成占位。只读，不取锁：
 * 打开着的 session 也能导出。调用时就确认有这个 session（没有时抛出 `WorkspaceError`）；
 * 数据库在开始遍历时打开，遍历结束或中途停下时关闭，结果可以遍历多次。
 */
export function exportSession(
	context: MaintenanceContext,
	scrub: Redactor,
	ref: SessionRef,
): Iterable<string> {
	const { path, store } = openSessionStore(context, ref);
	store.close();
	return {
		*[Symbol.iterator]() {
			const reader = SessionStore.open(path);
			try {
				yield* reader.export(ref.sessionId, scrub);
			} finally {
				reader.close();
			}
		},
	};
}

/**
 * 从事件表重建目录所在项目的会话树和检查点索引。重建时不能有别的写入者，所以先取得项目里每个
 * session 的写锁：有一个正被 Host 打开着，或者项目还没有 session 记录时抛出 `WorkspaceError`。
 */
export function rebuildSessions(
	context: MaintenanceContext,
	directory: string,
): void {
	const project = openProjectStore(context, directory);
	if (project === undefined) {
		throw new WorkspaceError(`这个项目还没有 session 记录：${directory}`);
	}
	const { store } = project;
	try {
		const held = lockSessions(
			context,
			store.sessions().map((session) => session.session_id),
			"重建索引",
		);
		try {
			store.rebuild();
		} finally {
			for (const lock of held.values()) lock.release();
		}
	} finally {
		store.close();
	}
}

/**
 * 清理一个项目里到期的 session，返回清理掉的。到期和用户删除的差别：记忆保留，只改来源；
 * 分叉留着。正被 Host 打开着的跳过。
 */
async function cleanProject(
	context: MaintenanceContext,
	project: ProjectStore,
	expired: (session: SessionMetadata) => boolean,
): Promise<string[]> {
	const { store, projectId } = project;
	const paths = memoryPaths(context.data, projectId);
	const workspaces = new Set<string>();
	const cleaned: string[] = [];
	for (const { session_id: id } of store.sessions().filter(expired)) {
		const lock = tryAcquireExclusiveLock(
			context.sessionLock(id),
			context.owner,
		);
		if (lock === undefined) continue;
		// 列出之后、取得写锁之前，它可能刚被恢复并写过，或者已经被用户删除：在锁里再看一次
		const current = store
			.sessions()
			.find((session) => session.session_id === id);
		if (current === undefined || !expired(current)) {
			lock.release();
			continue;
		}
		const deleted = await deleteLocked(store, id, lock);
		workspaces.add(deleted.workspace);
		removeSessionDirectories(context.root, id);
		expireSources(paths, id, reassignedEvents(store, deleted));
		cleaned.push(id);
		await nextTick();
	}
	// 这次没有清理掉什么的项目不动：本来就没有 session 的项目，缓存可能是正在打开的 session 刚写的
	if (cleaned.length > 0) await removeLeftovers(context, project, workspaces);
	return cleaned;
}

/**
 * 清理到期的 session：最后一次写入早于 `now` 之前 `session_retention_days` 天（只读用户级配置，
 * 默认 30）的，在每个登记过的项目里彻底删除，返回删掉的 session。期限最小是 1 天，所以 24 小时内
 * 写过的不会被清理。只由取得数据目录清理锁的 Host 执行：另一个 Host 正在清理时什么也不做，
 * 返回空数组。用户级配置加载出错时抛出 `ConfigError`。`home` 是 Host 环境里的 HOME。
 */
export async function cleanExpiredSessions(
	context: MaintenanceContext,
	home: string | undefined,
	now: Date,
): Promise<string[]> {
	const days =
		userLayer(context.root, home).session_retention_days ??
		defaultRetentionDays;
	const lock = tryAcquireExclusiveLock(
		join(context.data, "locks", "cleanup.lock"),
		context.owner,
	);
	if (lock === undefined) return [];
	try {
		// 按毫秒数比较：期限设成很大的数时，截止时间超出了 Date 能表示的范围
		const deadline = now.getTime() - days * dayMs;
		const expired = (session: SessionMetadata) =>
			Date.parse(session.last_written_at) < deadline;
		const cleaned: string[] = [];
		for (const { project_id: projectId } of context.registry.projects()) {
			// 调用方多半有打开着的 session，读库和删除又都是同步的：每个项目之前、每删一个 session 之后
			// 让出事件循环，界面和通道不被卡住
			await nextTick();
			const path = storePath(context.data, projectId);
			// 登记了项目但还没有打开过 session 时没有这个文件，SessionStore.open 会新建一个
			if (!existsSync(path)) continue;
			const project = { projectId, path, store: SessionStore.open(path) };
			try {
				cleaned.push(...(await cleanProject(context, project, expired)));
			} finally {
				project.store.close();
			}
		}
		return cleaned;
	} finally {
		lock.release();
	}
}
