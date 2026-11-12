import { readFileSync } from "node:fs";
import {
	countTokens,
	googleGenerateContentApiVersion,
	googleGenerateContentRequestBody,
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
	StreamEvent,
} from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

// 上下文长度、输出上限、推理级别和价格取自官方的模型页和定价页（gemini-3.8-flash）
const flash: ModelEntry = {
	id: "gemini-3.8-flash",
	protocol: "google.generate-content",
	service: "google",
	base_url: "https://generativelanguage.example.com/v1",
	model: "gemini-3.8-flash",
	context_window: 1_048_576,
	max_output_tokens: 65_536,
	price: { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0 },
	images: true,
	thinking_level_map: { low: "low", medium: "medium", high: "high" },
};

const fromGemini = {
	protocol: "google.generate-content",
	service: "google",
	model: "gemini-3.8-flash",
} as const;

const fromClaude = {
	protocol: "anthropic.messages",
	service: "anthropic",
	model: "claude-haiku-5-5",
} as const;

// 官方函数调用指南里的工具
const weather = {
	name: "get_current_temperature",
	description: "Gets the current temperature for a given location.",
	parameters: {
		type: "object",
		properties: {
			location: {
				type: "string",
				description: "The city name, e.g. San Francisco",
			},
		},
		required: ["location"],
	},
};

const usage = {
	input: 1,
	output: 1,
	cache_read: 0,
	cache_write: 0,
	reasoning: 0,
};

function reply(
	content: AssistantMessage["content"],
	from: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		message_id: "a",
		content,
		protocol: "google.generate-content",
		service: "google",
		requested_model: flash.id,
		model: flash.model,
		reasoning_effort: "low",
		stop_reason: "tool_use",
		usage,
		...from,
	};
}

function user(text: string, messageId = "u"): Message {
	return {
		role: "user",
		message_id: messageId,
		content: [{ type: "text", text }],
	};
}

function result(
	callId: string,
	content: Extract<Message, { role: "tool_result" }>["content"],
	isError = false,
): Message {
	return {
		role: "tool_result",
		message_id: `t-${callId}`,
		call_id: callId,
		content,
		is_error: isError,
	};
}

function request(messages: Message[], extra: Partial<ModelRequest> = {}) {
	return {
		model: flash.id,
		reasoning_effort: "low",
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
		tools: [weather],
		...extra,
	} satisfies ModelRequest;
}

function bodyOf(
	messages: Message[],
	extra: Partial<ModelRequest> = {},
	entry = flash,
) {
	return JSON.parse(
		googleGenerateContentRequestBody(entry, request(messages, extra)),
	);
}

const png = { type: "image", media_type: "image/png", data: "iVBO" } as const;
const gif = { type: "image", media_type: "image/gif", data: "R0lG" } as const;

const ask = user("Check the weather in Paris and London.");

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

describe("googleGenerateContentRequestBody", () => {
	test("系统指令连同之后追加的都并入 systemInstruction，图片是 inlineData，工具声明用 parametersJsonSchema", () => {
		const body = bodyOf(
			[
				{
					role: "user",
					message_id: "u",
					content: [{ type: "text", text: "What is in this picture?" }, png],
				},
				{
					role: "system",
					message_id: "late",
					content: [{ type: "text", text: "sandbox is now read-only" }],
				},
			],
			{ reasoning_effort: "high", tool_choice: "none", max_tokens: 4096 },
		);
		expect(body).toEqual({
			systemInstruction: {
				parts: [{ text: "be brief" }, { text: "sandbox is now read-only" }],
			},
			contents: [
				{
					role: "user",
					parts: [
						{ text: "What is in this picture?" },
						{ inlineData: { mimeType: "image/png", data: "iVBO" } },
					],
				},
			],
			tools: [
				{
					functionDeclarations: [
						{
							name: "get_current_temperature",
							description: weather.description,
							parametersJsonSchema: weather.parameters,
						},
					],
				},
			],
			toolConfig: { functionCallingConfig: { mode: "NONE" } },
			generationConfig: {
				maxOutputTokens: 4096,
				thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
			},
		});
	});

	test("tool_choice 为 auto 时不发 toolConfig，没有工具时不发 tools，推理强度和输出上限按条目取值", () => {
		// 3.8 Flash 不能关闭推理：请求 off 时往高找到 low
		const auto = bodyOf([ask], { reasoning_effort: "off" });
		expect(auto).not.toHaveProperty("toolConfig");
		expect(auto.generationConfig).toEqual({
			maxOutputTokens: 65_536,
			thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
		});

		const bare = bodyOf([ask], { tools: [], tool_choice: "none" });
		expect(bare).not.toHaveProperty("tools");
		expect(bare).not.toHaveProperty("toolConfig");

		const { thinking_level_map: _, ...unmapped } = flash;
		expect(bodyOf([ask], {}, unmapped).generationConfig).toEqual({
			maxOutputTokens: 65_536,
		});
	});

	test("不读图片的模型收到图片时换成文字占位，采样参数不接受", () => {
		const blind = bodyOf(
			[{ role: "user", message_id: "u", content: [png] }],
			{},
			{ ...flash, images: false },
		);
		expect(blind.contents[0].parts).toEqual([
			{ text: "[image omitted: the current model does not accept images]" },
		]);
		expect(() => bodyOf([ask], { sampling: { temperature: 0.2 } })).toThrow(
			"不接受采样参数",
		);
	});

	test("工具结果带着调用的 id 和名字排在同一条 user content 的最前面，文字放 output，出错时放 error，图片放 functionResponse.parts", () => {
		const { contents } = bodyOf([
			ask,
			reply([
				{
					type: "tool_call",
					call_id: "8f2b1a3c",
					name: "get_current_temperature",
					arguments: '{"location":"Paris"}',
				},
				{
					type: "tool_call",
					call_id: "m4q8z1v6",
					name: "get_current_temperature",
					arguments: '{"location":"London"}',
				},
			]),
			result("8f2b1a3c", [{ type: "text", text: "15C" }, png, gif]),
			result(
				"m4q8z1v6",
				[
					{ type: "text", text: "station offline" },
					{ type: "text", text: "retry later" },
				],
				true,
			),
			user("Also compare them.", "u2"),
		]);
		expect(contents.map((content: { role: string }) => content.role)).toEqual([
			"user",
			"model",
			"user",
		]);
		expect(contents[2].parts).toEqual([
			{
				functionResponse: {
					id: "8f2b1a3c",
					name: "get_current_temperature",
					response: { output: "15C" },
					parts: [{ inlineData: { mimeType: "image/png", data: "iVBO" } }],
				},
			},
			{
				functionResponse: {
					id: "m4q8z1v6",
					name: "get_current_temperature",
					response: { error: "station offline\nretry later" },
				},
			},
			// functionResponse.parts 不接受 GIF，移到这组结果之后
			{ inlineData: { mimeType: "image/gif", data: "R0lG" } },
			{ text: "Also compare them." },
		]);
	});

	test("工具结果对应的调用不在历史里是调用方的缺陷", () => {
		expect(() =>
			bodyOf([ask, result("missing", [{ type: "text", text: "15C" }])]),
		).toThrow("不在历史里");
	});

	test("别的协议留下的工具调用在第一个 functionCall 上带占位签名，别的服务的推理块不发，调用编号按限制改写", () => {
		const longId = `toolu_${"x".repeat(80)}`;
		const { contents } = bodyOf([
			ask,
			reply(
				[
					{
						type: "reasoning",
						text: "hmm",
						redacted: false,
						opaque: "claude-signature",
						origin: fromClaude,
					},
					{ type: "text", text: "checking" },
					{
						type: "tool_call",
						call_id: longId,
						name: "get_current_temperature",
						arguments: '{"location":"Paris"}',
					},
					{
						type: "tool_call",
						call_id: "toolu_2",
						name: "get_current_temperature",
						// 模型写出的参数不是 JSON 对象
						arguments: '{"location":',
					},
				],
				{ protocol: "anthropic.messages", service: "anthropic" },
			),
			result(longId, [{ type: "text", text: "15C" }]),
			result("toolu_2", [{ type: "text", text: "bad arguments" }], true),
			// 只有别的服务的推理块的回复整条不发，前后的 user content 并成一条
			reply(
				[
					{
						type: "reasoning",
						text: "",
						redacted: true,
						opaque: "data",
						origin: fromClaude,
					},
				],
				{
					message_id: "a2",
					protocol: "anthropic.messages",
					service: "anthropic",
				},
			),
			user("and Berlin?", "u2"),
		]);
		expect(contents).toHaveLength(3);
		const rewritten: string = contents[1].parts[1].functionCall.id;
		expect(rewritten).toHaveLength(64);
		expect(rewritten).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(contents[1].parts).toEqual([
			{ text: "checking" },
			{
				functionCall: {
					name: "get_current_temperature",
					args: { location: "Paris" },
					id: rewritten,
				},
				thoughtSignature: "skip_thought_signature_validator",
			},
			{
				functionCall: {
					name: "get_current_temperature",
					args: {},
					id: "toolu_2",
				},
			},
		]);
		expect(
			contents[2].parts.map(
				(part: { functionResponse?: { id: string }; text?: string }) =>
					part.functionResponse?.id ?? part.text,
			),
		).toEqual([rewritten, "toolu_2", "and Berlin?"]);
	});

	test("文字为空的推理块是紧跟其后那个 part 上的签名，接不上时是一个空 text part 上的签名", () => {
		const signature = (opaque: string) =>
			({
				type: "reasoning",
				text: "",
				redacted: false,
				opaque,
				origin: fromGemini,
			}) as const;
		const { contents } = bodyOf([
			ask,
			reply([
				signature("sig-text"),
				{ type: "text", text: "On it." },
				signature("sig-empty"),
				{
					type: "reasoning",
					text: "plan",
					redacted: false,
					origin: fromGemini,
				},
				signature("sig-call"),
				{
					type: "tool_call",
					call_id: "8f2b1a3c",
					name: "get_current_temperature",
					arguments: '{"location":"Paris"}',
				},
				signature("sig-last"),
			]),
			result("8f2b1a3c", [{ type: "text", text: "15C" }]),
		]);
		expect(contents[1].parts).toEqual([
			{ text: "On it.", thoughtSignature: "sig-text" },
			{ text: "", thoughtSignature: "sig-empty" },
			{ text: "plan", thought: true },
			{
				functionCall: {
					name: "get_current_temperature",
					args: { location: "Paris" },
					id: "8f2b1a3c",
				},
				thoughtSignature: "sig-call",
			},
			{ text: "", thoughtSignature: "sig-last" },
		]);
	});

	test("首字符不是字母或下划线的工具名前面加下划线，改写后重名时报错", () => {
		const long = `9${"x".repeat(127)}`;
		const tools = ["2fa.verify", "-dash", long, "mcp.github/create issue"].map(
			(name) => ({ ...weather, name }),
		);
		const body = bodyOf(
			[
				ask,
				reply([
					{
						type: "tool_call",
						call_id: "c1",
						name: "2fa.verify",
						arguments: "{}",
					},
				]),
				result("c1", [{ type: "text", text: "ok" }]),
			],
			{ tools },
		);
		const names: string[] = body.tools[0].functionDeclarations.map(
			(declaration: { name: string }) => declaration.name,
		);
		expect(names.slice(0, 2)).toEqual(["_2fa_verify", "_-dash"]);
		expect(names[3]).toBe("mcp_github_create_issue");
		for (const name of names) {
			expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/);
		}
		// 加了下划线之后超长：截断并加哈希，同一个原文总是得到同样的结果
		expect(names[2]).toHaveLength(128);
		expect(names[2]).toBe(
			bodyOf([ask], { tools }).tools[0].functionDeclarations[2].name,
		);
		expect(body.contents[1].parts[0].functionCall.name).toBe("_2fa_verify");
		expect(body.contents[2].parts[0].functionResponse.name).toBe("_2fa_verify");

		expect(() =>
			bodyOf([ask], {
				tools: [
					{ ...weather, name: "2fa" },
					{ ...weather, name: "_2fa" },
				],
			}),
		).toThrow("改写后重名");
	});

	test("同一个请求转换两次逐字节相同，保存过的原文原样取回", () => {
		const messages = [
			ask,
			reply([
				{
					type: "reasoning",
					text: "",
					redacted: false,
					opaque: "sig",
					origin: fromGemini,
				},
				{
					type: "tool_call",
					call_id: "8f2b1a3c",
					name: "get_current_temperature",
					arguments: '{"location":"Paris"}',
				},
			]),
			result("8f2b1a3c", [{ type: "text", text: "15C" }]),
		];
		const body = googleGenerateContentRequestBody(flash, request(messages));
		expect(googleGenerateContentRequestBody(flash, request(messages))).toBe(
			body,
		);

		const raws = new MemoryRaws();
		expect(
			googleGenerateContentRequestBody(flash, request(messages), { raws }),
		).toBe(body);
		const saved = [...raws.parts.values()];
		expect(
			saved.map((part) => `${part.part} ${part.message_id ?? ""}`),
		).toEqual([
			"system s",
			"message u",
			"message a",
			"message t-8f2b1a3c",
			"tools ",
		]);
		for (const part of saved) {
			expect(part).toMatchObject({
				protocol: "google.generate-content",
				service: "google",
				api_version: googleGenerateContentApiVersion,
			});
		}
		// 把保存的原文改成另一种等价的写法：请求体里出现的是保存的原文，不重新转换
		for (const [key, part] of raws.parts) {
			raws.parts.set(key, {
				...part,
				pieces: part.pieces.map((piece) => ` ${piece}`),
			});
		}
		const replayed = googleGenerateContentRequestBody(
			flash,
			request(messages),
			{ raws },
		);
		expect(replayed).toContain('"contents":[{"role":"user","parts":[ {"text"');
		expect(JSON.parse(replayed)).toEqual(JSON.parse(body));
	});
});

function fixture(name: string): string {
	return readFileSync(
		new URL(`./fixtures/${name}.sse`, import.meta.url),
		"utf8",
	);
}

/** 一个 `GenerateContentResponse`：候选里的 part，候选上的其他字段和响应上的其他字段。 */
function response(parts: object[], candidate: object = {}, top: object = {}) {
	return {
		candidates: [{ content: { parts, role: "model" }, index: 0, ...candidate }],
		modelVersion: "gemini-3.8-flash",
		responseId: "mAitaLmkHPPlz7IPvtfUqQ4",
		...top,
	};
}

/** 每个事件只有一行 `data:`，没有事件名，也没有结束标志。 */
function sse(responses: object[]): string {
	return responses.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
}

async function collect(
	body: string,
	options: {
		messages?: Message[];
		extra?: Partial<ModelRequest>;
		status?: number;
		headers?: Record<string, string>;
	} = {},
) {
	const events: StreamEvent[] = [];
	for await (const event of streamModel(
		flash,
		request(options.messages ?? [ask], options.extra),
		{
			messageId: "m-1",
			apiKey: "key",
			fetch: async () =>
				new Response(body, {
					status: options.status ?? 200,
					headers: options.headers ?? {},
				}),
			signal: new AbortController().signal,
		},
	)) {
		events.push(event);
	}
	const end = events.at(-1);
	if (end?.type !== "end") throw new Error("流没有以 end 结束");
	return { events, end };
}

interface Sent {
	url: string;
	headers: Headers;
	body: string;
}

/** 记下发出的请求，按 `respond` 回复。 */
function recording(respond: () => Response): {
	fetch: typeof fetch;
	sent: Sent[];
} {
	const sent: Sent[] = [];
	return {
		sent,
		fetch: async (url, init) => {
			sent.push({
				url: String(url),
				headers: new Headers(init?.headers),
				body: String(init?.body),
			});
			return respond();
		},
	};
}

/** 发一次请求，只看发出去的是什么。 */
async function sentBy(entry: ModelEntry): Promise<Sent> {
	const { fetch, sent } = recording(() => new Response("", { status: 500 }));
	for await (const _ of streamModel(entry, request([ask]), {
		messageId: "m-1",
		apiKey: "key",
		fetch,
		signal: new AbortController().signal,
	})) {
		// 只要发出的请求
	}
	const [only] = sent;
	if (only === undefined) throw new Error("请求没有发出");
	return only;
}

describe("streamModel（google.generate-content）", () => {
	test("请求发往 streamGenerateContent?alt=sse，凭据按条目的 auth 放进请求头", async () => {
		const sent = await sentBy(flash);
		expect(sent.url).toBe(
			"https://generativelanguage.example.com/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
		);
		expect(sent.headers.get("content-type")).toBe("application/json");
		expect(sent.headers.get("accept")).toBe("text/event-stream");
		expect(sent.headers.get("x-goog-api-key")).toBe("key");
		expect(sent.headers.get("authorization")).toBeNull();
		expect(sent.body).toBe(
			googleGenerateContentRequestBody(flash, request([ask])),
		);

		const bearer = await sentBy({ ...flash, auth: "bearer" });
		expect(bearer.headers.get("authorization")).toBe("Bearer key");
		expect(bearer.headers.get("x-goog-api-key")).toBeNull();
	});

	// 前两个事件是官方文本生成指南里的流式样例，最后一个带 finishReason 的事件按响应的字段说明补上
	test("连续的文本 part 并成一个文本块，用量取最后一份并换成内部的口径", async () => {
		const { events, end } = await collect(fixture("google-text"));
		expect(events.slice(0, -2)).toEqual([
			{ type: "start", model: "gemini-3.8-flash" },
			{ type: "text_delta", index: 0, text: "The image displays" },
			{
				type: "text_delta",
				index: 0,
				text: " the following materials:\n\n*   **Wood:** The accordion and the violin are primarily",
			},
			{ type: "text_delta", index: 0, text: " made of wood." },
		]);
		expect(events.at(-2)?.type).toBe("usage");
		expect(end.message).toMatchObject({
			message_id: "m-1",
			protocol: "google.generate-content",
			service: "google",
			requested_model: "gemini-3.8-flash",
			model: "gemini-3.8-flash",
			reasoning_effort_sent: "low",
			stop_reason: "end_turn",
			content: [
				{
					type: "text",
					text: "The image displays the following materials:\n\n*   **Wood:** The accordion and the violin are primarily made of wood.",
				},
			],
			usage: {
				input: 264,
				output: 79,
				cache_read: 0,
				cache_write: 0,
				reasoning: 58,
			},
		});
		expect(end.message.usage.cost_usd).toBeCloseTo(
			(264 * 0.75 + 79 * 3.75) / 1e6,
		);
	});

	// 并行调用的样例取自官方的思考签名指南：签名只在第一个 functionCall 上；id 的写法取自函数调用指南
	test("并行调用：签名保存成第一个调用前面的空文字推理块，下一次请求回到原来的 part 上，结果和调用不交错", async () => {
		const { events, end } = await collect(fixture("google-parallel-calls"));
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"reasoning_delta",
			"reasoning_delta",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_end",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_end",
			"usage",
			"end",
		]);
		expect(events.slice(3, 6)).toEqual([
			{
				type: "tool_call_start",
				index: 2,
				call_id: "8f2b1a3c",
				name: "get_current_temperature",
			},
			{ type: "tool_call_delta", index: 2, arguments: '{"location":"Paris"}' },
			{ type: "tool_call_end", index: 2 },
		]);
		const summary =
			"**Planning the lookups**\n\nThe user wants the weather in two cities. The two lookups are independent, so I can request both at once.";
		expect(end.message.stop_reason).toBe("tool_use");
		expect(end.message.content).toEqual([
			{ type: "reasoning", text: summary, redacted: false, origin: fromGemini },
			{
				type: "reasoning",
				text: "",
				redacted: false,
				opaque: "U2lnbmF0dXJlX0E=",
				origin: fromGemini,
			},
			{
				type: "tool_call",
				call_id: "8f2b1a3c",
				name: "get_current_temperature",
				arguments: '{"location":"Paris"}',
			},
			{
				type: "tool_call",
				call_id: "m4q8z1v6",
				name: "get_current_temperature",
				arguments: '{"location":"London"}',
			},
		]);
		expect(end.message.usage).toMatchObject({
			input: 118,
			output: 97,
			reasoning: 61,
		});

		const results = [
			result("8f2b1a3c", [{ type: "text", text: "15C" }]),
			result("m4q8z1v6", [{ type: "text", text: "12C" }]),
		];
		expect(bodyOf([ask, end.message, ...results]).contents).toEqual([
			{
				role: "user",
				parts: [{ text: "Check the weather in Paris and London." }],
			},
			{
				role: "model",
				parts: [
					{ text: summary, thought: true },
					{
						functionCall: {
							name: "get_current_temperature",
							args: { location: "Paris" },
							id: "8f2b1a3c",
						},
						thoughtSignature: "U2lnbmF0dXJlX0E=",
					},
					{
						functionCall: {
							name: "get_current_temperature",
							args: { location: "London" },
							id: "m4q8z1v6",
						},
					},
				],
			},
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: "8f2b1a3c",
							name: "get_current_temperature",
							response: { output: "15C" },
						},
					},
					{
						functionResponse: {
							id: "m4q8z1v6",
							name: "get_current_temperature",
							response: { output: "12C" },
						},
					},
				],
			},
		]);

		// 签名所在的推理块被作废之后，第一个调用带占位签名
		const invalidated = {
			...end.message,
			content: end.message.content.slice(2),
		};
		expect(
			bodyOf([ask, invalidated, ...results]).contents[1].parts[0]
				.thoughtSignature,
		).toBe("skip_thought_signature_validator");
	});

	test("流末尾空 text part 上的签名只留签名，下一次请求仍是一个空 text part 上的签名", async () => {
		const { events, end } = await collect(fixture("google-text-signature"));
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_delta",
			"text_delta",
			"usage",
			"end",
		]);
		expect(end.message.stop_reason).toBe("end_turn");
		expect(end.message.content).toEqual([
			{ type: "text", text: "AI learns patterns from data." },
			{
				type: "reasoning",
				text: "",
				redacted: false,
				opaque: "U2lnbmF0dXJlX0M=",
				origin: fromGemini,
			},
		]);
		expect(bodyOf([ask, end.message, user("go on", "u2")]).contents[1]).toEqual(
			{
				role: "model",
				parts: [
					{ text: "AI learns patterns from data." },
					{ text: "", thoughtSignature: "U2lnbmF0dXJlX0M=" },
				],
			},
		);
	});

	test("带签名的 part 不和别的 part 合并：带签名的文本和思考摘要各成一块，签名回到原来的 part 上", async () => {
		const { events, end } = await collect(
			sse([
				response([{ text: "plan", thought: true }]),
				response([{ text: " more", thought: true }]),
				response([
					{ text: "signed", thought: true, thoughtSignature: "sig-thought" },
				]),
				response([{ text: "after", thought: true }]),
				response([{ text: "Let me" }]),
				response([{ text: " think.", thoughtSignature: "sig-text" }]),
				response([{ text: " Done" }, { text: "." }], { finishReason: "STOP" }),
			]),
		);
		expect(events.slice(1, -2)).toEqual([
			{ type: "reasoning_delta", index: 0, text: "plan" },
			{ type: "reasoning_delta", index: 0, text: " more" },
			{ type: "reasoning_delta", index: 1, text: "signed" },
			{ type: "reasoning_delta", index: 2, text: "after" },
			{ type: "text_delta", index: 3, text: "Let me" },
			{ type: "text_delta", index: 5, text: " think." },
			{ type: "text_delta", index: 6, text: " Done" },
			{ type: "text_delta", index: 6, text: "." },
		]);
		expect(end.message.content).toEqual([
			{
				type: "reasoning",
				text: "plan more",
				redacted: false,
				origin: fromGemini,
			},
			{
				type: "reasoning",
				text: "signed",
				redacted: false,
				opaque: "sig-thought",
				origin: fromGemini,
			},
			{ type: "reasoning", text: "after", redacted: false, origin: fromGemini },
			{ type: "text", text: "Let me" },
			{
				type: "reasoning",
				text: "",
				redacted: false,
				opaque: "sig-text",
				origin: fromGemini,
			},
			{ type: "text", text: " think." },
			{ type: "text", text: " Done." },
		]);
		expect(
			bodyOf([ask, end.message, user("go on", "u2")]).contents[1].parts,
		).toEqual([
			{ text: "plan more", thought: true },
			{ text: "signed", thought: true, thoughtSignature: "sig-thought" },
			{ text: "after", thought: true },
			{ text: "Let me" },
			{ text: " think.", thoughtSignature: "sig-text" },
			{ text: " Done." },
		]);
	});

	test("functionCall 没有 id 时用回复的编号和内容块的下标生成，没有 args 时参数是空对象", async () => {
		const { end } = await collect(
			sse([
				response(
					[
						{
							functionCall: {
								name: "get_current_temperature",
								args: { location: "Paris" },
							},
							thoughtSignature: "sig",
						},
						{ functionCall: { name: "get_current_temperature" } },
					],
					{ finishReason: "STOP" },
				),
			]),
		);
		expect(end.message.content.slice(1)).toEqual([
			{
				type: "tool_call",
				call_id: "m-1_1",
				name: "get_current_temperature",
				arguments: '{"location":"Paris"}',
			},
			{
				type: "tool_call",
				call_id: "m-1_2",
				name: "get_current_temperature",
				arguments: "{}",
			},
		]);
		const { contents } = bodyOf([
			ask,
			end.message,
			result("m-1_1", [{ type: "text", text: "15C" }]),
			result("m-1_2", [{ type: "text", text: "location is required" }], true),
		]);
		expect(
			contents[1].parts.map(
				(part: { functionCall: { id: string } }) => part.functionCall.id,
			),
		).toEqual(["m-1_1", "m-1_2"]);
		expect(
			contents[2].parts.map(
				(part: { functionResponse: { id: string } }) =>
					part.functionResponse.id,
			),
		).toEqual(["m-1_1", "m-1_2"]);
	});

	test("模型调用改写过名字的工具时换回内部的名字，没声明过的名字原样交回", async () => {
		const { end } = await collect(
			sse([
				response(
					[
						{ functionCall: { name: "_2fa_verify", args: {}, id: "c1" } },
						{ functionCall: { name: "unknown_tool", args: {}, id: "c2" } },
					],
					{ finishReason: "STOP" },
				),
			]),
			{ extra: { tools: [{ ...weather, name: "2fa.verify" }] } },
		);
		expect(end.message.content).toMatchObject([
			{ type: "tool_call", call_id: "c1", name: "2fa.verify" },
			{ type: "tool_call", call_id: "c2", name: "unknown_tool" },
		]);
	});

	test("usageMetadata 是累计值，后到的覆盖先到的；缓存命中和工具用掉的提示换成互不包含的口径", async () => {
		// 官方 URL context 指南里的用量样例：27 + 10309 + 31 + 45 = 10412
		const documented = await collect(
			sse([
				response(
					[{ text: "Both" }],
					{},
					{
						usageMetadata: { promptTokenCount: 27, totalTokenCount: 27 },
					},
				),
				response(
					[{ text: " pages agree." }],
					{ finishReason: "STOP" },
					{
						usageMetadata: {
							candidatesTokenCount: 45,
							promptTokenCount: 27,
							thoughtsTokenCount: 31,
							toolUsePromptTokenCount: 10309,
							totalTokenCount: 10412,
						},
					},
				),
			]),
		);
		expect(documented.end.message.usage).toMatchObject({
			input: 10336,
			output: 76,
			cache_read: 0,
			cache_write: 0,
			reasoning: 31,
		});
		expect(documented.events.at(-2)).toEqual({
			type: "usage",
			usage: documented.end.message.usage,
		});

		const cached = await collect(
			sse([
				response(
					[{ text: "ok" }],
					{ finishReason: "STOP" },
					{
						usageMetadata: {
							promptTokenCount: 5000,
							cachedContentTokenCount: 4096,
							candidatesTokenCount: 10,
							totalTokenCount: 5010,
						},
					},
				),
			]),
		);
		expect(cached.end.message.usage).toMatchObject({
			input: 904,
			output: 10,
			cache_read: 4096,
			cache_write: 0,
			reasoning: 0,
		});
		expect(cached.end.message.usage.cost_usd).toBeCloseTo(
			(904 * 0.75 + 4096 * 0.075 + 10 * 3.75) / 1e6,
		);
	});

	test("finishReason：STOP 是正常结束，MAX_TOKENS 和 CONTINUATION 是达到输出上限", async () => {
		for (const [finishReason, stopReason] of [
			["STOP", "end_turn"],
			["MAX_TOKENS", "max_tokens"],
			["CONTINUATION", "max_tokens"],
		]) {
			const { events, end } = await collect(
				sse([response([{ text: "partial" }], { finishReason })]),
			);
			expect(end.message.stop_reason).toBe(stopReason);
			expect(end.error).toBeUndefined();
			expect(events.map((event) => event.type)).toEqual([
				"start",
				"text_delta",
				"usage",
				"end",
			]);
		}
	});

	test("内容被拦下的 finishReason 按拒绝处理，类别取它的值，作废本轮全部输出", async () => {
		for (const finishReason of [
			"SAFETY",
			"RECITATION",
			"LANGUAGE",
			"BLOCKLIST",
			"PROHIBITED_CONTENT",
			"SPII",
			"IMAGE_SAFETY",
			"IMAGE_PROHIBITED_CONTENT",
		]) {
			const { events, end } = await collect(
				sse([
					response([{ text: "Sure, " }]),
					response([{ text: "first" }], { finishReason }),
				]),
			);
			expect(end.message).toMatchObject({
				stop_reason: "refusal",
				refusal: { category: finishReason },
				content: [{ type: "text", text: "Sure, first" }],
			});
			expect(events.at(-2)).toEqual({
				type: "invalidate",
				invalidation: {
					blocks: [{ message_id: "m-1", index: 0 }],
					reason: "refusal",
				},
			});
		}
	});

	test("提示被拦下时没有候选，只有 promptFeedback.blockReason，同样按拒绝处理", async () => {
		const { events, end } = await collect(
			sse([
				{
					promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
					usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 },
					modelVersion: "gemini-3.8-flash",
				},
			]),
		);
		expect(end.message).toMatchObject({
			stop_reason: "refusal",
			refusal: { category: "PROHIBITED_CONTENT" },
			content: [],
			usage: { input: 12, output: 0 },
		});
		expect(end.error).toBeUndefined();
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"usage",
			"invalidate",
			"end",
		]);
	});

	test("其余的 finishReason 按请求出错处理，错误信息带上 finishReason 和 finishMessage", async () => {
		const malformed = await collect(
			sse([
				response([{ text: "Calling" }]),
				response([], {
					finishReason: "MALFORMED_FUNCTION_CALL",
					finishMessage: "Malformed function call: print(default_api",
				}),
			]),
		);
		expect(malformed.end.error).toEqual({
			category: "invalid_request",
			message:
				"Gemini 以 MALFORMED_FUNCTION_CALL 结束：Malformed function call: print(default_api",
		});
		expect(malformed.end.message).toMatchObject({
			stop_reason: "error",
			content: [{ type: "text", text: "Calling" }],
		});

		for (const finishReason of [
			"UNEXPECTED_TOOL_CALL",
			"TOO_MANY_TOOL_CALLS",
			"MISSING_THOUGHT_SIGNATURE",
			"MALFORMED_RESPONSE",
			"OTHER",
			"SOME_FUTURE_REASON",
		]) {
			const { end } = await collect(sse([response([], { finishReason })]));
			expect(end.error).toEqual({
				category: "invalid_request",
				message: `Gemini 以 ${finishReason} 结束`,
			});
		}
	});

	test("流在 finishReason 之前断开按网络中断处理，已收到的部分留在回复里", async () => {
		const { end } = await collect(
			sse([response([{ text: "The image displays" }])]),
		);
		expect(end.error?.category).toBe("network");
		expect(end.message).toMatchObject({
			stop_reason: "error",
			content: [{ type: "text", text: "The image displays" }],
		});
	});

	test("流中途的 error 事件和 HTTP 错误用同一套归类，状态码取 error.code", async () => {
		for (const [error, category] of [
			[
				{
					code: 503,
					message: "The model is overloaded. Please try again later.",
					status: "UNAVAILABLE",
				},
				"overloaded",
			],
			[
				{
					code: 429,
					message: "Resource has been exhausted (e.g. check quota).",
					status: "RESOURCE_EXHAUSTED",
				},
				"rate_limit",
			],
			[
				{
					code: 500,
					message: "Your input context is too long.",
					status: "INTERNAL",
				},
				"context_overflow",
			],
		] as const) {
			const { events, end } = await collect(
				sse([response([{ text: "The image" }]), { error }]),
			);
			expect(end.error).toEqual({ category, message: error.message });
			expect(end.message).toMatchObject({
				stop_reason: "error",
				content: [{ type: "text", text: "The image" }],
			});
			expect(events.map((event) => event.type)).toEqual([
				"start",
				"text_delta",
				"end",
			]);
		}
	});

	test("HTTP 错误按状态码、details 里的 reason 和文档给出的两句上下文超长的话归类", async () => {
		const failure = (code: number, status: string, message: string) =>
			JSON.stringify({ error: { code, message, status } });
		// 官方文档里密钥无效的错误体
		const invalidKey = JSON.stringify({
			error: {
				code: 400,
				message: "API key not valid. Please pass a valid API key.",
				status: "INVALID_ARGUMENT",
				details: [
					{
						"@type": "type.googleapis.com/google.rpc.ErrorInfo",
						reason: "API_KEY_INVALID",
						domain: "googleapis.com",
						metadata: { service: "generativelanguage.googleapis.com" },
					},
					{
						"@type": "type.googleapis.com/google.rpc.LocalizedMessage",
						locale: "en-US",
						message: "API key not valid. Please pass a valid API key.",
					},
				],
			},
		});
		const tooLong = "Your input context is too long.";
		const tooSlow =
			"Your prompt (or context) is too large to be processed in time.";
		for (const [status, body, category] of [
			[400, invalidKey, "authentication"],
			[400, failure(400, "INVALID_ARGUMENT", "bad field"), "invalid_request"],
			[
				401,
				failure(401, "UNAUTHENTICATED", "no credentials"),
				"authentication",
			],
			[402, failure(402, "RESOURCE_EXHAUSTED", "credits depleted"), "billing"],
			[403, failure(403, "PERMISSION_DENIED", "leaked key"), "permission"],
			[404, failure(404, "NOT_FOUND", "no such model"), "permission"],
			[413, failure(413, "INVALID_ARGUMENT", "too big"), "request_too_large"],
			[429, failure(429, "RESOURCE_EXHAUSTED", "quota"), "rate_limit"],
			[500, failure(500, "INTERNAL", tooLong), "context_overflow"],
			[500, failure(500, "INTERNAL", "internal error"), "overloaded"],
			[503, failure(503, "UNAVAILABLE", "out of capacity"), "overloaded"],
			[504, failure(504, "DEADLINE_EXCEEDED", tooSlow), "context_overflow"],
			[504, failure(504, "DEADLINE_EXCEEDED", "deadline"), "overloaded"],
		] as const) {
			const { events, end } = await collect(body, { status });
			expect(end.error).toEqual({
				category,
				message: JSON.parse(body).error.message,
			});
			expect(events).toHaveLength(1);
		}

		// 响应体不是 JSON 时只按状态码归类
		const gateway = await collect("<html>bad gateway</html>", { status: 502 });
		expect(gateway.end.error).toEqual({
			category: "overloaded",
			message: "<html>bad gateway</html>",
		});
		// 响应头给了等待时间时带上
		const limited = await collect(failure(429, "RESOURCE_EXHAUSTED", "quota"), {
			status: 429,
			headers: { "retry-after": "7" },
		});
		expect(limited.end.error).toEqual({
			category: "rate_limit",
			message: "quota",
			retry_after_ms: 7000,
		});
	});

	test("响应里出现没有列出的 part 时报错", async () => {
		await expect(
			collect(
				sse([
					response([{ executableCode: { language: "PYTHON", code: "1" } }]),
				]),
			),
		).rejects.toThrow("没有列出的 part：executableCode");
	});
});

describe("countTokens（google.generate-content）", () => {
	const options = { apiKey: "key", signal: new AbortController().signal };

	test("请求体是包在 generateContentRequest 里的同一份原文，另带 model，结果取 totalTokens", async () => {
		const counted = request([ask]);
		const raws = new MemoryRaws();
		const real = recording(() => new Response("", { status: 500 }));
		const stream = async () => {
			for await (const _ of streamModel(flash, counted, {
				...options,
				messageId: "m-1",
				fetch: real.fetch,
				raws,
			})) {
				// 只要发出的请求体
			}
		};
		await stream();
		// 把保存的原文改成另一种等价的写法：真实请求和计数都得用它，不重新转换
		for (const [key, part] of raws.parts) {
			raws.parts.set(key, {
				...part,
				pieces: part.pieces.map((piece) => ` ${piece}`),
			});
		}
		await stream();

		// 官方参考里 countTokens 的响应字段
		const count = recording(() =>
			Response.json({
				totalTokens: 1234,
				promptTokensDetails: [{ modality: "TEXT", tokenCount: 1234 }],
			}),
		);
		const counting = await countTokens(flash, counted, {
			...options,
			fetch: count.fetch,
			raws,
		});
		const [, replayed] = real.sent;
		const [sent] = count.sent;
		if (replayed === undefined || sent === undefined) {
			throw new Error("请求没有发出");
		}

		expect(counting).toEqual({ input_tokens: 1234 });
		expect(sent.url).toBe(
			"https://generativelanguage.example.com/v1/models/gemini-3.8-flash:countTokens",
		);
		expect(sent.headers.get("content-type")).toBe("application/json");
		expect(sent.headers.get("x-goog-api-key")).toBe("key");
		expect(sent.headers.get("authorization")).toBeNull();
		expect(replayed.body).toContain('[ {"');
		expect(sent.body).toBe(
			`{"generateContentRequest":{"model":"models/gemini-3.8-flash",${replayed.body.slice(1)}}`,
		);
		expect(Object.keys(JSON.parse(sent.body).generateContentRequest)).toEqual([
			"model",
			"systemInstruction",
			"contents",
			"tools",
			"generationConfig",
		]);
	});

	test("接口报错按和模型请求相同的类别给出，响应里没有 totalTokens 按网络错误给出", async () => {
		const limited = await countTokens(flash, request([ask]), {
			...options,
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 429,
							message: "Resource has been exhausted (e.g. check quota).",
							status: "RESOURCE_EXHAUSTED",
						},
					}),
					{ status: 429 },
				),
		});
		expect(limited).toEqual({
			error: {
				category: "rate_limit",
				message: "Resource has been exhausted (e.g. check quota).",
			},
		});

		const empty = await countTokens(flash, request([ask]), {
			...options,
			fetch: async () => Response.json({ input_tokens: 9 }),
		});
		expect(empty).toEqual({
			error: {
				category: "network",
				message: "计数接口的响应里没有 totalTokens",
			},
		});
	});
});
