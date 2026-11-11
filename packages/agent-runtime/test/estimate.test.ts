import {
	estimateContext,
	imageTokens,
	type ModelInfo,
	textTokens,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	ImageBlock,
	Message,
} from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

function png(width: number, height: number): ImageBlock {
	const bytes = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return {
		type: "image",
		media_type: "image/png",
		data: bytes.toString("base64"),
	};
}

function jpeg(width: number, height: number): ImageBlock {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
	const sof = Buffer.alloc(19);
	sof.writeUInt16BE(0xffc0, 0);
	sof.writeUInt16BE(17, 2);
	sof.writeUInt8(8, 4);
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	const data = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
	return {
		type: "image",
		media_type: "image/jpeg",
		data: data.toString("base64"),
	};
}

function gif(width: number, height: number): ImageBlock {
	const bytes = Buffer.alloc(13);
	bytes.write("GIF89a", 0, "ascii");
	bytes.writeUInt16LE(width, 6);
	bytes.writeUInt16LE(height, 8);
	return {
		type: "image",
		media_type: "image/gif",
		data: bytes.toString("base64"),
	};
}

function webp(width: number, height: number): ImageBlock {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUIntLE(width - 1, 24, 3);
	bytes.writeUIntLE(height - 1, 27, 3);
	return {
		type: "image",
		media_type: "image/webp",
		data: bytes.toString("base64"),
	};
}

describe("估算", () => {
	test("文字按 UTF-8 字节数除以 1.7", () => {
		expect(textTokens("abcdefghij")).toBe(Math.ceil(10 / 1.7));
		expect(textTokens("中文")).toBe(Math.ceil(6 / 1.7));
	});

	test("图片按各家的公式，尺寸从文件头读出", () => {
		// Anthropic：宽乘高除以 750；OpenAI：短边不超过 768 时不缩，2 × 1 个块
		expect(imageTokens("anthropic.messages", png(1000, 500))).toBe(667);
		expect(imageTokens("openai.responses", png(1000, 500))).toBe(85 + 170 * 2);
		// 大图：Anthropic 长边缩到 1568；OpenAI 先缩进 2048，再把短边缩到 768，2 × 2 个块
		expect(imageTokens("anthropic.messages", jpeg(4000, 3000))).toBe(
			Math.ceil((1568 * 1176) / 750),
		);
		expect(imageTokens("openai.chat", jpeg(4000, 3000))).toBe(85 + 170 * 4);
		expect(imageTokens("anthropic.messages", gif(750, 100))).toBe(100);
		expect(imageTokens("anthropic.messages", webp(1500, 1000))).toBe(2000);
		// 读不出尺寸时按会话允许的最大尺寸 2000 × 2000 算
		expect(
			imageTokens("anthropic.messages", {
				type: "image",
				media_type: "image/png",
				data: Buffer.from("not an image").toString("base64"),
			}),
		).toBe(Math.ceil((1568 * 1568) / 750));
	});

	const model: ModelInfo = {
		id: "m",
		protocol: "anthropic.messages",
		reasoning_effort: "off",
		context_window: 200_000,
		max_output_tokens: 8_000,
	};

	const system: Message = {
		role: "system",
		message_id: "s",
		content: [{ type: "text", text: "x".repeat(170) }],
	};

	function reply(fields: Partial<AssistantMessage>): AssistantMessage {
		return {
			role: "assistant",
			message_id: "a",
			content: [{ type: "text", text: "ok" }],
			protocol: "anthropic.messages",
			service: "s",
			requested_model: "m",
			model: "m",
			reasoning_effort: "off",
			stop_reason: "tool_use",
			usage: {
				input: 1_000,
				output: 50,
				cache_read: 2_000,
				cache_write: 300,
				reasoning: 0,
			},
			...fields,
		};
	}

	const result: Message = {
		role: "tool_result",
		message_id: "t",
		call_id: "c",
		content: [{ type: "text", text: "y".repeat(17) }],
		is_error: false,
	};

	test("以当前模型最后一条正常结束的回复的用量为锚点，加上之后新增内容的估算", () => {
		expect(estimateContext(model, [system, reply({}), result], [])).toBe(
			1_000 + 50 + 2_000 + 300 + 10,
		);
	});

	test("没有锚点时估算全部内容：换了模型或回复出错时不作锚点，回复按它的输出 token 计", () => {
		const tools = [{ name: "t", description: "d", parameters: {} }];
		const toolTokens = textTokens(JSON.stringify(tools));
		for (const fields of [
			{ requested_model: "other" },
			{ stop_reason: "error" as const },
		]) {
			expect(
				estimateContext(model, [system, reply(fields), result], tools),
			).toBe(toolTokens + 100 + 50 + 10);
		}
	});

	test("Host 数过的位置比最后一条回复更靠后时以它为锚点；换了模型或那条消息不在了就不用", () => {
		const messages = [system, reply({}), result];
		const counted = { message_id: "t", model: "m", tokens: 3_333 };
		const more: Message = {
			role: "user",
			message_id: "u",
			content: [{ type: "text", text: "z".repeat(34) }],
		};
		expect(estimateContext(model, messages, [], { counted })).toBe(3_333);
		expect(estimateContext(model, [...messages, more], [], { counted })).toBe(
			3_333 + 20,
		);
		// 数的位置在回复之前：回复报告的用量更新
		expect(
			estimateContext(model, messages, [], {
				counted: { ...counted, message_id: "s" },
			}),
		).toBe(3_350 + 10);
		for (const stale of [
			{ ...counted, model: "other" },
			{ ...counted, message_id: "gone" },
		]) {
			expect(estimateContext(model, messages, [], { counted: stale })).toBe(
				3_350 + 10,
			);
		}
	});

	test("乐观的估算：锚点之后的文字按每 token 4 字节算", () => {
		const long: Message = {
			role: "user",
			message_id: "u",
			content: [{ type: "text", text: "z".repeat(400) }],
		};
		expect(estimateContext(model, [system, reply({}), long], [])).toBe(
			3_350 + Math.ceil(400 / 1.7),
		);
		expect(
			estimateContext(model, [system, reply({}), long], [], {
				optimistic: true,
			}),
		).toBe(3_350 + 100);
	});
});
