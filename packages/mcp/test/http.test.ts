import {
	connectHttp,
	type HttpTarget,
	type McpConnection,
	type McpConnectOptions,
	type ProtocolVerdict,
} from "@ospreycode/mcp";
import { expect, test } from "vitest";
import { client, closeAfterTest, rejection } from "./helpers.js";
import {
	type ReceivedRequest,
	serveFixtureMcp,
	serveHttp,
} from "./http-server.js";

async function connect(
	target: HttpTarget,
	options: Omit<McpConnectOptions, "client"> = {},
): Promise<McpConnection> {
	return closeAfterTest(await connectHttp(target, { client, ...options }));
}

function json(payload: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(payload), {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

/** 只支持 2025-11-25、要先握手拿到会话 ID 的 HTTP server，像现有的多数远程 server。 */
function legacyOnlyHandler(request: Request, received: ReceivedRequest) {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const message = JSON.parse(received.body) as {
		id?: number;
		method: string;
		params?: { arguments?: { text?: string } };
	};
	const { id } = message;
	if (message.method === "initialize") {
		return json(
			{
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "legacy-http", version: "0.9.0" },
				},
			},
			{ headers: { "mcp-session-id": "session-1" } },
		);
	}
	if (request.headers.get("mcp-session-id") !== "session-1") {
		return json(
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32000, message: "Bad Request: Server not initialized" },
			},
			{ status: 400 },
		);
	}
	if (id === undefined) return new Response(null, { status: 202 });
	if (message.method === "tools/list") {
		return json({
			jsonrpc: "2.0",
			id,
			result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
		});
	}
	if (message.method === "tools/call") {
		return json({
			jsonrpc: "2.0",
			id,
			result: {
				content: [{ type: "text", text: message.params?.arguments?.text }],
			},
		});
	}
	return json({
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: "Method not found" },
	});
}

test("连接、列出工具、调用工具", async () => {
	const server = await serveFixtureMcp();

	const connection = await connect({ url: server.url });

	expect(connection.server).toEqual({ name: "fixture", version: "1.2.3" });
	expect(connection.protocolVersion).toBe("2026-07-28");
	expect(connection.pid).toBeUndefined();
	const tools = await connection.listTools();
	expect(tools.map((tool) => tool.name)).toContain("echo");
	expect(tools.find((tool) => tool.name === "echo")?.annotations).toEqual({
		readOnlyHint: true,
		idempotentHint: true,
	});
	expect(
		await connection.callTool({ name: "echo", arguments: { text: "你好" } }),
	).toEqual({ content: [{ type: "text", text: "你好" }], isError: false });
});

test("工具自己报的错在 isError 里，结构化的结果原样返回", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({ url: server.url });

	const failed = await connection.callTool({ name: "fail", arguments: {} });
	const sum = await connection.callTool({
		name: "sum",
		arguments: { a: 1, b: 2 },
	});

	expect(failed).toEqual({
		content: [{ type: "text", text: "工具执行失败" }],
		isError: true,
	});
	expect(sum.structuredContent).toEqual({ sum: 3 });
});

test("进度通知交给 onProgress", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({ url: server.url });
	const seen: unknown[] = [];
	let resumed: Promise<unknown> | undefined;

	const result = await connection.callTool(
		{ name: "progress", arguments: {} },
		{
			onProgress: (progress) => {
				seen.push(progress);
				// 工具报完进度后等着这个调用，保证结果在进度之后才来
				resumed = connection.callTool({ name: "resume", arguments: {} });
			},
		},
	);
	await resumed;

	expect(result.content).toEqual([{ type: "text", text: "完成" }]);
	expect(seen).toEqual([{ progress: 1, total: 2, message: "第 1 步" }]);
});

test("中止信号取消调用：关闭这个请求的响应流，server 那边的调用随之取消", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({ url: server.url });
	const controller = new AbortController();

	await rejection(
		connection.callTool(
			{ name: "wait", arguments: {} },
			{ signal: controller.signal, onProgress: () => controller.abort() },
		),
		"cancelled",
	);

	// 取消靠的是断开连接，没有发 notifications/cancelled
	const seen = await connection.callTool({
		name: "cancellation-seen",
		arguments: {},
	});
	expect(seen.content).toEqual([{ type: "text", text: "server 收到了取消" }]);
	expect(server.requests.map((request) => request.rpcMethod)).not.toContain(
		"notifications/cancelled",
	);
});

test("过了时限以 timeout 失败", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({ url: server.url });

	await rejection(
		connection.callTool({ name: "wait", arguments: {} }, { timeoutMs: 50 }),
		"timeout",
	);
});

test("关闭之后的调用以 closed 失败", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({ url: server.url });

	await connection.close();

	await rejection(connection.listTools(), "closed");
	await rejection(
		connection.callTool({ name: "echo", arguments: { text: "x" } }),
		"closed",
	);
});

test("server 的工具列表变了就调用 onToolsChanged", async () => {
	const server = await serveFixtureMcp();
	const changed = Promise.withResolvers<void>();
	const connection = await connect(
		{ url: server.url },
		{ onToolsChanged: () => changed.resolve() },
	);

	await connection.callTool({ name: "add-tool", arguments: {} });
	await changed.promise;

	const tools = await connection.listTools();
	expect(tools.map((tool) => tool.name)).toContain("extra");
});

test("elicitation 的答复随重发的请求交给 server", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect(
		{ url: server.url },
		{ elicit: async () => ({ action: "accept", content: { name: "小明" } }) },
	);

	const result = await connection.callTool({ name: "ask", arguments: {} });

	expect(result.content).toEqual([
		{
			type: "text",
			text: JSON.stringify({ action: "accept", content: { name: "小明" } }),
		},
	]);
});

test("探测得到 modern 的结果；带着它重连就不再发 server/discover", async () => {
	const server = await serveFixtureMcp();
	const first = await connect({ url: server.url });
	expect(first.verdict).toMatchObject({ era: "modern" });
	expect(server.requests.map((request) => request.rpcMethod)).toEqual([
		"server/discover",
	]);
	const prior = JSON.parse(JSON.stringify(first.verdict)) as ProtocolVerdict;
	server.requests.length = 0;

	const connection = await connect({ url: server.url }, { prior });
	await connection.callTool({ name: "echo", arguments: { text: "x" } });

	expect(connection.verdict).toEqual(prior);
	expect(connection.protocolVersion).toBe("2026-07-28");
	expect(server.requests.map((request) => request.rpcMethod)).toEqual([
		"tools/call",
	]);
});

test("只支持旧协议的 server：握手得到 legacy 的结果；带着它重连就不再探测", async () => {
	const server = await serveHttp(legacyOnlyHandler);
	const url = `${server.origin}/mcp`;

	const first = await connect({ url });

	expect(first.verdict).toEqual({ era: "legacy" });
	expect(first.protocolVersion).toBe("2025-11-25");
	expect(first.server).toEqual({ name: "legacy-http", version: "0.9.0" });
	expect(
		await first.callTool({ name: "echo", arguments: { text: "你好" } }),
	).toEqual({ content: [{ type: "text", text: "你好" }], isError: false });
	expect(server.requests[0]?.rpcMethod).toBe("server/discover");
	server.requests.length = 0;

	const connection = await connect({ url }, { prior: { era: "legacy" } });
	await connection.listTools();

	const methods = server.requests.map((request) => request.rpcMethod);
	expect(methods).not.toContain("server/discover");
	expect(methods[0]).toBe("initialize");
});

test("远程 server 不回应探测：过了 probeTimeoutMs 连接以 timeout 失败，不改按旧协议握手", async () => {
	const server = await serveHttp((request, received) => {
		if (received.rpcMethod !== "server/discover") {
			return legacyOnlyHandler(request, received);
		}
		// 一直不回应，到客户端自己断开为止
		const response = Promise.withResolvers<Response>();
		request.signal.addEventListener("abort", () =>
			response.resolve(new Response(null, { status: 204 })),
		);
		return response.promise;
	});
	const started = performance.now();

	await rejection(
		connectHttp(
			{ url: `${server.origin}/mcp` },
			{ client, probeTimeoutMs: 100 },
		),
		"timeout",
	);

	// 不给 probeTimeoutMs 时要等 5 秒
	expect(performance.now() - started).toBeLessThan(4000);
	expect(server.requests.map((request) => request.rpcMethod)).toEqual([
		"server/discover",
	]);
});

test("配置的请求头每个请求都带；和客户端生成的头同名时用客户端的", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({
		url: server.url,
		headers: {
			"X-Api-Key": "configured-key",
			"Content-Type": "text/plain",
			"MCP-Protocol-Version": "1999-01-01",
			"Mcp-Method": "configured",
		},
	});

	await connection.callTool({ name: "echo", arguments: { text: "x" } });

	expect(server.requests.map((request) => request.rpcMethod)).toEqual([
		"server/discover",
		"tools/call",
	]);
	for (const request of server.requests) {
		expect(request.headers.get("x-api-key")).toBe("configured-key");
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
		expect(request.headers.get("mcp-method")).toBe(request.rpcMethod);
	}
});

test("静态令牌每次请求前重新取，作为 Authorization: Bearer 发出", async () => {
	const server = await serveFixtureMcp();
	let token: string | undefined = "first-token";
	const connection = await connect({
		url: server.url,
		// 配置里同名的头让位给令牌
		headers: { Authorization: "Basic configured" },
		auth: { kind: "bearer", token: async () => token },
	});
	await connection.listTools();
	token = "second-token";
	await connection.listTools();
	token = undefined;
	await connection.listTools();

	expect(
		server.requests.map((request) => request.headers.get("authorization")),
	).toEqual([
		"Bearer first-token",
		"Bearer first-token",
		"Bearer second-token",
		// 取不到令牌时客户端不生成这个头，发出去的是配置的
		"Basic configured",
	]);
});

test("没有配置授权时不带 Authorization", async () => {
	const server = await serveFixtureMcp();
	const connection = await connect({ url: server.url });

	await connection.listTools();

	for (const request of server.requests) {
		expect(request.headers.has("authorization")).toBe(false);
	}
});

test("server 要求授权（401）而没有配置授权时，连接以 unauthorized 失败", async () => {
	const server = await serveHttp(
		() =>
			new Response(null, {
				status: 401,
				headers: { "www-authenticate": "Bearer" },
			}),
	);

	await rejection(
		connectHttp({ url: `${server.origin}/mcp` }, { client }),
		"unauthorized",
	);
});

test("静态令牌被 server 拒绝（401）时，调用以 unauthorized 失败", async () => {
	const mcp = await serveFixtureMcp();
	const server = await serveHttp(async (request, received) =>
		received.rpcMethod === "tools/call"
			? new Response(null, {
					status: 401,
					headers: { "www-authenticate": "Bearer" },
				})
			: await fetch(mcp.url, {
					method: request.method,
					headers: request.headers,
					body: received.body,
				}),
	);
	const connection = await connect({
		url: `${server.origin}/mcp`,
		auth: { kind: "bearer", token: async () => "revoked-token" },
	});

	const error = await rejection(
		connection.callTool({ name: "echo", arguments: { text: "x" } }),
		"unauthorized",
	);

	expect(error.message).not.toContain("revoked-token");
});

test("403 insufficient_scope 以 insufficient_scope 失败，带着 server 要求的 scope", async () => {
	const mcp = await serveFixtureMcp();
	const server = await serveHttp(async (request, received) =>
		received.rpcMethod === "tools/call"
			? new Response(null, {
					status: 403,
					headers: {
						"www-authenticate":
							'Bearer error="insufficient_scope", scope="files:write"',
					},
				})
			: await fetch(mcp.url, {
					method: request.method,
					headers: request.headers,
					body: received.body,
				}),
	);
	const connection = await connect({
		url: `${server.origin}/mcp`,
		auth: { kind: "bearer", token: async () => "narrow-token" },
	});

	const error = await rejection(
		connection.callTool({ name: "echo", arguments: { text: "x" } }),
		"insufficient_scope",
	);

	expect(error.requiredScope).toBe("files:write");
});

test("同源的重定向会跟过去，配置的头和令牌照样带着", async () => {
	const mcp = await serveFixtureMcp();
	const server = await serveHttp(async (request, received) =>
		received.path === "/old"
			? new Response(null, { status: 307, headers: { location: "/mcp" } })
			: await fetch(mcp.url, {
					method: request.method,
					headers: request.headers,
					body: received.body,
				}),
	);
	const connection = await connect({
		url: `${server.origin}/old`,
		headers: { "X-Api-Key": "configured-key" },
		auth: { kind: "bearer", token: async () => "static-token" },
	});

	await connection.listTools();

	const redirected = server.requests.filter(
		(request) => request.path === "/mcp",
	);
	expect(redirected.length).toBeGreaterThanOrEqual(2);
	for (const request of redirected) {
		expect(request.headers.get("x-api-key")).toBe("configured-key");
		expect(request.headers.get("authorization")).toBe("Bearer static-token");
	}
});

test("server 把请求重定向到别的源时不跟过去：配置的头和令牌到不了那里", async () => {
	const elsewhere = await serveFixtureMcp();
	const server = await serveHttp(
		() =>
			new Response(null, { status: 307, headers: { location: elsewhere.url } }),
	);

	await rejection(
		connectHttp(
			{
				url: `${server.origin}/mcp`,
				headers: { "X-Api-Key": "configured-key" },
				auth: { kind: "bearer", token: async () => "static-token" },
			},
			{ client },
		),
		"transport",
	);

	expect(server.requests.length).toBeGreaterThan(0);
	expect(elsewhere.requests).toEqual([]);
});
