import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelEntry, streamModel } from "@ospreycode/api";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
} from "@ospreycode/api/protocol";
import { expect, inject, test } from "vitest";

async function reply(entry: ModelEntry, apiKey: string, messages: Message[]) {
	const request: ModelRequest = {
		model: entry.id,
		reasoning_effort: "off",
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
		apiKey,
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

test("anthropic.messages：真实模型调用工具，拿到结果后结束", {
	tags: ["model"],
}, async () => {
	const entry: ModelEntry = {
		id: "claude-haiku-5-5",
		protocol: "anthropic.messages",
		service: "anthropic",
		base_url: inject("modelBaseUrl"),
		model: "claude-haiku-5-5",
		context_window: 200_000,
		max_output_tokens: 1_000,
	};
	const apiKey = readFileSync(
		join(inject("modelKeysDir"), "anthropic"),
		"utf8",
	).trim();
	const messages: Message[] = [
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
			content: [{ type: "text", text: "Run `echo hi` with the shell tool." }],
		},
	];

	const first = await reply(entry, apiKey, messages);
	expect(first.stop_reason).toBe("tool_use");
	expect(first.usage.input).toBeGreaterThan(0);
	const call = first.content.find((block) => block.type === "tool_call");
	expect(call?.name).toBe("shell");
	expect(
		JSON.parse(call?.type === "tool_call" ? call.arguments : "{}"),
	).toMatchObject({
		command: expect.stringContaining("echo"),
	});

	const second = await reply(entry, apiKey, [
		...messages,
		first,
		{
			role: "tool_result",
			message_id: crypto.randomUUID(),
			call_id: call?.type === "tool_call" ? call.call_id : "",
			content: [{ type: "text", text: "Exit code: 0\nhi\n" }],
			is_error: false,
		},
	]);
	expect(second.stop_reason).toBe("end_turn");
	expect(second.usage.output).toBeGreaterThan(0);
});
