import type {
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { McpError } from "../protocol/errors.js";
import { SerialQueue } from "./serial.js";

/**
 * Host 实现的凭据存取：整个 OAuth 状态（按 issuer 分开的客户端凭据、令牌、发现结果）
 * 序列化成一个字符串，Host 存进系统凭据库。字符串的内容只有这个包解读。
 */
export interface OAuthStore {
	/** 读出保存的字符串；没有保存过就返回 `undefined`。 */
	load(): Promise<string | undefined>;
	save(value: string): Promise<void>;
	clear(): Promise<void>;
}

/** 一个授权服务器名下的凭据。 */
export interface IssuerCredentials {
	/** 在这个授权服务器注册的客户端；预先注册的客户端来自配置，不存在这里。 */
	client?: StoredOAuthClientInformation;
	tokens?: StoredOAuthTokens;
}

/** 保存的 OAuth 状态。 */
export interface OAuthState {
	/** 现在用的授权服务器：最近一次登录成功的那个。 */
	current?: string;
	/** 按授权服务器的 issuer 分开的凭据。 */
	issuers: Record<string, IssuerCredentials>;
	/** 最近一次登录时的发现结果，刷新令牌时不用重新发现。 */
	discovery?: OAuthDiscoveryState;
}

/** 存储格式的版本，格式变了就加一。 */
const formatVersion = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalRecord(value: unknown): boolean {
	return value === undefined || isRecord(value);
}

function isClient(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.client_id === "string" &&
		isOptionalString(value.client_secret) &&
		isOptionalString(value.issuer)
	);
}

function isTokens(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.access_token === "string" &&
		typeof value.token_type === "string" &&
		isOptionalString(value.refresh_token) &&
		isOptionalString(value.scope) &&
		isOptionalString(value.issuer)
	);
}

function isIssuerCredentials(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.client === undefined || isClient(value.client)) &&
		(value.tokens === undefined || isTokens(value.tokens))
	);
}

function isDiscovery(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.authorizationServerUrl === "string" &&
		isOptionalString(value.resourceMetadataUrl) &&
		isOptionalRecord(value.authorizationServerMetadata) &&
		isOptionalRecord(value.resourceMetadata)
	);
}

/**
 * 解析从凭据库读回的字符串。这里只核对本包会读的字段；授权服务器的元数据在登录时由 SDK
 * 校验过，读回时不再逐项核对。
 */
function parseState(text: string): OAuthState {
	const invalid = new McpError(
		"unauthorized",
		"保存的 OAuth 状态格式不对，要先退出登录再重新登录",
	);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// 解析错误的消息里会带出一段原文，原文里有令牌，所以不把它留在 cause 里
		throw invalid;
	}
	if (
		!isRecord(value) ||
		value.version !== formatVersion ||
		!isOptionalString(value.current) ||
		!isRecord(value.issuers) ||
		!Object.values(value.issuers).every(isIssuerCredentials) ||
		!(value.discovery === undefined || isDiscovery(value.discovery))
	) {
		throw invalid;
	}
	const { version: _version, ...state } = value;
	return state as unknown as OAuthState;
}

/** 在 Host 的 `OAuthStore` 上读写 OAuth 状态。 */
export class OAuthStateStore {
	readonly #store: OAuthStore;
	/** "读出、修改、写回"要一次做完，两次修改交错会丢掉其中一次。 */
	readonly #updates = new SerialQueue();

	constructor(store: OAuthStore) {
		this.#store = store;
	}

	/** 读出现在的状态；没有保存过时是空的状态。 */
	async read(): Promise<OAuthState> {
		const text = await this.#store.load();
		return text === undefined ? { issuers: {} } : parseState(text);
	}

	/** 读出状态，交给 `change` 修改，再写回去。 */
	update(change: (state: OAuthState) => void): Promise<void> {
		return this.#updates.run(async () => {
			const state = await this.read();
			change(state);
			await this.#store.save(
				JSON.stringify({ version: formatVersion, ...state }),
			);
		});
	}

	/** 删除保存的全部状态。 */
	clear(): Promise<void> {
		return this.#updates.run(() => this.#store.clear());
	}
}

/** 取出（没有就建一个）`issuer` 名下的凭据。 */
export function credentialsOf(
	state: OAuthState,
	issuer: string,
): IssuerCredentials {
	state.issuers[issuer] ??= {};
	return state.issuers[issuer];
}

/** 现在用的授权服务器发的令牌。 */
export function currentTokens(
	state: OAuthState,
): StoredOAuthTokens | undefined {
	return state.current === undefined
		? undefined
		: state.issuers[state.current]?.tokens;
}
