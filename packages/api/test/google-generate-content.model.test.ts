import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	builtinModels,
	countTokens,
	type ModelEntry,
	streamModel,
} from "@ospreycode/api";
import type {
	AssistantMessage,
	ImageBlock,
	Message,
	ModelRequest,
	ReasoningEffort,
} from "@ospreycode/api/protocol";
import { beforeEach, describe, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	expectNoModelError,
} from "../../../scripts/model-test.js";

beforeEach(checkLedger);

function builtin(id: string): ModelEntry {
	const entry = builtinModels.find((m) => m.id === id);
	if (entry === undefined) throw new Error(`内置清单里没有 ${id}`);
	return {
		...entry,
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
}

/** 中转服务上能用原生接口调用的 Gemini 模型只有它。 */
const gemini = () => builtin("gemini-4-argon");

function apiKey(entry: ModelEntry): string {
	const service = entry.service === "google" ? "gemini" : entry.service;
	return readFileSync(join(inject("modelKeysDir"), service), "utf8").trim();
}

const shell = {
	name: "shell",
	description: "Run a shell command.",
	parameters: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
		additionalProperties: false,
	},
};

function request(
	entry: ModelEntry,
	messages: Message[],
	effort: ReasoningEffort,
): ModelRequest {
	return {
		model: entry.id,
		reasoning_effort: effort,
		tool_choice: "auto",
		cache_retention: "none",
		messages,
		tools: [shell],
	};
}

async function reply(
	entry: ModelEntry,
	messages: Message[],
	effort: ReasoningEffort,
): Promise<AssistantMessage> {
	let message: AssistantMessage | undefined;
	for await (const event of streamModel(
		entry,
		request(entry, messages, effort),
		{
			messageId: crypto.randomUUID(),
			apiKey: apiKey(entry),
			fetch,
			signal: AbortSignal.timeout(120_000),
		},
	)) {
		if (event.type === "end") {
			charge(event.message.usage);
			expectNoModelError(event.error);
			message = event.message;
		}
	}
	if (message === undefined) throw new Error("流没有以 end 结束");
	return message;
}

function start(text: string): Message[] {
	return [
		{
			role: "system",
			message_id: crypto.randomUUID(),
			content: [
				{
					type: "text",
					text: "Use the shell tool when asked. Keep replies short.",
				},
			],
		},
		{
			role: "user",
			message_id: crypto.randomUUID(),
			content: [{ type: "text", text }],
		},
	];
}

function toolResult(message: AssistantMessage, output: string): Message {
	const call = message.content.find((block) => block.type === "tool_call");
	if (call?.type !== "tool_call") throw new Error("回复里没有工具调用");
	expect(call.name).toBe("shell");
	expect(JSON.parse(call.arguments)).toMatchObject({
		command: expect.any(String),
	});
	return {
		role: "tool_result",
		message_id: crypto.randomUUID(),
		call_id: call.call_id,
		content: [{ type: "text", text: output }],
		is_error: false,
	};
}

test("真实模型调用工具：调用前面带着思考签名，签名随调用带回，拿到结果后结束", {
	tags: ["model"],
}, async () => {
	const entry = gemini();
	const messages = start("Run `echo hi` with the shell tool.");
	const first = await reply(entry, messages, "low");
	expect(first.stop_reason).toBe("tool_use");
	expect(first.protocol).toBe("google.generate-content");
	expect(first.reasoning_effort_sent).toBe("low");
	expect(first.usage.input).toBeGreaterThan(0);
	expect(first.usage.cost_usd).toBeGreaterThan(0);
	const call = first.content.findIndex((block) => block.type === "tool_call");
	expect(first.content[call - 1]).toMatchObject({
		type: "reasoning",
		text: "",
		opaque: expect.any(String),
		origin: { protocol: "google.generate-content", service: "google" },
	});
	const second = await reply(
		entry,
		[...messages, first, toolResult(first, "Exit code: 0\nhi\n")],
		"low",
	);
	expect(second.stop_reason).toBe("end_turn");
});

test("开着推理的文字回复：思考摘要和末尾的签名都收下，带回下一轮后请求照常完成", {
	tags: ["model"],
}, async () => {
	const entry = gemini();
	const messages = start(
		"What is 17 times 23? Think it through, then answer with the number only.",
	);
	const first = await reply(entry, messages, "high");
	expect(first.stop_reason).toBe("end_turn");
	expect(first.usage.reasoning).toBeGreaterThan(0);
	expect(first.content.some((block) => block.type === "text")).toBe(true);
	expect(
		first.content.some(
			(block) => block.type === "reasoning" && block.opaque !== undefined,
		),
	).toBe(true);
	const second = await reply(
		entry,
		[
			...messages,
			first,
			{
				role: "user",
				message_id: crypto.randomUUID(),
				content: [{ type: "text", text: "Now add 9 to it. Number only." }],
			},
		],
		"low",
	);
	expect(second.stop_reason).toBe("end_turn");
});

test("别的模型留下的工具调用没有签名：换到 Gemini 接着做，再换回去，工具调用和结果没有丢失", {
	tags: ["model"],
}, async () => {
	const haiku = builtin("claude-haiku-5-5");
	const messages = start(
		"Run `echo 7` with the shell tool, then tell me the number it printed.",
	);
	const first = await reply(haiku, messages, "low");
	expect(first.stop_reason).toBe("tool_use");
	messages.push(first, toolResult(first, "Exit code: 0\n7\n"));
	const second = await reply(gemini(), messages, "low");
	expect(second.stop_reason).toBe("end_turn");
	messages.push(second, {
		role: "user",
		message_id: crypto.randomUUID(),
		content: [
			{
				type: "text",
				text: "Run `echo 8` with the shell tool, then reply with both numbers.",
			},
		],
	});
	const third = await reply(gemini(), messages, "low");
	expect(third.stop_reason).toBe("tool_use");
	messages.push(third, toolResult(third, "Exit code: 0\n8\n"));
	const fourth = await reply(haiku, messages, "off");
	expect(fourth.stop_reason).toBe("end_turn");
});

test("计数接口接受和真实请求相同的内容，数出输入的 token", {
	tags: ["model"],
}, async () => {
	const entry = gemini();
	const result = await countTokens(
		entry,
		request(entry, start("Run `echo hi` with the shell tool."), "low"),
		{
			apiKey: apiKey(entry),
			fetch,
			signal: AbortSignal.timeout(60_000),
		},
	);
	// 计数接口的限流、过载也是模型服务的临时故障，和模型请求一样重跑一次
	if ("error" in result) expectNoModelError(result.error);
	if (!("input_tokens" in result)) {
		throw new Error(`计数没有成功：${JSON.stringify(result)}`);
	}
	expect(result.input_tokens).toBeGreaterThan(0);
});

/** 一张纯色的 PNG。 */
function png(size: number, rgb: number[]): ImageBlock {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	// 8 位、RGB、不隔行；每行开头一个过滤类型的字节
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.from([
		0,
		...Array.from({ length: size }, () => rgb).flat(),
	]);
	return {
		type: "image",
		media_type: "image/png",
		data: Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
			chunk("IEND", Buffer.alloc(0)),
		]).toString("base64"),
	};
}

/** 一张纯色的 GIF：每两个像素发一次清除码，编码长度一直是 3 位，不用实现 LZW 的字典。 */
function gif(size: number, rgb: number[]): ImageBlock {
	const bytes: number[] = [];
	let bits = 0;
	let filled = 0;
	const emit = (code: number) => {
		bits |= code << filled;
		filled += 3;
		while (filled >= 8) {
			bytes.push(bits & 0xff);
			bits >>= 8;
			filled -= 8;
		}
	};
	for (let pixel = 0; pixel < size * size; pixel += 2) {
		emit(4);
		emit(0);
		emit(0);
	}
	emit(5);
	if (filled > 0) bytes.push(bits);
	const blocks: number[] = [];
	for (let offset = 0; offset < bytes.length; offset += 255) {
		const block = bytes.slice(offset, offset + 255);
		blocks.push(block.length, ...block);
	}
	const dimension = [size & 0xff, size >> 8];
	return {
		type: "image",
		media_type: "image/gif",
		data: Buffer.from([
			...Buffer.from("GIF89a", "latin1"),
			...dimension,
			...dimension,
			// 有全局调色板，两种颜色
			0x80,
			0,
			0,
			...rgb,
			0,
			0,
			0,
			0x2c,
			0,
			0,
			0,
			0,
			...dimension,
			...dimension,
			0,
			2,
			...blocks,
			0,
			0x3b,
		]).toString("base64"),
	};
}

describe("工具结果里的图片", () => {
	/** 模型调用工具看一张纯色的图片，结果里带着图片；返回它看到图片之后的回复。 */
	async function colourSeen(image: ImageBlock, isError: boolean) {
		const entry = gemini();
		const messages = start(
			"Run `show picture` with the shell tool. It returns the picture itself. Then answer with one word: the colour that fills the picture.",
		);
		const first = await reply(entry, messages, "low");
		expect(first.stop_reason).toBe("tool_use");
		const call = first.content.find((block) => block.type === "tool_call");
		if (call?.type !== "tool_call") throw new Error("回复里没有工具调用");
		const result: Message = {
			role: "tool_result",
			message_id: crypto.randomUUID(),
			call_id: call.call_id,
			content: [
				{
					type: "text",
					text: isError
						? "Exit code: 1\nshow: could not read the metadata, the picture is attached anyway"
						: `[Image, ${image.media_type}, 64x64.]`,
				},
				image,
			],
			is_error: isError,
		};
		const second = await reply(entry, [...messages, first, result], "low");
		expect(second.stop_reason).toBe("end_turn");
		return second.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("")
			.toLowerCase();
	}

	test("PNG 放在 functionResponse.parts 里，is_error 为真时也一样，模型都看得到", {
		tags: ["model"],
	}, async () => {
		expect(await colourSeen(png(64, [255, 0, 0]), false)).toContain("red");
		expect(await colourSeen(png(64, [0, 0, 255]), true)).toContain("blue");
	});

	test("GIF 移到这组工具结果之后，模型看得到", {
		tags: ["model"],
	}, async () => {
		expect(await colourSeen(gif(64, [0, 0, 255]), false)).toContain("blue");
	});
});
