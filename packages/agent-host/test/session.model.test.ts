import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	createHost,
	type Session,
	type UserInput,
} from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import { EventLog, type TestDirectories, testDirectories } from "./harness.js";

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

/** 用真实模型做完一个 task，返回 `task.ended`。 */
async function runTask(input: string | UserInput[]) {
	// 内置清单里的条目，只把地址换成中转服务
	const entry: ModelFields = {
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
	session = await createHost({ root: dirs.root, env: dirs.env }).openSession({
		workspace: dirs.workspace,
		model: "claude-haiku-5-5",
		models: { "claude-haiku-5-5": entry },
		reasoningEffort: "off",
		credentials: {
			anthropic: { file: join(inject("modelKeysDir"), "anthropic") },
		},
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		budget: testRunLimits,
		onEvent: log.push,
	});
	await session.submit(input);
	const ended = await log.waitFor("task.ended");
	charge(ended.usage);
	throwIfTransient(ended);
	return ended;
}

/** 完成的工具调用：工具名和结果的状态。 */
function toolCalls(): [string, string][] {
	const names = new Map(
		log.events.flatMap((event) =>
			event.type === "tool_call.started"
				? [[event.tool_call_id, event.name] as const]
				: [],
		),
	);
	return log.events.flatMap((event) =>
		event.type === "tool_call.completed"
			? [[names.get(event.tool_call_id) ?? "", event.result.status]]
			: [],
	);
}

test("真实模型经通道请求模型、由 Host 执行 shell，完成任务", {
	tags: ["model"],
}, async () => {
	const ended = await runTask(
		"Use the shell tool to create a file named hello.txt in the workspace whose content is exactly the word osprey. Then reply with the single word: done.",
	);

	expect(ended.outcome).toBe("completed");
	expect(ended.usage.input).toBeGreaterThan(0);
	expect(readFileSync(join(dirs.workspace, "hello.txt"), "utf8").trim()).toBe(
		"osprey",
	);
	expect(toolCalls()).toContainEqual(["shell", "succeeded"]);
	expect(log.invalid).toEqual([]);
});

test("真实模型用 write 新建文件，再用 edit 改其中一处", {
	tags: ["model"],
}, async () => {
	const ended = await runTask(
		"Use the write tool to create notes.txt in the workspace with exactly two lines: `alpha` and `beta`. Then use the edit tool to replace `beta` with `gamma`. Do not use the shell tool. Then reply with the single word: done.",
	);

	expect(ended.outcome).toBe("completed");
	expect(
		readFileSync(join(dirs.workspace, "notes.txt"), "utf8").trim().split("\n"),
	).toEqual(["alpha", "gamma"]);
	expect(toolCalls()).toContainEqual(["write", "succeeded"]);
	expect(toolCalls()).toContainEqual(["edit", "succeeded"]);
	expect(log.invalid).toEqual([]);
});

/** 模型最后一条回复里的文字。 */
function lastReply(): string {
	const completed = log.events.filter((e) => e.type === "message.completed");
	return (completed.at(-1)?.message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/** 一张纯色的 PNG。 */
function png(width: number, height: number, rgb: number[]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	// 8 位、RGB、不隔行；每行开头一个过滤类型的字节
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.from([
		0,
		...Array.from({ length: width }, () => rgb).flat(),
	]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk(
			"IDAT",
			deflateSync(Buffer.concat(Array.from({ length: height }, () => row))),
		),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

test("真实模型看得到输入里提及的文件，不用再调用工具去读", {
	tags: ["model"],
}, async () => {
	writeFileSync(
		join(dirs.workspace, "notes.txt"),
		"The code word is kestrel-42.\n",
	);
	const ended = await runTask([
		{ type: "text", text: "What is the code word in " },
		{ type: "mention", path: "notes.txt" },
		{ type: "text", text: "? Reply with the code word only." },
	]);

	expect(ended.outcome).toBe("completed");
	expect(lastReply()).toContain("kestrel-42");
	expect(toolCalls()).toEqual([]);
	expect(log.invalid).toEqual([]);
});

test("真实模型看得到输入里附带的图片：超过尺寸上限的在沙盒里缩小后发出", {
	tags: ["model"],
}, async () => {
	const ended = await runTask([
		{
			type: "image",
			media_type: "image/png",
			data: png(2600, 1300, [255, 0, 0]).toString("base64"),
		},
		{
			type: "text",
			text: "What single color fills this image? Reply with one lowercase word.",
		},
	]);

	expect(ended.outcome).toBe("completed");
	expect(lastReply().toLowerCase()).toContain("red");
	expect(log.invalid).toEqual([]);
});

test("真实模型用 read 读工作区里的图片：图片随工具结果发给模型，超过尺寸上限的先缩小", {
	tags: ["model"],
}, async () => {
	writeFileSync(
		join(dirs.workspace, "picture.png"),
		png(2600, 1300, [0, 0, 255]),
	);
	const ended = await runTask(
		// 不说"不要用别的工具"时，模型有时会再用 shell 跑脚本数像素，答案就不一定来自图片
		"Use the read tool to look at picture.png in the workspace. Do not use any other tool. What single color fills it? Reply with one lowercase word.",
	);

	expect(ended.outcome).toBe("completed");
	expect(toolCalls()).toEqual([["read", "succeeded"]]);
	expect(lastReply().toLowerCase()).toContain("blue");
	expect(log.invalid).toEqual([]);
});
