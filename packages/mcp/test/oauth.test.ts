import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	connectHttp,
	createOAuthSession,
	type McpConnection,
	type OAuthClientConfig,
	type OAuthSession,
	type OAuthStore,
} from "@ospreycode/mcp";
import { expect, onTestFinished, test } from "vitest";
import { client, closeAfterTest, rejection } from "./helpers.js";
import {
	browser,
	type FakeAuthorizationServer,
	memoryStore,
	type ProtectedMcpServer,
	serveAuthorizationServer,
	serveProtectedMcp,
} from "./oauth-server.js";

const clientMetadataUrl = "https://client.example/oauth/client-metadata.json";
const clientConfig: OAuthClientConfig = {
	clientMetadataUrl,
	clientName: "MCP 测试客户端",
};

interface Setup {
	authorizationServer: FakeAuthorizationServer;
	mcp: ProtectedMcpServer;
	store: ReturnType<typeof memoryStore>;
	session: OAuthSession;
}

async function setup(config: OAuthClientConfig = clientConfig): Promise<Setup> {
	const authorizationServer = await serveAuthorizationServer("as1");
	const mcp = await serveProtectedMcp(authorizationServer);
	const store = memoryStore();
	const session = createOAuthSession({
		serverUrl: mcp.url,
		store,
		client: config,
	});
	return { authorizationServer, mcp, store, session };
}

/** 登录成功之后的状态。 */
async function loggedIn(config?: OAuthClientConfig): Promise<Setup> {
	const context = await setup(config);
	await context.session.login({ onAuthorizationUrl: browser().open });
	return context;
}

async function connect(
	mcp: ProtectedMcpServer,
	session: OAuthSession,
): Promise<McpConnection> {
	return closeAfterTest(
		await connectHttp(
			{ url: mcp.url, auth: { kind: "oauth", session } },
			{ client },
		),
	);
}

function echo(connection: McpConnection) {
	return connection.callTool({ name: "echo", arguments: { text: "你好" } });
}

/** 一个现在空闲的端口。 */
async function freePort(): Promise<number> {
	const server = createServer();
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	return port;
}

test("授权服务器支持 Client ID Metadata Documents 时，用元数据文件的地址作 client_id 登录", async () => {
	const { authorizationServer, mcp, store, session } = await setup();
	const user = browser();
	expect(await session.hasTokens()).toBe(false);

	await session.login({ onAuthorizationUrl: user.open });

	expect(authorizationServer.registrations).toEqual([]);
	expect(user.opened).toHaveLength(1);
	const request = user.opened[0]?.searchParams;
	expect(request?.get("client_id")).toBe(clientMetadataUrl);
	expect(request?.get("response_type")).toBe("code");
	expect(request?.get("code_challenge_method")).toBe("S256");
	expect(request?.get("code_challenge")).toMatch(/^[\w-]{43}$/);
	expect(request?.get("state")).toMatch(/^[\w-]{43}$/);
	expect(request?.get("resource")).toBe(mcp.url);
	expect(request?.get("redirect_uri")).toMatch(
		/^http:\/\/127\.0\.0\.1:\d+\/callback$/,
	);
	// 兑换授权码时是公开客户端：只报 client_id，带 PKCE 的 verifier
	expect(authorizationServer.tokenRequests).toHaveLength(1);
	const exchange = authorizationServer.tokenRequests[0];
	expect(exchange?.authorization).toBeNull();
	expect(exchange?.params.get("client_id")).toBe(clientMetadataUrl);
	expect(exchange?.params.get("code_verifier")).toMatch(/^[\w.~-]{43,128}$/);
	expect(await session.hasTokens()).toBe(true);
	expect(store.current()).toContain("as1-access-");
	expect(store.current()).toContain("as1-refresh-");
});

test("登录之后，用同一份保存的状态就能连接 server", async () => {
	const { mcp, store } = await loggedIn();
	// Host 的 session 在另一个进程里：另建一个对象，只共用存储
	const session = createOAuthSession({
		serverUrl: mcp.url,
		store,
		client: clientConfig,
	});

	const connection = await connect(mcp, session);
	const result = await echo(connection);

	expect(result.content).toEqual([{ type: "text", text: "你好" }]);
	expect(new Set(mcp.presentedAuthorizations())).toEqual(
		new Set(["Bearer as1-access-2"]),
	);
});

test("授权服务器不支持 Client ID Metadata Documents 时动态注册，带 application_type: native", async () => {
	const { authorizationServer, session } = await setup();
	authorizationServer.behavior.clientIdMetadataDocuments = false;
	const user = browser();

	await session.login({ onAuthorizationUrl: user.open });

	expect(authorizationServer.registrations).toEqual([
		expect.objectContaining({
			application_type: "native",
			client_name: "MCP 测试客户端",
			redirect_uris: ["http://127.0.0.1/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	]);
	expect(user.opened[0]?.searchParams.get("client_id")).toBe("as1-client-1");
	expect(await session.hasTokens()).toBe(true);
});

test("动态注册下来的客户端保存着，再次登录不重新注册", async () => {
	const { authorizationServer, session } = await setup();
	authorizationServer.behavior.clientIdMetadataDocuments = false;
	await session.login({ onAuthorizationUrl: browser().open });
	const user = browser();

	await session.login({ onAuthorizationUrl: user.open });

	expect(authorizationServer.registrations).toHaveLength(1);
	expect(user.opened[0]?.searchParams.get("client_id")).toBe("as1-client-1");
});

test("配置了预先注册的客户端就用它，不用元数据文件也不注册", async () => {
	const callbackPort = await freePort();
	const { authorizationServer, mcp, session } = await setup({
		...clientConfig,
		preRegistered: {
			clientId: "pre-registered",
			clientSecret: "client-secret",
			callbackPort,
		},
	});
	const user = browser();

	await session.login({ onAuthorizationUrl: user.open });

	expect(authorizationServer.registrations).toEqual([]);
	const request = user.opened[0]?.searchParams;
	expect(request?.get("client_id")).toBe("pre-registered");
	expect(request?.get("redirect_uri")).toBe(
		`http://127.0.0.1:${callbackPort}/callback`,
	);
	expect(authorizationServer.tokenRequests[0]?.authorization).toBe(
		`Basic ${btoa("pre-registered:client-secret")}`,
	);
	const connection = await connect(mcp, session);
	expect((await echo(connection)).isError).toBe(false);
});

test("指定的回调端口被占用时登录以 transport 失败，不发出任何请求", async () => {
	const occupying = createServer();
	const listening = Promise.withResolvers<void>();
	occupying.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	onTestFinished(() => void occupying.close());
	const { port } = occupying.address() as AddressInfo;
	const { authorizationServer, mcp, session } = await setup({
		...clientConfig,
		preRegistered: { clientId: "pre-registered", callbackPort: port },
	});
	const user = browser();

	await rejection(
		session.login({ onAuthorizationUrl: user.open }),
		"transport",
	);

	expect(user.opened).toEqual([]);
	expect(authorizationServer.requests).toEqual([]);
	expect(mcp.requests).toEqual([]);
});

test("回调里的 state 和发出的不一致时拒绝，不兑换授权码，不保存令牌", async () => {
	const { authorizationServer, store, session } = await setup();
	authorizationServer.behavior.callbackState = "forged-state";

	const error = await rejection(
		session.login({ onAuthorizationUrl: browser().open }),
		"unauthorized",
	);

	expect(error.message).toContain("state");
	expect(error.message).not.toContain("forged-state");
	expect(authorizationServer.tokenRequests).toEqual([]);
	expect(await session.hasTokens()).toBe(false);
	expect(store.current() ?? "").not.toContain("access");
});

test("回调里的 iss 不是授权服务器的 issuer 时拒绝，不兑换授权码，不保存令牌", async () => {
	const { authorizationServer, store, session } = await setup();
	authorizationServer.behavior.callbackIss = "https://attacker.example";

	const error = await rejection(
		session.login({ onAuthorizationUrl: browser().open }),
		"unauthorized",
	);

	expect(error.message).toContain("iss");
	// 回调里的值可能是攻击者给的，不放进消息
	expect(error.message).not.toContain("attacker.example");
	expect(authorizationServer.tokenRequests).toEqual([]);
	expect(await session.hasTokens()).toBe(false);
	expect(store.current() ?? "").not.toContain("access");
});

test("授权服务器声明回调带 iss，回调里却没有时拒绝", async () => {
	const { authorizationServer, session } = await setup();
	authorizationServer.behavior.callbackIss = undefined;

	await rejection(
		session.login({ onAuthorizationUrl: browser().open }),
		"unauthorized",
	);

	expect(authorizationServer.tokenRequests).toEqual([]);
	expect(await session.hasTokens()).toBe(false);
});

test("用户拒绝授权时登录以 unauthorized 失败", async () => {
	const { authorizationServer, session } = await setup();
	authorizationServer.behavior.denyAuthorization = true;

	await rejection(
		session.login({ onAuthorizationUrl: browser().open }),
		"unauthorized",
	);

	expect(authorizationServer.tokenRequests).toEqual([]);
	expect(await session.hasTokens()).toBe(false);
});

test("登录失败不动已经保存的令牌", async () => {
	const { authorizationServer, mcp, store, session } = await loggedIn();
	const before = store.current();
	authorizationServer.behavior.callbackState = "forged-state";

	await rejection(
		session.login({ onAuthorizationUrl: browser().open }),
		"unauthorized",
	);

	expect(store.current()).toBe(before);
	const connection = await connect(mcp, session);
	expect((await echo(connection)).isError).toBe(false);
});

test("过了时限没有收到回调：登录以 timeout 失败，端口随即关闭", async () => {
	const { session } = await setup();
	let authorizationUrl: URL | undefined;

	await rejection(
		session.login({
			// 用户一直没有在浏览器里完成授权
			onAuthorizationUrl: (url) => {
				authorizationUrl = new URL(url);
			},
			timeoutMs: 50,
		}),
		"timeout",
	);

	const redirectUri = authorizationUrl?.searchParams.get("redirect_uri");
	expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
	await expect(fetch(redirectUri as string)).rejects.toThrow();
	expect(await session.hasTokens()).toBe(false);
});

test("收到回调之后端口也关闭", async () => {
	const { session } = await setup();
	const user = browser();

	await session.login({ onAuthorizationUrl: user.open });

	const redirectUri = user.opened[0]?.searchParams.get("redirect_uri");
	await expect(fetch(redirectUri as string)).rejects.toThrow();
});

test("中止信号取消登录：以 cancelled 失败，端口随即关闭", async () => {
	const { session } = await setup();
	const controller = new AbortController();
	let authorizationUrl: URL | undefined;

	await rejection(
		session.login({
			onAuthorizationUrl: (url) => {
				authorizationUrl = new URL(url);
				controller.abort();
			},
			signal: controller.signal,
		}),
		"cancelled",
	);

	const redirectUri = authorizationUrl?.searchParams.get("redirect_uri");
	await expect(fetch(redirectUri as string)).rejects.toThrow();
});

test("回调端口以外的路径不算回调", async () => {
	const { session } = await setup();
	const user = browser();

	await session.login({
		onAuthorizationUrl: async (url) => {
			const redirectUri = new URL(url).searchParams.get("redirect_uri");
			const stray = await fetch(
				new URL("/favicon.ico?code=x&state=y", redirectUri as string),
			);
			expect(stray.status).toBe(404);
			await user.open(url);
		},
	});

	expect(await session.hasTokens()).toBe(true);
});

test("access token 过期：用 refresh token 换新的并保存，调用照常完成", async () => {
	const { authorizationServer, mcp, store, session } = await loggedIn();
	const connection = await connect(mcp, session);
	authorizationServer.validAccessTokens.clear();
	authorizationServer.tokenRequests.length = 0;

	const result = await echo(connection);

	expect(result.content).toEqual([{ type: "text", text: "你好" }]);
	expect(authorizationServer.tokenRequests).toHaveLength(1);
	const refresh = authorizationServer.tokenRequests[0]?.params;
	expect(refresh?.get("grant_type")).toBe("refresh_token");
	expect(refresh?.get("refresh_token")).toBe("as1-refresh-2");
	expect(refresh?.get("resource")).toBe(mcp.url);
	// 新的 access token 和轮换后的 refresh token 都存下来了
	expect(store.current()).toContain("as1-access-3");
	expect(store.current()).toContain("as1-refresh-3");
	expect(store.current()).not.toContain("as1-refresh-2");
	expect(mcp.presentedAuthorizations().at(-1)).toBe("Bearer as1-access-3");
});

test("连接时 access token 已经过期，也先刷新再连", async () => {
	const { authorizationServer, mcp, session } = await loggedIn();
	authorizationServer.validAccessTokens.clear();

	const connection = await connect(mcp, session);

	expect((await echo(connection)).isError).toBe(false);
});

test("几个调用同时遇到过期的令牌，只刷新一次", async () => {
	const { authorizationServer, mcp, session } = await loggedIn();
	const connection = await connect(mcp, session);
	authorizationServer.validAccessTokens.clear();
	authorizationServer.tokenRequests.length = 0;

	const results = await Promise.all([
		echo(connection),
		echo(connection),
		echo(connection),
		connection.listTools(),
	]);

	expect(results).toHaveLength(4);
	expect(authorizationServer.tokenRequests).toHaveLength(1);
});

test("另一个进程抢先用掉了同一个 refresh token：不删它刚换到的令牌，拿新的再换一次", async () => {
	const { authorizationServer, mcp, store, session } = await loggedIn();
	const otherProcess = await connect(mcp, session);
	let raced = false;
	const racing = createOAuthSession({
		serverUrl: mcp.url,
		store,
		client: clientConfig,
		// 这边的刷新请求发出之前，让另一个进程先完成它的刷新
		fetch: async (input, init) => {
			if (!raced && String(input).endsWith("/token")) {
				raced = true;
				await echo(otherProcess);
			}
			return fetch(input, init);
		},
	});
	const connection = await connect(mcp, racing);
	authorizationServer.validAccessTokens.clear();
	authorizationServer.tokenRequests.length = 0;

	const result = await echo(connection);

	expect(result.isError).toBe(false);
	// 另一个进程换了一次；这边拿作废的 refresh token 换失败，再用它存下的新 refresh token 换成功
	expect(
		authorizationServer.tokenRequests.map((request) =>
			request.params.get("refresh_token"),
		),
	).toEqual(["as1-refresh-2", "as1-refresh-2", "as1-refresh-3"]);
	expect(store.current()).toContain("as1-access-4");
	expect((await echo(otherProcess)).isError).toBe(false);
});

test("没有保存的令牌：连接以 unauthorized 失败，不发起任何授权", async () => {
	const { authorizationServer, mcp, session } = await setup();

	await rejection(
		connectHttp({ url: mcp.url, auth: { kind: "oauth", session } }, { client }),
		"unauthorized",
	);

	expect(authorizationServer.requests).toEqual([]);
	expect(mcp.requests.every((request) => request.path === "/mcp")).toBe(true);
});

test("令牌过期又没有 refresh token：调用以 unauthorized 失败，不发起任何授权", async () => {
	const { authorizationServer, mcp, session } = await setup();
	authorizationServer.behavior.issueRefreshTokens = false;
	await session.login({ onAuthorizationUrl: browser().open });
	const connection = await connect(mcp, session);
	authorizationServer.validAccessTokens.clear();
	authorizationServer.requests.length = 0;

	await rejection(echo(connection), "unauthorized");

	expect(authorizationServer.requests).toEqual([]);
});

test("refresh token 被授权服务器拒绝：调用以 unauthorized 失败，作废的令牌不再保存", async () => {
	const { authorizationServer, mcp, store, session } = await loggedIn();
	const connection = await connect(mcp, session);
	authorizationServer.validAccessTokens.clear();
	// 换一个授权服务器的状态：原来发的 refresh token 它不认
	const stale = store.current() as string;
	await store.save(stale.replace("as1-refresh-2", "as1-refresh-revoked"));
	authorizationServer.requests.length = 0;

	const error = await rejection(echo(connection), "unauthorized");

	expect(error.message).not.toContain("as1-refresh-revoked");
	expect(authorizationServer.requests.map((request) => request.path)).toEqual([
		"/token",
	]);
	expect(await session.hasTokens()).toBe(false);
	expect(store.current()).not.toContain("as1-refresh-revoked");
});

test.for<[string, () => Response]>([
	[
		"连不上",
		() => {
			throw new TypeError("fetch failed");
		},
	],
	["报 500", () => new Response("oops", { status: 500 })],
])(
	"刷新令牌时授权服务器%s：调用以 transport 失败，保存的令牌留着，恢复之后照常刷新",
	async ([_name, broken]) => {
		const { authorizationServer, mcp, store } = await loggedIn();
		let failing = true;
		const session = createOAuthSession({
			serverUrl: mcp.url,
			store,
			client: clientConfig,
			fetch: async (input, init) => (failing ? broken() : fetch(input, init)),
		});
		const connection = await connect(mcp, session);
		authorizationServer.validAccessTokens.clear();
		const saved = store.current();

		await rejection(echo(connection), "transport");

		expect(store.current()).toBe(saved);
		failing = false;
		expect((await echo(connection)).isError).toBe(false);
		expect(store.current()).toContain("as1-refresh-3");
	},
);

test("403 insufficient_scope：调用以 insufficient_scope 失败，带着要求的 scope，不自动重新授权", async () => {
	const { authorizationServer, mcp, session } = await loggedIn();
	const connection = await connect(mcp, session);
	mcp.requiredScope = "files:write";
	authorizationServer.requests.length = 0;

	const error = await rejection(echo(connection), "insufficient_scope");

	expect(error.requiredScope).toBe("files:write");
	expect(authorizationServer.requests).toEqual([]);
});

test("logout() 删除保存的全部状态", async () => {
	const { mcp, store, session } = await loggedIn();
	expect(store.current()).toBeDefined();

	await session.logout();

	expect(store.current()).toBeUndefined();
	expect(await session.hasTokens()).toBe(false);
	await rejection(
		connectHttp({ url: mcp.url, auth: { kind: "oauth", session } }, { client }),
		"unauthorized",
	);
});

test("server 换了授权服务器：重新登录时在新的授权服务器注册，用它发的令牌", async () => {
	const { authorizationServer, mcp, session } = await setup();
	authorizationServer.behavior.clientIdMetadataDocuments = false;
	await session.login({ onAuthorizationUrl: browser().open });
	const replacement = await serveAuthorizationServer("as2");
	replacement.behavior.clientIdMetadataDocuments = false;
	mcp.authorizationServer = replacement;
	const user = browser();

	await session.login({ onAuthorizationUrl: user.open });

	// 原来那个授权服务器注册的客户端不拿到新的授权服务器去用
	expect(replacement.registrations).toHaveLength(1);
	expect(user.opened[0]?.origin).toBe(replacement.origin);
	expect(user.opened[0]?.searchParams.get("client_id")).toBe("as2-client-1");
	const connection = await connect(mcp, session);
	expect((await echo(connection)).isError).toBe(false);
	expect(mcp.presentedAuthorizations().at(-1)).toMatch(/^Bearer as2-access-/);
});

test("预先注册的客户端绑定在第一次登录的授权服务器上：授权服务器变了就拒绝，退出登录后才能重新登录", async () => {
	const { mcp, session } = await loggedIn({
		...clientConfig,
		preRegistered: {
			clientId: "pre-registered",
			clientSecret: "client-secret",
		},
	});
	const replacement = await serveAuthorizationServer("as2");
	mcp.authorizationServer = replacement;

	await rejection(
		session.login({ onAuthorizationUrl: browser().open }),
		"unauthorized",
	);
	// 客户端密钥没有发给新的授权服务器
	expect(replacement.tokenRequests).toEqual([]);
	expect(replacement.authorizations).toEqual([]);

	await session.logout();
	await session.login({ onAuthorizationUrl: browser().open });
	expect(replacement.tokenRequests).toHaveLength(1);
});

test("保存的状态读不懂时以 unauthorized 失败，消息里不带保存的内容", async () => {
	const { mcp, store, session } = await setup();
	await store.save(
		'{"version":1,"issuers":{"x":{"tokens":{"access_token":5}}}}',
	);

	const error = await rejection(
		connectHttp({ url: mcp.url, auth: { kind: "oauth", session } }, { client }),
		"unauthorized",
	);

	expect(error.message).toContain("退出登录");
	await rejection(session.hasTokens(), "unauthorized");
});

test("session 不是 createOAuthSession 建的就拒绝", async () => {
	const { mcp } = await setup();
	const store: OAuthStore = memoryStore();
	const foreign: OAuthSession = {
		hasTokens: async () => store !== undefined,
		login: async () => {},
		logout: async () => {},
	};

	await expect(
		connectHttp(
			{ url: mcp.url, auth: { kind: "oauth", session: foreign } },
			{ client },
		),
	).rejects.toThrow(TypeError);
});
