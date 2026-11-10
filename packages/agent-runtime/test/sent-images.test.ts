import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ChannelRequestError,
	maxMessageBytes,
	ProtocolError,
	ReceivedImages,
	type RecordedEvent,
	type RequestMessage,
} from "@ospreycode/agent-runtime";
import type { ImageBlock, Message } from "@ospreycode/api/protocol";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type FakeHost, startFakeHost, type Turn, text } from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-sent-images-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

/** 一张纯色的 PNG，尺寸不同内容就不同。 */
function png(width: number, height: number): Uint8Array {
	const pixels = new Uint8Array(width * height * 4).fill(255);
	return new photon.PhotonImage(pixels, width, height).get_bytes();
}

function block(bytes: Uint8Array): ImageBlock {
	return {
		type: "image",
		media_type: "image/png",
		data: Buffer.from(bytes).toString("base64"),
	};
}

function reference(bytes: Uint8Array) {
	return {
		type: "sent_image",
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

/** 一次模型请求里各条消息的图片（通道上是引用），按顺序。 */
function pictures(messages: readonly (RequestMessage | Message)[] | undefined) {
	return (messages ?? []).flatMap((message) =>
		message.role === "user" || message.role === "tool_result"
			? message.content.filter((item) => item.type !== "text")
			: [],
	);
}

test("图片每张只过一次通道：工具结果里的随结果提交，用户附带的在模型请求之前单独交给 Host，请求里只有引用", async () => {
	const pasted = png(40, 30);
	const shot = png(64, 32);
	writeFileSync(join(workspace, "shot.png"), shot);
	const turns: Turn[] = [
		{
			content: [
				{
					type: "tool_call",
					call_id: "call_1",
					name: "read",
					arguments: JSON.stringify({ path: "shot.png" }),
				},
			],
		},
	];
	host = await startFakeHost({
		config: { workspace },
		blobs: new Map([["pasted", pasted]]),
		model: (_request, index) => turns[index] ?? done,
	});
	await host.start([
		...text("对比这张图和 shot.png"),
		{ type: "image_ref", sha256: "pasted", bytes: pasted.length },
	]);
	await host.until(() => host?.ends.length === 1);
	await host.start("再看一遍");
	await host.until(() => host?.ends.length === 2);

	expect(host.failures).toEqual([]);
	expect(host.puts).toEqual([block(pasted)]);
	expect(host.wire.map(pictures)).toEqual([
		[reference(pasted)],
		[reference(pasted), reference(shot)],
		[reference(pasted), reference(shot)],
	]);
	// Host 把引用换回原来的图片块，发给模型的请求里图片都在
	expect(host.requests.map((request) => pictures(request.messages))).toEqual([
		[block(pasted)],
		[block(pasted), block(shot)],
		[block(pasted), block(shot)],
	]);
});

/** 压不动的图片：固定的伪随机序列，`seed` 不同内容就不同。 */
function noise(width: number, height: number, seed: number): Uint8Array {
	const pixels = new Uint8Array(width * height * 4);
	let state = seed;
	for (let index = 0; index < pixels.length; index++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		pixels[index] = index % 4 === 3 ? 255 : state >>> 24;
	}
	return new photon.PhotonImage(pixels, width, height).get_bytes();
}

test("历史里的图片合计超过通道单条消息的上限，模型请求照常发出", {
	timeout: 60_000,
}, async () => {
	const names = ["a", "b", "c", "d", "e"].map((name) => `${name}.png`);
	names.forEach((name, index) => {
		// 每张的 base64 略低于单张图片的上限，原样交给模型
		writeFileSync(join(workspace, name), noise(1000, 800, index + 1));
	});
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) => {
			const name = names[index];
			if (name === undefined) return done;
			return {
				content: [
					{
						type: "tool_call",
						call_id: `call_${index}`,
						name: "read",
						arguments: JSON.stringify({ path: name }),
					},
				],
			};
		},
	});
	await host.start("把这几张图都看一遍");
	await host.until(() => host?.ends.length === 1);

	expect(host.failures).toEqual([]);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	const sent = pictures(host.requests.at(-1)?.messages);
	expect(sent).toHaveLength(names.length);
	const total = sent.reduce(
		(sum, item) => sum + (item.type === "image" ? item.data.length : 0),
		0,
	);
	expect(total).toBeGreaterThan(maxMessageBytes);
	// 最后一次请求带着全部图片的结果，通道上只有引用
	expect(pictures(host.wire.at(-1)).map((item) => item.type)).toEqual(
		names.map(() => "sent_image"),
	);
});

test("一条用户消息里的图片合计超过通道单条消息的上限：附带的和提及的逐张交给 Host，模型请求照常发出", {
	timeout: 60_000,
}, async () => {
	// 每张的 base64 略低于单张图片的上限，原样交给模型；两张附带、三张提及
	const pasted = [1, 2].map((seed) => noise(1000, 800, seed));
	const names = ["c", "d", "e"].map((name) => `${name}.png`);
	const mentioned = names.map((name, index) => {
		const bytes = noise(1000, 800, index + 3);
		writeFileSync(join(workspace, name), bytes);
		return bytes;
	});
	host = await startFakeHost({
		config: { workspace },
		blobs: new Map(pasted.map((bytes, index) => [`pasted-${index}`, bytes])),
		model: () => done,
	});
	await host.start([
		...text("这几张图有什么不同？"),
		...pasted.map((bytes, index) => ({
			type: "image_ref" as const,
			sha256: `pasted-${index}`,
			bytes: bytes.length,
		})),
		...names.map((path) => ({ type: "mention" as const, path })),
	]);
	await host.until(() => host?.ends.length === 1);

	expect(host.failures).toEqual([]);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	const all = [...pasted, ...mentioned];
	expect(host.puts).toEqual(all.map(block));
	expect(
		host.puts.reduce((sum, image) => sum + image.data.length, 0),
	).toBeGreaterThan(maxMessageBytes);
	expect(pictures(host.wire[0])).toEqual(all.map(reference));
	expect(pictures(host.requests[0]?.messages)).toEqual(all.map(block));
});

test("模型请求被取消后，已经交给 Host 的图片不再交第二次", async () => {
	const pasted = png(40, 30);
	const requested = Promise.withResolvers<void>();
	host = await startFakeHost({
		config: { workspace },
		blobs: new Map([["pasted", pasted]]),
		model: async (_request, index, { signal }) => {
			if (index > 0) return done;
			requested.resolve();
			await once(signal, "abort");
			throw new ChannelRequestError("cancelled", "已取消");
		},
	});
	await host.start([
		...text("图里是什么？"),
		{ type: "image_ref", sha256: "pasted", bytes: pasted.length },
	]);
	await requested.promise;
	await host.channel.request("run/cancel", {});
	await host.until(() => host?.ends.length === 1);
	await host.start("继续");
	await host.until(() => host?.ends.length === 2);

	expect(host.ends).toEqual([
		{ outcome: "cancelled" },
		{ outcome: "completed" },
	]);
	expect(host.puts).toEqual([block(pasted)]);
	expect(host.wire.map(pictures)).toEqual([
		[reference(pasted)],
		[reference(pasted)],
	]);
	expect(pictures(host.requests[1]?.messages)).toEqual([block(pasted)]);
});

test("重启后从 session 记录读回的历史里图片是引用，逐张向 Host 取回；之后的请求里仍然只带引用", async () => {
	const pasted = png(40, 30);
	const first = await startFakeHost({
		config: { workspace },
		blobs: new Map([["pasted", pasted]]),
		model: () => ({ content: [{ type: "text", text: "一张白色的图" }] }),
	});
	host = first;
	await first.start([
		...text("图里是什么？"),
		{ type: "image_ref", sha256: "pasted", bytes: pasted.length },
	]);
	await first.until(() => first.ends.length === 1);
	const before = first.requests[0]?.messages as Message[];
	const recorded = first.events.find((e) => e.type === "instructions.recorded");
	await first.close();

	// Host 交回的 `message.sent` 里图片换成了引用
	const stored = new ReceivedImages();
	const sent = before.map((message) => stored.refer(message));
	expect(pictures(sent)).toEqual([reference(pasted)]);
	const events: RecordedEvent[] = [
		{ type: "instructions.recorded", data: recorded?.data },
		...sent.map((message) => ({ type: "message.sent", data: { message } })),
	].map((event, index) => ({ ...event, run_id: "run-1", seq: index + 1 }));
	const second = await startFakeHost({
		config: { workspace, resume: { run_id: "run-1", seq: 99 } },
		received: [block(pasted)],
		model: () => done,
	});
	host = second;
	second.channel.handle("record/read", async (params) => ({
		events: events
			.filter((event) => params.types.includes(event.type))
			.slice(params.offset),
	}));
	await second.start("再看一遍");
	await second.until(() => second.ends.length === 1);

	expect(second.failures).toEqual([]);
	expect(second.ends).toEqual([{ outcome: "completed" }]);
	expect(second.puts).toEqual([]);
	expect(second.wire.map(pictures)).toEqual([[reference(pasted)]]);
	expect(second.requests[0]?.messages.slice(0, before.length)).toEqual(before);
});

test("引用了 Host 没有收到过的图片是协议错误", () => {
	const images = new ReceivedImages();
	const message: RequestMessage = {
		role: "user",
		message_id: "m-1",
		content: [{ type: "sent_image", sha256: "0".repeat(64) }],
	};

	expect(() => images.restore([message])).toThrow(ProtocolError);
	expect(() => images.image("0".repeat(64))).toThrow(ProtocolError);
});

test("Host 只收 base64 写法规范的图片：它按字节保存图片，写法不规范的取回时换不回原样", () => {
	const images = new ReceivedImages();
	const image = (data: string): ImageBlock => ({
		type: "image",
		media_type: "image/png",
		data,
	});

	// 同样的字节，规范的写法只有一种：带填充，填充位是 0，不夹别的字符
	images.remember([image("aGk=")]);
	for (const data of ["", "aGk", "aGl=", "aGk=\n", "aG k="]) {
		expect(() => images.remember([image(data)])).toThrow(ProtocolError);
	}
});
