import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { type Script, scriptedModel } from "@ospreycode/api/testing";
import { SessionStore } from "@ospreycode/session-store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	log = new EventLog();
	requests = [];
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	expect(log.invalid).toEqual([]);
});

async function open(script: Script): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(request);
			return script(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

const text = (value: string) => [{ type: "text" as const, text: value }];

/** 请求里的对话：去掉系统指令和会话开始的上下文消息。 */
function conversation(request: ModelRequest | undefined): Message[] {
	return (request?.messages ?? []).slice(2);
}

test("输入里提及的文件由 runtime 读进这条用户消息；事件里记的是展开之前的输入", async () => {
	writeFileSync(join(dirs.workspace, "notes.txt"), "第一行\n第二行\n");
	const current = await open(() => say("看过了"));
	const started = await log.waitFor("session.started");
	const input = [
		...text("总结一下 "),
		{ type: "mention" as const, path: "notes.txt" },
		...text("\n要短"),
	];
	const taskId = await current.submit(input);
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });

	expect(await log.waitFor("task.started")).toMatchObject({ input });
	const expanded = [
		...text("总结一下 "),
		...text('<file path="notes.txt">\n第一行\n第二行\n</file>'),
		...text("\n要短"),
	];
	expect(conversation(requests[0])[0]?.content).toEqual(expanded);

	await current.close();
	session = undefined;
	const store = SessionStore.open(
		join(dirs.root, "data", "projects", started.project_id, "sessions.sqlite"),
	);
	try {
		// 重启后按 `message.sent` 重建历史：记下的是展开后的内容，之后文件变了也不重新读
		const sent = store
			.events(current.id)
			.filter((event) => event.type === "message.sent")
			.map((event) => (event.data as { message: Message }).message);
		expect(sent.at(-1)).toMatchObject({ role: "user", content: expanded });
		expect(store.sessions()).toMatchObject([{ title: "总结一下 @notes.txt" }]);
	} finally {
		store.close();
	}
});

test("steering 和 follow-up 里的提及在各自进入上下文时读取", async () => {
	const file = join(dirs.workspace, "state.txt");
	writeFileSync(file, "排队时的内容\n");
	const current = await open((_request, call) => {
		if (call === 0) {
			current.steer([{ type: "mention", path: "state.txt" }]);
			current.followUp([
				...text("再看一次 "),
				{ type: "mention", path: "state.txt" },
			]);
			// 排队之后、插入之前文件变了：读到的是插入时的内容
			writeFileSync(file, "插入时的内容\n");
		}
		if (call === 1) writeFileSync(file, "follow-up 开始时的内容\n");
		return say("好");
	});
	await current.submit("开始");
	const followUp = await log.waitFor(
		"task.started",
		(e) => e.source === "follow_up",
	);
	await log.waitFor("task.ended", (e) => e.task_id === followUp.task_id);

	expect(conversation(requests[1]).at(-1)?.content).toEqual(
		text('<file path="state.txt">\n插入时的内容\n</file>'),
	);
	expect(conversation(requests[2]).at(-1)?.content).toEqual([
		...text("再看一次 "),
		...text('<file path="state.txt">\nfollow-up 开始时的内容\n</file>'),
	]);
	expect(await log.waitFor("input.queued")).toMatchObject({
		kind: "steering",
		input: [{ type: "mention", path: "state.txt" }],
	});
});

/** 一张纯白的 PNG：测试只关心它的尺寸，不为它引入图片库。 */
function png(width: number, height: number): Buffer {
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
	const rows = Buffer.alloc(height * (1 + width * 3), 255);
	for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** 图片块里 PNG 的宽和高。 */
function pngSize(block: Message["content"][number] | undefined): number[] {
	if (block?.type !== "image") throw new Error("这一块应该是图片");
	expect(block.media_type).toBe("image/png");
	const bytes = Buffer.from(block.data, "base64");
	return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("输入里的图片按引用保存，runtime 取来缩放后发给模型，session 记录按引用保存实际发送的图片", async () => {
	const bytes = png(2600, 130);
	const current = await open(() => say("一张白图"));
	const started = await log.waitFor("session.started");
	const taskId = await current.submit([
		...text("图里有什么？"),
		{ type: "image", media_type: "image/png", data: bytes.toString("base64") },
	]);
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });

	// 事件里只有引用，不带图片的字节
	expect((await log.waitFor("task.started")).input).toEqual([
		...text("图里有什么？"),
		{
			type: "image_ref",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
		},
	]);
	const [question, image] = conversation(requests[0])[0]?.content ?? [];
	expect(question).toEqual(text("图里有什么？")[0]);
	expect(pngSize(image)).toEqual([2000, 100]);

	await current.close();
	session = undefined;
	const store = SessionStore.open(
		join(dirs.root, "data", "projects", started.project_id, "sessions.sqlite"),
	);
	try {
		const sent = store
			.events(current.id)
			.filter((event) => event.type === "message.sent")
			.map((event) => (event.data as { message: unknown }).message);
		// 缩放过的图片和输入时保存的原始字节不是同一份
		const scaled = Buffer.from(
			(image as Extract<typeof image, { type: "image" }>).data,
			"base64",
		);
		const sha256 = createHash("sha256").update(scaled).digest("hex");
		expect(sent.at(-1)).toEqual({
			role: "user",
			message_id: expect.any(String),
			content: [
				question,
				{ type: "stored_image", media_type: "image/png", sha256 },
			],
		});
		expect(Buffer.from(store.blob(current.id, sha256)).equals(scaled)).toBe(
			true,
		);
		expect(store.blob(current.id, sha256).length).not.toBe(bytes.length);
		expect(store.sessions()).toMatchObject([{ title: "图里有什么？[image]" }]);
	} finally {
		store.close();
	}
});

test("提及的图片文件由 runtime 读成图片发给模型：拖进终端的图片走这条路", async () => {
	const bytes = png(40, 20);
	writeFileSync(join(dirs.workspace, "shot.png"), bytes);
	const current = await open(() => say("一张白图"));
	const taskId = await current.submit([
		...text("图里有什么？"),
		{ type: "mention", path: "shot.png" },
	]);
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });

	// 事件里记的是提及，图片的字节不经过 Host 的输入
	expect((await log.waitFor("task.started")).input).toEqual([
		...text("图里有什么？"),
		{ type: "mention", path: "shot.png" },
	]);
	const [, marker, image] = conversation(requests[0])[0]?.content ?? [];
	expect(marker).toEqual(
		text('<file path="shot.png">\n[Image, image/png, 40x20.]\n</file>')[0],
	);
	expect(pngSize(image)).toEqual([40, 20]);
});

/**
 * 一张不用缩放的 PNG，内容是随机的像素，压不小：文件大约有 `width * height * 3` 个字节。
 */
function noisePng(width: number, height: number): Buffer {
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
	header.set([8, 2, 0, 0, 0], 8);
	const rows = randomBytes(height * (1 + width * 3));
	for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		// 随机的内容压不小，不花时间压
		chunk("IDAT", deflateSync(rows, { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

test("一条输入里的图片合计超过通道单条消息的上限：照常发给模型，之后重启也能重建历史", {
	timeout: 60_000,
}, async () => {
	// 每张 base64 之后约 4.3 MB，在单张的上限以内、不用缩放；四张合计超过 16 MiB
	const images = Array.from({ length: 4 }, () => noisePng(1040, 1040));
	const total = images.reduce(
		(sum, image) => sum + image.toString("base64").length,
		0,
	);
	expect(total).toBeGreaterThan(16 * 1024 * 1024);
	const current = await open((_request, call) => say(`第 ${call} 次回答`));
	const taskId = await current.submit([
		...text("这四张图里有什么？"),
		...images.map((image) => ({
			type: "image" as const,
			media_type: "image/png" as const,
			data: image.toString("base64"),
		})),
	]);
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === taskId),
	).toMatchObject({ outcome: "completed" });
	const sent = conversation(requests[0])[0]?.content ?? [];
	expect(sent.map((block) => block.type)).toEqual([
		"text",
		"image",
		"image",
		"image",
		"image",
	]);
	expect(
		sent.flatMap((block) => (block.type === "image" ? [block.data] : [])),
	).toEqual(images.map((image) => image.toString("base64")));

	// 新的 agent 进程从 session 记录重建历史：这条消息的记录一样超过单条消息的上限
	const started = log.events.findLast(
		(event) => event.type === "process.started" && event.kind === "agent",
	);
	if (started?.type !== "process.started") throw new Error("没有 agent 进程");
	process.kill(started.pid, "SIGKILL");
	await log.waitFor("process.exited", (event) => event.pid === started.pid);
	const next = await current.submit("再看一遍");
	expect(
		await log.waitFor("task.ended", (e) => e.task_id === next),
	).toMatchObject({ outcome: "completed" });
	const [before] = requests;
	const after = requests.at(-1);
	expect(after?.messages.slice(0, before?.messages.length)).toEqual(
		before?.messages,
	);
	expect(log.types()).not.toContain("error");
});

test("取回的输入里图片是引用，原样交回来能重新排队；没保存过的引用被拒绝", async () => {
	const bytes = png(40, 20);
	const current = await open((_request, call) => {
		if (call === 0) {
			current.followUp([
				{
					type: "image",
					media_type: "image/png",
					data: bytes.toString("base64"),
				},
			]);
			const [queued] = current.dequeue();
			if (queued === undefined) throw new Error("应该取回一条 follow-up");
			expect(queued.input).toMatchObject([
				{ type: "image_ref", bytes: bytes.length },
			]);
			current.followUp([...text("再看这张 "), ...queued.input]);
			expect(() =>
				current.followUp([
					{ type: "image_ref", sha256: "0".repeat(64), bytes: 1 },
				]),
			).toThrow();
		}
		return say("好");
	});
	await current.submit("开始");
	const followUp = await log.waitFor(
		"task.started",
		(e) => e.source === "follow_up",
	);
	await log.waitFor("task.ended", (e) => e.task_id === followUp.task_id);

	const [words, image] = conversation(requests[1]).at(-1)?.content ?? [];
	expect(words).toEqual(text("再看这张 ")[0]);
	// 在上限内的图片原样发给模型
	expect(image).toEqual({
		type: "image",
		media_type: "image/png",
		data: bytes.toString("base64"),
	});
});
