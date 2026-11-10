import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingInput } from "@ospreycode/agent-runtime";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import { imageSize } from "../src/context/estimate.js";
import { type FakeHost, startFakeHost, type Turn, text } from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-mention-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

/** 请求里系统指令和上下文消息之后的消息。 */
function conversation(request: ModelRequest): Message[] {
	return request.messages.slice(2);
}

/** 第一次请求里用户消息各块的文字。 */
function firstInput(requests: ModelRequest[]): string[] {
	const [message] = conversation(requests[0] as ModelRequest);
	return (message as Message).content.map((block) =>
		block.type === "text" ? block.text : block.type,
	);
}

test("提及的文件在原位置换成它的内容，目录换成一层的列表", async () => {
	mkdirSync(join(workspace, "src/lib"), { recursive: true });
	writeFileSync(join(workspace, "src/a.ts"), "const a = 1;\nexport { a };\n");
	writeFileSync(join(workspace, "src/b.ts"), "");
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start([
		...text("看看 "),
		{ type: "mention", path: "src/a.ts" },
		...text(" 和 "),
		{ type: "mention", path: join(workspace, "src") },
		...text(" 有什么问题"),
	]);
	await host.until(() => host?.ends.length === 1);

	expect(host.ends).toEqual([{ outcome: "completed" }]);
	const [message] = conversation(host.requests[0] as ModelRequest);
	expect(message?.content).toEqual([
		...text("看看 "),
		...text('<file path="src/a.ts">\nconst a = 1;\nexport { a };\n</file>'),
		...text(" 和 "),
		...text(
			`<directory path=${JSON.stringify(join(workspace, "src"))}>\na.ts\nb.ts\nlib/\n</directory>`,
		),
		...text(" 有什么问题"),
	]);
});

test("读不了的路径在原位置写明原因，task 照常进行", async () => {
	writeFileSync(join(workspace, "data.bin"), Buffer.from([1, 0, 2, 0]));
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start([
		{ type: "mention", path: "missing.txt" },
		{ type: "mention", path: "data.bin" },
		...text("这两个文件"),
	]);
	await host.until(() => host?.ends.length === 1);

	expect(host.ends).toEqual([{ outcome: "completed" }]);
	const [missing, binary, rest] = firstInput(host.requests);
	expect(missing).toMatch(
		/^<file path="missing\.txt">\n\[Could not read this path: ENOENT.*\]\n<\/file>$/,
	);
	expect(binary).toMatch(
		/^<file path="data\.bin">\n\[Could not read this path: .*binary file.*\]\n<\/file>$/,
	);
	expect(rest).toBe("这两个文件");
});

test("超过读文件单次上限的文件只放前一段，并注明总行数和怎样续读", async () => {
	const lines = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`);
	writeFileSync(join(workspace, "big.txt"), `${lines.join("\n")}\n`);
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start([{ type: "mention", path: "big.txt" }]);
	await host.until(() => host?.ends.length === 1);

	const [block] = firstInput(host.requests);
	expect(block).toContain("line 2000\n");
	expect(block).not.toContain("line 2001\n");
	expect(block).toContain(
		"[Showing lines 1-2000 of 2500 (2000 lines limit). Use offset=2001 to continue.]",
	);
});

test("提及记作一次读取：模型不用再读就能编辑这个文件", async () => {
	writeFileSync(join(workspace, "note.txt"), "hello\n");
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) =>
			index === 0
				? {
						content: [
							{
								type: "tool_call",
								call_id: "call_1",
								name: "edit",
								arguments: JSON.stringify({
									path: "note.txt",
									edits: [{ old_text: "hello", new_text: "goodbye" }],
								}),
							},
						],
					}
				: done,
	});
	await host.start([...text("改一下 "), { type: "mention", path: "note.txt" }]);
	await host.until(() => host?.ends.length === 1);

	// 展开不登记为工具调用：提交过结果的只有模型发起的那次编辑
	expect(host.completed.map((result) => result.status)).toEqual(["succeeded"]);
	expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("goodbye\n");
});

test("steering 里的提及在插入时读取，读到的是那时的内容", async () => {
	writeFileSync(join(workspace, "state.txt"), "before\n");
	let pending: PendingInput[] = [
		{
			input_id: "in-1",
			kind: "steering",
			content: [...text("再看 "), { type: "mention", path: "state.txt" }],
		},
	];
	host = await startFakeHost({
		config: { workspace },
		model: () => {
			// 第一次回复之后文件才改：插入时读到的应该是改过的内容
			writeFileSync(join(workspace, "state.txt"), "after\n");
			return done;
		},
		taskEnd: () => pending.length > 0,
		takeInputs: () => {
			const taken = pending;
			pending = [];
			return taken;
		},
	});
	await host.start("开始");
	await host.until(() => host?.ends.length === 2);

	const messages = conversation(host.requests[1] as ModelRequest);
	expect(messages[2]?.content).toEqual([
		...text("再看 "),
		...text('<file path="state.txt">\nafter\n</file>'),
	]);
});

/** 一张纯色的 PNG。 */
function png(width: number, height: number): Uint8Array {
	const pixels = new Uint8Array(width * height * 4).fill(255);
	return new photon.PhotonImage(pixels, width, height).get_bytes();
}

test("提及的图片文件作为图片交给模型，标记里写明格式和尺寸；坏掉的写明原因", {
	timeout: 30_000,
}, async () => {
	const shot = png(2000, 100);
	writeFileSync(join(workspace, "shot.png"), shot);
	writeFileSync(join(workspace, "broken.png"), shot.slice(0, 100));
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start([
		...text("照这张图改 "),
		{ type: "mention", path: "shot.png" },
		{ type: "mention", path: "broken.png" },
	]);
	await host.until(() => host?.ends.length === 1);

	expect(host.ends).toEqual([{ outcome: "completed" }]);
	const [message] = conversation(host.requests[0] as ModelRequest);
	const [question, marker, image, broken] = (message as Message).content;
	expect(question).toEqual({ type: "text", text: "照这张图改 " });
	expect(marker).toEqual({
		type: "text",
		text: '<file path="shot.png">\n[Image, image/png, 2000x100.]\n</file>',
	});
	expect(image).toEqual({
		type: "image",
		media_type: "image/png",
		data: Buffer.from(shot).toString("base64"),
	});
	if (broken?.type !== "text") throw new Error("第四块应该是文字");
	expect(broken.text).toMatch(
		/^<file path="broken\.png">\n\[Could not read this path: .*cannot be shown.*\]\n<\/file>$/,
	);
});

test("附带的图片按引用向 Host 取来，缩放后放在原位置；解不开的写明原因", {
	timeout: 30_000,
}, async () => {
	const large = png(2600, 130);
	const blobs = new Map([
		["large", large],
		["broken", large.slice(0, 100)],
	]);
	host = await startFakeHost({
		config: { workspace },
		blobs,
		model: () => done,
	});
	await host.start([
		...text("这两张图里有什么？"),
		{ type: "image_ref", sha256: "large", bytes: large.length },
		{ type: "image_ref", sha256: "broken", bytes: 100 },
	]);
	await host.until(() => host?.ends.length === 1);

	expect(host.ends).toEqual([{ outcome: "completed" }]);
	const [message] = conversation(host.requests[0] as ModelRequest);
	const [question, image, broken] = (message as Message).content;
	expect(question).toEqual({ type: "text", text: "这两张图里有什么？" });
	if (image?.type !== "image") throw new Error("第二块应该是图片");
	expect(image.media_type).toBe("image/png");
	expect(imageSize(Buffer.from(image.data, "base64"))).toEqual({
		width: 2000,
		height: 100,
	});
	expect(broken).toEqual({
		type: "text",
		text: "[An image was attached here but could not be used: The image could not be decoded.]",
	});
});
