import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

const model = "claude-haiku-5-5";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;

beforeEach(() => {
	checkLedger();
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

function put(path: string, content: string): void {
	const target = join(dirs.workspace, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

/** 用真实模型打开 session：内置清单里的条目，只把地址换成中转服务，`fields` 再覆盖个别字段。 */
async function open(fields: ModelFields = {}): Promise<Session> {
	const entry: ModelFields = {
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 4_000,
		...fields,
	};
	session = await createHost({ root: dirs.root, env: dirs.env }).openSession({
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
	return session;
}

/** 这个 task 结束的事件；费用先记进账本，模型服务的临时故障抛出可以重跑的错误。 */
async function ended(taskId: string) {
	const event = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	charge(event.usage);
	throwIfTransient(event);
	return event;
}

/** 模型最后一条回复里的文字。 */
function lastReply(): string {
	const completed = log.events.filter((e) => e.type === "message.completed");
	return (completed.at(-1)?.message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/** 约 45 KB、680 行的清单，`read` 一次读得完；只有第 `recalled` 行的状态是 RECALLED。 */
function inventory(part: number, recalled: number): string {
	const lines: string[] = [];
	for (let index = 1; index <= 680; index++) {
		const id = `item-${part}${String(index).padStart(4, "0")}`;
		const shelf = `${"ABCDEFGH"[index % 8]}-${String(index % 97).padStart(3, "0")}`;
		const status = index === recalled ? "RECALLED" : "ok";
		lines.push(
			`${id} shelf=${shelf} quantity=${String((index * 37) % 500).padStart(3, "0")} supplier=northwind-${String(index % 23).padStart(2, "0")} status=${status}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

test("手动压缩之后，真实模型从自己写的摘要里答出压缩前的内容", {
	tags: ["model"],
}, async () => {
	const session = await open();

	const first = await ended(
		await session.submit(
			"The code word for this session is kestrel-4417. Reply with just OK.",
		),
	);
	expect(first.outcome).toBe("completed");

	const compacting = await ended(await session.compact());
	expect(compacting).toMatchObject({ outcome: "completed" });
	const compacted = await log.waitFor("context.compacted");
	expect(compacted.trigger).toBe("manual");
	expect(compacted.summary).toContain("kestrel-4417");

	const second = await ended(
		await session.submit(
			"What is the code word for this session? Reply with just the code word.",
		),
	);
	expect(second.outcome).toBe("completed");
	expect(lastReply()).toContain("kestrel-4417");
	expect(log.invalid).toEqual([]);
});

// 上下文长度设成 32,000：压缩的阈值是 (32,000 - 4,000) × 90% = 25,200 token。系统指令和工具声明
// 实测约 4,800 token，按每 token 1.7 字节估算也不到它的一半；两个清单各约 45 KB，都读进来后不论
// 怎么估算都超过它，所以任务中途一定要压缩。
test("读进来的文件让上下文超过阈值：真实模型在任务中途写摘要，再从摘要接着把任务做完", {
	tags: ["model"],
}, async () => {
	put("notes/part-1.txt", inventory(1, 212));
	put("notes/part-2.txt", inventory(2, 587));
	const session = await open({ context_window: 32_000 });

	const task = await ended(
		await session.submit(
			"Each of the files notes/part-1.txt and notes/part-2.txt has exactly one line whose status is RECALLED. Read notes/part-1.txt in full with the read tool, then read notes/part-2.txt in full with the read tool. Do not use the shell. Reply with the two item ids of the RECALLED lines.",
		),
	);

	expect(task).toMatchObject({ outcome: "completed" });
	const compactions = log.events.filter(
		(event) => event.type === "context.compacted",
	);
	expect(compactions.length).toBeGreaterThan(0);
	expect(compactions.map((event) => event.trigger)).toEqual(
		compactions.map(() => "auto"),
	);
	expect(lastReply()).toContain("item-10212");
	expect(lastReply()).toContain("item-20587");
	expect(log.invalid).toEqual([]);
});
