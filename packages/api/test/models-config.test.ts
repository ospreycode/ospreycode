import {
	completeModel,
	ModelConfigError,
	parseModelFields,
} from "@ospreycode/api";
import { expect, test } from "vitest";

function keyOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ModelConfigError);
		return (error as ModelConfigError).key;
	}
	throw new Error("没有报错");
}

test("服务地址只用 https，本机上的服务可以用 http，去掉末尾的斜杠", () => {
	expect(
		parseModelFields({ base_url: "https://api.example.com/v1/" }, "models.m"),
	).toEqual({ base_url: "https://api.example.com/v1" });
	expect(
		parseModelFields({ base_url: "http://localhost:11434/v1" }, "models.m"),
	).toEqual({ base_url: "http://localhost:11434/v1" });
	for (const url of [
		"http://api.example.com/v1",
		"https://user:pw@api.example.com",
		"https://api.example.com/v1?key=x",
		"not a url",
	]) {
		expect(keyOf(() => parseModelFields({ base_url: url }, "models.m"))).toBe(
			"models.m.base_url",
		);
	}
});

test("不认识的字段、不合规的值和不全的定义都报出位置", () => {
	expect(keyOf(() => parseModelFields({ apiKey: "x" }, "models.m"))).toBe(
		"models.m.apiKey",
	);
	expect(
		keyOf(() => parseModelFields({ price: { input: -1 } }, '"models.a b"')),
	).toBe('"models.a b".price.input');
	const fields = parseModelFields(
		{
			protocol: "anthropic.messages",
			service: "anthropic",
			base_url: "https://api.anthropic.com/v1",
			model: "m",
			context_window: 100,
			max_output_tokens: 200,
		},
		"models.m",
	);
	expect(keyOf(() => completeModel("m", fields, "models.m"))).toBe(
		"models.m.max_output_tokens",
	);
	expect(
		keyOf(() =>
			completeModel(
				"m",
				{ ...fields, max_output_tokens: 50, price: { input: 1 } },
				"models.m",
			),
		),
	).toBe("models.m.price");
	expect(keyOf(() => completeModel("m", { model: "m" }, "models.m"))).toBe(
		"models.m",
	);
});

test("回退的模型写成表的数组；模型有价格时回退的模型也要写价格", () => {
	const price = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };
	const base = {
		protocol: "anthropic.messages",
		service: "anthropic",
		base_url: "https://api.anthropic.com/v1",
		model: "claude-opus-5",
		context_window: 1_000_000,
		max_output_tokens: 128_000,
		price,
	};
	const fields = parseModelFields(
		{
			...base,
			allowed_fallback_models: [{ model: "claude-opus-4-8", price }],
		},
		"models.m",
	);
	expect(
		completeModel("m", fields, "models.m").allowed_fallback_models,
	).toEqual([{ model: "claude-opus-4-8", price }]);
	// 写空数组就不发回退列表
	expect(parseModelFields({ allowed_fallback_models: [] }, "models.m")).toEqual(
		{ allowed_fallback_models: [] },
	);
	expect(
		keyOf(() =>
			completeModel(
				"m",
				parseModelFields(
					{ ...base, allowed_fallback_models: [{ model: "claude-opus-4-8" }] },
					"models.m",
				),
				"models.m",
			),
		),
	).toBe("models.m.allowed_fallback_models[0].price");
	expect(
		keyOf(() =>
			parseModelFields(
				{ allowed_fallback_models: [{ model: "x", tier: 1 }] },
				"models.m",
			),
		),
	).toBe("models.m.allowed_fallback_models[0].tier");
	expect(
		keyOf(() =>
			parseModelFields(
				{ allowed_fallback_models: [{ model: "x", price: { input: 1 } }] },
				"models.m",
			),
		),
	).toBe("models.m.allowed_fallback_models[0].price");
});

test("认证方式、固定请求头和 Vertex 的写法", () => {
	expect(
		parseModelFields(
			{
				auth: {
					scheme: "aws-sigv4",
					region: "us-east-1",
					service: "bedrock-mantle",
				},
				headers: { "Anthropic-Workspace-Id": "wrkspc_1" },
				vertex: true,
			},
			"models.m",
		),
	).toEqual({
		auth: {
			scheme: "aws-sigv4",
			region: "us-east-1",
			service: "bedrock-mantle",
		},
		headers: { "anthropic-workspace-id": "wrkspc_1" },
		vertex: true,
	});
	expect(parseModelFields({ auth: "api-key" }, "models.m")).toEqual({
		auth: "api-key",
	});
	expect(keyOf(() => parseModelFields({ auth: "basic" }, "models.m"))).toBe(
		"models.m.auth",
	);
	expect(
		keyOf(() =>
			parseModelFields({ auth: { scheme: "aws-sigv4" } }, "models.m"),
		),
	).toBe("models.m.auth.region");
	// 认证和协议自己的请求头不能写进 headers：会绕过凭据的管理，或者和转换模块发出的冲突
	for (const name of [
		"Authorization",
		"x-api-key",
		"api-key",
		"x-goog-api-key",
		"anthropic-version",
		"X-Amz-Security-Token",
		"content-type",
	]) {
		expect(
			keyOf(() => parseModelFields({ headers: { [name]: "x" } }, "models.m")),
		).toBe(`models.m.headers.${name}`);
	}
	// 值里的换行能夹带出另一个请求头
	expect(
		keyOf(() =>
			parseModelFields(
				{ headers: { "x-team": "a\r\nx-api-key: b" } },
				"models.m",
			),
		),
	).toBe("models.m.headers.x-team");
	const base = {
		protocol: "openai.responses",
		service: "azure",
		base_url: "https://example.openai.azure.com/openai/v1",
		model: "my-deployment",
		context_window: 1_000_000,
		max_output_tokens: 100_000,
	};
	expect(
		keyOf(() =>
			completeModel(
				"m",
				parseModelFields({ ...base, vertex: true }, "models.m"),
				"models.m",
			),
		),
	).toBe("models.m.vertex");
});

test("服务端工具只能写协议有的；条目有价格时每个工具都要有价格", () => {
	const base = {
		protocol: "openai.responses",
		service: "azure",
		base_url: "https://example.openai.azure.com/openai/v1",
		model: "my-deployment",
		context_window: 1_000_000,
		max_output_tokens: 100_000,
	};
	const price = { input: 4, output: 20, cache_read: 0.4, cache_write: 0 };
	const complete = (fields: Record<string, unknown>) =>
		completeModel(
			"m",
			parseModelFields({ ...base, ...fields }, "models.m"),
			"models.m",
		);
	expect(complete({ server_tools: ["web_search"] }).server_tools).toEqual([
		"web_search",
	]);
	expect(
		complete({
			server_tools: ["web_search"],
			price: { ...price, server_tools: { web_search: 10 } },
		}).price?.server_tools,
	).toEqual({ web_search: 10 });
	expect(keyOf(() => complete({ server_tools: ["web_search"], price }))).toBe(
		"models.m.price.server_tools.web_search",
	);
	expect(keyOf(() => complete({ server_tools: ["web_fetch"] }))).toBe(
		"models.m.server_tools",
	);
	expect(keyOf(() => complete({ server_tools: ["code_execution"] }))).toBe(
		"models.m.server_tools[0]",
	);
	expect(
		keyOf(() =>
			complete({ protocol: "openai.chat", server_tools: ["web_search"] }),
		),
	).toBe("models.m.server_tools");
});

test("调价写成日期和倍数", () => {
	expect(
		parseModelFields(
			{ price: { changes: [{ from: "2026-12-01", factor: 2 }] } },
			"models.m",
		),
	).toEqual({ price: { changes: [{ from: "2026-12-01", factor: 2 }] } });
	expect(
		keyOf(() =>
			parseModelFields(
				{ price: { changes: [{ from: "12/01/2026", factor: 2 }] } },
				"models.m",
			),
		),
	).toBe("models.m.price.changes[0].from");
});
