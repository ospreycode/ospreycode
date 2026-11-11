// 测试用的本地 MCP server，手写 JSON-RPC（2025-11-25，经 stdio）：`echo` 原样返回文字，`ask` 用
// elicitation 向用户要一张表单再把答复返回，`fetch` 用 curl 访问一个地址、返回 HTTP 状态码。
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value, isError = false) {
	return { content: [{ type: "text", text: value }], isError };
}

const tools = [
	{
		name: "echo",
		description: "Return the text.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	{
		name: "ask",
		description: "Ask the user for a few values.",
		inputSchema: { type: "object" },
	},
	{
		name: "fetch",
		description: "Fetch a URL and return the HTTP status.",
		inputSchema: {
			type: "object",
			properties: { url: { type: "string" } },
			required: ["url"],
		},
	},
];

const form = {
	type: "object",
	properties: {
		name: { type: "string", title: "名字", description: "怎么称呼你" },
		level: {
			type: "string",
			title: "级别",
			oneOf: [
				{ const: "low", title: "低" },
				{ const: "high", title: "高" },
			],
		},
		count: { type: "integer", title: "数量", minimum: 1, maximum: 5 },
		agree: { type: "boolean", title: "同意" },
	},
	required: ["name", "level"],
};

/** 发出去的 elicitation/create 的 id，对应等着它的 tools/call 的 id。 */
const elicitations = new Map();

function callTool(id, params) {
	switch (params.name) {
		case "echo":
			send({ jsonrpc: "2.0", id, result: text(params.arguments.text) });
			return;
		case "ask": {
			const elicitationId = `elicitation-${id}`;
			elicitations.set(elicitationId, id);
			send({
				jsonrpc: "2.0",
				id: elicitationId,
				method: "elicitation/create",
				params: {
					mode: "form",
					message: "部署之前要几项信息",
					requestedSchema: form,
				},
			});
			return;
		}
		case "fetch": {
			let status;
			try {
				status = execFileSync(
					"curl",
					[
						"-s",
						"-o",
						"/dev/null",
						"-w",
						"%{http_code}",
						"--max-time",
						"10",
						params.arguments.url,
					],
					{ encoding: "utf8" },
				);
			} catch (error) {
				status = String(error.stdout);
			}
			send({ jsonrpc: "2.0", id, result: text(`status ${status}`) });
			return;
		}
		default:
			send({
				jsonrpc: "2.0",
				id,
				error: { code: -32602, message: "Unknown tool" },
			});
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === undefined) {
		// 客户端对 elicitation/create 的答复
		const callId = elicitations.get(String(message.id));
		if (callId !== undefined) {
			send({
				jsonrpc: "2.0",
				id: callId,
				result: text(JSON.stringify(message.result)),
			});
		}
		return;
	}
	if (message.id === undefined) return;
	const { id } = message;
	switch (message.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "cli-fixture", version: "1.0.0" },
				},
			});
			return;
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools } });
			return;
		case "tools/call":
			callTool(id, message.params);
			return;
		case "ping":
			send({ jsonrpc: "2.0", id, result: {} });
			return;
		default:
			send({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "Method not found" },
			});
	}
});
