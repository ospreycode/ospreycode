import { readFileSync } from "node:fs";
import {
	builtinModels,
	type ModelEntry,
	openaiChatRequestBody,
	streamModel,
} from "@ospreycode/api";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
	StreamEvent,
} from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

/** OpenAI 自己的 Chat Completions 带工具时只能不推理：这个服务上的条目只有 `off`。 */
const solChat: ModelEntry = {
	id: "gpt-5.6-sol-chat",
	protocol: "openai.chat",
	service: "openai",
	base_url: "https://api.example.com/v1",
	model: "gpt-5.6-sol",
	context_window: 400_000,
	max_output_tokens: 128_000,
	images: true,
	thinking_level_map: { off: "none" },
	price: { input: 4, output: 20, cache_read: 0.4, cache_write: 0 },
};

const deepseek = (() => {
	const entry = builtinModels.find((m) => m.id === "deepseek-flash");
	if (entry === undefined) throw new Error("内置清单里没有 deepseek-flash");
	return { ...entry, base_url: "https://api.example.com" };
})();

const usage = {
	input: 1,
	output: 1,
	cache_read: 0,
	cache_write: 0,
	reasoning: 0,
};

const shell = {
	name: "shell",
	description: "Run a shell command.",
	parameters: { type: "object", properties: { command: { type: "string" } } },
};

const image = { type: "image", media_type: "image/png", data: "iVBO" } as const;

function reply(
	entry: ModelEntry,
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		message_id: crypto.randomUUID(),
		content,
		protocol: entry.protocol,
		service: entry.service,
		requested_model: entry.id,
		model: entry.model,
		reasoning_effort: "high",
		stop_reason: "tool_use",
		usage,
	};
}

function request(
	entry: ModelEntry,
	messages: Message[],
	extra: Partial<ModelRequest> = {},
): ModelRequest {
	return {
		model: entry.id,
		reasoning_effort: "off",
		tool_choice: "auto",
		cache_retention: "short",
		messages: [
			{
				role: "system",
				message_id: "s",
				content: [{ type: "text", text: "be brief" }],
			},
			...messages,
		],
		tools: [shell],
		...extra,
	};
}

function deepseekThought(text: string, model = deepseek.model) {
	return {
		type: "reasoning" as const,
		text,
		redacted: false,
		origin: { protocol: "openai.chat" as const, service: "deepseek", model },
	};
}

describe("openaiChatRequestBody", () => {
	test("OpenAI 的行为：带 store、流式用量和 strict，工具结果里的图片移到这组结果之后", () => {
		const body = JSON.parse(
			openaiChatRequestBody(
				solChat,
				request(solChat, [
					{
						role: "user",
						message_id: "u",
						content: [{ type: "text", text: "look" }],
					},
					reply(solChat, [
						{ type: "text", text: "two calls" },
						{
							type: "tool_call",
							call_id: "call_1",
							name: "shell",
							arguments: '{"command":"a"}',
						},
						{
							type: "tool_call",
							call_id: "call_2",
							name: "shell",
							arguments: '{"command":"b"}',
						},
					]),
					{
						role: "tool_result",
						message_id: "t1",
						call_id: "call_1",
						content: [{ type: "text", text: "shot" }, image],
						is_error: false,
					},
					{
						role: "tool_result",
						message_id: "t2",
						call_id: "call_2",
						content: [image],
						is_error: false,
					},
					{
						role: "system",
						message_id: "late",
						content: [{ type: "text", text: "budget is low" }],
					},
				]),
			),
		);
		const imagePart = {
			type: "image_url",
			image_url: { url: "data:image/png;base64,iVBO" },
		};
		expect(body).toEqual({
			model: "gpt-5.6-sol",
			messages: [
				{ role: "system", content: "be brief\n\nbudget is low" },
				{ role: "user", content: [{ type: "text", text: "look" }] },
				{
					role: "assistant",
					content: "two calls",
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "shell", arguments: '{"command":"a"}' },
						},
						{
							id: "call_2",
							type: "function",
							function: { name: "shell", arguments: '{"command":"b"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "shot" },
				{
					role: "tool",
					tool_call_id: "call_2",
					content: "(see attached image)",
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from the tool results above:",
						},
						imagePart,
						imagePart,
					],
				},
			],
			tools: [{ type: "function", function: { ...shell, strict: false } }],
			tool_choice: "auto",
			reasoning_effort: "none",
			max_completion_tokens: 128_000,
			store: false,
			stream: true,
			stream_options: { include_usage: true },
		});
	});

	test("兼容服务按 compat 发送；推理内容只带回同一模型，换模型后不再发送", () => {
		const user: Message = {
			role: "user",
			message_id: "u",
			content: [{ type: "text", text: "go" }],
		};
		const own = reply(deepseek, [
			deepseekThought("plan"),
			{ type: "tool_call", call_id: "call_1", name: "shell", arguments: "{}" },
		]);
		const other = reply(deepseek, [
			deepseekThought("old plan", "deepseek-v4-pro"),
			{ type: "text", text: "done" },
		]);
		const body = JSON.parse(
			openaiChatRequestBody(
				deepseek,
				request(deepseek, [user, other, user, own], {
					reasoning_effort: "high",
				}),
			),
		);
		expect(body.messages.slice(2)).toEqual([
			{ role: "assistant", content: "done" },
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{
				role: "assistant",
				content: null,
				reasoning_content: "plan",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "shell", arguments: "{}" },
					},
				],
			},
		]);
		expect(body).toMatchObject({
			reasoning_effort: "high",
			max_tokens: deepseek.max_output_tokens,
		});
		expect(body).not.toHaveProperty("store");
		expect(body.tools[0].function).not.toHaveProperty("strict");
	});

	test("能中途追加 developer 消息的服务原样追加，OpenRouter 写法的推理强度放进 reasoning", () => {
		const entry: ModelEntry = {
			...solChat,
			system_updates: true,
			thinking_level_map: { off: "none", high: "high" },
			compat: { thinking_format: "openrouter" },
		};
		const body = JSON.parse(
			openaiChatRequestBody(
				entry,
				request(
					entry,
					[
						{
							role: "user",
							message_id: "u",
							content: [{ type: "text", text: "go" }],
						},
						{
							role: "system",
							message_id: "late",
							content: [{ type: "text", text: "note" }],
						},
					],
					{ reasoning_effort: "high" },
				),
			),
		);
		expect(body.messages.at(-1)).toEqual({
			role: "developer",
			content: "note",
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body).not.toHaveProperty("reasoning_effort");
	});
});

function fixture(name: string): string {
	return readFileSync(
		new URL(`./fixtures/${name}.sse`, import.meta.url),
		"utf8",
	);
}

function chunks(items: object[]): string {
	return `${items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function collect(entry: ModelEntry, body: string, status = 200) {
	const events: StreamEvent[] = [];
	for await (const event of streamModel(entry, request(entry, []), {
		messageId: "m-1",
		apiKey: "test",
		fetch: async () => new Response(body, { status }),
		signal: new AbortController().signal,
	})) {
		events.push(event);
	}
	const end = events.at(-1);
	if (end?.type !== "end") throw new Error("流没有以 end 结束");
	return { events, end };
}

describe("streamModel（openai.chat）", () => {
	test("把录制的真实流转换成内部事件和回复", async () => {
		const { events, end } = await collect(solChat, fixture("openai-chat-tool"));
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"tool_call_start",
			...Array(6).fill("tool_call_delta"),
			"tool_call_end",
			"usage",
			"end",
		]);
		expect(end.message).toMatchObject({
			protocol: "openai.chat",
			model: "gpt-5.6-sol",
			stop_reason: "tool_use",
			reasoning_effort_sent: "none",
			content: [
				{
					type: "tool_call",
					call_id: "call_371f4a8adb5145d597a2190737b23104",
					name: "shell",
					arguments: '{"command":"echo hi"}',
				},
			],
			usage: { input: 4447, output: 18 },
		});
		const text = await collect(solChat, fixture("openai-chat-text"));
		expect(text.end.message).toMatchObject({
			stop_reason: "end_turn",
			content: [{ type: "text", text: "Hello there, friend." }],
		});
	});

	test("推理内容从模型配置指定的字段读出，缓存命中按 DeepSeek 的字段换算", async () => {
		const { end } = await collect(
			deepseek,
			chunks([
				{
					model: "deepseek-flash",
					choices: [{ index: 0, delta: { reasoning_content: "think" } }],
				},
				{
					model: "deepseek-flash",
					choices: [
						{ index: 0, delta: { content: "hi" }, finish_reason: "stop" },
					],
				},
				{
					model: "deepseek-flash",
					choices: [],
					usage: {
						prompt_tokens: 100,
						prompt_cache_hit_tokens: 60,
						completion_tokens: 20,
						completion_tokens_details: { reasoning_tokens: 5 },
					},
				},
			]),
		);
		expect(end.message.content).toEqual([
			deepseekThought("think", "deepseek-flash"),
			{ type: "text", text: "hi" },
		]);
		expect(end.message.usage).toMatchObject({
			input: 40,
			cache_read: 60,
			output: 20,
			reasoning: 5,
		});
	});

	test("finish_reason 为 content_filter 时按拒绝处理并作废本轮输出，流里的错误以带错误的 end 结束", async () => {
		const filtered = await collect(
			solChat,
			chunks([
				{
					model: "gpt-5.6-sol",
					choices: [
						{
							index: 0,
							delta: { content: "Sure" },
							finish_reason: "content_filter",
						},
					],
				},
			]),
		);
		expect(filtered.end.message).toMatchObject({
			stop_reason: "refusal",
			refusal: { category: "content_filter" },
		});
		expect(
			filtered.events.find((event) => event.type === "invalidate"),
		).toMatchObject({
			invalidation: {
				reason: "refusal",
				blocks: [{ message_id: "m-1", index: 0 }],
			},
		});

		const failed = await collect(
			solChat,
			'data: {"error":{"code":"rate_limit_exceeded","message":"slow"}}\n\n',
		);
		expect(failed.end.error).toEqual({
			category: "rate_limit",
			message: "slow",
		});

		const truncated = await collect(
			solChat,
			'data: {"model":"gpt-5.6-sol","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
		);
		expect(truncated.end.error?.category).toBe("network");
	});
});
