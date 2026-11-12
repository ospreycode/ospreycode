import { createHash } from "node:crypto";
import {
	builtinModels,
	countTokens,
	credentialSecrets,
	entryAuth,
	type ModelEntry,
	signAws,
	streamModel,
} from "@ospreycode/api";
import type { ModelRequest, StreamEvent } from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

function builtin(id: string): ModelEntry {
	const entry = builtinModels.find((candidate) => candidate.id === id);
	if (entry === undefined) throw new Error(`内置清单里没有 ${id}`);
	return entry;
}

// 各平台的条目照 README 里给用户的写法：在首批服务的条目上换服务名、地址、模型名和认证方式
const { server_tools: _tools, ...opus } = builtin("claude-opus-5-5");
const { server_tools: _search, ...sol } = builtin("gpt-5.6-sol");

const azure: ModelEntry = {
	...sol,
	id: "azure-gpt",
	service: "azure",
	base_url: "https://example.openai.azure.com/openai/v1",
	model: "my-deployment",
	auth: "api-key",
};

const foundry: ModelEntry = {
	...opus,
	id: "foundry-opus",
	service: "foundry",
	base_url: "https://example.services.ai.azure.com/anthropic/v1",
	model: "my-claude",
	auth: "bearer",
	allowed_fallback_models: [],
};

const bedrock: ModelEntry = {
	...opus,
	id: "bedrock-opus",
	service: "bedrock",
	base_url: "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1",
	model: "anthropic.claude-opus-5-5",
	auth: { scheme: "aws-sigv4", region: "us-east-1", service: "bedrock-mantle" },
	allowed_fallback_models: [],
};

const claudeOnAws: ModelEntry = {
	...opus,
	id: "aws-opus",
	service: "claude-aws",
	base_url: "https://aws-external-anthropic.us-west-2.api.aws/v1",
	auth: "bearer",
	headers: { "anthropic-workspace-id": "wrkspc_01AbCdEf" },
};

const vertex: ModelEntry = {
	...opus,
	id: "vertex-opus",
	service: "vertex",
	base_url:
		"https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/anthropic/models",
	auth: "bearer",
	vertex: true,
	allowed_fallback_models: [],
};

function request(entry: ModelEntry): ModelRequest {
	return {
		model: entry.id,
		reasoning_effort: "low",
		tool_choice: "auto",
		cache_retention: "none",
		messages: [
			{
				role: "system",
				message_id: "s",
				content: [{ type: "text", text: "be brief" }],
			},
			{
				role: "user",
				message_id: "u",
				content: [{ type: "text", text: "hi" }],
			},
		],
		tools: [],
	};
}

interface Sent {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** 发一次请求，记下发出的地址、请求头和请求体，按 `response` 回复。 */
async function send(
	entry: ModelEntry,
	apiKey: string,
	response: () => Response = () => new Response("", { status: 200 }),
) {
	const sent: Sent[] = [];
	const events: StreamEvent[] = [];
	for await (const event of streamModel(entry, request(entry), {
		messageId: "m-1",
		apiKey,
		fetch: async (url, init) => {
			sent.push({
				url: String(url),
				headers: Object.fromEntries(new Headers(init?.headers)),
				body: String(init?.body),
			});
			return response();
		},
		signal: new AbortController().signal,
	})) {
		events.push(event);
	}
	const end = events.at(-1);
	if (end?.type !== "end") throw new Error("流没有以 end 结束");
	return { sent, end };
}

describe("认证", () => {
	test("没写 auth 时按协议取各家自己服务的写法", () => {
		expect(entryAuth(builtin("claude-opus-5-5"))).toBe("x-api-key");
		expect(entryAuth(builtin("gpt-5.6-sol"))).toBe("bearer");
		expect(entryAuth(builtin("deepseek-flash"))).toBe("bearer");
		expect(entryAuth(builtin("gemini-3.5-flash-lite"))).toBe("x-goog-api-key");
	});

	test("凭据只放进条目指定的那个请求头", async () => {
		const anthropic = await send(
			{ ...opus, base_url: "https://api.example.com/v1" },
			"sk-test",
		);
		expect(anthropic.sent[0]?.headers["x-api-key"]).toBe("sk-test");
		expect(anthropic.sent[0]?.headers.authorization).toBeUndefined();

		const onAzure = await send(azure, "azure-key");
		expect(onAzure.sent[0]?.url).toBe(
			"https://example.openai.azure.com/openai/v1/responses",
		);
		expect(onAzure.sent[0]?.headers["api-key"]).toBe("azure-key");
		expect(onAzure.sent[0]?.headers.authorization).toBeUndefined();
		expect(JSON.parse(onAzure.sent[0]?.body ?? "").model).toBe("my-deployment");

		const onFoundry = await send(foundry, "entra-token");
		expect(onFoundry.sent[0]?.url).toBe(
			"https://example.services.ai.azure.com/anthropic/v1/messages",
		);
		expect(onFoundry.sent[0]?.headers.authorization).toBe("Bearer entra-token");
		expect(onFoundry.sent[0]?.headers["x-api-key"]).toBeUndefined();
		expect(onFoundry.sent[0]?.headers["anthropic-version"]).toBe("2026-10-21");
		// 这个平台不支持服务端回退：条目没有回退模型，就不发回退列表和它的 beta
		expect(JSON.parse(onFoundry.sent[0]?.body ?? "").fallbacks).toBeUndefined();
	});

	test("条目的固定请求头每次请求都带上", async () => {
		const { sent } = await send(claudeOnAws, "aws-api-key");
		expect(sent[0]?.url).toBe(
			"https://aws-external-anthropic.us-west-2.api.aws/v1/messages",
		);
		expect(sent[0]?.headers).toMatchObject({
			authorization: "Bearer aws-api-key",
			"anthropic-workspace-id": "wrkspc_01AbCdEf",
		});
	});

	test("aws-sigv4 用 credential_process 格式的凭据给请求签名", async () => {
		const credential = JSON.stringify({
			Version: 1,
			AccessKeyId: "AKIDEXAMPLE",
			SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			SessionToken: "AQoDYXdzEPT//////////wEXAMPLE",
		});
		const { sent } = await send(bedrock, credential);
		const [http] = sent;
		if (http === undefined) throw new Error("没有发出请求");
		expect(http.url).toBe(
			"https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
		);
		expect(http.headers["x-api-key"]).toBeUndefined();
		expect(http.headers["x-amz-security-token"]).toBe(
			"AQoDYXdzEPT//////////wEXAMPLE",
		);
		expect(http.headers["x-amz-content-sha256"]).toBe(
			createHash("sha256").update(http.body).digest("hex"),
		);
		// 用请求里的时刻重新签一遍：发出的签名覆盖了地址、请求体和全部请求头
		const time = http.headers["x-amz-date"] ?? "";
		const now = new Date(
			time.replace(
				/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
				"$1-$2-$3T$4:$5:$6Z",
			),
		);
		const {
			authorization,
			"x-amz-date": _date,
			"x-amz-security-token": _token,
			...signed
		} = http.headers;
		expect(authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
		);
		expect(
			signAws(
				{ method: "POST", url: http.url, headers: signed, body: http.body },
				{
					accessKeyId: "AKIDEXAMPLE",
					secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
					sessionToken: "AQoDYXdzEPT//////////wEXAMPLE",
				},
				{ region: "us-east-1", service: "bedrock-mantle" },
				now,
			).authorization,
		).toBe(authorization);
	});

	test("凭据的格式和 auth 对不上时不发请求，按认证失败给出，错误信息里没有凭据", async () => {
		const { sent, end } = await send(bedrock, "sk-not-json-secret");
		expect(sent).toEqual([]);
		expect(end).toMatchObject({
			message: { stop_reason: "error" },
			error: { category: "authentication" },
		});
		expect(JSON.stringify(end)).not.toContain("sk-not-json-secret");

		const counted = await countTokens(bedrock, request(bedrock), {
			apiKey: '{"AccessKeyId":"AKIDEXAMPLE"}',
			fetch: async () => {
				throw new Error("不该发出请求");
			},
			signal: new AbortController().signal,
		});
		expect(counted).toMatchObject({ error: { category: "authentication" } });
	});

	test("要从日志和事件里去掉的值：整个凭据，签名用的密钥和会话令牌", () => {
		expect(credentialSecrets(azure, "azure-key")).toEqual(["azure-key"]);
		const credential = JSON.stringify({
			Version: 1,
			AccessKeyId: "AKIDEXAMPLE",
			SecretAccessKey: "secret-key",
			SessionToken: "session-token",
		});
		expect(credentialSecrets(bedrock, credential)).toEqual([
			credential,
			"secret-key",
			"session-token",
		]);
		expect(credentialSecrets(bedrock, "not json")).toEqual(["not json"]);
	});
});

describe("Vertex AI 上的 Claude", () => {
	test("模型写在地址里，版本写在请求体里，不发版本的请求头", async () => {
		const { sent } = await send(vertex, "ya29.token");
		const [http] = sent;
		expect(http?.url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict",
		);
		expect(http?.headers.authorization).toBe("Bearer ya29.token");
		expect(http?.headers["anthropic-version"]).toBeUndefined();
		expect(http?.headers["x-api-key"]).toBeUndefined();
		const body = JSON.parse(http?.body ?? "");
		expect(body.anthropic_version).toBe("2026-10-21");
		expect(body.model).toBeUndefined();
		expect(body.stream).toBe(true);
	});

	test("计数发到 count-tokens:rawPredict，请求体里留着 model", async () => {
		let sent: Sent | undefined;
		const counted = await countTokens(vertex, request(vertex), {
			apiKey: "ya29.token",
			fetch: async (url, init) => {
				sent = {
					url: String(url),
					headers: Object.fromEntries(new Headers(init?.headers)),
					body: String(init?.body),
				};
				return new Response('{"input_tokens":14}', { status: 200 });
			},
			signal: new AbortController().signal,
		});
		expect(counted).toEqual({ input_tokens: 14 });
		expect(sent?.url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/anthropic/models/count-tokens:rawPredict",
		);
		expect(JSON.parse(sent?.body ?? "")).toMatchObject({
			anthropic_version: "2026-10-21",
			model: "claude-opus-5-5",
		});
	});

	test("Google 的分类器中断流时按拒绝处理", async () => {
		const stream = [
			'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
			'event: vertex-block-event\ndata: {"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}\n\n',
		].join("");
		const { end } = await send(
			vertex,
			"ya29.token",
			() => new Response(stream),
		);
		expect(end.error).toBeUndefined();
		expect(end.message).toMatchObject({
			stop_reason: "refusal",
			refusal: { category: "PROHIBITED_CONTENT" },
		});
		// 别的服务上出现这个事件是缺陷
		await expect(
			send(
				{ ...opus, base_url: "https://api.example.com/v1" },
				"sk-test",
				() => new Response(stream),
			),
		).rejects.toThrow("不认识的事件：vertex-block-event");
	});
});

describe("Azure OpenAI", () => {
	test("429 的等待时间取 retry-after-ms", async () => {
		const { end } = await send(
			azure,
			"azure-key",
			() =>
				new Response(
					'{"error":{"code":"429","message":"Rate limit is exceeded."}}',
					{ status: 429, headers: { "retry-after-ms": "1500" } },
				),
		);
		expect(end.error).toEqual({
			category: "rate_limit",
			message: "Rate limit is exceeded.",
			retry_after_ms: 1500,
		});
	});

	test("流里的 error 事件包在 error 对象里，type 相当于状态码", async () => {
		// 取自 Azure 文档里流中途出错的样例
		const event = {
			type: "error",
			error: {
				type: "too_many_requests",
				code: "no_capacity",
				headers: { "skip-error-remapping": "true" },
				message: "The system is currently experiencing high demand.",
				param: null,
			},
		};
		const { end } = await send(
			azure,
			"azure-key",
			() => new Response(`event: error\ndata: ${JSON.stringify(event)}\n\n`),
		);
		expect(end.error).toEqual({
			category: "rate_limit",
			message: "The system is currently experiencing high demand.",
		});
	});

	test("输入被内容过滤器拦下时带着服务的说明报错", async () => {
		const { end } = await send(
			azure,
			"azure-key",
			() =>
				new Response(
					'{"error":{"code":"content_filter","message":"The response was filtered due to the prompt triggering content management policy."}}',
					{ status: 400 },
				),
		);
		expect(end.error).toEqual({
			category: "invalid_request",
			message:
				"The response was filtered due to the prompt triggering content management policy.",
		});
	});
});
