import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	builtinModels,
	type ModelEntry,
	type RawKey,
	type RawPart,
	type RawStore,
	streamModel,
} from "@ospreycode/api";
import type {
	AssistantMessage,
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

/** OpenAI 的 Chat Completions 带工具时只能不推理，测试用的条目只有 `off`。 */
function solChat(): ModelEntry {
	const responses = builtin("gpt-5.6-sol");
	return {
		...responses,
		id: "gpt-5.6-sol-chat",
		protocol: "openai.chat",
		thinking_level_map: { off: "none" },
	};
}

function apiKey(service: "openai" | "anthropic"): string {
	return readFileSync(join(inject("modelKeysDir"), service), "utf8").trim();
}

class MemoryRaws implements RawStore {
	parts = new Map<string, string[]>();

	#key(key: RawKey): string {
		return JSON.stringify([
			key.protocol,
			key.service,
			key.api_version,
			key.part,
			key.message_id,
			key.content_sha256,
		]);
	}

	get(key: RawKey): string[] | undefined {
		return this.parts.get(this.#key(key));
	}

	put(part: RawPart): void {
		this.parts.set(this.#key(part), part.pieces);
	}
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

async function reply(
	entry: ModelEntry,
	messages: Message[],
	effort: ReasoningEffort,
	raws?: RawStore,
): Promise<AssistantMessage> {
	const request: ModelRequest = {
		model: entry.id,
		reasoning_effort: effort,
		tool_choice: "auto",
		cache_retention: "none",
		messages,
		tools: [shell],
	};
	let message: AssistantMessage | undefined;
	for await (const event of streamModel(entry, request, {
		messageId: crypto.randomUUID(),
		apiKey: apiKey(entry.service === "anthropic" ? "anthropic" : "openai"),
		fetch,
		signal: AbortSignal.timeout(120_000),
		cacheKey: "protocols-model-test",
		...(raws === undefined ? {} : { raws }),
	})) {
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

describe("openai.responses", () => {
	test("真实模型调用工具，拿到结果后结束", { tags: ["model"] }, async () => {
		const entry = builtin("gpt-5.6-sol");
		const messages = start("Run `echo hi` with the shell tool.");
		const first = await reply(entry, messages, "off");
		expect(first.stop_reason).toBe("tool_use");
		expect(first.reasoning_effort_sent).toBe("none");
		expect(first.usage.input).toBeGreaterThan(0);
		expect(first.usage.cost_usd).toBeGreaterThan(0);
		const second = await reply(
			entry,
			[...messages, first, toolResult(first, "Exit code: 0\nhi\n")],
			"off",
		);
		expect(second.stop_reason).toBe("end_turn");
	});

	test("开着推理调用工具，推理 item 按收到的形式带回下一轮", {
		tags: ["model"],
	}, async () => {
		const entry = builtin("gpt-5.6-sol");
		const raws = new MemoryRaws();
		const messages = start(
			"Think briefly about which command prints hi, then run it with the shell tool.",
		);
		// 用 high：low 和 medium 下模型有时完全不推理（reasoning_tokens 为 0），回复里就没有推理 item
		const first = await reply(entry, messages, "high", raws);
		expect(first.stop_reason).toBe("tool_use");
		expect(first.reasoning_effort_sent).toBe("high");
		expect(
			first.content.find((block) => block.type === "reasoning"),
		).toMatchObject({
			opaque: expect.any(String),
			item_id: expect.any(String),
			origin: { protocol: "openai.responses" },
		});
		const second = await reply(
			entry,
			[...messages, first, toolResult(first, "Exit code: 0\nhi\n")],
			"high",
			raws,
		);
		expect(second.stop_reason).toBe("end_turn");
	});

	test("换到另一个模型系列后推理 item 照样带回，请求照常完成", {
		tags: ["model"],
	}, async () => {
		const messages = start(
			"Think briefly about which command prints hi, then run it with the shell tool.",
		);
		// 用 high 的原因同上一个测试：要模型确实返回推理 item
		const first = await reply(builtin("gpt-5.6-sol"), messages, "high");
		expect(first.stop_reason).toBe("tool_use");
		expect(
			first.content.find((block) => block.type === "reasoning"),
		).toMatchObject({ opaque: expect.any(String) });
		const second = await reply(
			builtin("gpt-6-sol"),
			[...messages, first, toolResult(first, "Exit code: 0\nhi\n")],
			"low",
		);
		expect(second.stop_reason).toBe("end_turn");
	});
});

describe("openai.chat", () => {
	test("真实模型调用工具，拿到结果后结束", { tags: ["model"] }, async () => {
		const entry = solChat();
		const messages = start("Run `echo hi` with the shell tool.");
		const first = await reply(entry, messages, "off");
		expect(first.stop_reason).toBe("tool_use");
		expect(first.protocol).toBe("openai.chat");
		const second = await reply(
			entry,
			[...messages, first, toolResult(first, "Exit code: 0\nhi\n")],
			"off",
		);
		expect(second.stop_reason).toBe("end_turn");
	});
});

test("同一段对话依次经三种协议继续：工具调用和工具结果没有丢失", {
	tags: ["model"],
}, async () => {
	const messages = start(
		"Run `echo 7` with the shell tool, then tell me the number it printed.",
	);
	const first = await reply(builtin("claude-haiku-5-5"), messages, "low");
	expect(first.stop_reason).toBe("tool_use");
	messages.push(first, toolResult(first, "Exit code: 0\n7\n"));
	const second = await reply(builtin("gpt-5.6-sol"), messages, "off");
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
	const third = await reply(solChat(), messages, "off");
	expect(third.stop_reason).toBe("tool_use");
	messages.push(third, toolResult(third, "Exit code: 0\n8\n"));
	const fourth = await reply(builtin("claude-haiku-5-5"), messages, "off");
	expect(fourth.stop_reason).toBe("end_turn");
});

/** 一张纯色的 PNG。 */
function png(width: number, height: number, rgb: number[]): string {
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
		chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

describe("工具结果里的图片", () => {
	/** 模型调用工具看一张纯色的图片，结果里带着图片；返回它看到图片之后的回复。 */
	async function colourSeen(
		entry: ModelEntry,
		rgb: number[],
		isError: boolean,
	): Promise<string> {
		const messages = start(
			"Run `show picture.png` with the shell tool. It returns the picture itself. Then answer with one word: the colour that fills the picture.",
		);
		const first = await reply(entry, messages, "off");
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
						: "[Image, image/png, 64x64.]",
				},
				{ type: "image", media_type: "image/png", data: png(64, 64, rgb) },
			],
			is_error: isError,
		};
		const second = await reply(entry, [...messages, first, result], "off");
		expect(second.stop_reason).toBe("end_turn");
		return second.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("")
			.toLowerCase();
	}

	test("openai.responses：图片放在 function_call_output 里，模型看得到", {
		tags: ["model"],
	}, async () => {
		expect(
			await colourSeen(builtin("gpt-5.6-sol"), [255, 0, 0], false),
		).toContain("red");
	});

	test("openai.chat：图片移到工具结果之后的 user 消息里，模型看得到", {
		tags: ["model"],
	}, async () => {
		expect(await colourSeen(solChat(), [0, 0, 255], false)).toContain("blue");
	});

	test("anthropic.messages：图片放在 tool_result 块里；is_error 为真时移到它后面，模型都看得到", {
		tags: ["model"],
	}, async () => {
		const entry = builtin("claude-haiku-5-5");
		expect(await colourSeen(entry, [255, 0, 0], false)).toContain("red");
		expect(await colourSeen(entry, [0, 0, 255], true)).toContain("blue");
	});
});
