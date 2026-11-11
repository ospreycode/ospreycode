import { createHash, randomUUID } from "node:crypto";
import {
	createOAuthSession,
	type OAuthSession,
	type OAuthStore,
} from "@ospreycode/mcp";
import type { McpClientLayer } from "../config/layer.js";
import {
	CredentialError,
	type CredentialSource,
	loadCredential,
} from "../credentials/sources.js";
import type { CredentialStore } from "../credentials/store.js";
import type { SessionServer } from "../extensions/catalog.js";
import type { ServerCredentials } from "./hub.js";

/**
 * 客户端元数据文件发布的地址，用 Client ID Metadata Documents 时它就是 `client_id`。
 * 要发布到这个地址的文件是本包的 `oauth/client-metadata.json`，测试核对它和这里的常量一致。
 */
export const clientMetadataUrl =
	"https://ospreycode.dev/oauth/client-metadata.json";

/** 向授权服务器自报的客户端名字。 */
export const oauthClientName = "Osprey Code";

/** 系统凭据库里保存的格式的版本。 */
const formatVersion = 1;

/** 远程 MCP server 的静态令牌的凭据 ID。 */
export function tokenCredentialId(label: string): string {
	return `mcp:${label}`;
}

/** 远程 MCP server 的 OAuth 状态在系统凭据库里的 ID。 */
export function oauthCredentialId(label: string): string {
	return `mcp-oauth:${label}`;
}

/** 本地 MCP server 的一个密钥的凭据 ID。 */
export function secretCredentialId(label: string, name: string): string {
	return `mcp:${label}:${name}`;
}

/** 本地 MCP server 的一个密钥：真实值只交给它的沙盒的代理，不进沙盒。 */
export interface ServerSecret {
	/** server 读它的环境变量名。 */
	name: string;
	/** 真实值可以发往的域名。 */
	hosts: string[];
	value: string;
}

/** 系统凭据库里一个本地 server 的密钥：绑定到扩展的标识（配置范围和 server 名）。 */
interface SavedSecret {
	version: number;
	server: string;
	value: string;
}

function parseSavedSecret(id: string, text: string): SavedSecret {
	const invalid = new CredentialError(
		`系统凭据库里的 ${id} 格式不对：重新保存它`,
	);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// 解析错误的消息里会带出一段原文，原文里有密钥
		throw invalid;
	}
	if (typeof value !== "object" || value === null) throw invalid;
	const { version, server, value: secret } = value as SavedSecret;
	if (
		version !== formatVersion ||
		typeof server !== "string" ||
		typeof secret !== "string"
	) {
		throw invalid;
	}
	return { version, server, value: secret };
}

/**
 * 凭据绑定的对象：扩展的标识里有配置范围和 server 名，再加上确切的地址。读出来的凭据和现在的
 * server 对不上就不用：仓库配置把同名 server 的地址改掉，引不走保存的令牌。
 */
interface Binding {
	server: string;
	url: string;
}

/** 系统凭据库里一个 MCP 凭据的内容。 */
interface Saved {
	version: number;
	binding: Binding;
	/** 每次保存或登录换一个：协议探测的结果按它分开保存，里面没有凭据本身。 */
	generation: string;
	value: string;
}

/** 一个远程 server 现在用哪种凭据。 */
export type McpCredentialKind = "none" | "token" | "oauth";

/** 解析凭据时用到的这次配置。 */
export interface McpCredentialContext {
	workspace: string;
	/** 启动参数和用户级配置指定的凭据来源，键是凭据的 ID。 */
	sources: Readonly<Record<string, CredentialSource>>;
	/** 预先注册的 OAuth 客户端，键是 server 的标签。 */
	clients: Readonly<Record<string, McpClientLayer>>;
	/** 本地 server 的密钥（`[mcp_secrets.<标签>]`）：server 的标签、环境变量名到可以发往的域名。 */
	secrets: Readonly<Record<string, Readonly<Record<string, string[]>>>>;
}

/** MCP 凭据用到的依赖。 */
export interface McpCredentialsOptions {
	/** 系统凭据库；没有的平台只能用显式指定的静态令牌。 */
	store: CredentialStore | undefined;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	/** 向授权服务器发请求用。 */
	fetch: typeof globalThis.fetch;
	/** Host 读进内存的令牌：日志、错误信息和事件里要去掉。 */
	onSecret: (value: string) => void;
}

function bindingOf(server: SessionServer): Binding {
	if (server.definition.transport !== "streamable-http") {
		throw new CredentialError(
			`MCP server ${server.label} 是本地 server，没有要保存的令牌`,
		);
	}
	// 比较前用 WHATWG URL 解析并取 href：写法不同的同一个地址算同一个
	return { server: server.id, url: new URL(server.definition.url).href };
}

function sameBinding(left: Binding, right: Binding): boolean {
	return left.server === right.server && left.url === right.url;
}

function parseSaved(id: string, text: string): Saved {
	const invalid = new CredentialError(
		`系统凭据库里的 ${id} 格式不对：重新保存它`,
	);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// 解析错误的消息里会带出一段原文，原文里有令牌
		throw invalid;
	}
	if (typeof value !== "object" || value === null) throw invalid;
	const { version, binding, generation, value: secret } = value as Saved;
	if (
		version !== formatVersion ||
		typeof binding !== "object" ||
		binding === null ||
		typeof binding.server !== "string" ||
		typeof binding.url !== "string" ||
		typeof generation !== "string" ||
		typeof secret !== "string"
	) {
		throw invalid;
	}
	return { version, binding, generation, value: secret };
}

/**
 * 远程 MCP server 的凭据：静态令牌和 OAuth 状态都存在系统凭据库里，绑定到配置范围、server 名和
 * 确切的地址；没有系统凭据库的平台只认启动参数或用户级配置指定来源的静态令牌。令牌只在 Host 的
 * 内存里，不进入任何沙盒。
 */
export class McpCredentials {
	#options: McpCredentialsOptions;

	constructor(options: McpCredentialsOptions) {
		this.#options = options;
	}

	async #read(id: string, binding: Binding): Promise<Saved | undefined> {
		const text = await this.#options.store?.get(id);
		if (text === undefined) return undefined;
		const saved = parseSaved(id, text);
		return sameBinding(saved.binding, binding) ? saved : undefined;
	}

	#requireStore(): CredentialStore {
		const { store } = this.#options;
		if (store === undefined) {
			throw new CredentialError(
				"这个平台没有系统凭据库：远程 MCP server 的静态令牌用 --credential-file mcp:<标签>=<文件> 提供，本地 server 的密钥用 --credential-file mcp:<标签>:<环境变量名>=<文件> 提供，不支持 OAuth 登录",
			);
		}
		return store;
	}

	/** OAuth 状态的存取：读出来的状态和这个 server 对不上时当作没有。 */
	#oauthStore(server: SessionServer): OAuthStore {
		const id = oauthCredentialId(server.label);
		const binding = bindingOf(server);
		return {
			load: async () => (await this.#read(id, binding))?.value,
			save: async (value) => {
				// 刷新令牌也走这里：登录的还是同一个账号，探测结果接着用
				const generation =
					(await this.#read(id, binding))?.generation ?? randomUUID();
				const saved: Saved = {
					version: formatVersion,
					binding,
					generation,
					value,
				};
				await this.#requireStore().set(id, JSON.stringify(saved));
			},
			clear: async () => {
				await this.#requireStore().delete(id);
			},
		};
	}

	/** 一个远程 server 的 OAuth 登录状态：连接、登录和退出登录都用它。 */
	oauthSession(
		server: SessionServer,
		context: McpCredentialContext,
	): OAuthSession {
		const { url } = bindingOf(server);
		const client = context.clients[server.label];
		return createOAuthSession({
			serverUrl: url,
			store: this.#oauthStore(server),
			client: {
				clientMetadataUrl,
				clientName: oauthClientName,
				...(client === undefined
					? {}
					: {
							preRegistered: {
								clientId: client.client_id,
								...(client.callback_port === undefined
									? {}
									: { callbackPort: client.callback_port }),
							},
						}),
			},
			fetch: this.#options.fetch,
		});
	}

	/**
	 * 连接一个 server 用的凭据。远程 server 依次看：启动参数或用户级配置给 `mcp:<标签>` 指定的来源、
	 * 系统凭据库里的静态令牌、系统凭据库里的 OAuth 状态；都没有就不带凭据去连。
	 */
	async connect(
		server: SessionServer,
		context: McpCredentialContext,
	): Promise<ServerCredentials> {
		if (server.definition.transport !== "streamable-http") {
			return { identity: "none" };
		}
		const id = tokenCredentialId(server.label);
		const source = context.sources[id];
		if (source !== undefined) {
			const { env, platform, onSecret } = this.#options;
			const loaded = loadCredential(id, source, {
				workspace: context.workspace,
				env,
				platform,
			});
			onSecret(loaded.value);
			return {
				// 来源没变就是同一个身份：文件里的令牌换了，探测结果也还能用
				identity: `source:${createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 16)}`,
				auth: {
					kind: "bearer",
					token: async () => {
						const value = loaded.reread?.() ?? loaded.value;
						onSecret(value);
						return value;
					},
				},
			};
		}
		const binding = bindingOf(server);
		const token = await this.#read(id, binding);
		if (token !== undefined) {
			this.#options.onSecret(token.value);
			return {
				identity: `token:${token.generation}`,
				auth: { kind: "bearer", token: async () => token.value },
			};
		}
		const oauth = await this.#read(oauthCredentialId(server.label), binding);
		if (oauth !== undefined) {
			return {
				identity: `oauth:${oauth.generation}`,
				auth: { kind: "oauth", session: this.oauthSession(server, context) },
			};
		}
		return { identity: "none" };
	}

	/**
	 * 一个本地 server 在配置里声明的密钥和它们的值，依次看启动参数或用户级配置给
	 * `mcp:<标签>:<环境变量名>` 指定的来源、系统凭据库。声明了却取不到值时抛 `CredentialError`：
	 * 不拿空值去启动 server。
	 */
	async secrets(
		server: SessionServer,
		context: McpCredentialContext,
	): Promise<ServerSecret[]> {
		if (server.definition.transport !== "stdio") return [];
		const { env, platform, onSecret, store } = this.#options;
		const result: ServerSecret[] = [];
		for (const [name, hosts] of Object.entries(
			context.secrets[server.label] ?? {},
		)) {
			const id = secretCredentialId(server.label, name);
			const source = context.sources[id];
			let value: string;
			if (source !== undefined) {
				({ value } = loadCredential(id, source, {
					workspace: context.workspace,
					env,
					platform,
				}));
			} else {
				const text = await store?.get(id);
				const saved =
					text === undefined ? undefined : parseSavedSecret(id, text);
				// 存的是别的配置范围里同名 server 的密钥时当作没有
				if (saved === undefined || saved.server !== server.id) {
					throw new CredentialError(
						`MCP server ${server.label} 的密钥 ${name} 还没有保存：用 ospreycode mcp secret ${server.label} ${name} 保存，或者用 --credential-file ${id}=<文件> 指定`,
					);
				}
				({ value } = saved);
			}
			onSecret(value);
			result.push({ name, hosts: [...hosts], value });
		}
		return result;
	}

	/** 保存一个本地 server 的密钥，已有的覆盖。 */
	async saveSecret(
		server: SessionServer,
		name: string,
		value: string,
	): Promise<void> {
		const saved: SavedSecret = {
			version: formatVersion,
			server: server.id,
			value,
		};
		await this.#requireStore().set(
			secretCredentialId(server.label, name),
			JSON.stringify(saved),
		);
	}

	/** 删除一个标签下保存的一个密钥；本来就没有时返回 false。 */
	deleteSecret(label: string, name: string): Promise<boolean> {
		return this.#requireStore().delete(secretCredentialId(label, name));
	}

	/** 一个远程 server 现在会用哪种凭据，不返回凭据的值。 */
	async kind(
		server: SessionServer,
		context: McpCredentialContext,
	): Promise<McpCredentialKind> {
		if (server.definition.transport !== "streamable-http") return "none";
		const id = tokenCredentialId(server.label);
		if (context.sources[id] !== undefined) return "token";
		const binding = bindingOf(server);
		if ((await this.#read(id, binding)) !== undefined) return "token";
		return (await this.#read(oauthCredentialId(server.label), binding)) ===
			undefined
			? "none"
			: "oauth";
	}

	/** 保存一个远程 server 的静态令牌，已有的覆盖。 */
	async saveToken(server: SessionServer, token: string): Promise<void> {
		const saved: Saved = {
			version: formatVersion,
			binding: bindingOf(server),
			generation: randomUUID(),
			value: token,
		};
		await this.#requireStore().set(
			tokenCredentialId(server.label),
			JSON.stringify(saved),
		);
	}

	/** 删除一个标签下保存的静态令牌；本来就没有时返回 false。 */
	deleteToken(label: string): Promise<boolean> {
		return this.#requireStore().delete(tokenCredentialId(label));
	}

	/**
	 * OAuth 登录（`ospreycode mcp login`）：成功后换一个身份标识，换了账号时协议探测的结果不沿用。
	 * 失败时抛 `McpError`，保存的令牌不变。
	 */
	async login(
		server: SessionServer,
		context: McpCredentialContext,
		options: {
			onAuthorizationUrl: (url: string) => void | Promise<void>;
			signal?: AbortSignal;
		},
	): Promise<void> {
		const store = this.#requireStore();
		await this.oauthSession(server, context).login(options);
		const id = oauthCredentialId(server.label);
		const saved = await this.#read(id, bindingOf(server));
		if (saved === undefined) {
			throw new Error("OAuth 登录成功后系统凭据库里没有保存的状态");
		}
		await store.set(id, JSON.stringify({ ...saved, generation: randomUUID() }));
	}

	/** 退出登录：删除一个标签下保存的 OAuth 状态；本来就没有时返回 false。 */
	logout(label: string): Promise<boolean> {
		return this.#requireStore().delete(oauthCredentialId(label));
	}
}
