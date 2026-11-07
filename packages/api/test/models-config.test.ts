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
