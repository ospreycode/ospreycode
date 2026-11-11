import {
	type AuthProvider,
	type FetchLike,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type OAuthSession, StoredOAuthSession } from "../auth/session.js";
import {
	type McpConnection,
	type McpConnectOptions,
	openConnection,
} from "../client/connection.js";

/** 远程 server 的授权方式。 */
export type McpAuth =
	/** 静态令牌：每次请求前取，作为 `Authorization: Bearer` 发出；返回空就不带。 */
	| { kind: "bearer"; token: () => Promise<string | undefined> }
	/**
	 * OAuth：用保存的令牌，过期时用 refresh token 刷新；需要用户重新授权时连接或调用以
	 * `McpError(kind: "unauthorized")` 失败，绝不在这里打开浏览器或监听端口。
	 * `session` 必须是 `createOAuthSession` 返回的对象。
	 */
	| { kind: "oauth"; session: OAuthSession };

/** 要连接的远程 server。 */
export interface HttpTarget {
	/** server 的 Streamable HTTP 地址。 */
	url: string;
	/**
	 * 配置里的固定请求头；客户端为 HTTP、MCP 和授权生成的头优先于同名的配置头，
	 * 跨源重定向时不带出去。
	 */
	headers?: Readonly<Record<string, string>>;
	auth?: McpAuth;
	/** 测试和代理用；不给时用全局 fetch。 */
	fetch?: typeof fetch;
}

/** 经 Streamable HTTP 连接远程 server。 */
export async function connectHttp(
	target: HttpTarget,
	options: McpConnectOptions,
): Promise<McpConnection> {
	const url = new URL(target.url);
	const baseFetch = target.fetch ?? fetch;
	const configured = Object.entries(target.headers ?? {});
	/** 每个响应对应的请求带的 `Authorization` 头：收到 401 时要知道被拒绝的是哪个令牌。 */
	const sentAuthorization = new WeakMap<Response, string | null>();

	// 配置的头不经 SDK 的 requestInit 传：那样 SDK 向授权服务器发请求时也会带上它们
	const send: FetchLike = async (input, init) => {
		const headers = new Headers(init?.headers);
		// SDK 只跟随同源的重定向，这里再核对一次：配置的头里常有密钥，只能发给配置它的那个源
		if (new URL(input).origin === url.origin) {
			for (const [name, value] of configured) {
				if (!headers.has(name)) headers.set(name, value);
			}
		}
		const response = await baseFetch(input, { ...init, headers });
		sentAuthorization.set(response, headers.get("authorization"));
		return response;
	};

	const transport = new StreamableHTTPClientTransport(url, {
		fetch: send,
		// 403 insufficient_scope 时不让 SDK 自己发起重新授权，报给调用方
		onInsufficientScope: "throw",
		...(target.auth !== undefined && {
			authProvider: authProviderOf(target.auth, sentAuthorization),
		}),
	});
	return await openConnection(transport, options);
}

function authProviderOf(
	auth: McpAuth,
	sentAuthorization: WeakMap<Response, string | null>,
): AuthProvider {
	if (auth.kind === "bearer") return { token: auth.token };
	const { session } = auth;
	if (!(session instanceof StoredOAuthSession)) {
		throw new TypeError("auth.session 必须是 createOAuthSession 返回的对象");
	}
	// 交给 SDK 的是只会取令牌和刷新的 AuthProvider，不是完整的 OAuthClientProvider：
	// 这样 SDK 在连接里没有办法发起要用户参与的授权
	return {
		token: () => session.accessToken(),
		onUnauthorized: ({ response }) =>
			session.refresh(sentAuthorization.get(response)),
	};
}
