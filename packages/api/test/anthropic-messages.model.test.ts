import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModels, type ModelEntry, streamModel } from "@ospreycode/api";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
	ReasoningEffort,
} from "@ospreycode/api/protocol";
import { expect, inject, test } from "vitest";

function haiku(): ModelEntry {
	const entry = builtinModels.find((m) => m.id === "claude-haiku-5-5");
	if (entry === undefined) throw new Error("内置清单里没有 claude-haiku-5-5");
	return {
		...entry,
		base_url: inject("modelBaseUrl"),
		max_output_tokens: 2_000,
	};
}

function apiKey(): string {
	return readFileSync(join(inject("modelKeysDir"), "anthropic"), "utf8").trim();
}

async function reply(
	entry: ModelEntry,
	messages: Message[],
	effort: ReasoningEffort,
) {
	const request: ModelRequest = {
		model: entry.id,
		reasoning_effort: effort,
		tool_choice: "auto",
		cache_retention: "none",
		messages,
		tools: [
			{
				name: "shell",
				description: "Run a shell command.",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
					additionalProperties: false,
				},
			},
		],
	};
	let message: AssistantMessage | undefined;
	for await (const event of streamModel(entry, request, {
		messageId: crypto.randomUUID(),
		apiKey: apiKey(),
		fetch,
		signal: AbortSignal.timeout(120_000),
	})) {
		if (event.type === "end") {
			expect(event.error).toBeUndefined();
			message = event.message;
		}
	}
	if (message === undefined) throw new Error("流没有以 end 结束");
	return message;
}

const start = (text: string): Message[] => [
	{
		role: "system",
		message_id: crypto.randomUUID(),
		content: [
			{
				type: "text",
				text: "Use the shell tool when asked. Keep replies short.",
			},
		],
	},
	{
		role: "user",
		message_id: crypto.randomUUID(),
		content: [{ type: "text", text }],
	},
];

function toolResult(message: AssistantMessage): Message {
	const call = message.content.find((block) => block.type === "tool_call");
	if (call?.type !== "tool_call") throw new Error("回复里没有工具调用");
	return {
		role: "tool_result",
		message_id: crypto.randomUUID(),
		call_id: call.call_id,
		content: [{ type: "text", text: "Exit code: 0\nhi\n" }],
		is_error: false,
	};
}

test("anthropic.messages：真实模型调用工具，拿到结果后结束", {
	tags: ["model"],
}, async () => {
	const entry = haiku();
	const messages = start("Run `echo hi` with the shell tool.");
	const first = await reply(entry, messages, "off");
	expect(first.stop_reason).toBe("tool_use");
	expect(first.usage.input).toBeGreaterThan(0);
	expect(first.usage.cost_usd).toBeGreaterThan(0);
	const call = first.content.find((block) => block.type === "tool_call");
	expect(call?.name).toBe("shell");
	expect(
		JSON.parse(call?.type === "tool_call" ? call.arguments : "{}"),
	).toMatchObject({
		command: expect.stringContaining("echo"),
	});

	const second = await reply(
		entry,
		[...messages, first, toolResult(first)],
		"off",
	);
	expect(second.stop_reason).toBe("end_turn");
	expect(second.usage.output).toBeGreaterThan(0);
});

test("anthropic.messages：开着推理和前缀校验调用工具，带签名的推理内容原样带回下一轮", {
	tags: ["model"],
}, async () => {
	const entry = haiku();
	const messages = start(
		"Think briefly about which command prints hi, then run it with the shell tool.",
	);
	const first = await reply(entry, messages, "low");
	expect(first.stop_reason).toBe("tool_use");
	expect(first.reasoning_effort_sent).toBe("low");
	const reasoning = first.content.find((block) => block.type === "reasoning");
	expect(reasoning).toMatchObject({
		type: "reasoning",
		redacted: false,
		opaque: expect.any(String),
		origin: { protocol: "anthropic.messages", model: "claude-haiku-5-5" },
	});
	const second = await reply(
		entry,
		[...messages, first, toolResult(first)],
		"low",
	);
	expect(second.stop_reason).toBe("end_turn");
});
