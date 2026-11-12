import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	builtinModels,
	type ModelEntry,
	type ServerToolName,
	streamModel,
} from "@ospreycode/api";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
} from "@ospreycode/api/protocol";
import { beforeEach, describe, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	expectNoModelError,
} from "../../../scripts/model-test.js";

beforeEach(checkLedger);

function builtin(id: string): ModelEntry {
	const entry = builtinModels.find((m) => m.id === id);
	if (entry === undefined) throw new Error(`内置清单里没有 ${id}`);
	return {
		...entry,
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
}

function apiKey(service: string): string {
	return readFileSync(join(inject("modelKeysDir"), service), "utf8").trim();
}

async function reply(
	entry: ModelEntry,
	messages: Message[],
	serverTools: readonly ServerToolName[],
): Promise<AssistantMessage> {
	const request: ModelRequest = {
		model: entry.id,
		reasoning_effort: "off",
		tool_choice: "auto",
		cache_retention: "none",
		messages,
		tools: [],
	};
	let message: AssistantMessage | undefined;
	for await (const event of streamModel(entry, request, {
		messageId: crypto.randomUUID(),
		apiKey: apiKey(entry.service),
		fetch,
		signal: AbortSignal.timeout(180_000),
		serverTools,
	})) {
		if (event.type === "end") {
			charge(event.message.usage);
			expectNoModelError(event.error);
			message = event.message;
		}
	}
	if (message === undefined) throw new Error("流没有以 end 结束");
	return message;
}

function start(text: string): Message[] {
	return [
		{
			role: "system",
			message_id: crypto.randomUUID(),
			content: [{ type: "text", text: "Keep replies to one short sentence." }],
		},
		{
			role: "user",
			message_id: crypto.randomUUID(),
			content: [{ type: "text", text }],
		},
	];
}

function followUp(text: string): Message {
	return {
		role: "user",
		message_id: crypto.randomUUID(),
		content: [{ type: "text", text }],
	};
}

function kinds(message: AssistantMessage): string[] {
	return message.content.flatMap((block) =>
		block.type === "opaque" ? [block.kind] : [],
	);
}

const searchPrompt =
	"Search the web for the current Node.js LTS version and tell me the version number.";

describe("anthropic.messages", () => {
	test("联网搜索：调用和结果作为不透明块收下，按次计费；带回下一次请求后照常完成", {
		tags: ["model"],
	}, async () => {
		const entry = builtin("claude-haiku-5-5");
		const messages = start(searchPrompt);
		const first = await reply(entry, messages, ["web_search"]);
		expect(first.stop_reason).toBe("end_turn");
		expect(kinds(first)).toContain("server_tool_use");
		expect(kinds(first)).toContain("web_search_tool_result");
		expect(
			first.content.find(
				(block) => block.type === "opaque" && block.kind === "server_tool_use",
			),
		).toMatchObject({
			summary: expect.stringMatching(/^web_search: ./),
			origin: { protocol: "anthropic.messages", service: "anthropic" },
		});
		const searches = first.usage.server_tools?.web_search ?? 0;
		expect(searches).toBeGreaterThan(0);
		// 每千次 10 美元，加在 token 的费用上
		expect(first.usage.cost_usd).toBeGreaterThan(searches * 0.01);
		const second = await reply(
			entry,
			[...messages, first, followUp("Thanks. Reply with OK.")],
			["web_search"],
		);
		expect(second.stop_reason).toBe("end_turn");
	});

	test("网页读取：调用和结果作为不透明块收下，带回下一次请求后照常完成", {
		tags: ["model"],
	}, async () => {
		const entry = builtin("claude-haiku-5-5");
		const messages = start(
			"Fetch https://example.com with the web fetch tool and tell me the page title.",
		);
		const first = await reply(entry, messages, ["web_fetch"]);
		expect(first.stop_reason).toBe("end_turn");
		expect(kinds(first)).toContain("server_tool_use");
		expect(kinds(first)).toContain("web_fetch_tool_result");
		expect(first.usage.server_tools?.web_fetch).toBeGreaterThan(0);
		const second = await reply(
			entry,
			[...messages, first, followUp("Thanks. Reply with OK.")],
			["web_fetch"],
		);
		expect(second.stop_reason).toBe("end_turn");
	});
});

describe("openai.responses", () => {
	test("联网搜索：web_search_call 作为不透明块收下，按次计费；带回下一次请求后照常完成", {
		tags: ["model"],
	}, async () => {
		const entry = builtin("gpt-5.6-sol");
		const messages = start(searchPrompt);
		const first = await reply(entry, messages, ["web_search"]);
		expect(first.stop_reason).toBe("end_turn");
		expect(kinds(first)).toContain("web_search_call");
		expect(first.usage.server_tools?.web_search).toBeGreaterThan(0);
		const second = await reply(
			entry,
			[...messages, first, followUp("Thanks. Reply with OK.")],
			["web_search"],
		);
		expect(second.stop_reason).toBe("end_turn");
	});
});
