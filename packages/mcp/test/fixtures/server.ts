// 测试用的 MCP server，新旧两种协议版本都支持。HTTP 的测试在进程里引用 createFixtureServer；
// 直接用 node 运行这个文件时经 stdio 提供服务。node 运行时只去掉类型，所以这里只用能直接擦除的 TypeScript 写法。
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	fromJsonSchema,
	inputRequired,
	inputResponse,
	McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

/** 几次请求之间共用的状态：HTTP 上每个请求都新建一个 server 实例。 */
export interface FixtureState {
	/** wait 工具收到取消时完成。 */
	cancelled: PromiseWithResolvers<void>;
	/** resume 工具被调用时完成。 */
	resumed: PromiseWithResolvers<void>;
	/** add-tool 工具被调用过：工具列表里多一个 extra。 */
	extraTool: boolean;
	/** 工具列表变了，通知订阅的客户端。 */
	notifyToolsChanged: (server: McpServer) => void;
}

export function createFixtureState(
	notifyToolsChanged: (server: McpServer) => void,
): FixtureState {
	return {
		cancelled: Promise.withResolvers<void>(),
		resumed: Promise.withResolvers<void>(),
		extraTool: false,
		notifyToolsChanged,
	};
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

const noArguments = fromJsonSchema<Record<string, never>>({ type: "object" });

export function createFixtureServer(state: FixtureState): McpServer {
	const server = new McpServer(
		{ name: "fixture", version: "1.2.3" },
		{ capabilities: { tools: { listChanged: true } } },
	);

	server.registerTool(
		"echo",
		{
			title: "回显",
			description: "原样返回 text",
			inputSchema: fromJsonSchema<{ text: string }>({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (args) => text(args.text),
	);

	server.registerTool(
		"fail",
		{ description: "工具自己报错", inputSchema: noArguments },
		async () => ({ ...text("工具执行失败"), isError: true }),
	);

	server.registerTool(
		"sum",
		{
			description: "返回结构化的结果",
			inputSchema: fromJsonSchema<{ a: number; b: number }>({
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
				required: ["a", "b"],
			}),
			outputSchema: fromJsonSchema<{ sum: number }>({
				type: "object",
				properties: { sum: { type: "number" } },
				required: ["sum"],
			}),
		},
		async (args) => {
			const output = { sum: args.a + args.b };
			return { ...text(JSON.stringify(output)), structuredContent: output };
		},
	);

	server.registerTool(
		"media",
		{ description: "返回各种内容块", inputSchema: noArguments },
		async () => ({
			content: [
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
				{
					type: "resource_link",
					uri: "file:///notes.txt",
					name: "notes",
					description: "一份笔记",
					mimeType: "text/plain",
				},
				{
					type: "resource",
					resource: {
						uri: "file:///a.txt",
						mimeType: "text/plain",
						text: "内容",
					},
				},
				{
					type: "resource",
					resource: {
						uri: "file:///b.bin",
						mimeType: "application/octet-stream",
						blob: "YmxvYg==",
					},
				},
			],
		}),
	);

	server.registerTool(
		"wait",
		{
			description: "报一次进度表示已经开始，然后一直等到这次调用被取消",
			inputSchema: noArguments,
		},
		async (_args, ctx) => {
			const { signal } = ctx.mcpReq;
			const cancelled = new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			const progressToken = ctx.mcpReq._meta?.progressToken;
			if (progressToken !== undefined) {
				await ctx.mcpReq.notify({
					method: "notifications/progress",
					params: { progressToken, progress: 0, message: "开始等待" },
				});
			}
			await cancelled;
			state.cancelled.resolve();
			return text("已取消");
		},
	);

	server.registerTool(
		"cancellation-seen",
		{ description: "等到 wait 收到过取消才返回", inputSchema: noArguments },
		async () => {
			await state.cancelled.promise;
			return text("server 收到了取消");
		},
	);

	server.registerTool(
		"progress",
		{
			description: "报一次进度，等 resume 被调用后才返回",
			inputSchema: noArguments,
		},
		async (_args, ctx) => {
			const progressToken = ctx.mcpReq._meta?.progressToken;
			if (progressToken === undefined) return text("客户端没有要进度");
			await ctx.mcpReq.notify({
				method: "notifications/progress",
				params: { progressToken, progress: 1, total: 2, message: "第 1 步" },
			});
			// 结果紧跟着进度通知发出时，客户端可能先处理结果、丢掉进度：等客户端确认收到了再返回
			await state.resumed.promise;
			return text("完成");
		},
	);

	server.registerTool(
		"resume",
		{ description: "让 progress 工具返回", inputSchema: noArguments },
		async () => {
			state.resumed.resolve();
			return text("继续");
		},
	);

	server.registerTool(
		"ask",
		{ description: "向用户要一个名字", inputSchema: noArguments },
		async (_args, ctx) => {
			const answer = inputResponse(ctx.mcpReq.inputResponses, "name");
			if (answer.kind !== "elicit") {
				return inputRequired({
					inputRequests: {
						name: inputRequired.elicit({
							message: "你叫什么名字？",
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
		"add-tool",
		{ description: "让工具列表多一个 extra", inputSchema: noArguments },
		async () => {
			state.extraTool = true;
			state.notifyToolsChanged(server);
			return text("加上了");
		},
	);

	if (state.extraTool) registerExtraTool(server);
	return server;
}

export function registerExtraTool(server: McpServer): void {
	server.registerTool(
		"extra",
		{ description: "后来才有的工具", inputSchema: noArguments },
		async () => text("extra"),
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	// 探测协议版本用的进程 stderr 没人读，所以把"启动过一次"记在文件里
	const log = process.env.MCP_FIXTURE_LOG;
	if (log !== undefined) appendFileSync(log, "start\n");

	// stdio 上一个连接固定用一个实例：直接在它上面注册新工具，SDK 会发 list_changed
	const state = createFixtureState((server) => registerExtraTool(server));
	serveStdio(() => {
		const server = createFixtureServer(state);
		server.registerTool(
			"stderr",
			{ description: "往 stderr 写一行", inputSchema: noArguments },
			async () => {
				process.stderr.write("fixture：诊断信息\n");
				return text("写了");
			},
		);
		server.registerTool(
			"exit",
			{ description: "不回应，直接退出进程", inputSchema: noArguments },
			async () => process.exit(0),
		);
		server.registerTool(
			"pid",
			{ description: "返回这个进程的 pid", inputSchema: noArguments },
			async () => text(String(process.pid)),
		);
		return server;
	});
}
