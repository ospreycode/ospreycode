import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { ModelRequest } from "@ospreycode/api/protocol";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { imageSize } from "../src/context/estimate.js";
import {
	type FakeHost,
	startFakeHost,
	type Turn,
	textOf,
} from "./fake-host.js";

let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "osp-read-image-")));
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(workspace, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

function read(callId: string, args: Record<string, unknown>): Turn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name: "read",
				arguments: JSON.stringify(args),
			},
		],
	};
}

/** 一张纯色的图片。 */
function picture(width: number, height: number): photon.PhotonImage {
	const pixels = new Uint8Array(width * height * 4).fill(255);
	return new photon.PhotonImage(pixels, width, height);
}

/** 模型依次读这些路径，每轮一次，都读完后结束；返回提交给 Host 的结果和最后一次模型请求。 */
async function readAll(
	calls: Record<string, unknown>[],
): Promise<{ results: ToolResult[]; last: ModelRequest }> {
	const turns = calls.map((args, index) => read(`call_${index}`, args));
	host = await startFakeHost({
		config: { workspace },
		model: (_request, index) => turns[index] ?? done,
	});
	await host.start("看看这些文件");
	await host.until(() => host?.ends.length === 1);
	expect(host.failures).toEqual([]);
	expect(host.ends).toEqual([{ outcome: "completed" }]);
	return {
		results: host.completed,
		last: host.requests.at(-1) as ModelRequest,
	};
}

// 解码和编码在 WASM 里做，机器忙的时候一张大图要几秒
describe("read 读图片", { timeout: 30_000 }, () => {
	test("图片按文件头认出来，作为图片块交给模型，前面一行写明格式和尺寸；记作一次读取", async () => {
		const png = picture(64, 32).get_bytes();
		const jpeg = picture(40, 30).get_bytes_jpeg(90);
		// 扩展名不对的图片照样能看
		writeFileSync(join(workspace, "shot.dat"), png);
		writeFileSync(join(workspace, "photo.jpg"), jpeg);

		const { results, last } = await readAll([
			{ path: "shot.dat" },
			// 行号和行数对图片没有意义，不影响结果
			{ path: join(workspace, "photo.jpg"), offset: 5, limit: 1 },
		]);

		expect(results).toEqual([
			{
				status: "succeeded",
				content: [
					{ type: "text", text: "[Image, image/png, 64x32.]" },
					{
						type: "image",
						media_type: "image/png",
						data: Buffer.from(png).toString("base64"),
					},
				],
			},
			{
				status: "succeeded",
				content: [
					{ type: "text", text: "[Image, image/jpeg, 40x30.]" },
					{
						type: "image",
						media_type: "image/jpeg",
						data: Buffer.from(jpeg).toString("base64"),
					},
				],
			},
		]);
		// 结果消息带着图片发给模型，不算出错
		const sent = last.messages.filter(
			(message) => message.role === "tool_result",
		);
		expect(sent).toMatchObject([
			{ call_id: "call_0", is_error: false, content: results[0]?.content },
			{ call_id: "call_1", is_error: false, content: results[1]?.content },
		]);
	});

	test("超过上限的图片缩小后交给模型，并写明原来的尺寸", async () => {
		writeFileSync(join(workspace, "wide.png"), picture(2600, 130).get_bytes());

		const { results } = await readAll([{ path: "wide.png" }]);

		const [note, image] = results[0]?.content ?? [];
		expect(results[0]?.status).toBe("succeeded");
		expect(note).toEqual({
			type: "text",
			text: "[Image, image/png, scaled down from 2600x130 to 2000x100.]",
		});
		if (image?.type !== "image") throw new Error("第二块应该是图片");
		expect(image.media_type).toBe("image/png");
		expect(imageSize(Buffer.from(image.data, "base64"))).toEqual({
			width: 2000,
			height: 100,
		});
	});

	test("坏掉的图片报告失败，不交给模型；之后的图片照常能读", async () => {
		const png = picture(64, 32).get_bytes();
		writeFileSync(join(workspace, "truncated.png"), png.subarray(0, 60));
		// 文件头是 PNG 的签名，尺寸也读得出来，内容不是图片
		const fake = Buffer.from(png);
		fake.fill(0x41, 33);
		writeFileSync(join(workspace, "fake.png"), fake);
		writeFileSync(join(workspace, "good.png"), png);

		const { results, last } = await readAll([
			{ path: "truncated.png" },
			{ path: "fake.png" },
			{ path: "good.png" },
		]);

		expect(results.map((result) => result.status)).toEqual([
			"failed",
			"failed",
			"succeeded",
		]);
		expect(results[0]?.content).toEqual([
			{
				type: "text",
				text: `${join(workspace, "truncated.png")} is an image that cannot be shown: The image could not be decoded.`,
			},
		]);
		expect(results[1]?.content).toEqual([
			{
				type: "text",
				text: `${join(workspace, "fake.png")} is an image that cannot be shown: The image could not be decoded.`,
			},
		]);
		const images = last.messages.flatMap((message) =>
			message.role === "tool_result"
				? message.content.filter((block) => block.type === "image")
				: [],
		);
		expect(images).toEqual([
			{
				type: "image",
				media_type: "image/png",
				data: Buffer.from(png).toString("base64"),
			},
		]);
	});

	test("以 GIF 这几个字母开头的文本文件按文本读；别的二进制文件照旧不显示", async () => {
		writeFileSync(join(workspace, "notes.md"), "GIFs in the docs\nline 2\n");
		writeFileSync(
			join(workspace, "data.bin"),
			Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		);

		const { results } = await readAll([
			{ path: "notes.md" },
			{ path: "data.bin" },
		]);

		expect(results[0]).toEqual({
			status: "succeeded",
			content: [{ type: "text", text: "GIFs in the docs\nline 2" }],
		});
		expect(results[1]?.status).toBe("failed");
		expect(textOf(results[1] as ToolResult)).toBe(
			`${join(workspace, "data.bin")} is a binary file. The read tool only shows text files and images (PNG, JPEG, GIF, WebP).`,
		);
	});
});
