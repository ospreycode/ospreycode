import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type OpenSessionOptions,
	type Session,
} from "@ospreycode/agent-host";
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

/** 用真实模型打开 session 的选项：内置清单里的条目，只把地址换成中转服务。 */
function options(): OpenSessionOptions {
	return {
		workspace: dirs.workspace,
		model,
		models: {
			[model]: { base_url: inject("modelBaseUrl"), max_output_tokens: 4_000 },
		},
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		budget: testRunLimits,
		onEvent: log.push,
	};
}

const host = () => createHost({ root: dirs.root, env: dirs.env });

/** 开始一个 task 并等它结束；费用先记进账本，模型服务的临时故障抛出可以重跑的错误。 */
async function task(input: string) {
	if (session === undefined) throw new Error("session 还没有打开");
	const taskId = await session.submit(input);
	const event = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	charge(event.usage);
	throwIfTransient(event);
	expect(event.outcome).toBe("completed");
}

/** 模型最后一条回复里的文字。 */
function lastReply(): string {
	const completed = log.events.filter((e) => e.type === "message.completed");
	return (completed.at(-1)?.message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

const asked =
	"What is the code word for this session? Reply with just the code word.";

test("关闭之后恢复 session，真实模型接着之前的对话", {
	tags: ["model"],
}, async () => {
	session = await host().openSession(options());
	await task(
		"The code word for this session is kestrel-4417. Reply with just OK.",
	);
	const id = session.id;
	await session.close();

	session = await host().resumeSession({ ...options(), sessionId: id });
	await task(asked);
	expect(lastReply()).toContain("kestrel-4417");
	expect(log.invalid).toEqual([]);
});

test("撤销真实模型用工具做的改动：文件回到那次输入之前，模型知道文件还原了", {
	tags: ["model"],
}, async () => {
	const notes = join(dirs.workspace, "notes.txt");
	writeFileSync(notes, "alpha\n");
	session = await host().openSession(options());
	await task(
		"Replace the entire contents of notes.txt with the single word beta. Then reply with just DONE.",
	);
	expect(readFileSync(notes, "utf8").trim()).toBe("beta");

	const [checkpoint] = session.checkpoints();
	if (checkpoint === undefined) throw new Error("没有检查点");
	const undone = await session.undo(checkpoint.id);
	expect(undone).toMatchObject({ restored: ["notes.txt"], conflicts: [] });
	expect(readFileSync(notes, "utf8")).toBe("alpha\n");

	await task(
		"What does notes.txt contain right now? Reply with just its contents.",
	);
	expect(lastReply()).toContain("alpha");
	expect(lastReply()).not.toContain("beta");
	expect(log.invalid).toEqual([]);
});

test("回退之后真实模型看不到被放弃的那一段，切回那个分支又看得到", {
	tags: ["model"],
}, async () => {
	session = await host().openSession(options());
	await task(
		"The code word for this session is kestrel-4417. Reply with just OK.",
	);
	await task(
		"The code word has changed: it is now osprey-9921 and the old one is void. Reply with just OK.",
	);
	const [, second] = session.checkpoints();
	if (second === undefined) throw new Error("没有第二个检查点");

	await session.rewind(second.id);
	await task(asked);
	expect(lastReply()).toContain("kestrel-4417");
	expect(lastReply()).not.toContain("osprey-9921");

	const [abandoned] = session.branches();
	if (abandoned === undefined) throw new Error("没有被放弃的分支");
	await session.switchBranch(abandoned.id);
	await task(asked);
	expect(lastReply()).toContain("osprey-9921");
	expect(log.invalid).toEqual([]);
});
