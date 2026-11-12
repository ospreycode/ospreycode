import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { afterEach, expect, test } from "vitest";
import { interactiveFixture } from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";

const fixture = interactiveFixture();
let server: Server | undefined;

afterEach(async () => {
	if (server === undefined) return;
	server.closeAllConnections();
	server.close();
	await once(server, "close");
	server = undefined;
});

function sse(events: readonly (readonly [string, object])[]): string {
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
}

const callId = "srvtoolu_014hJH82Qum7Td6UV8gDXThB";

/** Messages API 的一次流式回应：搜索一次，然后回答。 */
const searched = sse([
	[
		"message_start",
		{
			message: {
				model: "fake-model",
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
	],
	[
		"content_block_start",
		{
			index: 0,
			content_block: {
				type: "server_tool_use",
				id: callId,
				name: "web_search",
				input: {},
			},
		},
	],
	[
		"content_block_delta",
		{
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: '{"query": "nyc weather today"}',
			},
		},
	],
	["content_block_stop", { index: 0 }],
	[
		"content_block_start",
		{
			index: 1,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: callId,
				content: [
					{
						type: "web_search_result",
						title: "NYC weather",
						url: "https://weather.example/nyc",
						encrypted_content: "opaque",
						page_age: null,
					},
				],
			},
		},
	],
	["content_block_stop", { index: 1 }],
	[
		"content_block_start",
		{ index: 2, content_block: { type: "text", text: "" } },
	],
	[
		"content_block_delta",
		{ index: 2, delta: { type: "text_delta", text: "今天多云" } },
	],
	["content_block_stop", { index: 2 }],
	[
		"message_delta",
		{
			delta: { stop_reason: "end_turn" },
			usage: {
				output_tokens: 20,
				server_tool_use: { web_search_requests: 1 },
			},
		},
	],
	["message_stop", {}],
]);

/** 说 `anthropic.messages` 的模型服务：每次请求都回 `searched`。返回收到的请求体。 */
async function messagesServer(): Promise<{ port: number; bodies: string[] }> {
	const bodies: string[] = [];
	server = createServer((request, response) => {
		void (async () => {
			bodies.push(await text(request));
			if (request.url !== "/v1/messages") {
				response.writeHead(404).end();
				return;
			}
			response
				.writeHead(200, { "content-type": "text/event-stream" })
				.end(searched);
		})();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { port: (server.address() as AddressInfo).port, bodies };
}

test("打开了联网搜索：请求带着它的定义，回复结束时对话区列出搜索的关键词，费用里有搜索的次数", async () => {
	const { port, bodies } = await messagesServer();
	fixture.dirs.writeConfig(`
model = "fake"

[models.fake]
protocol = "anthropic.messages"
service = "fake"
base_url = "http://127.0.0.1:${port}/v1"
model = "fake-model"
context_window = 100000
max_output_tokens = 4000
server_tools = ["web_search"]

[models.fake.price]
input = 1
output = 5
cache_read = 0.1
cache_write = 1.25
server_tools = { web_search = 10 }

[server_tools.fake]
web_search = true
`);
	const { terminal } = await fixture.start();
	await terminal.type("纽约今天的天气");
	await terminal.press(key.enter);
	await terminal.waitFor("今天多云");
	await terminal.waitFor("web_search: nyc weather today");
	await terminal.waitFor("完成");

	expect(JSON.parse(bodies[0] as string).tools.at(-1)).toMatchObject({
		type: "web_search_20250305",
		name: "web_search",
	});
	// 10 个输入、20 个输出 token 只有 $0.0001，一次搜索 $0.01
	expect(terminal.text()).toContain("$0.01");
});
