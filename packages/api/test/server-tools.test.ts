import {
	anthropicRequestBody,
	builtinModels,
	countTokens,
	type ModelEntry,
	openaiResponsesRequestBody,
	type StreamOptions,
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

const haiku: ModelEntry = {
	...builtin("claude-haiku-5-5"),
	price: {
		input: 1,
		output: 5,
		cache_read: 0.1,
		cache_write: 1.25,
		server_tools: { web_search: 10, web_fetch: 0 },
	},
};
const sol = builtin("gpt-5.6-sol");

const shell = {
	name: "shell",
	description: "Run a shell command.",
	parameters: { type: "object", properties: { command: { type: "string" } } },
};

const system: Message = {
	role: "system",
	message_id: "s",
	content: [{ type: "text", text: "be brief" }],
};

const question: Message = {
	role: "user",
	message_id: "u",
	content: [{ type: "text", text: "What is the weather in NYC today?" }],
};

function request(entry: ModelEntry, messages: Message[]): ModelRequest {
	return {
		model: entry.id,
		reasoning_effort: "low",
		tool_choice: "auto",
		cache_retention: "none",
		messages: [system, ...messages],
		tools: [shell],
	};
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
	entry: ModelEntry,
	body: string,
	options: Partial<StreamOptions> = {},
	messages: Message[] = [question],
) {
	const events: StreamEvent[] = [];
	for await (const event of streamModel(entry, request(entry, messages), {
		messageId: "m-1",
		apiKey: "test",
		fetch: async () => new Response(body, { status: 200 }),
		signal: new AbortController().signal,
		...options,
	})) {
		events.push(event);
	}
	const end = events.at(-1);
	if (end?.type !== "end") throw new Error("流没有以 end 结束");
	return { events, end };
}

// 取自 Anthropic 文档 "Streaming request with web search tool use" 的样例，文档里省略的增量按原样补全
const serverToolUse = {
	type: "server_tool_use",
	id: "srvtoolu_014hJH82Qum7Td6UV8gDXThB",
	name: "web_search",
	input: {},
};

const searchResult = {
	type: "web_search_tool_result",
	tool_use_id: "srvtoolu_014hJH82Qum7Td6UV8gDXThB",
	content: [
		{
			type: "web_search_result",
			title:
				"Weather in New York City in May 2025 (New York) - detailed Weather Forecast for a month",
			url: "https://world-weather.info/forecast/usa/new_york/may-2025/",
			encrypted_content: "Ev0DCioIAxgCIiQ3NmU4ZmI4OC1k...",
			page_age: null,
		},
	],
};

const citation = {
	type: "web_search_result_location",
	url: "https://world-weather.info/forecast/usa/new_york/may-2025/",
	title:
		"Weather in New York City in May 2025 (New York) - detailed Weather Forecast for a month",
	encrypted_index: "Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..",
	cited_text: "Partly cloudy, 68°F",
};

function blockEvents(
	index: number,
	block: object,
	deltas: object[] = [],
): [string, object][] {
	return [
		["content_block_start", { index, content_block: block }],
		...deltas.map((delta): [string, object] => [
			"content_block_delta",
			{ index, delta },
		]),
		["content_block_stop", { index }],
	];
}

function anthropicStream(
	blocks: [string, object][][],
	stopReason: string,
	usage: object,
): string {
	return sse([
		[
			"message_start",
			{
				message: {
					model: "claude-haiku-5-5",
					usage: {
						input_tokens: 2679,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						output_tokens: 3,
					},
				},
			},
		],
		...blocks.flat(),
		[
			"message_delta",
			{ delta: { stop_reason: stopReason, stop_sequence: null }, usage },
		],
		["message_stop", {}],
	]);
}

const queryDeltas = [
	"",
	'{"query',
	'":',
	' "weather',
	" NY",
	"C to",
	'day"}',
].map((partial_json) => ({ type: "input_json_delta", partial_json }));

const webSearchStream = anthropicStream(
	[
		blockEvents(0, { type: "text", text: "" }, [
			{ type: "text_delta", text: "I'll check the current weather." },
		]),
		blockEvents(1, serverToolUse, queryDeltas),
		blockEvents(2, searchResult),
		blockEvents(3, { type: "text", text: "", citations: [] }, [
			{ type: "citations_delta", citation },
			{ type: "text_delta", text: "It is partly cloudy, 68°F." },
		]),
	],
	"end_turn",
	{
		input_tokens: 10682,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 510,
		server_tool_use: { web_search_requests: 1 },
	},
);

const anthropicOrigin = {
	protocol: "anthropic.messages",
	service: "anthropic",
	model: "claude-haiku-5-5",
};

describe("服务端工具（anthropic.messages）", () => {
	test("启用的工具排在客户端工具后面，计数接口的请求不带它们", async () => {
		const body = JSON.parse(
			anthropicRequestBody(haiku, request(haiku, [question]), {
				serverTools: ["web_search", "web_fetch"],
			}),
		);
		expect(body.tools).toEqual([
			{
				name: "shell",
				description: shell.description,
				input_schema: shell.parameters,
			},
			{ type: "web_search_20250305", name: "web_search" },
			{ type: "web_fetch_20250910", name: "web_fetch" },
		]);

		let counted: { tools: { name: string }[] } | undefined;
		await countTokens(haiku, request(haiku, [question]), {
			apiKey: "test",
			fetch: async (_url, init) => {
				counted = JSON.parse(String(init?.body));
				return new Response('{"input_tokens":12}', { status: 200 });
			},
			signal: new AbortController().signal,
		});
		expect(counted?.tools.map((tool) => tool.name)).toEqual(["shell"]);
	});

	test("条目没有列出的工具、和客户端工具重名的工具不能启用", () => {
		const { server_tools: _, ...plain } = haiku;
		expect(() =>
			anthropicRequestBody(plain, request(plain, [question]), {
				serverTools: ["web_search"],
			}),
		).toThrow("没有服务端工具 web_search");
		expect(() =>
			anthropicRequestBody(
				haiku,
				{
					...request(haiku, [question]),
					tools: [{ ...shell, name: "web_search" }],
				},
				{ serverTools: ["web_search"] },
			),
		).toThrow("重名");
	});

	test("调用和结果存成不透明的块，引用留在文本块上，按计费的次数算钱", async () => {
		const { events, end } = await collect(haiku, webSearchStream, {
			serverTools: ["web_search"],
		});
		// 不透明的块没有流式事件，只出现在最后的回复里
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_delta",
			"text_delta",
			"usage",
			"end",
		]);
		expect(end.message.content).toEqual([
			{ type: "text", text: "I'll check the current weather." },
			{
				type: "opaque",
				kind: "server_tool_use",
				summary: "web_search: weather NYC today",
				raw: '{"type":"server_tool_use","id":"srvtoolu_014hJH82Qum7Td6UV8gDXThB","name":"web_search","input":{"query": "weather NYC today"}}',
				origin: anthropicOrigin,
			},
			{
				type: "opaque",
				kind: "web_search_tool_result",
				raw: JSON.stringify(searchResult),
				origin: anthropicOrigin,
			},
			{
				type: "text",
				text: "It is partly cloudy, 68°F.",
				citations: {
					raw: JSON.stringify([citation]),
					origin: anthropicOrigin,
				},
			},
		]);
		expect(end.message.stop_reason).toBe("end_turn");
		expect(end.message.usage).toMatchObject({
			input: 10682,
			output: 510,
			server_tools: { web_search: 1 },
		});
		// 每百万 token 1 和 5 美元，搜索每一千次 10 美元
		expect(end.message.usage.cost_usd).toBeCloseTo(
			(10682 * 1 + 510 * 5) / 1e6 + 10 / 1000,
		);
	});

	test("下一次请求把这些块按收到的原样带回，换了服务就不带", async () => {
		const { end } = await collect(haiku, webSearchStream, {
			serverTools: ["web_search"],
		});
		const next = request(haiku, [
			question,
			end.message,
			{
				role: "user",
				message_id: "u2",
				content: [{ type: "text", text: "and tomorrow?" }],
			},
		]);
		const body = JSON.parse(
			anthropicRequestBody(haiku, next, { serverTools: ["web_search"] }),
		);
		expect(body.messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "I'll check the current weather." },
				{ ...serverToolUse, input: { query: "weather NYC today" } },
				searchResult,
				{
					type: "text",
					text: "It is partly cloudy, 68°F.",
					citations: [citation],
				},
			],
		});

		// 同一个协议的另一个服务：加密的搜索结果和引用的索引它读不了
		const foundry: ModelEntry = {
			...haiku,
			id: "foundry-haiku",
			service: "foundry",
		};
		const elsewhere = JSON.parse(
			anthropicRequestBody(foundry, { ...next, model: foundry.id }),
		);
		expect(elsewhere.messages[1].content).toEqual([
			{ type: "text", text: "I'll check the current weather." },
			{ type: "text", text: "It is partly cloudy, 68°F." },
		]);
		const responses = JSON.parse(
			openaiResponsesRequestBody(sol, { ...next, model: sol.id }),
		);
		expect(responses.input.map((item: { type?: string }) => item.type)).toEqual(
			[undefined, "message", "message", undefined],
		);
	});

	test("没有启用服务端工具时，响应里出现它们的内容块是缺陷", async () => {
		await expect(collect(haiku, webSearchStream)).rejects.toThrow(
			"没有列出的内容块：server_tool_use",
		);
	});

	test("网页读取的调用没有 input 增量时用块开始时给出的，结果整块保存", async () => {
		const fetchUse = {
			type: "server_tool_use",
			id: "srvtoolu_xyz789",
			name: "web_fetch",
		};
		const fetchResult = {
			type: "web_fetch_tool_result",
			tool_use_id: "srvtoolu_xyz789",
			content: {
				type: "web_fetch_result",
				url: "https://example.com/article",
				content: {
					type: "document",
					source: {
						type: "text",
						media_type: "text/plain",
						data: "Article content...",
					},
				},
			},
		};
		const { end } = await collect(
			haiku,
			anthropicStream(
				[
					blockEvents(0, fetchUse, [
						{
							type: "input_json_delta",
							partial_json: '{"url":"https://example.com/article"}',
						},
					]),
					blockEvents(1, fetchResult),
					blockEvents(2, { ...fetchUse, id: "srvtoolu_abc", input: {} }),
				],
				"pause_turn",
				{
					output_tokens: 20,
					server_tool_use: { web_search_requests: 0, web_fetch_requests: 1 },
				},
			),
			{ serverTools: ["web_fetch"] },
		);
		expect(end.message.content).toMatchObject([
			{
				kind: "server_tool_use",
				summary: "web_fetch: https://example.com/article",
			},
			{ kind: "web_fetch_tool_result", raw: JSON.stringify(fetchResult) },
			{
				kind: "server_tool_use",
				summary: "web_fetch",
				raw: '{"type":"server_tool_use","id":"srvtoolu_abc","name":"web_fetch","input":{}}',
			},
		]);
		// 网页读取不另收费，次数照记
		expect(end.message.usage.server_tools).toEqual({ web_fetch: 1 });
		expect(end.message.usage.cost_usd).toBeCloseTo((2679 * 1 + 20 * 5) / 1e6);
		// 被暂停的回复原样带回，没有结果的调用留着：下一条回复以它的结果开头
		const body = JSON.parse(
			anthropicRequestBody(haiku, request(haiku, [question, end.message]), {
				serverTools: ["web_fetch"],
			}),
		);
		expect(
			body.messages[1].content.map((block: { type: string }) => block.type),
		).toEqual(["server_tool_use", "web_fetch_tool_result", "server_tool_use"]);
	});

	test("没有结果的调用：后面只有工具结果时留着，接了别的内容就不带回", () => {
		const origin = {
			...anthropicOrigin,
			protocol: "anthropic.messages",
		} as const;
		const pending: AssistantMessage = {
			role: "assistant",
			message_id: "a1",
			content: [
				{
					type: "opaque",
					kind: "server_tool_use",
					raw: JSON.stringify({
						...serverToolUse,
						input: { query: "weather NYC today" },
					}),
					origin,
				},
				{
					type: "tool_call",
					call_id: "toolu_1",
					name: "shell",
					arguments: '{"command":"date"}',
				},
			],
			protocol: "anthropic.messages",
			service: "anthropic",
			requested_model: haiku.id,
			model: "claude-haiku-5-5",
			reasoning_effort: "low",
			stop_reason: "tool_use",
			usage: {
				input: 1,
				output: 1,
				cache_read: 0,
				cache_write: 0,
				reasoning: 0,
			},
		};
		const result: Message = {
			role: "tool_result",
			message_id: "t1",
			call_id: "toolu_1",
			content: [{ type: "text", text: "Thu Nov 12" }],
			is_error: false,
		};
		const types = (messages: Message[]) =>
			JSON.parse(
				anthropicRequestBody(haiku, request(haiku, messages), {
					serverTools: ["web_search"],
				}),
			).messages.map((message: { content: { type: string }[] }) =>
				message.content.map((block) => block.type),
			);

		// 服务端在下一次请求里执行这个调用
		expect(types([question, pending, result])).toEqual([
			["text"],
			["server_tool_use", "tool_use"],
			["tool_result"],
		]);
		// 下一条回复带着它的结果：两条回复和中间的工具结果都按顺序留着
		const resumed: AssistantMessage = {
			...pending,
			message_id: "a2",
			stop_reason: "end_turn",
			content: [
				{
					type: "opaque",
					kind: "web_search_tool_result",
					raw: JSON.stringify(searchResult),
					origin,
				},
				{ type: "text", text: "Partly cloudy." },
			],
		};
		expect(types([question, pending, result, resumed, question])).toEqual([
			["text"],
			["server_tool_use", "tool_use"],
			["tool_result"],
			["web_search_tool_result", "text"],
			["text"],
		]);
		// 工具结果之后接了用户的话（task 被取消后接着输入、steering）：服务端会返回 400，去掉这个调用
		expect(types([question, pending, result, question])).toEqual([
			["text"],
			["tool_use"],
			["tool_result", "text"],
		]);
		// 调用所在的块作废之后（回退、按事件脱敏），剩下的结果也不带回
		expect(
			types([
				question,
				{ ...pending, content: pending.content.slice(1) },
				result,
				resumed,
				question,
			]),
		).toEqual([["text"], ["tool_use"], ["tool_result"], ["text"], ["text"]]);
	});

	test("回退时分界之前没有结果的调用作废，成对的留下", async () => {
		const { events } = await collect(
			{
				...haiku,
				allowed_fallback_models: [
					{ model: "claude-opus-4-8", price: haiku.price as never },
				],
			},
			anthropicStream(
				[
					blockEvents(0, serverToolUse, queryDeltas),
					blockEvents(1, searchResult),
					blockEvents(2, { ...serverToolUse, id: "srvtoolu_unfinished" }),
					blockEvents(3, {
						type: "fallback",
						from: { model: "claude-haiku-5-5" },
						to: { model: "claude-opus-4-8" },
					}),
					blockEvents(4, { type: "text", text: "" }, [
						{ type: "text_delta", text: "Partly cloudy." },
					]),
				],
				"end_turn",
				{ output_tokens: 30, server_tool_use: { web_search_requests: 1 } },
			),
			{ serverTools: ["web_search"] },
		);
		expect(events.find((event) => event.type === "invalidate")).toEqual({
			type: "invalidate",
			invalidation: {
				blocks: [{ message_id: "m-1", index: 2 }],
				reason: "fallback",
			},
		});
	});
});

// 事件的形状取自 OpenAI 的流式事件参考和联网搜索指南的输出样例
const searchCall = {
	type: "web_search_call",
	id: "ws_67c9fa0502748190b7dd390736892e100be649c1a5ff9609",
	status: "completed",
	action: { type: "search", queries: ["latest news about AI"] },
};

const annotation = {
	type: "url_citation",
	start_index: 0,
	end_index: 12,
	url: "https://example.com/news?utm_source=chatgpt.com",
	title: "AI news",
};

const answer = {
	id: "msg_67c9fa077e288190af08fdffda2e34f20be649c1a5ff9609",
	type: "message",
	status: "completed",
	role: "assistant",
	content: [
		{
			type: "output_text",
			text: "On March 6, several things happened.",
			annotations: [annotation],
			logprobs: [],
		},
	],
};

function responsesStream(toolUsage: object | undefined): string {
	const response = {
		model: "gpt-5.6-sol",
		status: "completed",
		incomplete_details: null,
		usage: {
			input_tokens: 8200,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 300,
			output_tokens_details: { reasoning_tokens: 0 },
		},
		...(toolUsage === undefined ? {} : { tool_usage: toolUsage }),
	};
	return sse([
		["response.created", { response: { model: "gpt-5.6-sol" } }],
		[
			"response.output_item.added",
			{
				output_index: 0,
				item: {
					type: "web_search_call",
					id: searchCall.id,
					status: "in_progress",
				},
			},
		],
		[
			"response.web_search_call.in_progress",
			{ output_index: 0, item_id: searchCall.id },
		],
		[
			"response.web_search_call.searching",
			{ output_index: 0, item_id: searchCall.id },
		],
		[
			"response.web_search_call.completed",
			{ output_index: 0, item_id: searchCall.id },
		],
		["response.output_item.done", { output_index: 0, item: searchCall }],
		[
			"response.output_item.added",
			{
				output_index: 1,
				item: { ...answer, status: "in_progress", content: [] },
			},
		],
		[
			"response.output_text.delta",
			{ output_index: 1, content_index: 0, delta: answer.content[0]?.text },
		],
		[
			"response.output_text.annotation.added",
			{ output_index: 1, content_index: 0, annotation_index: 0, annotation },
		],
		["response.output_item.done", { output_index: 1, item: answer }],
		["response.completed", { response }],
	]);
}

const openaiOrigin = {
	protocol: "openai.responses",
	service: "openai",
	model: "gpt-5.6-sol",
};

describe("服务端工具（openai.responses）", () => {
	test("启用的工具排在函数工具后面，条目没有列出的不能启用", () => {
		const body = JSON.parse(
			openaiResponsesRequestBody(sol, request(sol, [question]), {
				serverTools: ["web_search"],
			}),
		);
		expect(body.tools.map((tool: { type: string }) => tool.type)).toEqual([
			"function",
			"web_search",
		]);
		expect(body.tools.at(-1)).toEqual({ type: "web_search" });
		expect(() =>
			openaiResponsesRequestBody(sol, request(sol, [question]), {
				serverTools: ["web_fetch"],
			}),
		).toThrow("没有服务端工具 web_fetch");
	});

	test("搜索的 item 存成不透明的块，引用留在文本块上，按 tool_usage 的次数算钱", async () => {
		const { events, end } = await collect(
			sol,
			responsesStream({ web_search: { num_requests: 2 } }),
			{ serverTools: ["web_search"] },
		);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_delta",
			"usage",
			"end",
		]);
		expect(end.message.content).toEqual([
			{
				type: "opaque",
				kind: "web_search_call",
				summary: "web_search: latest news about AI",
				raw: JSON.stringify(searchCall),
				origin: openaiOrigin,
			},
			{
				type: "text",
				text: "On March 6, several things happened.",
				citations: { raw: JSON.stringify([annotation]), origin: openaiOrigin },
			},
		]);
		expect(end.message.usage.server_tools).toEqual({ web_search: 2 });
		// gpt-5.6-sol 每百万 token 4 和 20 美元，搜索每一千次 10 美元
		expect(end.message.usage.cost_usd).toBeCloseTo(
			(8200 * 4 + 300 * 20) / 1e6 + (2 * 10) / 1000,
		);

		// 打开网页不算计费的搜索：tool_usage 里是 0 或者没有这一项时不记次数
		const free = await collect(sol, responsesStream(undefined), {
			serverTools: ["web_search"],
		});
		expect(free.end.message.usage.server_tools).toBeUndefined();
	});

	test("下一次请求把搜索的 item 和引用按收到的原样带回，换了服务就不带", async () => {
		const { end } = await collect(
			sol,
			responsesStream({ web_search: { num_requests: 1 } }),
			{ serverTools: ["web_search"] },
		);
		const next = request(sol, [question, end.message, question]);
		const body = JSON.parse(
			openaiResponsesRequestBody(sol, next, { serverTools: ["web_search"] }),
		);
		expect(body.input.slice(1, 3)).toEqual([
			searchCall,
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "On March 6, several things happened.",
						annotations: [annotation],
					},
				],
				status: "completed",
			},
		]);

		const azure: ModelEntry = { ...sol, id: "azure-sol", service: "azure" };
		const elsewhere = JSON.parse(
			openaiResponsesRequestBody(azure, { ...next, model: azure.id }),
		);
		expect(elsewhere.input.slice(1, 2)).toEqual([
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "On March 6, several things happened.",
						annotations: [],
					},
				],
				status: "completed",
			},
		]);
		expect(elsewhere.input).toHaveLength(3);
		const anthropic = JSON.parse(
			anthropicRequestBody(haiku, { ...next, model: haiku.id }),
		);
		expect(anthropic.messages[1].content).toEqual([
			{ type: "text", text: "On March 6, several things happened." },
		]);
	});

	test("没有启用服务端工具时，响应里出现搜索的 item 是缺陷", async () => {
		await expect(
			collect(sol, responsesStream({ web_search: { num_requests: 1 } })),
		).rejects.toThrow("没有列出的 item：web_search_call");
	});
});
