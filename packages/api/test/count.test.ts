import {
	builtinModels,
	countTokens,
	type ModelEntry,
	type RawKey,
	type RawPart,
	type RawStore,
	streamModel,
} from "@ospreycode/api";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { scriptedCounter } from "@ospreycode/api/testing";
import { describe, expect, test } from "vitest";

function builtin(id: string): ModelEntry {
	const entry = builtinModels.find((candidate) => candidate.id === id);
	if (entry === undefined) throw new Error(`内置清单里没有 ${id}`);
	return { ...entry, base_url: "https://api.example.com/v1" };
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

function requestFor(model: string): ModelRequest {
	return {
		model,
		reasoning_effort: "low",
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
				content: [{ type: "text", text: "list the files" }],
			},
		],
		tools: [
			{
				name: "shell",
				description: "run a command",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				},
			},
		],
	};
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

/**
 * 先发一次真实的请求，把保存的原文各改成另一种等价的写法（开头多一个空格），再发一次真实请求和
 * 一次计数：两边都得用保存的原文，不重新转换。返回第二次的真实请求和计数请求。
 */
async function sameRaws(entry: ModelEntry, counted: object) {
	const request = requestFor(entry.id);
	const raws = new MemoryRaws();
	const real = recording(() => new Response("", { status: 500 }));
	const stream = async () => {
		for await (const _ of streamModel(entry, request, {
			messageId: "m-1",
			apiKey: "key",
			fetch: real.fetch,
			signal: new AbortController().signal,
			cacheKey: "session-1",
			raws,
		})) {
			// 只要发出的请求体
		}
	};
	await stream();
	expect(raws.parts.size).toBeGreaterThan(0);
	for (const [key, pieces] of raws.parts) {
		raws.parts.set(
			key,
			pieces.map((piece) => ` ${piece}`),
		);
	}
	await stream();

	const count = recording(() => Response.json(counted));
	const result = await countTokens(entry, request, {
		apiKey: "key",
		fetch: count.fetch,
		signal: new AbortController().signal,
		raws,
	});
	const [, replayed] = real.sent;
	const [sent] = count.sent;
	if (replayed === undefined || sent === undefined) {
		throw new Error("请求没有发出");
	}
	// 改过的写法出现在请求体里，说明用的是保存的原文
	expect(replayed.body).toContain('[ {"');
	return { result, real: replayed, count: sent };
}

describe("countTokens（anthropic.messages）", () => {
	// 做前缀校验、用户配置里又写了回退列表的模型：这两项计数接口都不接受
	const fable: ModelEntry = {
		...builtin("claude-fable-5-1"),
		allowed_fallback_models: [
			{
				model: "claude-opus-4-8",
				price: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
			},
		],
	};

	test("请求体和真实请求用同一份原文，只去掉计数接口不接受的字段和 beta header", async () => {
		expect(fable.prefix_check).toBe(true);
		const { result, real, count } = await sameRaws(fable, {
			input_tokens: 1234,
		});

		expect(result).toEqual({ input_tokens: 1234 });
		expect(count.url).toBe("https://api.example.com/v1/messages/count_tokens");
		expect(count.headers.get("x-api-key")).toBe("key");
		expect(count.headers.get("anthropic-version")).toBe(
			real.headers.get("anthropic-version"),
		);
		expect(real.headers.get("anthropic-beta")).not.toBeNull();
		expect(count.headers.get("anthropic-beta")).toBeNull();

		// 逐字节相同，只少了这四个字段
		let expected = real.body;
		for (const dropped of [
			`"max_tokens":${fable.max_output_tokens},`,
			'"prefix_mismatch_behavior":"error",',
			'"fallbacks":[{"model":"claude-opus-4-8"}],',
			',"stream":true',
		]) {
			expect(expected).toContain(dropped);
			expected = expected.replace(dropped, "");
		}
		expect(count.body).toBe(expected);
		expect(Object.keys(JSON.parse(count.body))).toEqual([
			"model",
			"system",
			"messages",
			"thinking",
			"output_config",
			"tools",
			"tool_choice",
		]);
	});

	test("接口报错按和模型请求相同的类别给出", async () => {
		const options = {
			apiKey: "key",
			signal: new AbortController().signal,
		};
		const limited = await countTokens(fable, requestFor(fable.id), {
			...options,
			fetch: async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "slow down" },
					}),
					{ status: 429, headers: { "retry-after": "7" } },
				),
		});
		expect(limited).toEqual({
			error: {
				category: "rate_limit",
				message: "slow down",
				retry_after_ms: 7_000,
			},
		});

		const tooLong = await countTokens(fable, requestFor(fable.id), {
			...options,
			fetch: async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "prompt is too long: 250000 tokens > 200000 maximum",
						},
					}),
					{ status: 400 },
				),
		});
		expect(tooLong).toMatchObject({ error: { category: "context_overflow" } });
	});

	test("请求没有发出去、响应里没有 input_tokens 都按网络错误给出", async () => {
		const options = {
			apiKey: "key",
			signal: new AbortController().signal,
		};
		const refused = await countTokens(fable, requestFor(fable.id), {
			...options,
			fetch: async () => {
				throw new TypeError("fetch failed", {
					cause: new Error("connect ECONNREFUSED"),
				});
			},
		});
		expect(refused).toEqual({
			error: {
				category: "network",
				message: "fetch failed: connect ECONNREFUSED",
			},
		});

		for (const body of ["<html>gateway</html>", "{}", '{"input_tokens":"9"}']) {
			const result = await countTokens(fable, requestFor(fable.id), {
				...options,
				fetch: async () => new Response(body),
			});
			expect(result).toEqual({
				error: {
					category: "network",
					message: "计数接口的响应里没有 input_tokens",
				},
			});
		}
	});

	test("取消时结果是 cancelled，不算出错", async () => {
		const controller = new AbortController();
		const pending = countTokens(fable, requestFor(fable.id), {
			apiKey: "key",
			signal: controller.signal,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		});
		controller.abort();
		expect(await pending).toEqual({ cancelled: true });
	});
});

describe("countTokens（openai.responses）", () => {
	const sol = builtin("gpt-5.6-sol");

	test("请求体和真实请求用同一份原文，只留计数接口接受的字段", async () => {
		const { result, real, count } = await sameRaws(sol, {
			object: "response.input_tokens",
			input_tokens: 42,
		});

		expect(result).toEqual({ input_tokens: 42 });
		expect(count.url).toBe("https://api.example.com/v1/responses/input_tokens");
		expect(count.headers.get("authorization")).toBe("Bearer key");

		// 逐字节相同，只少了 reasoning 之后的字段
		const kept = real.body.slice(0, real.body.indexOf(',"include":'));
		expect(count.body).toBe(`${kept}}`);
		expect(Object.keys(JSON.parse(count.body))).toEqual([
			"model",
			"instructions",
			"input",
			"tools",
			"tool_choice",
			"reasoning",
		]);
		expect(Object.keys(JSON.parse(real.body))).toEqual([
			"model",
			"instructions",
			"input",
			"tools",
			"tool_choice",
			"reasoning",
			"include",
			"max_output_tokens",
			"prompt_cache_key",
			"store",
			"stream",
		]);
	});

	test("接口报错按和模型请求相同的类别给出", async () => {
		const result = await countTokens(sol, requestFor(sol.id), {
			apiKey: "key",
			signal: new AbortController().signal,
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: { code: "invalid_api_key", message: "bad key" },
					}),
					{ status: 401 },
				),
		});
		expect(result).toMatchObject({ error: { category: "authentication" } });
	});
});

describe("countTokens（openai.chat）", () => {
	test("没有计数接口，调用是缺陷", async () => {
		const chat = builtin("deepseek-flash");
		expect(chat.protocol).toBe("openai.chat");
		await expect(
			countTokens(chat, requestFor(chat.id), {
				apiKey: "key",
				signal: new AbortController().signal,
				fetch: async () => Response.json({ input_tokens: 1 }),
			}),
		).rejects.toThrow("没有 token 计数接口");
	});
});

describe("scriptedCounter", () => {
	test("按脚本给出 token 数或错误，脚本能看到请求和这是第几次", async () => {
		const seen: [number, number][] = [];
		const counter = scriptedCounter((request, call) => {
			seen.push([request.messages.length, call]);
			return call === 0 ? 77 : { category: "overloaded", message: "busy" };
		});
		const sol = builtin("gpt-5.6-sol");
		const options = {
			apiKey: "key",
			fetch: globalThis.fetch,
			signal: new AbortController().signal,
		};
		expect(await counter(sol, requestFor(sol.id), options)).toEqual({
			input_tokens: 77,
		});
		expect(await counter(sol, requestFor(sol.id), options)).toEqual({
			error: { category: "overloaded", message: "busy" },
		});
		expect(seen).toEqual([
			[2, 0],
			[2, 1],
		]);
	});
});
