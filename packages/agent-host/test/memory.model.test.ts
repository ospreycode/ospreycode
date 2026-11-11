import { join } from "node:path";
import {
	createHost,
	type MemoryManager,
	type Session,
} from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	expectNoModelError,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

const model = "claude-haiku-5-5";

let dirs: TestDirectories;
let sessions: Session[];
let log: EventLog;

beforeEach(() => {
	checkLedger();
	dirs = testDirectories();
	sessions = [];
	log = new EventLog();
});

afterEach(async () => {
	for (const session of sessions) await session.close();
	dirs.cleanup();
});

/** 用真实模型打开 session：内置清单里的条目，只把地址换成中转服务。非交互，候选不会自动生效。 */
async function open(): Promise<Session> {
	const entry: ModelFields = {
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
	const session = await createHost({
		root: dirs.root,
		env: dirs.env,
	}).openSession({
		workspace: dirs.workspace,
		model,
		models: { [model]: entry },
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		budget: testRunLimits,
		onEvent: log.push,
	});
	sessions.push(session);
	return session;
}

async function close(session: Session): Promise<void> {
	await session.close();
	sessions = sessions.filter((item) => item !== session);
}

async function runTask(session: Session, input: string): Promise<void> {
	const taskId = await session.submit(input);
	const ended = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	charge(ended.usage);
	throwIfTransient(ended);
	expect(ended.outcome).toBe("completed");
}

function manager(session: Session): MemoryManager {
	const { memory } = session;
	if (memory === undefined) throw new Error("这个 session 没有启用长期记忆");
	return memory;
}

/** 模型最后一条回复里的文字。 */
function lastReply(): string {
	const completed = log.events.filter((e) => e.type === "message.completed");
	return (completed.at(-1)?.message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

test("用户要求记住时真实模型调用 memory_propose，候选待确认；确认后新的 session 读了正文再回答", {
	tags: ["model"],
}, async () => {
	const first = await open();
	await runTask(
		first,
		"Please remember this for future sessions in this project: the staging server is called `heron-staging-7`, and deploys to it go through `make ship-staging`, never `make deploy`. Then reply with just OK.",
	);
	const [candidate] = manager(first).list();
	expect(candidate).toMatchObject({
		scope: "project",
		status: "pending",
		origin: "untrusted",
	});
	if (candidate === undefined) throw new Error("模型没有提议候选");
	expect(`${candidate.title}\n${candidate.body}`).toContain("heron-staging-7");
	expect(candidate.body).toContain("make ship-staging");
	// 非交互运行时不自动生效：由调用方确认，标题换成不带答案的
	manager(first).confirm(candidate.id, candidate.version, {
		title: "How deploys to staging work in this project",
	});
	await close(first);

	const second = await open();
	await runTask(
		second,
		"Which command deploys this project to staging, and what is the staging server called? Reply with just those two.",
	);
	const retrieved = log.events.flatMap((event) =>
		event.type === "memory.retrieved" ? event.memory_ids : [],
	);
	expect(retrieved).toContain(candidate.id);
	expect(lastReply()).toContain("make ship-staging");
	expect(lastReply()).toContain("heron-staging-7");
	expect(log.invalid).toEqual([]);
});

test("真实模型从已关闭 session 的记录里提取候选，回复符合约定的格式", {
	tags: ["model"],
}, async () => {
	const source = await open();
	await runTask(
		source,
		"FYI, no action needed: in this project the unit tests must be run with `npm run test:unit`. Plain `npm test` also starts the end-to-end suite, which needs a Postgres instance we do not have locally, so it always fails with ECONNREFUSED 127.0.0.1:5432. Reply with just OK.",
	);
	// 这里只看后台提取：模型在任务里自己提议的不算
	for (const record of manager(source).list()) {
		manager(source).reject(record.id, record.version);
	}
	await close(source);

	const session = await open();
	const ended = await session.extractMemory(source.id);
	charge(ended.usage);
	// 提取失败时错误信息写成"模型请求失败（类别）：信息"：模型服务的临时故障重跑一次
	const failure = /^模型请求失败（(\w+)）：(.*)$/su.exec(ended.error ?? "");
	if (failure !== null) {
		expectNoModelError({
			category: failure[1] as string,
			message: failure[2] as string,
		});
	}
	expect(ended.error).toBeUndefined();
	expect(ended).toMatchObject({ outcome: "completed", requests: 1 });
	expect(ended.candidate_ids.length).toBeGreaterThan(0);
	const candidates = manager(session)
		.list()
		.filter((record) => ended.candidate_ids.includes(record.id));
	expect(candidates.map((record) => record.status)).toEqual(
		candidates.map(() => "pending"),
	);
	expect(
		candidates.map((record) => `${record.title}\n${record.body}`).join("\n"),
	).toContain("npm run test:unit");
	// 来源指向那个 session 里的事件
	for (const record of candidates) {
		expect(record.sources.sessions.map((s) => s.session_id)).toEqual([
			source.id,
		]);
	}
	expect(log.invalid).toEqual([]);
});
