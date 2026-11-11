// 只支持 2025-11-25 的 MCP server，手写 JSON-RPC：不认识 server/discover，要先 initialize 握手，
// 需要用户输入时主动向客户端发 elicitation/create。收到的每个方法名都记在 MCP_FIXTURE_LOG 指的文件里；
// 设了 MCP_FIXTURE_IGNORE_PROBE 就不回应 server/discover。
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface Message {
	id?: number | string;
	method?: string;
	params?: {
		name?: string;
		arguments?: { text?: string };
		capabilities?: { elicitation?: object };
	};
	result?: object;
}

const log = process.env.MCP_FIXTURE_LOG;
function record(line: string): void {
	if (log !== undefined) appendFileSync(log, `${line}\n`);
}

function send(message: object): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value: string, isError = false): object {
	return { content: [{ type: "text", text: value }], isError };
}

const noArguments = { type: "object" };
let clientElicits = false;
let extraTool = false;
/** 发出去的 elicitation/create 的 id，对应等着它的 tools/call 的 id。 */
const elicitations = new Map<string, number | string>();

function listTools(): object[] {
	const tools = [
		{
			name: "echo",
			description: "原样返回 text",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		},
		{ name: "ask", inputSchema: noArguments },
		{ name: "add-tool", inputSchema: noArguments },
	];
	if (extraTool) tools.push({ name: "extra", inputSchema: noArguments });
	return tools;
}

function callTool(id: number | string, params: Message["params"]): void {
	switch (params?.name) {
		case "echo":
			send({ jsonrpc: "2.0", id, result: text(params.arguments?.text ?? "") });
			return;
		case "ask": {
			if (!clientElicits) {
				send({
					jsonrpc: "2.0",
					id,
					result: text("客户端没有声明 elicitation", true),
				});
				return;
			}
			const elicitationId = `elicitation-${id}`;
			elicitations.set(elicitationId, id);
			send({
				jsonrpc: "2.0",
				id: elicitationId,
				method: "elicitation/create",
				params: {
					mode: "form",
					message: "你叫什么名字？",
					requestedSchema: {
						type: "object",
						properties: { name: { type: "string" } },
						required: ["name"],
					},
				},
			});
			return;
		}
		case "add-tool":
			extraTool = true;
			send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			send({ jsonrpc: "2.0", id, result: text("加上了") });
			return;
		default:
			send({
				jsonrpc: "2.0",
				id,
				error: { code: -32602, message: "Unknown tool" },
			});
	}
}

record("start");
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line) as Message;
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
	record(message.method);
	if (message.id === undefined) return;
	// 有些旧 server 对握手之前的请求不作任何回应
	if (
		message.method === "server/discover" &&
		process.env.MCP_FIXTURE_IGNORE_PROBE !== undefined
	) {
		return;
	}
	const { id } = message;
	switch (message.method) {
		case "initialize":
			clientElicits = message.params?.capabilities?.elicitation !== undefined;
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "legacy-fixture", version: "0.9.0" },
				},
			});
			return;
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools: listTools() } });
			return;
		case "tools/call":
			callTool(id, message.params);
			return;
		default:
			send({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "Method not found" },
			});
	}
});
