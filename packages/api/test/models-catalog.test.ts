import {
	anthropicRequestBody,
	builtinModels,
	completeModel,
	computeCost,
	type ModelEntry,
	resolveEffort,
} from "@ospreycode/api";
import type { ModelRequest, Usage } from "@ospreycode/api/protocol";
import { describe, expect, test } from "vitest";

function model(id: string): ModelEntry {
	const entry = builtinModels.find((candidate) => candidate.id === id);
	if (entry === undefined) throw new Error(`内置清单里没有 ${id}`);
	return entry;
}

describe("内置清单", () => {
	test("每个条目都完整，ID 不重复，按服务选协议", () => {
		const ids = builtinModels.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const entry of builtinModels) {
			expect(completeModel(entry.id, entry, `models.${entry.id}`)).toEqual(
				entry,
			);
		}
		expect(model("claude-haiku-5-5").protocol).toBe("anthropic.messages");
		expect(model("gpt-5.6-sol").protocol).toBe("openai.responses");
		expect(model("deepseek-flash")).toMatchObject({
			protocol: "openai.chat",
			compat: { reasoning_field: "reasoning_content" },
		});
		expect(model("gemini-3.5-flash-lite")).toMatchObject({
			protocol: "google.generate-content",
			service: "google",
			base_url: "https://generativelanguage.googleapis.com/v1",
		});
	});

	test("服务端工具只列在有它的服务上，列出的都有价格", () => {
		expect(model("claude-opus-5-5")).toMatchObject({
			server_tools: ["web_search", "web_fetch"],
			price: { server_tools: { web_search: 10, web_fetch: 0 } },
		});
		expect(model("gpt-5.6-sol")).toMatchObject({
			server_tools: ["web_search"],
			price: { server_tools: { web_search: 10 } },
		});
		expect(model("deepseek-flash").server_tools).toBeUndefined();
		expect(model("gemini-4-argon").server_tools).toBeUndefined();
	});
});

describe("推理强度", () => {
	test("不支持的级别先往高找、再往低找", () => {
		// Opus 5.5 不能关闭推理，请求 off 时按 low 发
		expect(resolveEffort(model("claude-opus-5-5"), "off")).toEqual({
			level: "low",
			value: "low",
		});
		expect(resolveEffort(model("claude-haiku-5-5"), "off")).toEqual({
			level: "off",
			value: "disabled",
		});
		expect(resolveEffort(model("gpt-5.6-sol"), "off")?.value).toBe("none");
		expect(resolveEffort(model("gpt-6.1-sol"), "off")?.value).toBe("low");
		// Gemini 3 起的模型关不掉推理，也没有比 high 更高的级别
		expect(resolveEffort(model("gemini-4-argon"), "off")?.value).toBe("low");
		expect(resolveEffort(model("gemini-3.6-flash"), "off")?.value).toBe(
			"minimal",
		);
		expect(resolveEffort(model("gemini-4-argon"), "max")?.value).toBe("high");
		// DeepSeek 没有 medium，往高找到 high；没有 xhigh 时 max 之上找不到，往低找回 max
		expect(resolveEffort(model("deepseek-flash"), "medium")?.value).toBe(
			"high",
		);
		expect(
			resolveEffort(
				{ ...model("deepseek-flash"), thinking_level_map: { low: "low" } },
				"max",
			)?.value,
		).toBe("low");
		const { thinking_level_map: _, ...plain } = model("gpt-5.4");
		expect(resolveEffort(plain, "high")).toBeUndefined();
	});
});

describe("费用", () => {
	const usage: Usage = {
		input: 1_000_000,
		output: 1_000_000,
		cache_read: 0,
		cache_write: 0,
		reasoning: 0,
	};

	test("总输入超过阈值时整次请求按高一档计费", () => {
		const price = model("claude-haiku-5-5").price;
		if (price === undefined) throw new Error("没有价格");
		const monday = new Date("2026-11-09T12:00:00Z");
		expect(
			computeCost(price, { ...usage, input: 50_000, output: 0 }, monday),
		).toBeCloseTo((50_000 * 0.1) / 1_000_000);
		expect(
			computeCost(
				price,
				{ ...usage, input: 60_000, cache_read: 60_000, output: 0 },
				monday,
			),
		).toBeCloseTo((60_000 * 0.5 + 60_000 * 0.05) / 1_000_000);
	});

	test("工作日高峰时段按倍数计费", () => {
		const price = model("deepseek-flash").price;
		if (price === undefined) throw new Error("没有价格");
		const offPeak = computeCost(price, usage, new Date("2026-11-09T05:00:00Z"));
		expect(
			computeCost(price, usage, new Date("2026-11-09T07:30:00Z")),
		).toBeCloseTo(offPeak * 2);
		// 周六不算高峰
		expect(
			computeCost(price, usage, new Date("2026-11-07T07:30:00Z")),
		).toBeCloseTo(offPeak);
	});

	test("已经公布的调价从那一天（UTC）起生效", () => {
		const price = model("gemini-4-argon").price;
		if (price === undefined) throw new Error("没有价格");
		expect(price.changes).toEqual([{ from: "2026-12-01", factor: 2 }]);
		const before = computeCost(price, usage, new Date("2026-11-30T23:59:59Z"));
		expect(before).toBeCloseTo(2 + 10);
		expect(
			computeCost(price, usage, new Date("2026-12-01T00:00:00Z")),
		).toBeCloseTo(before * 2);
	});

	test("服务端工具按计费的次数另计，不随分档、时段和调价变", () => {
		const price = model("deepseek-flash").price;
		if (price === undefined) throw new Error("没有价格");
		const peak = new Date("2026-11-09T07:30:00Z");
		const searched = { ...usage, server_tools: { web_search: 3 } };
		expect(
			computeCost(
				{ ...price, server_tools: { web_search: 10 } },
				searched,
				peak,
			),
		).toBeCloseTo(computeCost(price, usage, peak) + 0.03);
		// 用了清单里没有价格的工具是清单的缺陷
		expect(() => computeCost(price, searched, peak)).toThrow("web_search");
	});
});

describe("Anthropic 的推理字段", () => {
	const request = (effort: ModelRequest["reasoning_effort"]): ModelRequest => ({
		model: "claude-haiku-5-5",
		reasoning_effort: effort,
		tool_choice: "auto",
		cache_retention: "none",
		messages: [
			{
				role: "system",
				message_id: "s",
				content: [{ type: "text", text: "s" }],
			},
			{ role: "user", message_id: "u", content: [{ type: "text", text: "u" }] },
		],
		tools: [],
	});

	test("开着推理时发 adaptive 和 effort，做前缀校验的模型显式要求校验失败时报错", () => {
		expect(
			JSON.parse(
				anthropicRequestBody(model("claude-haiku-5-5"), request("low")),
			),
		).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "low" },
			prefix_mismatch_behavior: "error",
		});
	});

	test("关闭推理时不设前缀校验的字段", () => {
		const body = JSON.parse(
			anthropicRequestBody(model("claude-haiku-5-5"), request("off")),
		);
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body).not.toHaveProperty("output_config");
		expect(body).not.toHaveProperty("prefix_mismatch_behavior");
	});
});
