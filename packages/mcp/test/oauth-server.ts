import { createHash } from "node:crypto";
import type { OAuthStore } from "@ospreycode/mcp";
import {
	fixtureMcpHandler,
	type ReceivedRequest,
	serveHttp,
	type TestHttpServer,
} from "./http-server.js";

function json(payload: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(payload), {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

function oauthError(error: string, status = 400): Response {
	return json({ error }, { status });
}

/** 测试里可以随时改的授权服务器行为。 */
export interface AuthorizationServerBehavior {
	/** 元数据里声明支持 Client ID Metadata Documents。 */
	clientIdMetadataDocuments: boolean;
	/** 元数据里声明回调带 `iss`（RFC 9207）。 */
	issParameterSupported: boolean;
	/** 回调里带的 `iss`；`undefined` 表示不带。默认是授权服务器自己的 issuer。 */
	callbackIss: string | undefined;
	/** 回调里带的 `state`；`undefined` 表示原样带回客户端发来的。 */
	callbackState: string | undefined;
	/** 用户拒绝授权：回调里带 `error=access_denied`，不带授权码。 */
	denyAuthorization: boolean;
	/** 发令牌时附带 refresh token。 */
	issueRefreshTokens: boolean;
}

/** 假的授权服务器。 */
export interface FakeAuthorizationServer extends TestHttpServer {
	issuer: string;
	behavior: AuthorizationServerBehavior;
	/** 现在有效的 access token；从这里删掉就是让它过期。 */
	validAccessTokens: Set<string>;
	/** `/register` 收到的客户端元数据。 */
	registrations: Record<string, unknown>[];
	/** `/authorize` 收到的参数。 */
	authorizations: URLSearchParams[];
	/** `/token` 收到的请求。 */
	tokenRequests: { params: URLSearchParams; authorization: string | null }[];
}

interface IssuedCode {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	scope: string | null;
}

/** 起一个假的授权服务器：元数据、动态注册、授权端点（直接重定向回去）、令牌端点。 */
export async function serveAuthorizationServer(
	name: string,
): Promise<FakeAuthorizationServer> {
	const behavior: AuthorizationServerBehavior = {
		clientIdMetadataDocuments: true,
		issParameterSupported: true,
		callbackIss: undefined,
		callbackState: undefined,
		denyAuthorization: false,
		issueRefreshTokens: true,
	};
	const validAccessTokens = new Set<string>();
	const registrations: Record<string, unknown>[] = [];
	const authorizations: URLSearchParams[] = [];
	const tokenRequests: FakeAuthorizationServer["tokenRequests"] = [];
	const codes = new Map<string, IssuedCode>();
	/** 有效的 refresh token 和它所属的客户端；用过一次就作废。 */
	const refreshTokens = new Map<string, { clientId: string }>();
	let serial = 0;

	function issueTokens(clientId: string, scope: string | null): Response {
		serial += 1;
		const accessToken = `${name}-access-${serial}`;
		validAccessTokens.add(accessToken);
		const tokens: Record<string, unknown> = {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 3600,
		};
		if (scope !== null) tokens.scope = scope;
		if (behavior.issueRefreshTokens) {
			const refreshToken = `${name}-refresh-${serial}`;
			refreshTokens.set(refreshToken, { clientId });
			tokens.refresh_token = refreshToken;
		}
		return json(tokens);
	}

	function clientOf(
		params: URLSearchParams,
		authorization: string | null,
	): string | null {
		if (authorization?.startsWith("Basic ")) {
			const [id] = atob(authorization.slice("Basic ".length)).split(":");
			return id ?? null;
		}
		return params.get("client_id");
	}

	function token(received: ReceivedRequest): Response {
		const params = new URLSearchParams(received.body);
		const authorization = received.headers.get("authorization");
		tokenRequests.push({ params, authorization });
		const clientId = clientOf(params, authorization);
		if (clientId === null) return oauthError("invalid_client", 401);

		if (params.get("grant_type") === "authorization_code") {
			const code = params.get("code") ?? "";
			const issued = codes.get(code);
			codes.delete(code);
			const challenge = createHash("sha256")
				.update(params.get("code_verifier") ?? "")
				.digest("base64url");
			if (
				issued === undefined ||
				issued.clientId !== clientId ||
				issued.redirectUri !== params.get("redirect_uri") ||
				issued.codeChallenge !== challenge
			) {
				return oauthError("invalid_grant");
			}
			return issueTokens(clientId, issued.scope);
		}
		if (params.get("grant_type") === "refresh_token") {
			const refreshToken = params.get("refresh_token") ?? "";
			const owner = refreshTokens.get(refreshToken);
			refreshTokens.delete(refreshToken);
			if (owner?.clientId !== clientId) return oauthError("invalid_grant");
			return issueTokens(clientId, null);
		}
		return oauthError("unsupported_grant_type");
	}

	function authorize(url: URL): Response {
		const params = url.searchParams;
		authorizations.push(params);
		const redirectUri = params.get("redirect_uri");
		const clientId = params.get("client_id");
		const codeChallenge = params.get("code_challenge");
		if (
			redirectUri === null ||
			clientId === null ||
			codeChallenge === null ||
			params.get("response_type") !== "code" ||
			params.get("code_challenge_method") !== "S256"
		) {
			return new Response("invalid authorization request", { status: 400 });
		}
		const callback = new URL(redirectUri);
		if (behavior.denyAuthorization) {
			callback.searchParams.set("error", "access_denied");
		} else {
			serial += 1;
			const code = `${name}-code-${serial}`;
			codes.set(code, {
				clientId,
				redirectUri,
				codeChallenge,
				scope: params.get("scope"),
			});
			callback.searchParams.set("code", code);
		}
		const state = behavior.callbackState ?? params.get("state");
		if (state !== null) callback.searchParams.set("state", state);
		if (behavior.callbackIss !== undefined) {
			callback.searchParams.set("iss", behavior.callbackIss);
		}
		return new Response(null, {
			status: 302,
			headers: { location: callback.href },
		});
	}

	const server = await serveHttp((request, received) => {
		const url = new URL(request.url);
		const issuer = url.origin;
		switch (`${request.method} ${url.pathname}`) {
			case "GET /.well-known/oauth-authorization-server":
				return json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					registration_endpoint: `${issuer}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: [
						"none",
						"client_secret_basic",
					],
					client_id_metadata_document_supported:
						behavior.clientIdMetadataDocuments,
					authorization_response_iss_parameter_supported:
						behavior.issParameterSupported,
				});
			case "POST /register": {
				const metadata = JSON.parse(received.body) as Record<string, unknown>;
				registrations.push(metadata);
				return json(
					{ ...metadata, client_id: `${name}-client-${registrations.length}` },
					{ status: 201 },
				);
			}
			case "GET /authorize":
				return authorize(url);
			case "POST /token":
				return token(received);
			default:
				return new Response(null, { status: 404 });
		}
	});
	behavior.callbackIss = server.origin;
	return {
		...server,
		issuer: server.origin,
		behavior,
		validAccessTokens,
		registrations,
		authorizations,
		tokenRequests,
	};
}

/** 要求 OAuth 令牌的 MCP server。 */
export interface ProtectedMcpServer extends TestHttpServer {
	/** MCP 的地址。 */
	url: string;
	/** 现在由哪个授权服务器发令牌；可以换。 */
	authorizationServer: FakeAuthorizationServer;
	/** 给出时，`tools/call` 以 403 insufficient_scope 拒绝，要求这个 scope。 */
	requiredScope: string | undefined;
	/** `/mcp` 收到的请求带的 Authorization 头，按到达顺序。 */
	presentedAuthorizations(): (string | null)[];
}

/** 起一个受保护的 MCP server：没有有效令牌的请求得到 401，令牌由 `authorizationServer` 发。 */
export async function serveProtectedMcp(
	authorizationServer: FakeAuthorizationServer,
): Promise<ProtectedMcpServer> {
	const mcp = fixtureMcpHandler();
	const metadataPath = "/.well-known/oauth-protected-resource/mcp";
	const protectedServer: Pick<
		ProtectedMcpServer,
		"authorizationServer" | "requiredScope"
	> = { authorizationServer, requiredScope: undefined };

	const server = await serveHttp((request, received) => {
		const url = new URL(request.url);
		if (url.pathname === metadataPath) {
			return json({
				resource: `${url.origin}/mcp`,
				authorization_servers: [protectedServer.authorizationServer.issuer],
				scopes_supported: ["mcp:tools"],
			});
		}
		if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
		const authorization = request.headers.get("authorization") ?? "";
		const accessToken = authorization.replace(/^Bearer /, "");
		if (
			!protectedServer.authorizationServer.validAccessTokens.has(accessToken)
		) {
			return new Response(null, {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${url.origin}${metadataPath}"`,
				},
			});
		}
		if (
			protectedServer.requiredScope !== undefined &&
			received.rpcMethod === "tools/call"
		) {
			return new Response(null, {
				status: 403,
				headers: {
					"www-authenticate": `Bearer error="insufficient_scope", scope="${protectedServer.requiredScope}"`,
				},
			});
		}
		return mcp.fetch(request);
	});

	return Object.assign(protectedServer, server, {
		url: `${server.origin}/mcp`,
		presentedAuthorizations: () =>
			server.requests
				.filter((request) => request.path === "/mcp")
				.map((request) => request.headers.get("authorization")),
	});
}

/** 存在内存里的 `OAuthStore`。 */
export function memoryStore(): OAuthStore & {
	/** 现在保存的字符串。 */
	current(): string | undefined;
} {
	let value: string | undefined;
	return {
		load: async () => value,
		save: async (next) => {
			value = next;
		},
		clear: async () => {
			value = undefined;
		},
		current: () => value,
	};
}

/**
 * 扮演浏览器和用户：打开授权地址，授权服务器直接把它重定向回环回地址上的回调。
 * 返回打开过的授权地址。
 */
export function browser(): {
	opened: URL[];
	open: (url: string) => Promise<void>;
} {
	const opened: URL[] = [];
	return {
		opened,
		async open(url) {
			opened.push(new URL(url));
			const response = await fetch(url, { redirect: "manual" });
			const callback = response.headers.get("location");
			if (callback === null) {
				throw new Error(`授权服务器没有重定向：${response.status}`);
			}
			await fetch(callback);
		},
	};
}
