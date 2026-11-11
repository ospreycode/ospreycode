// 测试用的本地 MCP server（2026-07-28，经 stdio）。用 node 直接运行这个文件，node 只去掉类型，
// 所以这里只用能直接擦除的 TypeScript 写法。设了 MCP_FIXTURE_LOG 时每次启动往那个文件里记一行；
// 设了 MCP_FIXTURE_START_DELAY_MS 时等这么久才开始回应，像第一次启动要下载包的 server。
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
	fromJsonSchema,
	inputRequired,
	inputResponse,
	McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

function text(value: string, isError = false) {
	return { content: [{ type: "text" as const, text: value }], isError };
}

const noArguments = fromJsonSchema<Record<string, never>>({ type: "object" });

function attempt(run: () => string) {
	try {
		return text(run());
	} catch (error) {
		return text((error as Error).message, true);
	}
}

const log = process.env.MCP_FIXTURE_LOG;
if (log !== undefined) appendFileSync(log, `start ${process.pid}\n`);

const startDelay = process.env.MCP_FIXTURE_START_DELAY_MS;
if (startDelay !== undefined) {
	await new Promise((resolve) => setTimeout(resolve, Number(startDelay)));
}

serveStdio(() => {
	const server = new McpServer(
		{ name: "host-fixture", version: "0.0.1" },
		{ capabilities: { tools: { listChanged: true } } },
	);
	server.registerTool(
		"echo",
		{
			description: "Returns text unchanged.",
			inputSchema: fromJsonSchema<{ text: string }>({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			}),
			// server 自己的标注不可信：标了只读也照样要批准
			annotations: { readOnlyHint: true },
		},
		async (args) => text(args.text),
	);
	server.registerTool(
		"env",
		{
			description: "Returns the environment of the server process.",
			inputSchema: noArguments,
		},
		async () => text(JSON.stringify(process.env)),
	);
	server.registerTool(
		"write",
		{
			description: "Writes a file.",
			inputSchema: fromJsonSchema<{ path: string }>({
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			}),
		},
		async (args) =>
			attempt(() => {
				writeFileSync(args.path, "written by the server\n");
				return "written";
			}),
	);
	server.registerTool(
		"read",
		{
			description: "Reads a file.",
			inputSchema: fromJsonSchema<{ path: string }>({
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			}),
		},
		async (args) => attempt(() => readFileSync(args.path, "utf8")),
	);
	server.registerTool(
		"fetch",
		{
			description: "Requests a URL and returns the HTTP status.",
			inputSchema: fromJsonSchema<{ url: string }>({
				type: "object",
				properties: { url: { type: "string" } },
				required: ["url"],
			}),
		},
		async (args) =>
			attempt(() =>
				execFileSync(
					"curl",
					[
						"-s",
						"-o",
						"/dev/null",
						"-w",
						"%{http_code}",
						"--max-time",
						"20",
						args.url,
					],
					{ encoding: "utf8" },
				),
			),
	);
	server.registerTool(
		"send_key",
		{
			description:
				"Sends an environment variable as a bearer token and returns the HTTP status.",
			inputSchema: fromJsonSchema<{ url: string; variable: string }>({
				type: "object",
				properties: { url: { type: "string" }, variable: { type: "string" } },
				required: ["url", "variable"],
			}),
		},
		async (args) =>
			attempt(() =>
				execFileSync(
					"curl",
					[
						"-s",
						"-o",
						"/dev/null",
						"-w",
						"%{http_code}",
						"--max-time",
						"20",
						// 沙盒里的 NO_PROXY 有 localhost：连本机的测试服务也经代理
						"--noproxy",
						"",
						"-H",
						`Authorization: Bearer ${process.env[args.variable]}`,
						args.url,
					],
					{ encoding: "utf8" },
				),
			),
	);
	server.registerTool(
		"wipe",
		{
			description: "Pretends to delete everything.",
			inputSchema: noArguments,
			annotations: { destructiveHint: true },
		},
		async () => text("wiped"),
	);
	server.registerTool(
		"big",
		{ description: "Returns a large result.", inputSchema: noArguments },
		async () => text(`${"0123456789".repeat(10_000)}END`),
	);
	server.registerTool(
		"ask",
		{ description: "Asks the user for a name.", inputSchema: noArguments },
		async (_args, ctx) => {
			const answer = inputResponse(ctx.mcpReq.inputResponses, "name");
			if (answer.kind !== "elicit") {
				return inputRequired({
					inputRequests: {
						name: inputRequired.elicit({
							message: "What is your name?",
							requestedSchema: {
								type: "object",
								properties: { name: { type: "string" } },
								required: ["name"],
							},
						}),
					},
				});
			}
			return text(
				JSON.stringify({ action: answer.action, content: answer.content }),
			);
		},
	);
	server.registerTool(
		"exit",
		{ description: "Exits without answering.", inputSchema: noArguments },
		async () => process.exit(0),
	);
	return server;
});
