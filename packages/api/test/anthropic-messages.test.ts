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

function sse(events: [string, object][]): string {
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
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

	test("中途回退：分界原位保留，之前的推理和工具调用作废，按各次采样的模型分别计费", async () => {
		const opus: ModelEntry = {
			...entry,
			model: "claude-opus-5",
			price: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
			allowed_fallback_models: [
				{
					model: "claude-opus-4-8",
					price: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
				},
			],
		};
		let headers: Headers | undefined;
		let body = "";
		const events: StreamEvent[] = [];
		for await (const event of streamModel(opus, request, {
			messageId: "m-1",
			apiKey: "test",
			fetch: async (_url, init) => {
				headers = new Headers(init?.headers);
				body = String(init?.body);
				return new Response(
					sse([
						[
							"message_start",
							{
								message: {
									model: "claude-opus-5",
									usage: { input_tokens: 10 },
								},
							},
						],
						[
							"content_block_start",
							{ index: 0, content_block: { type: "thinking", thinking: "" } },
						],
						[
							"content_block_delta",
							{ index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
						],
						[
							"content_block_delta",
							{
								index: 0,
								delta: { type: "signature_delta", signature: "sig" },
							},
						],
						["content_block_stop", { index: 0 }],
						[
							"content_block_start",
							{
								index: 1,
								content_block: {
									type: "tool_use",
									id: "toolu_a",
									name: "shell",
									input: {},
								},
							},
						],
						[
							"content_block_delta",
							{
								index: 1,
								delta: {
									type: "input_json_delta",
									partial_json: '{"command":"a"}',
								},
							},
						],
						["content_block_stop", { index: 1 }],
						[
							"content_block_start",
							{
								index: 2,
								content_block: {
									type: "fallback",
									from: { model: "claude-opus-5" },
									to: { model: "claude-opus-4-8" },
									trigger: { type: "refusal", category: "cyber" },
								},
							},
						],
						["content_block_stop", { index: 2 }],
						[
							"content_block_start",
							{ index: 3, content_block: { type: "text", text: "" } },
						],
						[
							"content_block_delta",
							{ index: 3, delta: { type: "text_delta", text: "ok" } },
						],
						["content_block_stop", { index: 3 }],
						[
							"content_block_start",
							{
								index: 4,
								content_block: {
									type: "tool_use",
									id: "toolu_b",
									name: "shell",
									input: {},
								},
							},
						],
						[
							"content_block_delta",
							{
								index: 4,
								delta: {
									type: "input_json_delta",
									partial_json: '{"command":"b"}',
								},
							},
						],
						["content_block_stop", { index: 4 }],
						[
							"message_delta",
							{
								delta: { stop_reason: "tool_use" },
								usage: {
									input_tokens: 12,
									output_tokens: 20,
									iterations: [
										{
											type: "message",
											model: "claude-opus-5",
											input_tokens: 10,
											output_tokens: 5,
											cache_read_input_tokens: 0,
											cache_creation_input_tokens: 0,
										},
										{
											type: "fallback_message",
											model: "claude-opus-4-8",
											input_tokens: 12,
											output_tokens: 20,
											cache_read_input_tokens: 0,
											cache_creation_input_tokens: 0,
										},
									],
								},
							},
						],
						["message_stop", {}],
					]),
				);
			},
			signal: new AbortController().signal,
		})) {
			events.push(event);
		}
		// 只给出明确的回退列表，并带上回退的 beta
		expect(JSON.parse(body).fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
		expect(headers?.get("anthropic-beta")).toBe(
			"server-side-fallback-2026-07-01",
		);
		expect(events.at(-2)).toEqual({
			type: "invalidate",
			invalidation: {
				blocks: [
					{ message_id: "m-1", index: 0 },
					{ message_id: "m-1", index: 1 },
				],
				reason: "fallback",
			},
		});
		const end = events.at(-1);
		if (end?.type !== "end") throw new Error("流没有以 end 结束");
		expect(end.message).toMatchObject({
			model: "claude-opus-4-8",
			stop_reason: "tool_use",
			usage: { input: 22, output: 25 },
		});
		expect(end.message.content[2]).toEqual({
			type: "fallback",
			from: "claude-opus-5",
			to: "claude-opus-4-8",
			origin: {
				protocol: "anthropic.messages",
				service: "anthropic",
				model: "claude-opus-4-8",
			},
		});
		expect(end.message.usage.cost_usd).toBeCloseTo(
			(10 * 1 + 5 * 2 + 12 * 10 + 20 * 20) / 1e6,
		);
		// 作废的块去掉之后，分界原位带回
		const next = JSON.parse(
			anthropicRequestBody(opus, {
				...request,
				messages: [
					...request.messages.slice(0, 2),
					{ ...end.message, content: end.message.content.slice(2) },
				],
			}),
		);
		expect(next.messages.at(-1).content.slice(0, 2)).toEqual([
			{
				type: "fallback",
				from: { model: "claude-opus-5" },
				to: { model: "claude-opus-4-8" },
			},
			{ type: "text", text: "ok" },
		]);
	});

	test("拒绝时带上类别、说明和建议的模型，作废本轮全部输出", async () => {
		const events = await collect(
			fakeFetch(
				() =>
					new Response(
						sse([
							[
								"message_start",
								{ message: { model: "m", usage: { input_tokens: 5 } } },
							],
							[
								"content_block_start",
								{ index: 0, content_block: { type: "text", text: "" } },
							],
							[
								"content_block_delta",
								{ index: 0, delta: { type: "text_delta", text: "Sure" } },
							],
							["content_block_stop", { index: 0 }],
							[
								"message_delta",
								{
									delta: {
										stop_reason: "refusal",
										stop_details: {
											type: "refusal",
											category: "cyber",
											explanation: "no",
											recommended_model: "claude-opus-4-8",
										},
									},
									usage: { output_tokens: 1 },
								},
							],
							["message_stop", {}],
						]),
					),
			),
		);
		expect(events.at(-2)).toEqual({
			type: "invalidate",
			invalidation: {
				blocks: [{ message_id: "m-1", index: 0 }],
				reason: "refusal",
			},
		});
		expect(events.at(-1)).toMatchObject({
			message: {
				stop_reason: "refusal",
				refusal: {
					category: "cyber",
					explanation: "no",
					recommended_model: "claude-opus-4-8",
				},
			},
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
