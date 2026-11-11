import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { onTestFinished } from "vitest";
import {
	createFixtureServer,
	createFixtureState,
	type FixtureState,
} from "./fixtures/server.js";

/** 测试用的 HTTP server 收到的一个请求。 */
export interface ReceivedRequest {
	method: string;
	path: string;
	headers: Headers;
	body: string;
	/** 请求体是 JSON-RPC 请求时它的方法名。 */
	rpcMethod: string | undefined;
}

/** 在 `127.0.0.1` 的空闲端口上运行的 HTTP server，测试结束时关闭。 */
export interface TestHttpServer {
	/** 形如 `http://127.0.0.1:端口`。 */
	origin: string;
	/** 按到达顺序记下的请求。 */
	requests: ReceivedRequest[];
}

function headersOf(incoming: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		for (const item of [value].flat()) {
			if (item !== undefined) headers.append(name, item);
		}
	}
	return headers;
}

function rpcMethodOf(body: string): string | undefined {
	if (!body.startsWith("{")) return undefined;
	const message = JSON.parse(body) as { method?: string };
	return message.method;
}

/**
 * 起一个 HTTP server，每个请求交给 `handle`（Web 标准的 Request 和 Response）。
 * 客户端中途断开时 `request.signal` 中止。
 */
export async function serveHttp(
	handle: (
		request: Request,
		received: ReceivedRequest,
	) => Response | Promise<Response>,
): Promise<TestHttpServer> {
	const requests: ReceivedRequest[] = [];
	const server = createServer(async (incoming, outgoing) => {
		const body = await text(incoming);
		const method = incoming.method ?? "GET";
		const headers = headersOf(incoming);
		const disconnected = new AbortController();
		outgoing.on("close", () => {
			if (!outgoing.writableFinished) disconnected.abort();
		});
		const received: ReceivedRequest = {
			method,
			path: incoming.url ?? "/",
			headers,
			body,
			rpcMethod: rpcMethodOf(body),
		};
		requests.push(received);
		const response = await handle(
			new Request(new URL(received.path, `http://${headers.get("host")}`), {
				method,
				headers,
				body: method === "GET" || method === "HEAD" ? undefined : body,
				signal: disconnected.signal,
			}),
			received,
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		if (response.body !== null) {
			const reader = response.body.getReader();
			disconnected.signal.addEventListener("abort", () => {
				void reader.cancel();
			});
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				outgoing.write(chunk.value);
			}
		}
		outgoing.end();
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	onTestFinished(async () => {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		server.closeAllConnections();
		await closed.promise;
	});
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, requests };
}

/** fixture 里那个 MCP server 的 HTTP 处理函数，新旧协议都支持。 */
export function fixtureMcpHandler(): {
	state: FixtureState;
	fetch: (request: Request) => Promise<Response>;
} {
	const state = createFixtureState(() => handler.notify.toolsChanged());
	const handler = createMcpHandler(() => createFixtureServer(state));
	onTestFinished(() => handler.close());
	return { state, fetch: handler.fetch };
}

/** 把 fixture 里的 MCP server 挂在 `/mcp` 上。 */
export async function serveFixtureMcp(): Promise<
	TestHttpServer & { url: string; state: FixtureState }
> {
	const mcp = fixtureMcpHandler();
	const server = await serveHttp((request) => mcp.fetch(request));
	return { ...server, url: `${server.origin}/mcp`, state: mcp.state };
}
