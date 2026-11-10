import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	createHost,
	type ProtocolRaw,
	type Session,
} from "@ospreycode/agent-host";
import { SessionStore, type StoredEvent } from "@ospreycode/session-store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

// 图片在 session 记录里只存一份。要看到目标协议里的原文，这里不用脚本模型：请求经 anthropic.messages
// 的转换发给一个假的 fetch。

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 发给模型服务的每个请求体。 */
let bodies: string[];

beforeEach(() => {
	dirs = testDirectories();
	log = new EventLog();
	bodies = [];
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

function sse(events: (readonly [string, object])[]): string {
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
}

const messageStart = [
	"message_start",
	{
		message: {
			model: "scripted",
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
] as const;

function textReply(text: string): string {
	return sse([
		messageStart,
		[
			"content_block_start",
			{ index: 0, content_block: { type: "text", text: "" } },
		],
		["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { index: 0 }],
		[
			"message_delta",
			{ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		],
		["message_stop", {}],
	]);
}

/** 模型调用 `read` 读一个文件。 */
function readReply(path: string): string {
	return sse([
		messageStart,
		[
			"content_block_start",
			{
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_1",
					name: "read",
					input: {},
				},
			},
		],
		[
			"content_block_delta",
			{
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify({ path }),
				},
			},
		],
		["content_block_stop", { index: 0 }],
		[
			"message_delta",
			{ delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		],
		["message_stop", {}],
	]);
}

/** 一张不用缩放的 PNG，内容是随机的像素：每张都不一样，base64 里也没有重复的片段。 */
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
	// 8 位、RGB、不隔行；每行开头一个过滤类型的字节
	header.set([8, 2, 0, 0, 0], 8);
	const rows = randomBytes(height * (1 + width * 3));
	for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows, { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 打开一个模型能读图片的 session，模型服务按顺序给出这些回应。 */
async function open(replies: string[]): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		fetch: async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response(replies[bodies.length - 1]);
		},
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: { ...testModel, images: true } },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

async function completed(taskId: string): Promise<void> {
	expect(
		await log.waitFor("task.ended", (event) => event.task_id === taskId),
	).toMatchObject({ outcome: "completed" });
}

/** 关掉 session，读出它的记录。 */
async function record(
	current: Session,
): Promise<{ events: StoredEvent[]; blob: (sha256: string) => Buffer }> {
	const { project_id } = await log.waitFor("session.started");
	await current.close();
	session = undefined;
	const store = SessionStore.open(
		join(dirs.root, "data", "projects", project_id, "sessions.sqlite"),
	);
	try {
		const events = store.events(current.id);
		const blobs = new Map<string, Buffer>();
		for (const [, digest] of JSON.stringify(events).matchAll(
			/"(?:sha256|image_sha256)":"([0-9a-f]{64})"/g,
		)) {
			blobs.set(
				digest as string,
				Buffer.from(store.blob(current.id, digest as string)),
			);
		}
		return {
			events,
			blob: (digest) => {
				const bytes = blobs.get(digest);
				if (bytes === undefined) throw new Error(`记录里没有引用 ${digest}`);
				return bytes;
			},
		};
	} finally {
		store.close();
	}
}

function ofType(events: StoredEvent[], type: string): unknown[] {
	return events.filter((event) => event.type === type).map(({ data }) => data);
}

/** 记录里带这张图片的原文片段，取回大内容后拼成的原文。 */
function rawWith(
	events: StoredEvent[],
	digest: string,
	blob: (sha256: string) => Buffer,
): string[] {
	return (ofType(events, "protocol.raw") as ProtocolRaw[])
		.flatMap((raw) => raw.pieces)
		.filter(
			(piece) =>
				typeof piece !== "string" &&
				piece.some(
					(segment) =>
						typeof segment !== "string" && segment.image_sha256 === digest,
				),
		)
		.map((piece) =>
			(piece as Exclude<typeof piece, string>)
				.map((segment) =>
					typeof segment === "string"
						? segment
						: blob(segment.image_sha256).toString("base64"),
				)
				.join(""),
		);
}

/** 事件的内容里都没有这张图片的字节。 */
function expectNotInlined(events: StoredEvent[], image: Buffer): void {
	const fragment = image.toString("base64").slice(1000, 1200);
	expect(
		events
			.filter((event) => JSON.stringify(event.data).includes(fragment))
			.map((event) => event.type),
	).toEqual([]);
}

test("read 读到的图片在 session 记录里只存一份：工具结果、发给模型的消息和目标协议里的原文都只带引用；重启后的请求里图片还在原处", async () => {
	const shot = noisePng(200, 100);
	const data = shot.toString("base64");
	writeFileSync(join(dirs.workspace, "shot.png"), shot);
	const current = await open([
		readReply("shot.png"),
		textReply("一张图"),
		textReply("还是那张图"),
	]);
	await completed(await current.submit("看 shot.png"));

	// 发给前端的事件照旧带完整的图片
	expect(await log.waitFor("tool_call.completed")).toMatchObject({
		result: {
			status: "succeeded",
			content: [
				{ type: "text" },
				{ type: "image", media_type: "image/png", data },
			],
		},
	});
	expect(bodies[1]?.split(data)).toHaveLength(2);

	// agent 进程重启后按记录重建历史：图片从大内容取回，请求里它前面的内容逐字节不变
	await current.reload();
	await completed(await current.submit("再看一遍"));
	const [, second, third] = bodies as [string, string, string];
	const until = second.indexOf(data) + data.length;
	expect(third.slice(0, until)).toBe(second.slice(0, until));

	const { events, blob } = await record(current);
	expectNotInlined(events, shot);
	const stored = {
		type: "stored_image",
		media_type: "image/png",
		sha256: sha256(shot),
	};
	expect(ofType(events, "tool_call.completed")).toMatchObject([
		{ result: { status: "succeeded", content: [{ type: "text" }, stored] } },
	]);
	expect(
		ofType(events, "message.sent").filter(
			(sent) =>
				(sent as { message: { role: string } }).message.role === "tool_result",
		),
	).toMatchObject([{ message: { content: [{ type: "text" }, stored] } }]);
	expect(blob(sha256(shot)).equals(shot)).toBe(true);
	// 原文取回大内容后和发出的逐字节相同（最后一个字符之后可以接缓存断点）
	const raws = rawWith(events, sha256(shot), blob);
	expect(raws).toHaveLength(1);
	expect(second).toContain(raws[0]?.slice(0, -1));
});

test("附带的和提及的图片：不用缩放时，输入时保存的字节和发给模型的是同一份大内容，事件里都只带引用", async () => {
	const pasted = noisePng(200, 100);
	const dragged = noisePng(120, 90);
	writeFileSync(join(dirs.workspace, "dragged.png"), dragged);
	const current = await open([textReply("两张图")]);
	await completed(
		await current.submit([
			{ type: "text", text: "图里有什么？" },
			{
				type: "image",
				media_type: "image/png",
				data: pasted.toString("base64"),
			},
			{ type: "mention", path: "dragged.png" },
		]),
	);
	for (const image of [pasted, dragged]) {
		expect(bodies[0]?.split(image.toString("base64"))).toHaveLength(2);
	}

	const { events, blob } = await record(current);
	expectNotInlined(events, pasted);
	expectNotInlined(events, dragged);
	expect(ofType(events, "task.started")).toMatchObject([
		{
			input: [
				{ type: "text" },
				{ type: "image_ref", sha256: sha256(pasted), bytes: pasted.length },
				{ type: "mention", path: "dragged.png" },
			],
		},
	]);
	expect(ofType(events, "message.sent").at(-1)).toMatchObject({
		message: {
			role: "user",
			content: [
				{ type: "text", text: "图里有什么？" },
				{
					type: "stored_image",
					media_type: "image/png",
					sha256: sha256(pasted),
				},
				{ type: "text" },
				{
					type: "stored_image",
					media_type: "image/png",
					sha256: sha256(dragged),
				},
			],
		},
	});
	for (const image of [pasted, dragged]) {
		expect(blob(sha256(image)).equals(image)).toBe(true);
		const raws = rawWith(events, sha256(image), blob);
		expect(raws).toHaveLength(1);
		expect(bodies[0]).toContain(raws[0]?.slice(0, -1));
	}
});
