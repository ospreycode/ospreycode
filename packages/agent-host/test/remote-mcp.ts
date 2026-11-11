import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import {
	createMcpHandler,
	fromJsonSchema,
	McpServer,
} from "@modelcontextprotocol/server";
import type { CredentialStore } from "@ospreycode/agent-host";
import { onTestFinished } from "vitest";

/** 测试里远程 MCP server 对外的地址：`mcp.json` 只接受 https，请求由 `fetch` 转到本机的端口上。 */
export const publicOrigin = "https://mcp.test";

function json(payload: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(payload), {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

/** 一个要求令牌的远程 MCP server，自己兼做 OAuth 授权服务器。测试结束时关闭。 */
export interface RemoteMcp {
	/** 把发往 `publicOrigin` 的请求转到本机的 `fetch`，交给 `createHost`。 */
	fetch: typeof globalThis.fetch;
	/** 现在有效的令牌：静态令牌写在这里，OAuth 发的也加进来；删掉就是作废。 */
	validTokens: Set<string>;
	/** `/mcp` 和 `/other` 收到的请求带的 Authorization 头，按到达顺序。 */
	presented: (string | null)[];
	/** `/authorize` 收到的 `client_id`。 */
	clientIds: string[];
	/** 扮演浏览器和用户：打开授权地址，授权服务器直接重定向回环回地址上的回调。 */
	browse(url: string): Promise<void>;
}

/**
 * 起一个受保护的 MCP server：`/mcp` 和 `/other` 是同一个 server 的两个地址，没有有效令牌的请求
 * 得到 401，并指向自己的授权服务器元数据。
 */
export async function serveRemoteMcp(): Promise<RemoteMcp> {
	const validTokens = new Set<string>();
	const presented: (string | null)[] = [];
	const clientIds: string[] = [];
	const codes = new Map<
		string,
		{ clientId: string; redirectUri: string; challenge: string }
	>();
	let serial = 0;

	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: "remote-fixture", version: "0.0.1" });
		server.registerTool(
			"whoami",
			{
				description: "Says hello.",
				inputSchema: fromJsonSchema<Record<string, never>>({ type: "object" }),
			},
			async () => ({ content: [{ type: "text" as const, text: "hello" }] }),
		);
		return server;
	});
	onTestFinished(() => handler.close());

	const handle = async (request: Request, body: string): Promise<Response> => {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (
			route === "GET /.well-known/oauth-protected-resource/mcp" ||
			route === "GET /.well-known/oauth-protected-resource/other"
		) {
			return json({
				resource: `${publicOrigin}/${url.pathname.split("/").at(-1)}`,
				authorization_servers: [publicOrigin],
			});
		}
		if (route === "GET /.well-known/oauth-authorization-server") {
			return json({
				issuer: publicOrigin,
				authorization_endpoint: `${publicOrigin}/authorize`,
				token_endpoint: `${publicOrigin}/token`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				client_id_metadata_document_supported: true,
				authorization_response_iss_parameter_supported: true,
			});
		}
		if (route === "GET /authorize") {
			const params = url.searchParams;
			const redirectUri = params.get("redirect_uri");
			const clientId = params.get("client_id");
			const challenge = params.get("code_challenge");
			if (redirectUri === null || clientId === null || challenge === null) {
				return new Response("invalid authorization request", { status: 400 });
			}
			clientIds.push(clientId);
			serial += 1;
			const code = `code-${serial}`;
			codes.set(code, { clientId, redirectUri, challenge });
			const callback = new URL(redirectUri);
			callback.searchParams.set("code", code);
			callback.searchParams.set("state", params.get("state") ?? "");
			callback.searchParams.set("iss", publicOrigin);
			return new Response(null, {
				status: 302,
				headers: { location: callback.href },
			});
		}
		if (route === "POST /token") {
			const params = new URLSearchParams(body);
			const issued = codes.get(params.get("code") ?? "");
			codes.delete(params.get("code") ?? "");
			const challenge = createHash("sha256")
				.update(params.get("code_verifier") ?? "")
				.digest("base64url");
			if (
				params.get("grant_type") !== "authorization_code" ||
				issued === undefined ||
				issued.clientId !== params.get("client_id") ||
				issued.redirectUri !== params.get("redirect_uri") ||
				issued.challenge !== challenge
			) {
				return json({ error: "invalid_grant" }, { status: 400 });
			}
			serial += 1;
			const accessToken = `oauth-access-${serial}`;
			validTokens.add(accessToken);
			return json({
				access_token: accessToken,
				token_type: "Bearer",
				expires_in: 3600,
			});
		}
		if (url.pathname === "/mcp" || url.pathname === "/other") {
			const authorization = request.headers.get("authorization");
			presented.push(authorization);
			if (!validTokens.has((authorization ?? "").replace(/^Bearer /, ""))) {
				return new Response(null, {
					status: 401,
					headers: {
						"www-authenticate": `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource${url.pathname}"`,
					},
				});
			}
			return handler.fetch(request);
		}
		return new Response(null, { status: 404 });
	};

	const server = createServer(async (incoming, outgoing) => {
		const body = await text(incoming);
		const method = incoming.method ?? "GET";
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			for (const item of [value].flat()) {
				if (item !== undefined) headers.append(name, item);
			}
		}
		const response = await handle(
			new Request(
				new URL(incoming.url ?? "/", `http://${headers.get("host")}`),
				{
					method,
					headers,
					body: method === "GET" || method === "HEAD" ? undefined : body,
				},
			),
			body,
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		if (response.body !== null) {
			const reader = response.body.getReader();
			outgoing.on("close", () => void reader.cancel());
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
	const local = `http://127.0.0.1:${port}`;

	const routed: typeof globalThis.fetch = (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith(`${publicOrigin}/`)) {
			throw new Error(`测试里不该访问 ${url}`);
		}
		const target = local + url.slice(publicOrigin.length);
		return fetch(
			input instanceof Request ? new Request(target, input) : target,
			init,
		);
	};

	return {
		fetch: routed,
		validTokens,
		presented,
		clientIds,
		async browse(url) {
			const response = await routed(url, { redirect: "manual" });
			const callback = response.headers.get("location");
			if (callback === null) {
				throw new Error(`授权服务器没有重定向：${response.status}`);
			}
			await fetch(callback);
		},
	};
}

/** 存在内存里的系统凭据库。 */
export function memoryCredentialStore(): CredentialStore & {
	entries: Map<string, string>;
} {
	const entries = new Map<string, string>();
	return {
		entries,
		get: async (id) => entries.get(id),
		set: async (id, value) => {
			entries.set(id, value);
		},
		delete: async (id) => entries.delete(id),
	};
}
