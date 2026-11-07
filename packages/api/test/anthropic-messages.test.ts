import { readFileSync } from "node:fs";
import {
	anthropicRequestBody,
	classifyAnthropicError,
	type ModelEntry,
	streamModel,
} from "@ospreycode/api";
import type { ModelRequest, StreamEvent } from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

const entry: ModelEntry = {
	id: "haiku",
	protocol: "anthropic.messages",
	service: "anthropic",
	base_url: "https://api.example.com/v1",
	model: "claude-haiku-5-5",
	context_window: 200_000,
	max_output_tokens: 8_000,
	price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

const request: ModelRequest = {
	model: "haiku",
	reasoning_effort: "off",
	tool_choice: "auto",
	cache_retention: "short",
	messages: [
		{
			role: "system",
			message_id: "s",
			content: [{ type: "text", text: "be brief" }],
		},
		{
			role: "user",
			message_id: "u1",
			content: [{ type: "text", text: "list" }],
		},
		{
			role: "assistant",
			message_id: "a1",
			content: [
				{ type: "text", text: "ok" },
				{
					type: "tool_call",
					call_id: "toolu_1",
					name: "shell",
					arguments: '{"command":"ls"}',
				},
			],
			protocol: "anthropic.messages",
			service: "anthropic",
			requested_model: "haiku",
			model: "claude-haiku-5-5",
			reasoning_effort: "off",
			stop_reason: "tool_use",
			usage: {
				input: 1,
				output: 1,
				cache_read: 0,
				cache_write: 0,
				reasoning: 0,
			},
		},
		{
			role: "tool_result",
			message_id: "t1",
			call_id: "toolu_1",
			tool_call_id: "tc",
			content: [{ type: "text", text: "a.txt" }],
			is_error: false,
		},
		{
			role: "user",
			message_id: "u2",
			content: [{ type: "text", text: "now stop" }],
		},
	],
	tools: [
		{
			name: "shell",
			description: "run",
			parameters: { type: "object", properties: {} },
		},
	],
};

describe("anthropicRequestBody", () => {
	test("工具结果和其后的用户输入并成一条 user 消息，断点加在 system、tools 和最后一条消息的末尾", () => {
		expect(JSON.parse(anthropicRequestBody(entry, request))).toEqual({
			model: "claude-haiku-5-5",
			max_tokens: 8_000,
			system: [
				{
					type: "text",
					text: "be brief",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{ role: "user", content: [{ type: "text", text: "list" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "ok" },
						{
							type: "tool_use",
							id: "toolu_1",
							name: "shell",
							input: { command: "ls" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							content: [{ type: "text", text: "a.txt" }],
							is_error: false,
						},
						{
							type: "text",
							text: "now stop",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
			tools: [
				{
					name: "shell",
					description: "run",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral" },
				},
			],
			tool_choice: { type: "auto" },
			stream: true,
		});
	});

	test("同样的内部请求每次生成相同的请求体", () => {
		expect(anthropicRequestBody(entry, request)).toBe(
			anthropicRequestBody(entry, request),
		);
	});
});

describe("classifyAnthropicError", () => {
	test("按状态码和错误码归类", () => {
		const body = (message: string, extra: object = {}) =>
			JSON.stringify({
				type: "error",
				error: { type: "x", message, ...extra },
			});
		expect(classifyAnthropicError(401, body("bad key"), null).category).toBe(
			"authentication",
		);
		expect(classifyAnthropicError(429, body("slow down"), "3")).toEqual({
			category: "rate_limit",
			message: "slow down",
			retry_after_ms: 3000,
		});
		expect(
			classifyAnthropicError(
				429,
				body("limit", {
					details: { error_code: "enforced_spend_limit_reached" },
				}),
				null,
			).category,
		).toBe("billing");
		expect(
			classifyAnthropicError(
				400,
				body("prompt is too long: 300000 tokens"),
				null,
			).category,
		).toBe("context_overflow");
		expect(
			classifyAnthropicError(
				400,
				body(
					"messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
				),
				null,
			).category,
		).toBe("reasoning_prefix_mismatch");
		expect(
			classifyAnthropicError(
				400,
				body("messages.3.content.0: Invalid `signature` in `thinking` block"),
				null,
			).category,
		).toBe("invalid_request");
		expect(
			classifyAnthropicError(529, "<html>overloaded</html>", null),
		).toEqual({
			category: "overloaded",
			message: "<html>overloaded</html>",
		});
	});
});

function fakeFetch(response: () => Response): typeof fetch {
	return async () => response();
}

async function collect(
	fetch: typeof globalThis.fetch,
	signal = new AbortController().signal,
) {
	const events: StreamEvent[] = [];
	for await (const event of streamModel(entry, request, {
		messageId: "m-1",
		apiKey: "test",
		fetch,
		signal,
	})) {
		events.push(event);
	}
	return events;
}

describe("streamModel（anthropic.messages）", () => {
	test("把录制的真实流转换成内部事件和回复", async () => {
		const sse = readFileSync(
			new URL("./fixtures/anthropic-tool-use.sse", import.meta.url),
		);
		const events = await collect(
			fakeFetch(() => new Response(sse, { status: 200 })),
		);
		expect(events.map((e) => e.type)).toEqual([
			"start",
			"text_delta",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_end",
			"usage",
			"end",
		]);
		const end = events.at(-1);
		expect(end).toMatchObject({
			type: "end",
			message: {
				message_id: "m-1",
				model: "claude-haiku-5-5",
				stop_reason: "tool_use",
				content: [
					{ type: "text", text: "I'll run that echo command." },
					{
						type: "tool_call",
						call_id: "toolu_01htIuHzXbcC0mn1LMZQBF66",
						name: "shell",
						arguments: '{"command": "echo hi"}',
					},
				],
				usage: {
					input: 375,
					output: 65,
					cache_read: 0,
					cache_write: 0,
					reasoning: 0,
				},
			},
		});
		expect(end?.type === "end" && end.message.usage.cost_usd).toBeCloseTo(
			(375 * 1 + 65 * 5) / 1_000_000,
		);
	});

	test("HTTP 错误、流里的 error 事件和提前结束的流都以带错误的 end 结束", async () => {
		const http = await collect(
			fakeFetch(
				() =>
					new Response('{"error":{"type":"x","message":"no"}}', {
						status: 401,
					}),
			),
		);
		expect(http.at(-1)).toMatchObject({
			type: "end",
			error: { category: "authentication" },
		});

		const overloaded = await collect(
			fakeFetch(
				() =>
					new Response(
						'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
					),
			),
		);
		expect(overloaded.at(-1)).toMatchObject({
			type: "end",
			message: { stop_reason: "error" },
			error: { category: "overloaded", message: "busy" },
		});

		const truncated = await collect(
			fakeFetch(
				() =>
					new Response(
						'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
					),
			),
		);
		expect(truncated.at(-1)).toMatchObject({
			type: "end",
			error: { category: "network" },
		});

		const unreachable = await collect(async () => {
			throw new TypeError("fetch failed");
		});
		expect(unreachable.at(-1)).toMatchObject({
			type: "end",
			error: { category: "network" },
		});
	});

	test("取消时以 cancelled 结束", async () => {
		const controller = new AbortController();
		const events = await collect(async (_url, init) => {
			controller.abort();
			throw init?.signal?.reason;
		}, controller.signal);
		expect(events).toMatchObject([
			{ type: "end", message: { stop_reason: "cancelled" } },
		]);
	});
});
