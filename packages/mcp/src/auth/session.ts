import { randomBytes } from "node:crypto";
import {
	AuthorizationServerMismatchError,
	auth,
	type FetchLike,
	IssuerMismatchError,
	type OAuthClientInformationContext,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	OAuthError,
	type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { abortable } from "../client/abort.js";
import { McpError } from "../protocol/errors.js";
import { type CallbackListener, listenForCallback } from "./callback.js";
import { clientRegistration, registeredRedirectUri } from "./metadata.js";
import { SerialQueue } from "./serial.js";
import {
	credentialsOf,
	currentTokens,
	OAuthStateStore,
	type OAuthStore,
} from "./store.js";

/** 这个客户端在授权服务器那里的身份。 */
export interface OAuthClientConfig {
	/** 客户端元数据文件（Client ID Metadata Documents）的地址。 */
	clientMetadataUrl: string;
	/** 动态注册时用的客户端名字。 */
	clientName: string;
	/**
	 * 预先注册的客户端；有它就不用 CIMD 和动态注册。`callbackPort` 是要求固定回调地址的客户端
	 * 指定的端口。
	 */
	preRegistered?: {
		clientId: string;
		clientSecret?: string;
		callbackPort?: number;
	};
}

/** 一个 MCP server 的 OAuth 登录状态。 */
export interface OAuthSession {
	/** 有没有保存的令牌（不检查是否过期）。 */
	hasTokens(): Promise<boolean>;
	/**
	 * 交互登录：监听 `127.0.0.1:0`（或预先注册的固定端口）上的 `/callback`，把授权地址交给
	 * `onAuthorizationUrl`（调用方打开浏览器或显示给用户），收到回调或过了时限（默认 300 秒）
	 * 就关闭端口。核对 `state`，按 RFC 9207 核对 `iss` 后兑换授权码并保存令牌。
	 *
	 * 失败时抛 `McpError`：授权没有完成或被拒绝是 `unauthorized`，过了时限是 `timeout`，
	 * `signal` 中止是 `cancelled`，其余（网络、发现、注册、端口被占用）是 `transport`。
	 * 登录失败不改动已经保存的令牌。
	 */
	login(options: {
		onAuthorizationUrl: (url: string) => void | Promise<void>;
		signal?: AbortSignal;
		/** 从开始监听算起的时限，毫秒；不给时 300000。 */
		timeoutMs?: number;
	}): Promise<void>;
	/** 删除保存的全部 OAuth 状态。不向授权服务器撤销令牌。 */
	logout(): Promise<void>;
}

/** `createOAuthSession` 的参数。 */
export interface OAuthSessionOptions {
	/** MCP server 的地址。 */
	serverUrl: string;
	store: OAuthStore;
	client: OAuthClientConfig;
	/** 向授权服务器发请求用；测试和代理用，不给时用全局 fetch。 */
	fetch?: typeof fetch;
}

const defaultLoginTimeoutMs = 300_000;

/** provider 里和客户端凭据有关的部分。 */
type ClientAccess = Pick<
	OAuthClientProvider,
	"clientMetadataUrl" | "clientInformation" | "saveClientInformation"
>;

/** 一次登录过程中攒下的东西，登录成功才写进凭据库。 */
interface LoginRecord {
	authorizationUrl?: URL;
	codeVerifier?: string;
	discovery?: OAuthDiscoveryState;
	issued?: { issuer: string; tokens: StoredOAuthTokens };
}

/** SDK 的 `auth()` 存取凭据时总会给出授权服务器的 issuer。 */
function issuerOf(context: OAuthClientInformationContext | undefined): string {
	if (context === undefined) {
		throw new Error("SDK 存取凭据时没有给出授权服务器的 issuer");
	}
	return context.issuer;
}

function clientAccess(
	states: OAuthStateStore,
	config: OAuthClientConfig,
): ClientAccess {
	const { preRegistered } = config;
	if (preRegistered !== undefined) {
		// 不提供 saveClientInformation：授权服务器变了的时候 SDK 报错，
		// 而不是把预先注册的凭据交给新的授权服务器，或者另行注册一个客户端
		return {
			async clientInformation() {
				const { current } = await states.read();
				return {
					client_id: preRegistered.clientId,
					...(preRegistered.clientSecret !== undefined && {
						client_secret: preRegistered.clientSecret,
					}),
					// 配置里没写它是在哪个授权服务器注册的：第一次登录用的那个算数
					...(current !== undefined && { issuer: current }),
				};
			},
		};
	}
	return {
		clientMetadataUrl: config.clientMetadataUrl,
		async clientInformation(context) {
			return (await states.read()).issuers[issuerOf(context)]?.client;
		},
		// 注册下来的客户端马上保存：这次登录没完成，下次也不用重新注册
		async saveClientInformation(client, context) {
			await states.update((state) => {
				credentialsOf(state, issuerOf(context)).client = client;
			});
		},
	};
}

function needsLogin(cause?: unknown): McpError {
	return new McpError(
		"unauthorized",
		"没有可用的 MCP server 令牌，要（重新）登录",
		{ cause },
	);
}

function toLoginError(
	error: unknown,
	signal: AbortSignal | undefined,
	timeout: AbortSignal,
): McpError {
	const action = "登录 MCP server";
	if (error instanceof McpError) return error;
	if (signal?.aborted) {
		return new McpError("cancelled", `${action}：已取消`, { cause: error });
	}
	if (timeout.aborted) {
		return new McpError("timeout", `${action}：过了时限还没有完成授权`, {
			cause: error,
		});
	}
	// 下面三种的消息都不带对方发来的内容：回调里的参数可能是攻击者给的
	if (
		error instanceof IssuerMismatchError &&
		error.kind === "authorization_response"
	) {
		return new McpError(
			"unauthorized",
			`${action}：回调里的 iss 和授权服务器的 issuer 不一致`,
			{ cause: error },
		);
	}
	if (error instanceof AuthorizationServerMismatchError) {
		return new McpError(
			"unauthorized",
			`${action}：授权服务器和保存的凭据所属的不是同一个，要先退出登录再重新登录`,
			{ cause: error },
		);
	}
	if (error instanceof OAuthError) {
		return new McpError("unauthorized", `${action}：授权服务器拒绝了请求`, {
			cause: error,
		});
	}
	return new McpError(
		"transport",
		`${action}：${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
}

/** `createOAuthSession` 返回的实现；`connectHttp` 还要用到接口以外的两个方法。 */
export class StoredOAuthSession implements OAuthSession {
	readonly #serverUrl: string;
	readonly #states: OAuthStateStore;
	readonly #client: OAuthClientConfig;
	readonly #fetch: typeof fetch;
	/** refresh token 可能用一次就换新的，同时刷新会让其中一个拿着作废的去换。 */
	readonly #refreshes = new SerialQueue();

	constructor(options: OAuthSessionOptions) {
		this.#serverUrl = options.serverUrl;
		this.#states = new OAuthStateStore(options.store);
		this.#client = options.client;
		this.#fetch = options.fetch ?? fetch;
	}

	async hasTokens(): Promise<boolean> {
		return currentTokens(await this.#states.read()) !== undefined;
	}

	async login(options: {
		onAuthorizationUrl: (url: string) => void | Promise<void>;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<void> {
		const { signal } = options;
		const timeout = AbortSignal.timeout(
			options.timeoutMs ?? defaultLoginTimeoutMs,
		);
		const deadline =
			signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
		let listener: CallbackListener | undefined;
		try {
			deadline.throwIfAborted();
			listener = await listenForCallback(
				this.#client.preRegistered?.callbackPort ?? 0,
			);
			const expectedState = randomBytes(32).toString("base64url");
			const record: LoginRecord = {};
			const provider = this.#loginProvider(
				listener.redirectUrl,
				expectedState,
				record,
			);
			// 时限和中止也管着发现、注册和兑换授权码的请求
			const fetchFn: FetchLike = (url, init) =>
				this.#fetch(url, { ...init, signal: deadline });

			await auth(provider, { serverUrl: this.#serverUrl, fetchFn });
			if (record.authorizationUrl === undefined) {
				throw new Error("SDK 没有给出授权地址");
			}
			await abortable(
				Promise.resolve(
					options.onAuthorizationUrl(record.authorizationUrl.href),
				),
				deadline,
			);
			const callback = await abortable(listener.callback, deadline);

			if (callback.get("state") !== expectedState) {
				throw new McpError(
					"unauthorized",
					"登录 MCP server：回调里的 state 和发出的不一致",
				);
			}
			const code = callback.get("code");
			if (code === null) {
				throw new McpError(
					"unauthorized",
					"登录 MCP server：授权没有完成（用户拒绝了，或者授权服务器报错）",
				);
			}
			// SDK 先按 RFC 9207 核对 iss，再兑换授权码
			await auth(provider, {
				serverUrl: this.#serverUrl,
				authorizationCode: code,
				iss: callback.get("iss") ?? undefined,
				fetchFn,
			});
			const { issued, discovery } = record;
			if (issued === undefined) {
				throw new Error("SDK 报告授权成功，但没有交来令牌");
			}
			await this.#states.update((state) => {
				credentialsOf(state, issued.issuer).tokens = issued.tokens;
				state.current = issued.issuer;
				state.discovery = discovery;
			});
		} catch (error) {
			throw toLoginError(error, signal, timeout);
		} finally {
			await listener?.close();
		}
	}

	logout(): Promise<void> {
		return this.#states.clear();
	}

	/** 现在的 access token。每次都从凭据库读：用户可能刚在另一个进程里重新登录过。 */
	async accessToken(): Promise<string | undefined> {
		return currentTokens(await this.#states.read())?.access_token;
	}

	/**
	 * 一个请求收到了 401：用 refresh token 换新的令牌并保存。换不了（没有 refresh token、
	 * 授权服务器不认）就抛 `McpError(kind: "unauthorized")`，绝不发起要用户参与的授权；
	 * 授权服务器连不上或出错时抛 `McpError(kind: "transport")`，保存的令牌不动。
	 *
	 * @param rejectedAuthorization 收到 401 的那个请求带的 `Authorization` 头。
	 */
	refresh(rejectedAuthorization: string | null | undefined): Promise<void> {
		return this.#refreshes.run(async () => {
			const tokens = currentTokens(await this.#states.read());
			if (tokens === undefined) throw needsLogin();
			// 排队的时候别的请求已经换过令牌，或者用户在别处重新登录了：用新的令牌重试就行
			if (`Bearer ${tokens.access_token}` !== rejectedAuthorization) return;
			const { refresh_token: refreshToken } = tokens;
			if (refreshToken === undefined) throw needsLogin();
			try {
				await auth(this.#sessionProvider(refreshToken), {
					serverUrl: this.#serverUrl,
					fetchFn: this.#fetch,
				});
			} catch (error) {
				if (
					error instanceof OAuthError ||
					error instanceof AuthorizationServerMismatchError
				) {
					throw needsLogin(error);
				}
				throw error;
			}
		});
	}

	#loginProvider(
		redirectUrl: string,
		expectedState: string,
		record: LoginRecord,
	): OAuthClientProvider {
		return {
			redirectUrl,
			clientMetadata: clientRegistration(this.#client.clientName),
			...clientAccess(this.#states, this.#client),
			state: () => expectedState,
			// 登录总是走完整的授权流程，不拿已有的 refresh token 去换
			tokens: () => undefined,
			saveTokens(tokens, context) {
				record.issued = { issuer: issuerOf(context), tokens };
			},
			// 发现结果要留到兑换授权码的时候：SDK 据此确认还是发出授权请求时的那个授权服务器
			discoveryState: () => record.discovery,
			saveDiscoveryState(discovery) {
				record.discovery = discovery;
			},
			saveCodeVerifier(codeVerifier) {
				record.codeVerifier = codeVerifier;
			},
			codeVerifier() {
				if (record.codeVerifier === undefined) {
					throw new Error("SDK 在发出授权请求之前就来取 PKCE verifier");
				}
				return record.codeVerifier;
			},
			redirectToAuthorization(authorizationUrl) {
				record.authorizationUrl = authorizationUrl;
			},
		};
	}

	/** @param refreshToken 这次拿去换新令牌的 refresh token。 */
	#sessionProvider(refreshToken: string): OAuthClientProvider {
		const states = this.#states;
		const client = clientAccess(states, this.#client);
		/** SDK 最近一次来取令牌时有没有拿到 refresh token：拿到了它就会去换。 */
		let offeredRefreshToken = false;
		return {
			// 有回调地址，SDK 才按授权码流程处理、先用 refresh token 去换；session 里不会真的用到它
			redirectUrl: registeredRedirectUri,
			clientMetadata: clientRegistration(this.#client.clientName),
			async clientInformation(context) {
				const information = await client.clientInformation(context);
				// session 里不注册客户端：注册完也得用户授权才有令牌
				if (information === undefined) throw needsLogin();
				return information;
			},
			async tokens(context) {
				const tokens = (await states.read()).issuers[issuerOf(context)]?.tokens;
				offeredRefreshToken = tokens?.refresh_token !== undefined;
				return tokens;
			},
			async saveTokens(tokens, context) {
				await states.update((state) => {
					credentialsOf(state, issuerOf(context)).tokens = tokens;
				});
			},
			async discoveryState() {
				return (await states.read()).discovery;
			},
			async saveDiscoveryState(discovery) {
				await states.update((state) => {
					state.discovery = discovery;
				});
			},
			// 授权服务器不认 refresh token 或客户端的时候 SDK 调用：删掉它们，下次登录重新来过
			async invalidateCredentials(scope) {
				await states.update((state) => {
					if (scope === "discovery" || scope === "all") {
						state.discovery = undefined;
					}
					if (state.current === undefined) return;
					const credentials = credentialsOf(state, state.current);
					if (scope === "client" || scope === "all") {
						credentials.client = undefined;
					}
					// 只删这次拿去换的那一份：另一个进程可能刚用同一个 refresh token 换到了新的，
					// 留着它，SDK 接下来的重试就会用新的那份
					if (
						(scope === "tokens" || scope === "all") &&
						credentials.tokens?.refresh_token === refreshToken
					) {
						credentials.tokens = undefined;
					}
				});
			},
			saveCodeVerifier() {
				// session 里不发起授权，verifier 用不上
			},
			codeVerifier() {
				throw new Error("session 里不兑换授权码");
			},
			// SDK 没换到令牌才走到这里来发起授权；session 里不发起，只报错
			redirectToAuthorization() {
				// 授权服务器明确拒绝 refresh token 时，SDK 删掉它再来一遍，那一遍取不到 refresh token。
				// 刚取到过却还是走到这里，就是换令牌的请求没得到正常的回应（网络故障、授权服务器出错，
				// SDK 只打印一条警告）：令牌没有失效，不该让用户重新登录
				if (offeredRefreshToken) {
					throw new McpError(
						"transport",
						"刷新 MCP server 的令牌：授权服务器没有正常回应",
					);
				}
				throw needsLogin();
			},
		};
	}
}

/** 建一个 MCP server 的 OAuth 登录状态，凭据经 `store` 存取。 */
export function createOAuthSession(options: OAuthSessionOptions): OAuthSession {
	return new StoredOAuthSession(options);
}
