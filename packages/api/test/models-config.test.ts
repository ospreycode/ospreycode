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
