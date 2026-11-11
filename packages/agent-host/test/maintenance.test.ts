import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	createHost,
	type Host,
	type Session,
	type SessionOptions,
	WorkspaceError,
} from "@ospreycode/agent-host";
import type { ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
import {
	type Position,
	type RunRecord,
	SessionStore,
	storageVersion,
} from "@ospreycode/session-store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memoryPaths, openMemoryStore } from "../src/memory/session-sources.js";
import {
	bootId,
	type ProcessIdentity,
	processStartTime,
} from "../src/processes/info.js";
import { Registry } from "../src/project/identity.js";
import { tryAcquireExclusiveLock } from "../src/project/locks.js";
import { sessionPaths, snapshotDirectory } from "../src/project/workspace.js";
import { cleanExpiredSessions } from "../src/sessions/maintenance.js";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

const hour = 3_600_000;
const day = 24 * hour;

let dirs: TestDirectories;
let host: Host;
/** 脚本模型收到的每次请求。 */
let requests: ModelRequest[];
const opened: Session[] = [];

function reply(text: string): ScriptedTurn {
	return { content: [{ type: "text", text }] };
}

function newHost(script: Script = () => reply("好的")): Host {
	return createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, index) => {
			requests.push(request);
			return script(request, index);
		}),
	});
}

beforeEach(() => {
	dirs = testDirectories();
	requests = [];
	host = newHost();
});

afterEach(async () => {
	await Promise.all(opened.splice(0).map((session) => session.close()));
	dirs.cleanup();
});

function options(workspace: string): SessionOptions {
	return {
		workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
	};
}

interface Opened {
	session: Session;
	sessionId: string;
	projectId: string;
	log: EventLog;
}

async function submit({ session, log }: Opened, input: string): Promise<void> {
	const taskId = await session.submit(input);
	await log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/** 打开一个 session，把输入逐个作为任务执行完，留着不关。 */
async function open(
	inputs: readonly string[] = [],
	workspace = dirs.workspace,
): Promise<Opened> {
	const log = new EventLog();
	const session = await host.openSession({
		...options(workspace),
		onEvent: log.push,
	});
	opened.push(session);
	const started = await log.waitFor("session.started");
	const result = {
		session,
		sessionId: started.session_id,
		projectId: started.project_id,
		log,
	};
	for (const input of inputs) await submit(result, input);
	return result;
}

/** 一个执行过这些任务、已经关闭的 session。 */
async function record(
	inputs: readonly string[],
	workspace = dirs.workspace,
): Promise<Opened> {
	const result = await open(inputs, workspace);
	await result.session.close();
	return result;
}

async function resume(sessionId: string): Promise<Opened> {
	const log = new EventLog();
	const session = await host.resumeSession({
		...options(dirs.workspace),
		sessionId,
		onEvent: log.push,
	});
	opened.push(session);
	const started = await log.waitFor("session.started");
	return { session, sessionId, projectId: started.project_id, log };
}

function userConfig(text: string): void {
	writeFileSync(join(dirs.root, "config.toml"), text);
}

function dataDir(): string {
	return join(dirs.root, "data");
}

function storePath(projectId: string): string {
	return join(dataDir(), "projects", projectId, "sessions.sqlite");
}

/** 记录文件和它的 WAL 里的全部字节。 */
function recordBytes(projectId: string): Buffer {
	const path = storePath(projectId);
	return Buffer.concat(
		[path, `${path}-wal`].filter(existsSync).map((file) => readFileSync(file)),
	);
}

function sessionLock(sessionId: string): string {
	return join(dataDir(), "locks", `session-${sessionId}.lock`);
}

/** 测试进程自己的身份：用它取得的锁，在 Host 看来被一个还在运行的进程持有。 */
function identity(): ProcessIdentity {
	return {
		pid: process.pid,
		start_time: processStartTime(process.pid) as string,
		boot_id: bootId(),
	};
}

/** 像另一个 Host 正打开着它那样，持有一个 session 的写锁。 */
function holdSession(sessionId: string): { release(): void } {
	const lock = tryAcquireExclusiveLock(sessionLock(sessionId), identity());
	if (lock === undefined) throw new Error("这个 session 的写锁已经被持有");
	return lock;
}

/** 以 `now` 为当前时间清理到期的 session：Host 的 `cleanExpiredSessions()` 传的是真实的当前时间。 */
function cleanAt(now: number): Promise<string[]> {
	const owner = identity();
	return cleanExpiredSessions(
		{
			root: dirs.root,
			data: dataDir(),
			registry: new Registry(dataDir(), owner),
			owner,
			sessionLock,
		},
		dirs.home,
		new Date(now),
	);
}

function lastWritten(sessionId: string): number {
	const found = host
		.listSessions()
		.find((session) => session.session_id === sessionId);
	if (found === undefined) throw new Error(`没有 session ${sessionId}`);
	return Date.parse(found.last_written_at);
}

function listed(): string[] {
	return host.listSessions().map((session) => session.session_id);
}

const memoryContent = { kind: "fact", body: "正文" } as const;

/** 在项目的记忆库里加一条记忆，来源是 `sessionId` 的这些事件；返回它的编号。 */
function addMemory(
	projectId: string,
	title: string,
	sessionId: string,
	eventIds: string[],
): string {
	const store = openMemoryStore(
		memoryPaths(dataDir(), projectId).project,
		"project",
	);
	try {
		return store.add({
			...memoryContent,
			title,
			sources: {
				sessions: [
					{ session_id: sessionId, event_ids: eventIds, deleted: false },
				],
				files: [],
			},
		}).id;
	} finally {
		store.close();
	}
}

/** 项目的记忆库里各条记忆的来源 session，键是记忆的编号。 */
function memorySources(projectId: string) {
	const store = openMemoryStore(
		memoryPaths(dataDir(), projectId).project,
		"project",
	);
	try {
		return Object.fromEntries(
			store.list().map((memory) => [memory.id, memory.sources.sessions]),
		);
	} finally {
		store.close();
	}
}

/**
 * 直接在记录里从 `parent` 的 `position` 分出一个分叉，返回它的标识：Host 的 `forkSession` 只能从
 * 当前位置或检查点分叉，这里要从第一个任务结束的位置分出去。分叉的工作区和父 session 相同。
 */
async function addFork(
	projectId: string,
	parent: string,
	position: Position,
): Promise<string> {
	const store = SessionStore.open(storePath(projectId));
	try {
		const sessionId = randomUUID();
		const writer = await store.fork(
			{
				session_id: sessionId,
				workspace: dirs.workspace,
				created_at: new Date().toISOString(),
			},
			{ parent_session_id: parent, position },
			async () => ({ release: () => {} }),
		);
		writer.close();
		return sessionId;
	} finally {
		store.close();
	}
}

/**
 * 一个执行过两个任务的 session，从它第一个任务结束的位置分出去的分叉，和分叉的分叉。
 * 另有三条记忆：来源分别是第一个任务的事件（分叉也沿用）、第二个任务的事件（只属于父 session）。
 */
async function sessionTree() {
	const parent = await record([
		"第一个任务 heron-0917",
		"第二个任务 walrus-5521",
	]);
	const { sessionId, projectId } = parent;
	const store = SessionStore.open(storePath(projectId));
	let position: Position;
	let early: string;
	let late: string;
	try {
		const [first, second] = store
			.runs(sessionId)
			.filter((run) => run.task_id !== null) as [RunRecord, RunRecord];
		position = second.base as Position;
		const ended = (run: RunRecord) =>
			store
				.events(sessionId)
				.find(
					(event) => event.run_id === run.run_id && event.type === "task.ended",
				)?.event_id as string;
		early = ended(first);
		late = ended(second);
	} finally {
		store.close();
	}
	const fork = await addFork(projectId, sessionId, position);
	const nested = await addFork(projectId, fork, position);
	return {
		projectId,
		parent: sessionId,
		fork,
		nested,
		early,
		late,
		memories: {
			early: addMemory(projectId, "分叉也沿用的", sessionId, [early]),
			late: addMemory(projectId, "只属于父 session 的", sessionId, [late]),
		},
	};
}

/** 一个 session 导出的事件的 `event_id`，按导出的顺序。 */
function exportedEventIds(sessionId: string): string[] {
	return [...host.exportSession({ directory: dirs.workspace, sessionId })]
		.slice(1)
		.map((line) => (JSON.parse(line) as { event_id: string }).event_id);
}

describe("deleteSession", () => {
	test("删除之后列表里没有，记录文件里找不到它的内容，临时目录和输出文件不在，不能恢复", async () => {
		host = newHost(() => reply("回答 walrus-onyx-5521"));
		const { sessionId, projectId } = await record(["输入 zebra-quartz-0917"]);
		const paths = sessionPaths(dirs.root, sessionId);
		writeFileSync(join(paths.output, "command.log"), "命令的输出");
		writeFileSync(join(paths.tmp, "scratch"), "临时文件");
		for (const text of ["zebra-quartz-0917", "walrus-onyx-5521"]) {
			expect(recordBytes(projectId).includes(text)).toBe(true);
		}

		expect(
			await host.deleteSession({ directory: dirs.workspace, sessionId }),
		).toEqual({ sessions: [sessionId], memories: [] });

		expect(host.listSessions()).toEqual([]);
		for (const text of ["zebra-quartz-0917", "walrus-onyx-5521", sessionId]) {
			expect(recordBytes(projectId).includes(text)).toBe(false);
		}
		expect(existsSync(paths.tmp)).toBe(false);
		expect(existsSync(paths.output)).toBe(false);
		expect(existsSync(sessionLock(sessionId))).toBe(false);
		await expect(resume(sessionId)).rejects.toThrow(WorkspaceError);
	});

	test("在整个项目里找；工作区没有别的 session 时删掉它的影子仓库，项目的 session 都删除了才清空构建缓存", async () => {
		// 同一个仓库的两个子目录是同一个项目的两个工作区
		execFileSync("git", ["init", "-q", dirs.workspace]);
		const [one, other] = ["one", "other"].map((name) => {
			const dir = join(dirs.workspace, name);
			mkdirSync(dir);
			return dir;
		}) as [string, string];
		const first = await record(["第一个"], one);
		const second = await record(["第二个"], one);
		const third = await record(["第三个"], other);
		const { projectId } = first;
		const snapshots = (workspace: string) =>
			snapshotDirectory(dirs.root, projectId, workspace);
		const artifact = join(dirs.root, "cache", projectId, "artifact");
		writeFileSync(artifact, "构建产物");
		expect(existsSync(snapshots(one))).toBe(true);
		expect(existsSync(snapshots(other))).toBe(true);

		// 当前目录不必是它的工作区
		await host.deleteSession({ directory: other, sessionId: first.sessionId });
		expect(existsSync(snapshots(one))).toBe(true);

		await host.deleteSession({ directory: other, sessionId: second.sessionId });
		expect(existsSync(snapshots(one))).toBe(false);
		expect(existsSync(snapshots(other))).toBe(true);
		expect(existsSync(artifact)).toBe(true);

		await host.deleteSession({ directory: one, sessionId: third.sessionId });
		expect(existsSync(snapshots(other))).toBe(false);
		// 只删缓存目录里的内容，目录本身留着
		expect(readdirSync(join(dirs.root, "cache", projectId))).toEqual([]);
		expect(host.listSessions()).toEqual([]);
	});

	test("工作区（或和它互相包含的工作区）正有 session 打开着时，影子仓库不删", async () => {
		execFileSync("git", ["init", "-q", dirs.workspace]);
		const inner = join(dirs.workspace, "inner");
		mkdirSync(inner);
		const { sessionId, projectId } = await record(["任务"], inner);
		// 仓库的根目录包含 inner
		const outer = await open();

		await host.deleteSession({ directory: inner, sessionId });

		expect(listed()).toEqual([outer.sessionId]);
		expect(existsSync(snapshotDirectory(dirs.root, projectId, inner))).toBe(
			true,
		);
		// 打开着的 session 不受影响
		await submit(outer, "接着做");
	});

	test("打开着的 session 不能删除，关闭之后可以", async () => {
		const current = await open(["任务"]);
		const { sessionId } = current;
		const ref = { directory: dirs.workspace, sessionId };

		await expect(host.deleteSession(ref)).rejects.toThrow(WorkspaceError);
		await expect(host.deleteSession(ref)).rejects.toThrow(
			`session ${sessionId} 正被一个 Host 进程打开着`,
		);
		expect(listed()).toEqual([sessionId]);
		// 没删成的尝试不动它的写锁：它还能接着用
		await submit(current, "接着做");

		await current.session.close();
		expect((await host.deleteSession(ref)).sessions).toEqual([sessionId]);
	});

	test("没有这个 session、项目没有记录、目录不存在时报错，不留下记录文件", async () => {
		const sessionId = randomUUID();
		const empty = join(dirs.home, "empty");
		mkdirSync(empty);
		for (const directory of [empty, join(dirs.home, "missing")]) {
			const ref = { directory, sessionId };
			expect(() => host.sessionForks(ref)).toThrow(WorkspaceError);
			expect(() => host.exportSession(ref)).toThrow(WorkspaceError);
			await expect(host.deleteSession(ref)).rejects.toThrow(WorkspaceError);
			expect(() => host.rebuildSessions({ directory })).toThrow(WorkspaceError);
		}
		expect(host.listProjects()).toEqual([]);
		expect(existsSync(join(dataDir(), "projects"))).toBe(false);

		const existing = await record(["任务"]);
		const ref = { directory: dirs.workspace, sessionId };
		expect(() => host.sessionForks(ref)).toThrow(
			`这个项目里没有 session ${sessionId}`,
		);
		expect(() => host.exportSession(ref)).toThrow(WorkspaceError);
		await expect(host.deleteSession(ref)).rejects.toThrow(WorkspaceError);
		expect(listed()).toEqual([existing.sessionId]);
	});

	test("不带分叉删除：分叉留着，它沿用的事件改记到它名下，记忆的来源跟着改记", async () => {
		const tree = await sessionTree();
		const ref = { directory: dirs.workspace, sessionId: tree.parent };
		expect(host.sessionForks(ref)).toEqual([tree.fork, tree.nested]);
		const inherited = exportedEventIds(tree.fork);
		expect(inherited).toContain(tree.early);
		expect(inherited).not.toContain(tree.late);

		expect(await host.deleteSession(ref)).toEqual({
			sessions: [tree.parent],
			memories: [tree.memories.late],
		});

		expect(listed().sort()).toEqual([tree.fork, tree.nested].sort());
		expect(exportedEventIds(tree.fork)).toEqual(inherited);
		expect(exportedEventIds(tree.nested)).toEqual(inherited);
		// 只属于被删 session 的内容不在了，分叉沿用的还在
		expect(recordBytes(tree.projectId).includes("walrus-5521")).toBe(false);
		expect(recordBytes(tree.projectId).includes("heron-0917")).toBe(true);
		expect(memorySources(tree.projectId)).toEqual({
			[tree.memories.early]: [
				{ session_id: tree.fork, event_ids: [tree.early], deleted: false },
			],
		});
		// 分叉的工作区和它相同：影子仓库留着
		expect(
			existsSync(snapshotDirectory(dirs.root, tree.projectId, dirs.workspace)),
		).toBe(true);
	});

	test("Host 分出来的分叉：父 session 删除之后还能恢复，发给模型的历史里分叉之前的对话都在", async () => {
		host = newHost((_request, index) => reply(`第 ${index + 1} 次回答`));
		const parent = await record(["分叉之前的任务"]);
		const log = new EventLog();
		const session = await host.forkSession({
			...options(dirs.workspace),
			sessionId: parent.sessionId,
			onEvent: log.push,
		});
		opened.push(session);
		const fork = (await log.waitFor("session.started")).session_id;
		await session.close();
		const ref = { directory: dirs.workspace, sessionId: parent.sessionId };
		expect(host.sessionForks(ref)).toEqual([fork]);

		expect(await host.deleteSession(ref)).toEqual({
			sessions: [parent.sessionId],
			memories: [],
		});
		expect(listed()).toEqual([fork]);

		const resumed = await resume(fork);
		await submit(resumed, "分叉里的任务");
		const [first, second] = requests as [ModelRequest, ModelRequest];
		expect(second.messages.slice(0, first.messages.length)).toEqual(
			first.messages,
		);
		expect(second.messages.slice(first.messages.length)).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "第 1 次回答" }] },
			{ role: "user", content: [{ type: "text", text: "分叉里的任务" }] },
		]);
	});

	test("带分叉删除：分叉先删；有一个正打开着就整个失败，什么也不删", async () => {
		const tree = await sessionTree();
		const all = { directory: dirs.workspace, sessionId: tree.parent };
		const held = holdSession(tree.nested);

		await expect(
			host.deleteSession({ ...all, withForks: true }),
		).rejects.toThrow(`session ${tree.nested} 正被一个 Host 进程打开着`);
		expect(listed().sort()).toEqual(
			[tree.parent, tree.fork, tree.nested].sort(),
		);
		// 已经取得的写锁都放掉了
		expect(existsSync(sessionLock(tree.parent))).toBe(false);
		expect(existsSync(sessionLock(tree.fork))).toBe(false);
		expect(Object.keys(memorySources(tree.projectId))).toHaveLength(2);

		held.release();
		const deleted = await host.deleteSession({ ...all, withForks: true });
		expect(deleted.sessions).toEqual([tree.nested, tree.fork, tree.parent]);
		expect(deleted.memories.sort()).toEqual(
			[tree.memories.early, tree.memories.late].sort(),
		);
		expect(host.listSessions()).toEqual([]);
		expect(recordBytes(tree.projectId).includes("heron-0917")).toBe(false);
		expect(memorySources(tree.projectId)).toEqual({});
		expect(
			existsSync(snapshotDirectory(dirs.root, tree.projectId, dirs.workspace)),
		).toBe(false);
	});
});

describe("exportSession", () => {
	const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

	test("第一行是元数据，之后每行一个事件，密钥换成占位；打开着的 session 也能导出", async () => {
		const current = await open([`密钥是 ${secret} 记住`]);
		const { sessionId } = current;
		const ref = { directory: dirs.workspace, sessionId };

		const lines = [...host.exportSession(ref)];
		const [header, ...events] = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		expect(header).toEqual({
			type: "session",
			format_version: storageVersion,
			session_id: sessionId,
			workspace: dirs.workspace,
			created_at: expect.any(String),
			last_written_at: expect.any(String),
			title: "密钥是 [REDACTED] 记住",
		});
		for (const event of events) {
			expect(event).toMatchObject({
				event_id: expect.any(String),
				session_id: sessionId,
				run_id: expect.any(String),
				seq: expect.any(Number),
				type: expect.any(String),
			});
		}
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"task.started",
				"message.completed",
				"task.ended",
			]),
		);
		// 记录里存的是原文，占位是导出时换上的
		expect(recordBytes(current.projectId).includes(secret)).toBe(true);
		expect(lines.join("\n")).not.toContain(secret);
		expect(events.find((event) => event.type === "task.started")).toMatchObject(
			{ data: { input: [{ type: "text", text: "密钥是 [REDACTED] 记住" }] } },
		);

		// 导出不取写锁：session 接着用，关闭之后再导出，原来的事件都还在
		await submit(current, "接着做");
		await current.session.close();
		expect(exportedEventIds(sessionId).slice(0, events.length)).toEqual(
			events.map((event) => event.event_id),
		);
	});

	test("遍历结束或中途停下时关闭数据库，结果可以再遍历", async () => {
		const { sessionId, projectId } = await record(["任务"]);
		// 最后一个连接关闭时 SQLite 删掉共享内存文件：它在就是还有连接开着
		const connected = () => existsSync(`${storePath(projectId)}-shm`);
		const exported = host.exportSession({
			directory: dirs.workspace,
			sessionId,
		});
		expect(connected()).toBe(false);

		const iterator = exported[Symbol.iterator]();
		expect(iterator.next().done).toBe(false);
		expect(connected()).toBe(true);
		iterator.return?.();
		expect(connected()).toBe(false);

		for (const line of exported) {
			expect(JSON.parse(line)).toMatchObject({ type: "session" });
			break;
		}
		expect(connected()).toBe(false);

		expect([...exported].length).toBeGreaterThan(1);
		expect(connected()).toBe(false);
	});
});

describe("rebuildSessions", () => {
	test("重建之后会话树不变，恢复的 session 发给模型的历史以原来的为前缀", async () => {
		host = newHost((_request, index) => reply(`第 ${index + 1} 次回答`));
		const { sessionId, projectId } = await record(["第一个任务"]);
		const tree = () => {
			const store = SessionStore.open(storePath(projectId));
			try {
				return {
					position: store.position(sessionId),
					runs: store.runs(sessionId),
					checkpoints: store.checkpoints(sessionId),
				};
			} finally {
				store.close();
			}
		};
		const before = tree();
		expect(before.position).not.toBeNull();

		host.rebuildSessions({ directory: dirs.workspace });

		expect(tree()).toEqual(before);
		expect(existsSync(sessionLock(sessionId))).toBe(false);
		const resumed = await resume(sessionId);
		await submit(resumed, "第二个任务");
		const [first, second] = requests as [ModelRequest, ModelRequest];
		expect(second.messages.slice(0, first.messages.length)).toEqual(
			first.messages,
		);
		expect(second.messages.slice(first.messages.length)).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "第 1 次回答" }] },
			{ role: "user", content: [{ type: "text", text: "第二个任务" }] },
		]);
	});

	test("项目里有 session 打开着时不能重建，已经取得的写锁都放掉", async () => {
		const closed = await record(["关了的"]);
		const current = await open(["开着的"]);

		expect(() => host.rebuildSessions({ directory: dirs.workspace })).toThrow(
			WorkspaceError,
		);
		expect(() => host.rebuildSessions({ directory: dirs.workspace })).toThrow(
			`session ${current.sessionId} 正被一个 Host 进程打开着`,
		);
		expect(existsSync(sessionLock(closed.sessionId))).toBe(false);
		// 打开着的 session 的写锁还是它的
		await submit(current, "接着做");

		await current.session.close();
		host.rebuildSessions({ directory: dirs.workspace });
	});
});

describe("保存期限", () => {
	test("默认保存 30 天，从最后一次写入算起；到期的彻底删除，记忆留着、来源标为已删除", async () => {
		const { sessionId, projectId } = await record(["任务 zebra-quartz-0917"]);
		const paths = sessionPaths(dirs.root, sessionId);
		const memory = addMemory(projectId, "来自到期的 session", sessionId, [
			"e1",
		]);
		const artifact = join(dirs.root, "cache", projectId, "artifact");
		writeFileSync(artifact, "构建产物");
		const written = lastWritten(sessionId);

		expect(await cleanAt(written + 30 * day - 1000)).toEqual([]);
		expect(listed()).toEqual([sessionId]);

		expect(await cleanAt(written + 30 * day + 1000)).toEqual([sessionId]);
		expect(host.listSessions()).toEqual([]);
		expect(recordBytes(projectId).includes("zebra-quartz-0917")).toBe(false);
		expect(existsSync(paths.tmp)).toBe(false);
		expect(existsSync(paths.output)).toBe(false);
		expect(
			existsSync(snapshotDirectory(dirs.root, projectId, dirs.workspace)),
		).toBe(false);
		expect(existsSync(artifact)).toBe(false);
		expect(memorySources(projectId)).toEqual({
			[memory]: [{ session_id: sessionId, event_ids: [], deleted: true }],
		});
		// 清理完放掉清理锁和 session 的写锁
		expect(readdirSync(join(dataDir(), "locks"))).toEqual([]);
	});

	test("天数取用户级配置的 session_retention_days", async () => {
		userConfig("session_retention_days = 7");
		const { sessionId } = await record(["任务"]);
		const written = lastWritten(sessionId);

		expect(await cleanAt(written + 7 * day - 1000)).toEqual([]);
		expect(await cleanAt(written + 7 * day + 1000)).toEqual([sessionId]);
	});

	test("期限设成很大的数时什么也不清理", async () => {
		userConfig("session_retention_days = 9007199254740991");
		const { sessionId } = await record(["任务"]);

		expect(await cleanAt(lastWritten(sessionId) + 10_000 * day)).toEqual([]);
		expect(listed()).toEqual([sessionId]);
	});

	test("跳过正打开着的 session 和 24 小时内写过的 session", async () => {
		userConfig("session_retention_days = 1");
		const closed = await record(["关了的"]);
		const current = await open(["开着的"]);
		const written = Math.max(
			lastWritten(closed.sessionId),
			lastWritten(current.sessionId),
		);

		expect(await cleanAt(written + 23 * hour)).toEqual([]);
		expect(listed().sort()).toEqual(
			[closed.sessionId, current.sessionId].sort(),
		);

		expect(await cleanAt(written + 25 * hour)).toEqual([closed.sessionId]);
		expect(listed()).toEqual([current.sessionId]);
		// 打开着的 session 的写锁还是它的，工作区的影子仓库也还在
		await submit(current, "接着做");

		await current.session.close();
		expect(await cleanAt(lastWritten(current.sessionId) + 25 * hour)).toEqual([
			current.sessionId,
		]);
	});

	test("清理锁被另一个还在运行的 Host 持有时什么也不做；持有者已经不在的锁接管过来", async () => {
		const { sessionId } = await record(["任务"]);
		const later = lastWritten(sessionId) + 40 * day;
		const cleanupLock = join(dataDir(), "locks", "cleanup.lock");
		const held = tryAcquireExclusiveLock(cleanupLock, identity());

		expect(await cleanAt(later)).toEqual([]);
		expect(listed()).toEqual([sessionId]);
		expect(existsSync(cleanupLock)).toBe(true);

		held?.release();
		// 这个 pid 超出了系统会分配的范围：持有它的进程不在了
		writeFileSync(cleanupLock, JSON.stringify({ ...identity(), pid: 2 ** 30 }));
		expect(await cleanAt(later)).toEqual([sessionId]);
		expect(existsSync(cleanupLock)).toBe(false);
	});

	test("到期的父 session 被清理时分叉留着：沿用的事件和记忆的来源改记到分叉名下，其余的来源标为已删除", async () => {
		const tree = await sessionTree();
		const inherited = exportedEventIds(tree.fork);
		// 分叉是刚建的，父 session 最后一次写入更早
		const later = lastWritten(tree.parent) + 30 * day + 1;
		expect(lastWritten(tree.fork)).toBeGreaterThan(lastWritten(tree.parent));

		expect(await cleanAt(later)).toEqual([tree.parent]);

		expect(listed().sort()).toEqual([tree.fork, tree.nested].sort());
		expect(exportedEventIds(tree.fork)).toEqual(inherited);
		expect(memorySources(tree.projectId)).toEqual({
			[tree.memories.early]: [
				{ session_id: tree.fork, event_ids: [tree.early], deleted: false },
			],
			[tree.memories.late]: [
				{ session_id: tree.parent, event_ids: [], deleted: true },
			],
		});
	});

	test("Host 的 cleanExpiredSessions 按当前时间清理：刚写过的 session 留着", async () => {
		const { sessionId } = await record(["任务"]);

		expect(await host.cleanExpiredSessions()).toEqual([]);
		expect(listed()).toEqual([sessionId]);
	});

	test.each(["0", "-3", "1.5", '"30"', "true"])(
		"session_retention_days = %s：配置错误",
		async (value) => {
			userConfig(`session_retention_days = ${value}`);

			expect(() => host.resolveConfig(options(dirs.workspace))).toThrow(
				ConfigError,
			);
			expect(() => host.resolveConfig(options(dirs.workspace))).toThrow(
				"session_retention_days 要是不小于 1 的整数（天）",
			);
			await expect(host.cleanExpiredSessions()).rejects.toThrow(ConfigError);
		},
	);

	test("仓库配置里的 session_retention_days 被忽略并列出，期限还是用户级配置的", async () => {
		execFileSync("git", ["init", "-q", dirs.workspace]);
		mkdirSync(join(dirs.workspace, ".ospreycode"));
		writeFileSync(
			join(dirs.workspace, ".ospreycode", "config.toml"),
			"session_retention_days = 1\n",
		);

		expect(host.resolveConfig(options(dirs.workspace)).warnings).toEqual([
			expect.stringMatching(/session_retention_days 只认用户级配置和启动参数/),
		]);
		const { sessionId } = await record(["任务"]);
		expect(await cleanAt(lastWritten(sessionId) + 2 * day)).toEqual([]);
		expect(listed()).toEqual([sessionId]);
	});
});
