import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type RunRecord,
	runStartedType,
	type SessionLocker,
	SessionStore,
	StorageError,
	type StoredEvent,
	storageVersion,
} from "@ospreycode/session-store";
import { afterEach, beforeEach, expect, test } from "vitest";

let dir: string;
let path: string;
const opened: SessionStore[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "osp-store-"));
	path = join(dir, "sessions.sqlite");
});

afterEach(() => {
	for (const store of opened.splice(0)) store.close();
	rmSync(dir, { recursive: true, force: true });
});

function open(): SessionStore {
	const store = SessionStore.open(path);
	opened.push(store);
	return store;
}

/** 进程内的写锁：同一个 session 同时只能被取得一次。 */
function locker(): SessionLocker {
	const held = new Set<string>();
	return async (sessionId) => {
		if (held.has(sessionId)) throw new Error(`session ${sessionId} 已被锁住`);
		held.add(sessionId);
		return { release: () => held.delete(sessionId) };
	};
}

let seq = 0;

function event(
	session: string,
	run: string,
	type: string,
	data: unknown,
	overrides: Partial<StoredEvent> = {},
): StoredEvent {
	seq += 1;
	return {
		event_id: `e${seq}`,
		session_id: session,
		run_id: run,
		seq,
		time: `2026-11-07T00:00:${String(seq).padStart(2, "0")}.000Z`,
		source: "host",
		task_id: `task-${run}`,
		agent_id: "agent",
		type,
		version: 1,
		data,
		...overrides,
	};
}

function runStarted(
	session: string,
	run: string,
	base: RunRecord["base"],
): StoredEvent {
	return event(
		session,
		run,
		runStartedType,
		{
			run_id: run,
			task_id: `task-${run}`,
			agent_id: "agent",
			base,
		} satisfies RunRecord,
		{ version: storageVersion },
	);
}

test("事件按写入顺序读回，重新打开之后还在；会话树按 run.started 维护", async () => {
	seq = 0;
	const store = open();
	const writer = await store.create(
		{
			session_id: "s",
			workspace: "/work",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		locker(),
	);
	writer.append(runStarted("s", "r1", null));
	writer.append(event("s", "r1", "task.started", { input: "修复测试" }));
	const end = event("s", "r1", "task.ended", { outcome: "completed" });
	writer.append(end);
	writer.append(runStarted("s", "r2", { run_id: "r1", seq: end.seq }));
	writer.append(event("s", "r2", "task.started", { input: "再来" }));
	writer.setTitle("修复测试");
	writer.setTitle("不会覆盖");
	writer.close();
	store.close();
	opened.length = 0;

	const reopened = open();
	expect(reopened.events("s").map((e) => `${e.run_id}:${e.type}`)).toEqual([
		"r1:run.started",
		"r1:task.started",
		"r1:task.ended",
		"r2:run.started",
		"r2:task.started",
	]);
	expect(reopened.events("s")[1]?.data).toEqual({ input: "修复测试" });
	expect(reopened.runs("s").map((run) => run.base)).toEqual([
		null,
		{ run_id: "r1", seq: end.seq },
	]);
	expect(reopened.position("s")).toEqual({ run_id: "r2", seq: 5 });
	expect(reopened.sessions()).toMatchObject([
		{ session_id: "s", workspace: "/work", title: "修复测试" },
	]);
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("按路径读取：每个 run 只取到下一个 run 接续的位置", async () => {
	seq = 0;
	const store = open();
	const writer = await store.create(
		{
			session_id: "s",
			workspace: "/w",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		locker(),
	);
	writer.append(runStarted("s", "r1", null));
	const kept = event("s", "r1", "message", "kept");
	writer.append(kept);
	writer.append(event("s", "r1", "message", "abandoned"));
	writer.append(runStarted("s", "r2", { run_id: "r1", seq: kept.seq }));
	const last = event("s", "r2", "message", "after");
	writer.append(last);
	expect(
		store.pathEvents("s", { run_id: "r2", seq: last.seq }).map((e) => e.data),
	).toEqual([
		{ run_id: "r1", task_id: "task-r1", agent_id: "agent", base: null },
		"kept",
		{
			run_id: "r2",
			task_id: "task-r2",
			agent_id: "agent",
			base: { run_id: "r1", seq: kept.seq },
		},
		"after",
	]);
});

test("同一个 session 只有一个写入者；同一个 run 里重复的 event_id 和序号被拒绝", async () => {
	seq = 0;
	const store = open();
	const lock = locker();
	const writer = await store.create(
		{
			session_id: "s",
			workspace: "/w",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		lock,
	);
	await expect(lock("s")).rejects.toThrow(/已被锁住/);
	const first = event("s", "r1", "x", 1);
	writer.append(first);
	expect(() => writer.append({ ...first, seq: 99 })).toThrow(/UNIQUE/);
	expect(() => writer.append({ ...first, event_id: "other" })).toThrow(
		/UNIQUE/,
	);
	expect(() =>
		writer.append(event("s", "r1", runStartedType, { run_id: "other" })),
	).toThrow(StorageError);
	writer.close();
	await lock("s");
});

test("大内容按摘要只存一份，只能由引用过它的 session 读取", async () => {
	const store = open();
	const lock = locker();
	const a = await store.create(
		{
			session_id: "a",
			workspace: "/w",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		lock,
	);
	const b = await store.create(
		{
			session_id: "b",
			workspace: "/w",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		lock,
	);
	const bytes = new TextEncoder().encode("一张很大的图片");
	const digest = a.putBlob(bytes);
	expect(digest).toMatch(/^[0-9a-f]{64}$/);
	expect(Buffer.from(store.blob("a", digest)).toString()).toBe(
		"一张很大的图片",
	);
	expect(() => store.blob("b", digest)).toThrow(StorageError);
	expect(b.putBlob(bytes)).toBe(digest);
	expect(Buffer.from(store.blob("b", digest)).toString()).toBe(
		"一张很大的图片",
	);
});

test("两个连接同时写不同的 session", async () => {
	seq = 0;
	const lock = locker();
	const first = open();
	const second = open();
	const a = await first.create(
		{
			session_id: "a",
			workspace: "/w",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		lock,
	);
	const b = await second.create(
		{
			session_id: "b",
			workspace: "/w",
			created_at: "2026-11-07T00:00:00.000Z",
		},
		lock,
	);
	for (let i = 0; i < 20; i++) {
		a.append(event("a", "r", "x", i));
		b.append(event("b", "r", "x", i));
	}
	expect(first.events("b")).toHaveLength(20);
	expect(second.events("a")).toHaveLength(20);
});

test("格式版本比程序新时报错，不打开", () => {
	open().close();
	opened.length = 0;
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA user_version = ${storageVersion + 1}`);
	db.close();
	expect(() => SessionStore.open(path)).toThrow(/只认识/);
});
