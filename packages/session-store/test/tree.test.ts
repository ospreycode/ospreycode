import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type CheckpointCreated,
	type CheckpointSnapshot,
	type CheckpointsInherited,
	checkpointCreatedType,
	checkpointSnapshotType,
	checkpointsInheritedType,
	type EventRedaction,
	type ExportedEvent,
	type ExportHeader,
	eventRedactedType,
	type Position,
	type PositionMove,
	positionMovedType,
	type RunRecord,
	retainedCheckpoints,
	runStartedType,
	type SessionLocker,
	SessionStore,
	type SessionWriter,
	StorageError,
	type StoredEvent,
	storageVersion,
} from "@ospreycode/session-store";
import { afterEach, beforeEach, expect, test } from "vitest";

let dir: string;
let path: string;
const opened: SessionStore[] = [];
let lock: SessionLocker;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "osp-store-"));
	path = join(dir, "sessions.sqlite");
	const held = new Set<string>();
	lock = async (sessionId) => {
		if (held.has(sessionId)) throw new Error(`session ${sessionId} 已被锁住`);
		held.add(sessionId);
		return { release: () => held.delete(sessionId) };
	};
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

/** 一个 session 的写入者，替测试分配序号和 event_id。 */
class Recorder {
	readonly session: string;
	readonly writer: SessionWriter;
	#seqs = new Map<string, number>();
	#events = 0;

	constructor(session: string, writer: SessionWriter) {
		this.session = session;
		this.writer = writer;
	}

	#event(run: string, type: string, data: unknown, task: boolean): StoredEvent {
		const seq = (this.#seqs.get(run) ?? 0) + 1;
		this.#seqs.set(run, seq);
		this.#events += 1;
		const event: StoredEvent = {
			event_id: `${this.session}-e${this.#events}`,
			session_id: this.session,
			run_id: run,
			seq,
			time: `2026-11-11T00:00:${String(this.#events % 60).padStart(2, "0")}.000Z`,
			source: "host",
			task_id: task ? `task-${run}` : null,
			agent_id: task ? "agent" : null,
			type,
			version: storageVersion,
			data,
		};
		return event;
	}

	/** 在会话树上开始一个 run，接在 `base` 之后。 */
	run(run: string, base: Position | null): void {
		this.writer.append(
			this.#event(
				run,
				runStartedType,
				{
					run_id: run,
					task_id: `task-${run}`,
					agent_id: "agent",
					base,
				} satisfies RunRecord,
				true,
			),
		);
	}

	/** 写一个属于 task 的事件，返回它的位置。 */
	add(run: string, type: string, data: unknown): Position & { id: string } {
		const event = this.#event(run, type, data, true);
		this.writer.append(event);
		return { run_id: run, seq: event.seq, id: event.event_id };
	}

	/** 写一个不属于任何 task 的事件，第一次用到时先开始这个 run。 */
	housekeeping(type: string, data: unknown): StoredEvent {
		const run = `${this.session}-housekeeping`;
		if (!this.#seqs.has(run)) {
			this.writer.append(
				this.#event(
					run,
					runStartedType,
					{
						run_id: run,
						task_id: null,
						agent_id: null,
						base: null,
					} satisfies RunRecord,
					false,
				),
			);
		}
		const event = this.#event(run, type, data, false);
		this.writer.append(event);
		return event;
	}

	/** 一次用户输入和它的检查点，返回输入事件的位置。 */
	input(
		run: string,
		text: string,
		before: Position | null,
		kind: "task" | "steering" = "task",
	): Position & { id: string } {
		const input = this.add(run, "task.started", { input: text });
		this.add(run, checkpointCreatedType, {
			input_event_id: input.id,
			kind,
			before,
		} satisfies CheckpointCreated);
		return input;
	}

	move(to: Position | null): void {
		this.housekeeping(positionMovedType, { to } satisfies PositionMove);
	}

	/** 没有写进事件、只用来构造脱敏记录的事件外壳。 */
	record(type: string, data: unknown): StoredEvent {
		const run = `${this.session}-housekeeping`;
		if (!this.#seqs.has(run)) this.housekeeping("noop", null);
		return this.#event(run, type, data, false);
	}
}

async function create(store: SessionStore, session: string): Promise<Recorder> {
	return new Recorder(
		session,
		await store.create(
			{
				session_id: session,
				workspace: "/work",
				created_at: "2026-11-11T00:00:00.000Z",
			},
			lock,
		),
	);
}

async function fork(
	store: SessionStore,
	session: string,
	parent: string,
	position: Position,
): Promise<Recorder> {
	const recorder = new Recorder(
		session,
		await store.fork(
			{
				session_id: session,
				workspace: "/work",
				created_at: "2026-11-11T00:01:00.000Z",
			},
			{ parent_session_id: parent, position },
			lock,
		),
	);
	recorder.housekeeping(checkpointsInheritedType, {
		checkpoints: store
			.checkpoints(parent)
			.map(({ on_path: _, snapshot_ref: __, ...record }) => record),
	} satisfies CheckpointsInherited);
	return recorder;
}

function texts(events: StoredEvent[]): unknown[] {
	return events
		.filter(
			(event) => event.type === "message" || event.type === "task.started",
		)
		.map((event) =>
			event.type === "message"
				? event.data
				: (event.data as { input: string }).input,
		);
}

/** 两次输入的一个 session：r1 是第一次输入，r2 接在它后面是第二次。 */
async function twoInputs(store: SessionStore, session = "p") {
	const p = await create(store, session);
	p.run("r1", null);
	const first = p.input("r1", "第一次", null);
	p.add("r1", "message", "回复一");
	const end1 = p.add("r1", "task.ended", {});
	p.run("r2", end1);
	const second = p.input("r2", "第二次", end1);
	p.add("r2", "message", "回复二");
	const end2 = p.add("r2", "task.ended", {});
	return { p, first, end1, second, end2 };
}

test("回退把当前位置移到某次输入之前，被放弃的一段还在，可以再切回去", async () => {
	const store = open();
	const { p, end1, end2 } = await twoInputs(store);
	expect(store.position("p")).toEqual({ run_id: "r2", seq: end2.seq });

	p.move(end1);
	expect(store.position("p")).toEqual({ run_id: "r1", seq: end1.seq });
	expect(store.abandoned("p")).toEqual([{ run_id: "r2", seq: end2.seq }]);
	expect(store.events("p").some((event) => event.data === "回复二")).toBe(true);

	p.run("r3", end1);
	p.input("r3", "换一个问法", end1);
	const end3 = p.add("r3", "task.ended", {});
	expect(texts(store.pathEvents("p", end3))).toEqual([
		"第一次",
		"回复一",
		"换一个问法",
	]);
	expect(
		store
			.checkpoints("p")
			.map((c) => [
				texts(
					store.events("p").filter((e) => e.event_id === c.input_event_id),
				)[0],
				c.on_path,
			]),
	).toEqual([
		["第一次", true],
		["第二次", false],
		["换一个问法", true],
	]);

	p.move(end2);
	expect(store.position("p")).toEqual({ run_id: "r2", seq: end2.seq });
	expect(store.abandoned("p")).toEqual([{ run_id: "r3", seq: end3.seq }]);
	expect(texts(store.pathEvents("p", end2))).toEqual([
		"第一次",
		"回复一",
		"第二次",
		"回复二",
	]);

	// 回退到第一次输入之前：当前位置为空，原来的位置被放弃
	p.move(null);
	expect(store.position("p")).toBeNull();
	expect(store.abandoned("p")).toContainEqual({ run_id: "r2", seq: end2.seq });
	// 往前回退到自己路径上的位置时，原来的位置不算被放弃的（它不是一片叶子）
	p.move(end2);
	p.move(end1);
	p.move({ run_id: "r1", seq: 2 });
	expect(store.abandoned("p")).not.toContainEqual({
		run_id: "r1",
		seq: end1.seq,
	});
	expect(() => p.move({ run_id: "nowhere", seq: 1 })).toThrow(StorageError);
});

test("检查点记下输入的范围和各次快照；只留最近 100 个检查点的快照", async () => {
	const store = open();
	const p = await create(store, "p");
	p.run("r1", null);
	const first = p.input("r1", "任务", null);
	p.add("r1", checkpointSnapshotType, {
		input_event_id: first.id,
		commit: "c0",
		paths: [],
		origin: "external",
	} satisfies CheckpointSnapshot);
	p.add("r1", checkpointSnapshotType, {
		input_event_id: first.id,
		commit: "c1",
		paths: ["src/a.ts", "new.txt"],
		origin: "agent",
		tool_call_id: "call-1",
	} satisfies CheckpointSnapshot);
	const before = p.add("r1", "message", "中途");
	const steering = p.input("r1", "改一下方向", before, "steering");
	expect(store.checkpoints("p")).toEqual([
		{
			input_event_id: first.id,
			kind: "task",
			position: { run_id: "r1", seq: first.seq },
			before: null,
			cleaned: false,
			on_path: true,
			snapshot_ref: `p/${first.id}`,
			snapshots: [
				{ commit: "c0", paths: [], origin: "external" },
				{
					commit: "c1",
					paths: ["src/a.ts", "new.txt"],
					origin: "agent",
					tool_call_id: "call-1",
				},
			],
		},
		{
			input_event_id: steering.id,
			kind: "steering",
			position: { run_id: "r1", seq: steering.seq },
			before: { run_id: "r1", seq: before.seq },
			cleaned: false,
			on_path: true,
			snapshot_ref: null,
			snapshots: [],
		},
	]);
	expect(store.inputs("p")).toEqual([
		{
			input_event_id: first.id,
			kind: "task",
			run_id: "r1",
			from_seq: first.seq,
			to_seq: steering.seq - 1,
		},
		{
			input_event_id: steering.id,
			kind: "steering",
			run_id: "r1",
			from_seq: steering.seq,
			to_seq: null,
		},
	]);
	expect(() =>
		p.add("r1", checkpointSnapshotType, {
			input_event_id: "没有这个检查点",
			commit: "c",
			paths: [],
			origin: "agent",
		} satisfies CheckpointSnapshot),
	).toThrow(StorageError);

	for (let i = 0; i < retainedCheckpoints - 1; i++) {
		p.input("r1", `输入 ${i}`, { run_id: "r1", seq: 1 }, "steering");
	}
	const refs = [`p/${first.id}`, `p/${steering.id}`, "gone/x"];
	expect(store.checkpoints("p")[0]).toMatchObject({
		cleaned: true,
		snapshot_ref: null,
	});
	expect(store.checkpoints("p")[1]?.cleaned).toBe(false);
	// 清理过的检查点和已经没有的 session 的引用不再被引用；别的工作区的不归这里管
	expect(store.unreferencedSnapshots("/work", refs)).toEqual([
		`p/${first.id}`,
		"gone/x",
	]);
	expect(store.unreferencedSnapshots("/elsewhere", refs)).toEqual(refs);
});

test("分叉只读得到父 session 分叉位置之前的那一段，不复制事件", async () => {
	const store = open();
	const { p, end1, end2, first } = await twoInputs(store);
	const image = new TextEncoder().encode("第一轮的图片");
	const later = new TextEncoder().encode("第二轮的图片");
	const digest = p.writer.putBlob(image);
	const laterDigest = p.writer.putBlob(later);
	p.run("r4", end1);
	p.add("r4", "message", { image: { sha256: digest } });
	const forkAt = p.add("r4", "task.ended", {});
	p.add("r4", "message", { image: { sha256: laterDigest } });
	p.writer.setTitle("第一次");

	const f = await fork(store, "f", "p", forkAt);
	expect(store.session("f")).toMatchObject({
		title: "第一次",
		fork: {
			parent_session_id: "p",
			position: { run_id: "r4", seq: forkAt.seq },
		},
	});
	expect(store.position("f")).toEqual({ run_id: "r4", seq: forkAt.seq });
	expect(store.events("f").map((event) => event.type)).toEqual([
		runStartedType,
		checkpointsInheritedType,
	]);
	// 路径上的事件引用的大内容分叉读得到，分叉位置之后的读不到
	expect(Buffer.from(store.blob("f", digest)).toString()).toBe("第一轮的图片");
	expect(() => store.blob("f", laterDigest)).toThrow(StorageError);
	// 沿用父 session 的检查点索引，在不在路径上按分叉自己的当前位置算
	expect(
		store.checkpoints("f").map((c) => [c.input_event_id, c.on_path]),
	).toEqual([
		[first.id, true],
		[store.checkpoints("p")[1]?.input_event_id, false],
	]);

	f.run("f1", forkAt);
	f.input("f1", "分叉里的输入", forkAt);
	const fEnd = f.add("f1", "task.ended", {});
	expect(texts(store.pathEvents("f", fEnd))).toEqual([
		"第一次",
		"回复一",
		{ image: { sha256: digest } },
		"分叉里的输入",
	]);
	// 父 session 里分叉位置之后的事件、别的分支上的事件，分叉都读不到
	expect(() =>
		store.pathEvents("f", { run_id: "r4", seq: forkAt.seq + 1 }),
	).toThrow(StorageError);
	expect(() => store.pathEvents("f", end2)).toThrow(StorageError);
	expect(() => f.run("f2", end2)).toThrow(StorageError);
	expect(store.forks("p")).toEqual(["f"]);
	// 父 session 接着写不影响分叉
	p.add("r4", "message", "父 session 之后的内容");
	expect(texts(store.pathEvents("f", fEnd))).toHaveLength(4);
	await expect(
		fork(store, "bad", "p", { run_id: "r4", seq: 99 }),
	).rejects.toThrow(StorageError);
});

/** 库文件和 WAL 里有没有这段文字。 */
function onDisk(text: string): boolean {
	return readdirSync(dir).some((name) =>
		readFileSync(join(dir, name)).includes(text),
	);
}

test("删除父 session：多层分叉和并列的分叉各自接手仍引用的事件，其余彻底删除", async () => {
	const store = open();
	const { p, end1, end2 } = await twoInputs(store);
	const shared = p.writer.putBlob(new TextEncoder().encode("共用的大内容"));
	const own = p.writer.putBlob(
		new TextEncoder().encode("只有父 session 用的大内容"),
	);
	p.run("r3", end2);
	p.add("r3", "message", { ref: shared });
	const end3 = p.add("r3", "task.ended", {});
	p.add("r3", "message", { ref: own, text: "只在父 session 里的秘密" });

	// f1 从第二次输入之后分叉，f2 从 f1 分叉；g 是和 f1 并列的分叉，位置更靠后
	const f1 = await fork(store, "f1", "p", end2);
	f1.run("f1r", end2);
	f1.add("f1r", "message", "f1 的内容");
	const f1End = f1.add("f1r", "task.ended", {});
	const f2 = await fork(store, "f2", "f1", f1End);
	f2.run("f2r", f1End);
	const f2End = f2.add("f2r", "message", "f2 的内容");
	// f3 从 f1 沿用的那段路径（父 session 的 run）上分叉
	const f3 = await fork(store, "f3", "f1", end1);
	f3.run("f3r", end1);
	const f3End = f3.add("f3r", "message", "f3 的内容");
	const g = await fork(store, "g", "p", end3);
	g.run("gr", end3);
	const gEnd = g.add("gr", "message", "g 的内容");

	const before = {
		f1: texts(store.pathEvents("f1", f1End)),
		f2: texts(store.pathEvents("f2", f2End)),
		f3: texts(store.pathEvents("f3", f3End)),
		g: texts(store.pathEvents("g", gEnd)),
	};
	expect(before.g).toEqual([
		"第一次",
		"回复一",
		"第二次",
		"回复二",
		{ ref: shared },
		"g 的内容",
	]);
	expect(store.forks("p")).toEqual(["f1", "f2", "f3", "g"]);

	// 有写入者打开着的 session 删不了
	await expect(store.delete("p", lock)).rejects.toThrow(/已被锁住/);
	p.writer.close();
	const deleted = await store.delete("p", lock);
	expect(deleted.workspace).toBe("/work");
	expect(deleted.reowned).toEqual([
		{
			session_id: "f1",
			segments: [
				{ run_id: "r2", from_seq: 1, to_seq: end2.seq },
				{ run_id: "r1", from_seq: 1, to_seq: end1.seq },
			],
		},
		{
			session_id: "g",
			segments: [{ run_id: "r3", from_seq: 1, to_seq: end3.seq }],
		},
	]);

	expect(
		store
			.sessions()
			.map((s) => s.session_id)
			.sort(),
	).toEqual(["f1", "f2", "f3", "g"]);
	// f1 走到了根，不再有父 session；g 改为从 f1 分叉；f2、f3 不用动
	expect(store.session("f1").fork).toBeUndefined();
	expect(store.session("g").fork).toEqual({
		parent_session_id: "f1",
		position: { run_id: "r2", seq: end2.seq },
	});
	expect(store.session("f2").fork?.parent_session_id).toBe("f1");
	expect(texts(store.pathEvents("f1", f1End))).toEqual(before.f1);
	expect(texts(store.pathEvents("f2", f2End))).toEqual(before.f2);
	expect(texts(store.pathEvents("f3", f3End))).toEqual(before.f3);
	expect(texts(store.pathEvents("g", gEnd))).toEqual(before.g);
	expect(Buffer.from(store.blob("g", shared)).toString()).toBe("共用的大内容");

	// 只属于父 session 的事件和大内容在库文件和 WAL 里都找不到了
	expect(onDisk("只在父 session 里的秘密")).toBe(false);
	expect(onDisk("只有父 session 用的大内容")).toBe(false);
	expect(onDisk("共用的大内容")).toBe(true);

	// 再删中间的一层：f2、f3 接手 f1 名下的事件，g 也一样
	f1.writer.close();
	await store.delete("f1", lock);
	expect(texts(store.pathEvents("f2", f2End))).toEqual(before.f2);
	expect(texts(store.pathEvents("f3", f3End))).toEqual(before.f3);
	expect(texts(store.pathEvents("g", gEnd))).toEqual(before.g);
	expect(onDisk("f1 的内容")).toBe(true);
	f2.writer.close();
	await store.delete("f2", lock);
	expect(onDisk("f1 的内容")).toBe(false);

	// 重建索引得到同样的会话树，也找不回删掉的内容
	store.rebuild();
	expect(texts(store.pathEvents("f3", f3End))).toEqual(before.f3);
	expect(texts(store.pathEvents("g", gEnd))).toEqual(before.g);
	expect(store.sessions()).toHaveLength(2);
});

/** 索引表的全部内容，用来比较重建前后。 */
function indexes(): unknown {
	const db = new DatabaseSync(path);
	try {
		return {
			sessions: db
				.prepare(
					"SELECT session_id, current_run_id, current_seq, parent_session_id, fork_run_id, fork_seq FROM sessions ORDER BY session_id",
				)
				.all(),
			runs: db.prepare("SELECT * FROM runs ORDER BY session_id, rowid").all(),
			abandoned: db
				.prepare("SELECT * FROM abandoned_positions ORDER BY session_id, rowid")
				.all(),
			checkpoints: db
				.prepare("SELECT * FROM checkpoints ORDER BY session_id, rowid")
				.all(),
		};
	} finally {
		db.close();
	}
}

test("会话树和检查点索引能从事件表重建", async () => {
	const store = open();
	const { p, first, end1, end2 } = await twoInputs(store);
	p.add("r2", checkpointSnapshotType, {
		input_event_id: first.id,
		commit: "c1",
		paths: ["a"],
		origin: "agent",
	} satisfies CheckpointSnapshot);
	p.move(end1);
	p.run("r3", end1);
	p.input("r3", "另一个问法", end1);
	const end3 = p.add("r3", "task.ended", {});
	const f = await fork(store, "f", "p", end3);
	f.move({ run_id: "r1", seq: first.seq });
	f.run("fr", { run_id: "r1", seq: first.seq });
	f.input("fr", "分叉里回退之后的输入", { run_id: "r1", seq: first.seq });
	const g = await fork(store, "g", "p", end2);
	g.housekeeping("noop", null);

	const expected = indexes();
	const db = new DatabaseSync(path);
	db.exec(
		"DELETE FROM runs; DELETE FROM abandoned_positions; DELETE FROM checkpoints; UPDATE sessions SET current_run_id = NULL, current_seq = NULL;",
	);
	db.close();
	store.rebuild();
	expect(indexes()).toEqual(expected);
	expect(store.position("g")).toEqual({ run_id: "r2", seq: end2.seq });
});

test("导出：第一行是元数据，之后每行一个事件，大内容内嵌，分叉带父 session 的前缀", async () => {
	const store = open();
	const { p, end2 } = await twoInputs(store);
	p.writer.setTitle("标题里有 sk-secret");
	const text = p.writer.putBlob(new TextEncoder().encode("输出里有 sk-secret"));
	const binary = p.writer.putBlob(new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
	p.run("r3", end2);
	p.add("r3", "message", { text: "密钥是 sk-secret", output: text });
	p.add("r3", "message", { image: binary, again: text });
	const forkAt = p.add("r3", "task.ended", {});
	p.add("r3", "message", "分叉之后的内容");
	const f = await fork(store, "f", "p", forkAt);
	f.run("fr", forkAt);
	f.add("fr", "message", "分叉自己的内容");

	const redact = (value: string) => value.replaceAll("sk-secret", "[REDACTED]");
	const lines = [...store.export("f", redact)].map(
		(line) => JSON.parse(line) as ExportHeader | ExportedEvent,
	);
	expect(lines[0]).toMatchObject({
		type: "session",
		format_version: storageVersion,
		session_id: "f",
		workspace: "/work",
		title: "标题里有 [REDACTED]",
		fork: {
			parent_session_id: "p",
			position: { run_id: "r3", seq: forkAt.seq },
		},
	});
	const events = lines.slice(1) as ExportedEvent[];
	expect(texts(events)).toEqual([
		"第一次",
		"回复一",
		"第二次",
		"回复二",
		{ text: "密钥是 [REDACTED]", output: text },
		{ image: binary, again: text },
		"分叉自己的内容",
	]);
	const withBlobs = events.filter((event) => event.blobs !== undefined);
	// 同一份大内容只在第一次引用它的事件那一行内嵌
	expect(withBlobs.map((event) => Object.keys(event.blobs ?? {}))).toEqual([
		[text],
		[binary],
	]);
	expect(
		Buffer.from(withBlobs[0]?.blobs?.[text] ?? "", "base64").toString(),
	).toBe("输出里有 [REDACTED]");
	expect([
		...Buffer.from(withBlobs[1]?.blobs?.[binary] ?? "", "base64"),
	]).toEqual([0xff, 0xfe, 0x00, 0x01]);
	expect(events.every((event) => typeof event.event_id === "string")).toBe(
		true,
	);
});

test("按事件脱敏：覆盖事件的内容和它引用的大内容，追加一条脱敏事件", async () => {
	const store = open();
	const { p, end2 } = await twoInputs(store);
	const secret = new TextEncoder().encode("要忘掉的输出");
	const digest = p.writer.putBlob(secret);
	const kept = p.writer.putBlob(new TextEncoder().encode("留下的输出"));
	p.run("r3", end2);
	const target = p.add("r3", "message", { text: "要忘掉的话", output: digest });
	const copy = p.add("r3", "raw", { text: "要忘掉的话的原文" });
	p.add("r3", "message", { output: kept });
	const forkAt = p.add("r3", "task.ended", {});
	const f = await fork(store, "f", "p", forkAt);

	expect(store.redactionScope("p", [target, copy])).toEqual({
		blobs: [digest],
		sessions: ["f"],
	});
	const positions = [target, copy].map(({ run_id, seq }) => ({ run_id, seq }));
	const record = p.record(eventRedactedType, {
		events: positions,
	} satisfies EventRedaction);
	expect(() =>
		p.writer.redact(
			record,
			[{ ...positions[0], data: null } as Position & { data: unknown }],
			new Uint8Array(),
		),
	).toThrow(StorageError);
	const placeholder = new TextEncoder().encode("[已脱敏]");
	expect(
		p.writer.redact(
			record,
			positions.map((position) => ({
				...position,
				data: { text: "[已脱敏]" },
			})),
			placeholder,
		),
	).toEqual([digest]);

	expect(onDisk("要忘掉的话")).toBe(false);
	expect(onDisk("要忘掉的输出")).toBe(false);
	expect(onDisk("留下的输出")).toBe(true);
	const events = store.events("p");
	expect(
		events.find((e) => e.seq === target.seq && e.run_id === "r3")?.data,
	).toEqual({ text: "[已脱敏]" });
	expect(events.at(-1)).toMatchObject({
		type: eventRedactedType,
		data: { events: positions },
	});
	// 分叉沿用这个事件，读到的也是占位内容；它引用的大内容也一样
	expect(
		store
			.pathEvents("f", forkAt)
			.find((e) => e.seq === target.seq && e.run_id === "r3")?.data,
	).toEqual({ text: "[已脱敏]" });
	expect(Buffer.from(store.blob("f", digest)).toString()).toBe("[已脱敏]");
	// 分叉也可以对沿用的事件脱敏，但够不到父 session 分叉之后的事件
	const after = p.add("r3", "message", "分叉之后");
	const beyond = f.record(eventRedactedType, {
		events: [{ run_id: "r3", seq: after.seq }],
	} satisfies EventRedaction);
	expect(() =>
		f.writer.redact(
			beyond,
			[{ run_id: "r3", seq: after.seq, data: null }],
			placeholder,
		),
	).toThrow(StorageError);
	// 用户重新给出同样的内容时存回去
	expect(p.writer.putBlob(secret)).toBe(digest);
	expect(Buffer.from(store.blob("p", digest)).toString()).toBe("要忘掉的输出");
});

test("按事件脱敏时给了标题：这个 session 的标题一起换掉，别的 session 的不动", async () => {
	const store = open();
	const { p, first, end2 } = await twoInputs(store);
	p.writer.setTitle("要忘掉的第一行");
	const f = await fork(store, "f", "p", end2);
	const positions = [{ run_id: first.run_id, seq: first.seq }];
	const redact = (recorder: Recorder, events: Position[], title?: string) =>
		recorder.writer.redact(
			recorder.record(eventRedactedType, {
				events,
			} satisfies EventRedaction),
			events.map((position) => ({ ...position, data: { input: "[已脱敏]" } })),
			new Uint8Array(),
			title,
		);

	// 不给标题时标题不变
	redact(p, positions);
	expect(store.session("p").title).toBe("要忘掉的第一行");
	redact(p, positions, "[已脱敏]");
	expect(store.session("p").title).toBe("[已脱敏]");
	expect(store.session("f").title).toBe("要忘掉的第一行");
	// 分叉没有自己要覆盖的事件，也能只换标题
	redact(f, [], "[已脱敏]");
	expect(store.session("f").title).toBe("[已脱敏]");
	expect(onDisk("要忘掉的第一行")).toBe(false);
	expect(store.events("f").at(-1)).toMatchObject({
		type: eventRedactedType,
		data: { events: [] },
	});
});

test("sessionsMentioning：只列出自己的事件内容里出现过这段文字的 session", async () => {
	const store = open();
	const { p, end2 } = await twoInputs(store);
	p.run("r3", end2);
	p.add("r3", "message", { text: "索引里有 [p-0a1b2c3d] 这一条" });
	const forkAt = p.add("r3", "task.ended", {});
	// 分叉沿用了父 session 的那个事件，自己的事件里没有
	const f = await fork(store, "f", "p", forkAt);
	await twoInputs(store, "o");

	expect(store.sessionsMentioning("p-0a1b2c3d")).toEqual(["p"]);
	f.run("r4", forkAt);
	f.add("r4", "listed", { candidates: [{ id: "p-0a1b2c3d" }] });
	expect(store.sessionsMentioning("p-0a1b2c3d")).toEqual(["p", "f"]);
	expect(store.sessionsMentioning("p-ffffffff")).toEqual([]);
	// 匹配的是 JSON 文本：要转义的字符匹配不上，直接拒绝
	expect(() => store.sessionsMentioning('带"引号')).toThrow(StorageError);
	expect(() => store.sessionsMentioning("")).toThrow(StorageError);
});

test("恢复：重新取得已有 session 的写锁接着写", async () => {
	const store = open();
	const { p, end2 } = await twoInputs(store);
	await expect(store.resume("p", lock)).rejects.toThrow(/已被锁住/);
	p.writer.close();
	await expect(store.resume("没有", lock)).rejects.toThrow(StorageError);
	const writer = await store.resume("p", lock);
	const resumed = new Recorder("p", writer);
	resumed.run("r9", end2);
	resumed.add("r9", "message", "恢复之后");
	expect(store.position("p")).toEqual({ run_id: "r9", seq: 2 });
	expect(store.runs("p").at(-1)?.base).toEqual({ run_id: "r2", seq: end2.seq });
});

const version1 = `
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, last_written_at TEXT NOT NULL, title TEXT, current_run_id TEXT, current_seq INTEGER) STRICT;
CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions (session_id), run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, time TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('host', 'runtime')), task_id TEXT, agent_id TEXT, type TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, run_id, seq), UNIQUE (session_id, run_id, event_id)) STRICT;
CREATE TABLE runs (session_id TEXT NOT NULL REFERENCES sessions (session_id), run_id TEXT NOT NULL, task_id TEXT, agent_id TEXT, parent_agent_id TEXT, parent_tool_call_id TEXT, base_run_id TEXT, base_seq INTEGER, PRIMARY KEY (session_id, run_id)) STRICT;
CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;
CREATE TABLE blob_refs (sha256 TEXT NOT NULL REFERENCES blobs (sha256), session_id TEXT NOT NULL REFERENCES sessions (session_id), PRIMARY KEY (sha256, session_id)) STRICT;
INSERT INTO sessions VALUES ('old', '/work', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:02.000Z', '旧的任务', 'r1', 2);
INSERT INTO events VALUES ('old', 'r1', 1, 'e1', '2026-11-01T00:00:01.000Z', 'host', 't1', 'a1', 'run.started', 1, '{"run_id":"r1","task_id":"t1","agent_id":"a1","base":null}');
INSERT INTO events VALUES ('old', 'r1', 2, 'e2', '2026-11-01T00:00:02.000Z', 'host', 't1', 'a1', 'task.started', 1, '{"input":"旧的任务"}');
INSERT INTO runs VALUES ('old', 'r1', 't1', 'a1', NULL, NULL, NULL, NULL);
PRAGMA user_version = 1;
`;

test("第 1 版的库打开时迁移到第 2 版，原有的内容不变，备份在成功后删除", async () => {
	const db = new DatabaseSync(path);
	db.exec(version1);
	db.close();

	const store = open();
	expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toEqual([]);
	const check = new DatabaseSync(path);
	expect(check.prepare("PRAGMA user_version").get()).toEqual({
		user_version: storageVersion,
	});
	check.close();
	expect(store.sessions()).toEqual([
		{
			session_id: "old",
			workspace: "/work",
			created_at: "2026-11-01T00:00:00.000Z",
			last_written_at: "2026-11-01T00:00:02.000Z",
			title: "旧的任务",
		},
	]);
	expect(store.position("old")).toEqual({ run_id: "r1", seq: 2 });
	expect(store.checkpoints("old")).toEqual([]);

	// 迁移之后新的功能可用：接着写、回退、分叉
	const old = new Recorder("old", await store.resume("old", lock));
	old.run("r2", { run_id: "r1", seq: 2 });
	const input = old.input("r2", "新的输入", { run_id: "r1", seq: 2 });
	old.move({ run_id: "r1", seq: 2 });
	expect(store.abandoned("old")).toHaveLength(1);
	expect(store.checkpoints("old")[0]).toMatchObject({
		input_event_id: input.id,
		on_path: false,
	});
	await fork(store, "new", "old", { run_id: "r1", seq: 2 });
	expect(store.forks("old")).toEqual(["new"]);
	// 重建索引时第 1 版写的 run.started 照常接受
	store.rebuild();
	expect(store.runs("old")).toHaveLength(3);
});

test("迁移失败时留下备份，删除 session 时一起删掉", async () => {
	const db = new DatabaseSync(path);
	// 已经有一张同名的表，迁移会失败
	db.exec(`${version1} CREATE TABLE checkpoints (x TEXT);`);
	db.close();
	expect(() => SessionStore.open(path)).toThrow(/checkpoints/);
	const backup = `${path}.v1.bak`;
	expect(existsSync(backup)).toBe(true);
	const copy = new DatabaseSync(backup);
	expect(copy.prepare("SELECT title FROM sessions").get()).toEqual({
		title: "旧的任务",
	});
	copy.close();
	// 原来的库没有变，去掉那张表之后能迁移
	const fix = new DatabaseSync(path);
	expect(fix.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
	fix.exec("DROP TABLE checkpoints");
	fix.close();
	const store = open();
	expect(existsSync(backup)).toBe(false);
	// 备份里有整个库的内容，删除 session 时不能留着
	const stale = new DatabaseSync(backup);
	stale.exec("CREATE TABLE leftover (x TEXT)");
	stale.close();
	await store.delete("old", lock);
	expect(existsSync(backup)).toBe(false);
	expect(store.sessions()).toEqual([]);
});

test("子 agent 的 run 不在会话树的路径上：事件不移动当前位置，里面的位置不能接续、回退", async () => {
	const store = open();
	const p = await create(store, "p");
	p.run("r1", null);
	p.input("r1", "第一次", null);
	const call = p.add("r1", "tool_call.started", {});
	const child = (
		run: string,
		seq: number,
		type: string,
		data: unknown,
	): StoredEvent => ({
		event_id: `${run}-${seq}`,
		session_id: "p",
		run_id: run,
		seq,
		time: "2026-11-11T00:00:30.000Z",
		source: "host",
		task_id: "task-r1",
		agent_id: "sub",
		type,
		version: storageVersion,
		data,
	});
	const record = (run: string, extra: Partial<RunRecord>): RunRecord => ({
		run_id: run,
		task_id: "task-r1",
		agent_id: "sub",
		base: null,
		...extra,
	});
	const parents = { parent_agent_id: "agent", parent_tool_call_id: "call-1" };
	p.writer.append(child("c1", 1, runStartedType, record("c1", parents)));
	p.writer.append(child("c1", 2, "message", "子 agent 的回复"));
	expect(store.position("p")).toEqual({ run_id: "r1", seq: call.seq });

	// 父 run 接着写，子 run 的事件交错其间
	p.add("r1", "message", "回复一");
	p.writer.append(child("c1", 3, "message", "子 agent 的第二条回复"));
	const end = p.add("r1", "task.ended", {});
	expect(store.position("p")).toEqual({ run_id: "r1", seq: end.seq });
	expect(texts(store.pathEvents("p", end))).toEqual(["第一次", "回复一"]);
	expect(store.runs("p").find((run) => run.run_id === "c1")).toEqual(
		record("c1", parents),
	);

	// 重建之后一样
	store.rebuild();
	expect(store.position("p")).toEqual({ run_id: "r1", seq: end.seq });

	// 子 run 里的位置不在会话树里
	const inChild = { run_id: "c1", seq: 2 };
	expect(() =>
		p.writer.append({
			...child("r2", 1, runStartedType, {
				run_id: "r2",
				task_id: "task-r2",
				agent_id: "agent",
				base: inChild,
			} satisfies RunRecord),
			task_id: "task-r2",
			agent_id: "agent",
		}),
	).toThrow(StorageError);
	expect(() => p.move(inChild)).toThrow(StorageError);
	// 两个父字段要一起出现，`base` 要为空
	expect(() =>
		p.writer.append(
			child(
				"c2",
				1,
				runStartedType,
				record("c2", { parent_agent_id: "agent" }),
			),
		),
	).toThrow(StorageError);
	expect(() =>
		p.writer.append(
			child("c3", 1, runStartedType, record("c3", { ...parents, base: end })),
		),
	).toThrow(StorageError);
});
