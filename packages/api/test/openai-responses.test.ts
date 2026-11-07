import { readFileSync } from "node:fs";
import {
	builtinModels,
	classifyOpenAIError,
	type ModelEntry,
	openaiResponsesRequestBody,
	type RawKey,
	type RawPart,
	type RawStore,
	streamModel,
} from "@ospreycode/api";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
	StreamEvent,
} from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

function builtin(id: string): ModelEntry {
	const entry = builtinModels.find((candidate) => candidate.id === id);
	if (entry === undefined) throw new Error(`内置清单里没有 ${id}`);
	return { ...entry, base_url: "https://api.example.com/v1" };
}

const sol = builtin("gpt-5.6-sol");

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

function reply(
	content: AssistantMessage["content"],
	from: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		message_id: crypto.randomUUID(),
		content,
		protocol: "openai.responses",
		service: "openai",
		requested_model: "gpt-5.6-sol",
		model: "gpt-5.6-sol",
		reasoning_effort: "low",
		stop_reason: "tool_use",
		usage,
		...from,
	};
}

function request(messages: Message[], extra: Partial<ModelRequest> = {}) {
	return {
		model: sol.id,
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
	} satisfies ModelRequest;
}

const image = { type: "image", media_type: "image/png", data: "iVBO" } as const;

describe("openaiResponsesRequestBody", () => {
	test("指令放进 instructions，回复和工具结果按 item 转换，只带回同一服务的推理 item", () => {
		const body = JSON.parse(
			openaiResponsesRequestBody(
				sol,
				request(
					[
						{
							role: "user",
							message_id: "u",
							content: [{ type: "text", text: "look" }, image],
						},
						reply([
							{
								type: "reasoning",
								text: "",
								redacted: false,
								opaque: "enc",
								item_id: "rs_1",
								origin: {
									protocol: "openai.responses",
									service: "openai",
									model: "gpt-5.6-sol",
								},
							},
							{ type: "text", text: "checking", phase: "commentary" },
							{
								type: "tool_call",
								call_id: "call_1",
								name: "shell",
								arguments: '{"command":"ls"}',
							},
						]),
						{
							role: "tool_result",
							message_id: "t",
							call_id: "call_1",
							content: [{ type: "text", text: "a.png" }, image],
							is_error: false,
						},
						reply(
							[
								{
									type: "reasoning",
									text: "hmm",
									redacted: false,
									opaque: "sig",
									origin: {
										protocol: "anthropic.messages",
										service: "anthropic",
										model: "claude-haiku-5-5",
									},
								},
								{ type: "text", text: "done" },
							],
							{ protocol: "anthropic.messages", service: "anthropic" },
						),
					],
					{ reasoning_effort: "low" },
				),
				{ cacheKey: "session-1" },
			),
		);
		expect(body).toEqual({
			model: "gpt-5.6-sol",
			instructions: "be brief",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "look" },
						{
							type: "input_image",
							image_url: "data:image/png;base64,iVBO",
							detail: "auto",
						},
					],
				},
				{
					type: "reasoning",
					id: "rs_1",
					summary: [],
					encrypted_content: "enc",
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "checking", annotations: [] }],
					status: "completed",
					phase: "commentary",
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "shell",
					arguments: '{"command":"ls"}',
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: [
						{ type: "input_text", text: "a.png" },
						{
							type: "input_image",
							image_url: "data:image/png;base64,iVBO",
							detail: "auto",
						},
					],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "done", annotations: [] }],
					status: "completed",
				},
			],
			tools: [{ type: "function", ...shell, strict: false }],
			tool_choice: "auto",
			reasoning: { effort: "low", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			max_output_tokens: 128_000,
			prompt_cache_key: "session-1",
			store: false,
			stream: true,
		});
	});

	test("不能中途追加 developer 消息的模型把之后的指令并入 instructions，不缓存时不带缓存的键", () => {
		const late: Message = {
			role: "system",
			message_id: "late",
			content: [{ type: "text", text: "sandbox is now read-only" }],
		};
		const user: Message = {
			role: "user",
			message_id: "u",
			content: [{ type: "text", text: "go" }],
		};
		const withUpdates = JSON.parse(
			openaiResponsesRequestBody(sol, request([user, late])),
		);
		expect(withUpdates.input.at(-1)).toEqual({
			role: "developer",
			content: [{ type: "input_text", text: "sandbox is now read-only" }],
		});
		const folded = JSON.parse(
			openaiResponsesRequestBody(
				{ ...sol, system_updates: false },
				request([user, late], { cache_retention: "none" }),
				{ cacheKey: "session-1" },
			),
		);
		expect(folded.instructions).toBe("be brief\n\nsandbox is now read-only");
		expect(folded.input).toHaveLength(1);
		expect(folded).not.toHaveProperty("prompt_cache_key");
	});

	test("工具名和别的协议留下的调用编号按 Responses 的限制改写，同一个编号总是改写成同一个结果", () => {
		const longId = `toolu_${"x".repeat(80)}`;
		const tool = { ...shell, name: "mcp.github/create issue" };
		const body = JSON.parse(
			openaiResponsesRequestBody(
				sol,
				request(
					[
						reply(
							[
								{
									type: "tool_call",
									call_id: longId,
									name: tool.name,
									arguments: "{}",
								},
							],
							{ protocol: "anthropic.messages", service: "anthropic" },
						),
						{
							role: "tool_result",
							message_id: "t",
							call_id: longId,
							content: [{ type: "text", text: "ok" }],
							is_error: true,
						},
					],
					{ tools: [tool] },
				),
			),
		);
		const [call, output] = body.input;
		expect(call.name).toBe("mcp_github_create_issue");
		expect(body.tools[0].name).toBe("mcp_github_create_issue");
		expect(call.call_id).toHaveLength(64);
		expect(call.call_id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(output.call_id).toBe(call.call_id);
	});
});

function fixture(name: string): string {
	return readFileSync(
		new URL(`./fixtures/${name}.sse`, import.meta.url),
		"utf8",
	);
}

function sse(events: object[]): string {
	return events
		.map(
			(event) =>
				`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
}

async function collect(
	body: string,
	messages: Message[] = [],
	options: {
		raws?: RawStore;
		status?: number;
		tools?: ModelRequest["tools"];
	} = {},
) {
	const events: StreamEvent[] = [];
	for await (const event of streamModel(
		sol,
		request(messages, { tools: options.tools ?? [shell] }),
		{
			messageId: "m-1",
			apiKey: "test",
			fetch: async () => new Response(body, { status: options.status ?? 200 }),
			signal: new AbortController().signal,
			...(options.raws === undefined ? {} : { raws: options.raws }),
		},
	)) {
		events.push(event);
	}
	const end = events.at(-1);
	if (end?.type !== "end") throw new Error("流没有以 end 结束");
	return { events, end };
}

class MemoryRaws implements RawStore {
	parts = new Map<string, RawPart>();

	#key(key: RawKey): string {
		return [
			key.protocol,
			key.service,
			key.api_version,
			key.part,
			key.message_id,
			key.content_sha256,
		].join(" ");
	}

	get(key: RawKey): string[] | undefined {
		return this.parts.get(this.#key(key))?.pieces;
	}

	put(part: RawPart): void {
		this.parts.set(this.#key(part), part);
	}
}

describe("streamModel（openai.responses）", () => {
	test("把录制的真实流转换成内部事件和回复，用量换成三项互不包含的口径", async () => {
		const { events, end } = await collect(fixture("openai-responses-tool"));
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"tool_call_start",
			...Array(6).fill("tool_call_delta"),
			"tool_call_end",
			"usage",
			"end",
		]);
		expect(end.message).toMatchObject({
			message_id: "m-1",
			protocol: "openai.responses",
			model: "gpt-5.6-sol",
			stop_reason: "tool_use",
			reasoning_effort_sent: "none",
			content: [
				{
					type: "tool_call",
					call_id: "call_7fd23f4f52694f77a58662bf6389948c",
					name: "shell",
					arguments: '{"command":"echo hi"}',
				},
			],
			usage: { input: 65, output: 18, cache_read: 0, cache_write: 0 },
		});
		expect(end.message.usage.cost_usd).toBeCloseTo((65 * 4 + 18 * 20) / 1e6);
	});

	test("推理 item 带着加密内容和编号，文字带 phase", async () => {
		const reasoning = await collect(fixture("openai-responses-reasoning"));
		expect(reasoning.end.message.content).toMatchObject([
			{
				type: "reasoning",
				text: "",
				redacted: false,
				opaque: expect.stringMatching(/^gAAAA/),
				item_id: expect.stringMatching(/^rs_/),
				origin: { protocol: "openai.responses", model: "gpt-5.6-sol" },
			},
			{ type: "tool_call", name: "shell" },
		]);
		expect(reasoning.end.message.usage.reasoning).toBe(10);

		const text = await collect(fixture("openai-responses-text"));
		expect(text.end.message).toMatchObject({
			stop_reason: "end_turn",
			content: [
				{ type: "reasoning" },
				{ type: "text", text: "Hello there, friend!", phase: "final_answer" },
			],
		});
	});

	test("回复里的 item 按收到的形式保存，下一次请求原样带回，请求体逐字节不变", async () => {
		const raws = new MemoryRaws();
		const user: Message = {
			role: "user",
			message_id: "u",
			content: [{ type: "text", text: "run it" }],
		};
		const { end } = await collect(
			fixture("openai-responses-reasoning"),
			[user],
			{
				raws,
			},
		);
		const next = request([
			user,
			end.message,
			{
				role: "tool_result",
				message_id: "t",
				call_id: "call_be1f60e91e06433eb108d15683ac9fe1",
				content: [{ type: "text", text: "hi" }],
				is_error: false,
			},
		]);
		const body = openaiResponsesRequestBody(sol, next, { raws });
		// 中转服务加在 item 上的字段也原样带回：重放的就是收到的原文
		expect(body).toContain('"internal_chat_message_metadata_passthrough"');
		const items = JSON.parse(body).input;
		expect(items.map((item: { type?: string }) => item.type)).toEqual([
			undefined,
			"reasoning",
			"function_call",
			"function_call_output",
		]);
		expect(openaiResponsesRequestBody(sol, next, { raws })).toBe(body);
		expect(
			[...raws.parts.values()].map(
				(part) => `${part.part} ${part.message_id ?? ""}`,
			),
		).toEqual(["system s", "message u", "tools ", "message m-1", "message t"]);
	});

	test("过滤器截断的输出按拒绝处理，作废本轮全部输出", async () => {
		const { events, end } = await collect(
			sse([
				{ type: "response.created", response: { model: "gpt-5.6-sol" } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", content: [] },
				},
				{
					type: "response.output_text.delta",
					output_index: 0,
					delta: "Sure, ",
				},
				{
					type: "response.incomplete",
					response: {
						model: "gpt-5.6-sol",
						status: "incomplete",
						incomplete_details: { reason: "content_filter" },
						usage: null,
					},
				},
			]),
		);
		expect(end.message).toMatchObject({
			stop_reason: "refusal",
			refusal: { category: "content_filter" },
			content: [{ type: "text", text: "Sure, " }],
		});
		expect(events.find((event) => event.type === "invalidate")).toEqual({
			type: "invalidate",
			invalidation: {
				blocks: [{ message_id: "m-1", index: 0 }],
				reason: "refusal",
			},
		});
	});

	test("模型调用改写过名字的工具时换回内部的名字", async () => {
		const { end } = await collect(
			sse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "mcp_github_create_issue",
						arguments: "{}",
					},
				},
				{
					type: "response.completed",
					response: { model: "gpt-5.6-sol", status: "completed", usage: null },
				},
			]),
			[],
			{ tools: [{ ...shell, name: "mcp.github/create issue" }] },
		);
		expect(end.message.content).toEqual([
			{
				type: "tool_call",
				call_id: "call_1",
				name: "mcp.github/create issue",
				arguments: "{}",
			},
		]);
	});

	test("流里的错误、失败的响应和提前断开的流都以带错误的 end 结束", async () => {
		const streamError = await collect(
			sse([{ type: "error", code: "rate_limit_exceeded", message: "slow" }]),
		);
		expect(streamError.end).toMatchObject({
			message: { stop_reason: "error" },
			error: { category: "rate_limit", message: "slow" },
		});
		const failed = await collect(
			sse([
				{
					type: "response.failed",
					response: {
						status: "failed",
						error: { code: "server_error", message: "boom" },
					},
				},
			]),
		);
		expect(failed.end.error).toEqual({
			category: "overloaded",
			message: "boom",
		});
		const truncated = await collect(
			sse([{ type: "response.created", response: { model: "gpt-5.6-sol" } }]),
		);
		expect(truncated.end.error?.category).toBe("network");
		const http = await collect(
			'{"error":{"code":"model_not_found","message":"No available channel","type":"new_api_error"}}',
			[],
			{ status: 503 },
		);
		expect(http.end.error?.category).toBe("overloaded");
	});
});

describe("classifyOpenAIError", () => {
	const body = (code: string, type = "x") =>
		JSON.stringify({ error: { message: code, type, code } });

	test("429 按错误码区分额度不足和限流", () => {
		for (const code of [
			"credit_balance_exhausted",
			"organization_spend_limit_exceeded",
			"project_spend_limit_exceeded",
			"organization_usage_limit_exceeded",
		]) {
			expect(
				classifyOpenAIError(429, body(code, "insufficient_quota"), null)
					.category,
			).toBe("billing");
		}
		expect(classifyOpenAIError(429, body("slow_down"), "2")).toEqual({
			category: "rate_limit",
			message: "slow_down",
			retry_after_ms: 2000,
		});
		expect(
			classifyOpenAIError(429, body("rate_limit_exceeded"), null).category,
		).toBe("rate_limit");
	});

	test("其他状态码和错误码", () => {
		expect(
			classifyOpenAIError(401, body("invalid_api_key"), null).category,
		).toBe("authentication");
		expect(
			classifyOpenAIError(400, body("context_length_exceeded"), null).category,
		).toBe("context_overflow");
		expect(
			classifyOpenAIError(503, body("server_is_overloaded"), null).category,
		).toBe("overloaded");
		expect(classifyOpenAIError(400, "<html>bad</html>", null)).toEqual({
			category: "invalid_request",
			message: "<html>bad</html>",
		});
	});
});
