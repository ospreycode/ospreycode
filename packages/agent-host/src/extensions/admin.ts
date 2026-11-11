import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpSchemaIds, parseMcpConfig } from "@ospreycode/agent-plugins";
import { ConfigError } from "../config/errors.js";
import type { CredentialSource } from "../credentials/sources.js";
import { userLayer } from "../credentials/status.js";
import type {
	McpCredentialContext,
	McpCredentialKind,
	McpCredentials,
} from "../mcp-hub/credentials.js";
import type { ProcessIdentity } from "../processes/info.js";
import { projectKey, type Registry } from "../project/identity.js";
import { withFileLock, writeFileAtomic } from "../project/locks.js";
import { findProjectRoot, resolveWorkspace } from "../project/workspace.js";
import {
	type ExtensionInfo,
	type ExtensionLocations,
	type LoadedExtensions,
	loadExtensions,
	normalizeLabel,
	type SessionServer,
} from "./catalog.js";
import type {
	PluginInfo,
	PluginOrigin,
	PluginStage,
	PluginStore,
} from "./plugins.js";
import type { TrustStore } from "./trust.js";

/** 一个工作区里找到的扩展。 */
export interface ExtensionList {
	/** 每个扩展的来源、版本和状态。 */
	items: ExtensionInfo[];
	/** 要提示用户的话：没确认的仓库扩展、被跳过的条目、加载失败的原因。 */
	warnings: string[];
}

/** 管理 MCP 凭据的命令共用的参数。 */
export interface McpCredentialOptions {
	/** 工作区：项目级 `mcp.json` 里的 server 按它找。 */
	workspace: string;
	/** MCP server 的标签。 */
	label: string;
	/** 启动参数指定的凭据来源（`--credential-file`），键是凭据的 ID。 */
	credentials?: Readonly<Record<string, CredentialSource>>;
}

/** 扩展管理用到的依赖。 */
export interface ExtensionAdminOptions {
	/** Host 根目录。 */
	root: string;
	/** Host 根目录下的 `data/`。 */
	data: string;
	owner: ProcessIdentity;
	home: string | undefined;
	registry: Registry;
	trust: TrustStore;
	plugins: PluginStore;
	credentials: McpCredentials;
}

/** 新写的 `mcp.json` 声明的规范版本。 */
const mcpSchema = Object.keys(mcpSchemaIds)[0] as string;

/**
 * 不打开 session 的扩展管理（`ospreycode mcp`、`plugin`、`trust`、`hooks` 这些子命令）：查看扩展，
 * 确认、启用和停用，安装、更新和卸载插件，改用户级的 `mcp.json`，保存 MCP 的凭据。确认记录保存在
 * 沙盒读写不到的地方，只有这里和交互界面能替用户确认。
 */
export class ExtensionAdmin {
	#options: ExtensionAdminOptions;

	constructor(options: ExtensionAdminOptions) {
		this.#options = options;
	}

	/** 查找扩展用到的位置；目录不存在时抛出 `WorkspaceError`。 */
	async locations(directory: string): Promise<ExtensionLocations> {
		const { root, home, registry } = this.#options;
		const workspace = resolveWorkspace(directory);
		const projectRoot = findProjectRoot(workspace).root;
		return {
			root,
			home,
			workspace,
			projectRoot,
			projectId: await registry.projectId(projectKey(projectRoot)),
		};
	}

	async #load(directory: string): Promise<LoadedExtensions> {
		return loadExtensions(await this.locations(directory), this.#options.trust);
	}

	async #find(directory: string, id: string): Promise<ExtensionInfo> {
		const item = (await this.#load(directory)).items.find(
			(candidate) => candidate.id === id,
		);
		if (item === undefined) throw new ConfigError(`没有这个扩展：${id}`);
		return item;
	}

	/** 一个工作区里找到的全部扩展和它们的状态。不执行扩展里的任何东西，也不联网。 */
	async list(directory: string): Promise<ExtensionList> {
		const { items, warnings } = await this.#load(directory);
		return { items, warnings };
	}

	/**
	 * 记下用户确认了一个仓库自带的扩展现在的内容：`hash` 是用户审阅时看到的那一份（`ExtensionInfo`
	 * 里的），和现在的内容不一样时抛出 `ConfigError`，要重新审阅。只有仓库自带的扩展这样确认：
	 * 用户自己安装的不用确认，插件在安装和更新时确认。
	 */
	async confirm(directory: string, id: string, hash: string): Promise<void> {
		const item = await this.#find(directory, id);
		if (item.origin !== "project") {
			throw new ConfigError(
				item.origin === "plugin"
					? `${id} 属于插件：用 ospreycode plugin update 重新确认`
					: `${id} 是用户自己安装的扩展，不用确认`,
			);
		}
		if (item.hash === undefined) {
			throw new ConfigError(`${id} 加载失败，没法确认：${item.detail ?? ""}`);
		}
		if (item.hash !== hash) {
			throw new ConfigError(`${id} 的内容在审阅之后又变了：重新审阅后再确认`);
		}
		await this.#options.trust.confirm(id, hash);
	}

	/** 启用或停用一个扩展；确认过的内容保留。没有这个扩展时抛出 `ConfigError`。 */
	async setEnabled(
		directory: string,
		id: string,
		enabled: boolean,
	): Promise<void> {
		await this.#find(directory, id);
		await this.#options.trust.setEnabled(id, enabled);
	}

	/** 已安装的插件，按名字排序。 */
	plugins(): PluginInfo[] {
		return this.#options.plugins.list();
	}

	/**
	 * 准备安装一个插件：取来内容、按规范校验，列出它带的组件。这时还没有生效，用户确认后调用
	 * 返回值的 `commit()`，不确认调用 `discard()`。
	 */
	stagePlugin(origin: PluginOrigin): Promise<PluginStage> {
		return this.#options.plugins.stage(origin);
	}

	/** 准备更新一个已安装的插件：从安装时的来源再取一次，列出相对已安装版本的变化。 */
	stagePluginUpdate(name: string): Promise<PluginStage> {
		const { plugins } = this.#options;
		return plugins.stage(plugins.originOf(name));
	}

	/** 卸载一个插件；`deleteData` 为真时连它的数据目录一起删。没有安装时返回 false。 */
	removePlugin(name: string, deleteData: boolean): Promise<boolean> {
		return this.#options.plugins.remove(name, deleteData);
	}

	#userMcpFile(): string {
		return join(this.#options.root, "mcp.json");
	}

	#readUserMcp(): Record<string, unknown> {
		let text: string;
		try {
			text = readFileSync(this.#userMcpFile(), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return {};
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			throw new ConfigError(
				`${this.#userMcpFile()} 不是合法的 JSON：${(error as Error).message}`,
			);
		}
		const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
		if (typeof servers !== "object" || servers === null) {
			throw new ConfigError(`${this.#userMcpFile()} 里没有 mcpServers`);
		}
		return servers as Record<string, unknown>;
	}

	#writeUserMcp(servers: Record<string, unknown>): void {
		writeFileAtomic(
			this.#userMcpFile(),
			`${JSON.stringify({ $schema: mcpSchema, mcpServers: servers }, null, "\t")}\n`,
		);
	}

	#lockUserMcp<T>(run: () => T): Promise<T> {
		const { data, owner } = this.#options;
		return withFileLock(join(data, "locks", "mcp-config.lock"), owner, run);
	}

	/**
	 * 往用户级的 `mcp.json` 里加一个 server（`ospreycode mcp add`）：`entry` 是这个 server 在
	 * `mcpServers` 里的写法。同名的已经有了，或者这份配置不合规范时抛出 `ConfigError`，文件不变。
	 */
	addMcpServer(name: string, entry: Record<string, unknown>): Promise<void> {
		return this.#lockUserMcp(() => {
			const servers = this.#readUserMcp();
			if (name in servers) {
				throw new ConfigError(
					`用户级的 mcp.json 里已经有 ${name}：先用 ospreycode mcp remove 删掉`,
				);
			}
			const next = { ...servers, [name]: entry };
			const directory = join(
				this.#options.root,
				"server-data",
				"user",
				normalizeLabel(name),
			);
			const parsed = parseMcpConfig(
				JSON.stringify({ $schema: mcpSchema, mcpServers: next }),
				{ pluginRoot: directory, pluginData: directory, userLevel: true },
			);
			const problem = parsed.skipped.find((skipped) => skipped.name === name);
			if (problem !== undefined) throw new ConfigError(problem.message);
			this.#writeUserMcp(next);
		});
	}

	/** 从用户级的 `mcp.json` 里删掉一个 server；本来就没有时返回 false。 */
	removeMcpServer(name: string): Promise<boolean> {
		return this.#lockUserMcp(() => {
			const { [name]: removed, ...rest } = this.#readUserMcp();
			if (removed === undefined) return false;
			this.#writeUserMcp(rest);
			return true;
		});
	}

	async #server(
		options: McpCredentialOptions,
	): Promise<{ server: SessionServer; context: McpCredentialContext }> {
		const { root, home } = this.#options;
		const locations = await this.locations(options.workspace);
		const loaded = loadExtensions(locations, this.#options.trust);
		const server = loaded.servers.find(
			(candidate) => candidate.label === options.label,
		);
		if (server === undefined) {
			throw new ConfigError(
				`没有启用的 MCP server ${options.label}：用 ospreycode mcp list 查看；仓库自带的要先确认`,
			);
		}
		const user = userLayer(root, home);
		return {
			server,
			context: {
				workspace: locations.workspace,
				sources: { ...user.credentials, ...options.credentials },
				clients: user.mcp_clients ?? {},
				secrets: user.mcp_secrets ?? {},
			},
		};
	}

	/** 一个远程 MCP server 现在会用哪种凭据，不返回凭据的值。 */
	async mcpCredentialKind(
		options: McpCredentialOptions,
	): Promise<McpCredentialKind> {
		const { server, context } = await this.#server(options);
		return this.#options.credentials.kind(server, context);
	}

	/**
	 * 保存一个远程 MCP server 的静态令牌（`ospreycode mcp token`），已有的覆盖。令牌绑定到这个
	 * server 的配置范围、名字和确切的地址。没有系统凭据库的平台抛出 `CredentialError`。
	 */
	async saveMcpToken(
		options: McpCredentialOptions,
		token: string,
	): Promise<void> {
		const { server } = await this.#server(options);
		await this.#options.credentials.saveToken(server, token);
	}

	/** 删除一个标签下保存的静态令牌；本来就没有时返回 false。 */
	deleteMcpToken(label: string): Promise<boolean> {
		return this.#options.credentials.deleteToken(label);
	}

	/**
	 * 用户级配置给一个本地 MCP server 声明的密钥（`[mcp_secrets.<标签>]`）：环境变量名到真实值可以
	 * 发往的域名。不读也不返回密钥的值。
	 */
	async mcpSecretHosts(
		options: McpCredentialOptions,
	): Promise<Record<string, string[]>> {
		const { server, context } = await this.#server(options);
		return { ...context.secrets[server.label] };
	}

	/**
	 * 保存一个本地 MCP server 的密钥（`ospreycode mcp secret`），已有的覆盖。`name` 是 server 读它的
	 * 环境变量名，要先在用户级配置的 `[mcp_secrets.<标签>]` 里写明它可以发往哪些域名，否则抛出
	 * `ConfigError`。密钥绑定到这个 server 的配置范围和名字。没有系统凭据库的平台抛出 `CredentialError`。
	 */
	async saveMcpSecret(
		options: McpCredentialOptions,
		name: string,
		value: string,
	): Promise<void> {
		const { server, context } = await this.#server(options);
		if (server.definition.transport !== "stdio") {
			throw new ConfigError(
				`MCP server ${server.label} 是远程 server：它的静态令牌用 ospreycode mcp token 保存`,
			);
		}
		if (context.secrets[server.label]?.[name] === undefined) {
			throw new ConfigError(
				`用户级配置里没有声明 ${server.label} 的密钥 ${name}：先在 [mcp_secrets.${server.label}] 里写 ${name} = ["<域名>"]，写明它可以发往哪些域名`,
			);
		}
		await this.#options.credentials.saveSecret(server, name, value);
	}

	/** 删除一个标签下保存的一个密钥；本来就没有时返回 false。 */
	deleteMcpSecret(label: string, name: string): Promise<boolean> {
		return this.#options.credentials.deleteSecret(label, name);
	}

	/**
	 * OAuth 登录一个远程 MCP server（`ospreycode mcp login`）：监听本机的回调端口，把授权地址交给
	 * `onAuthorizationUrl`（调用方打开浏览器或显示给用户），等用户在浏览器里完成授权。失败时抛
	 * `McpError`（`@ospreycode/mcp`），已经保存的令牌不变。
	 */
	async mcpLogin(
		options: McpCredentialOptions,
		login: {
			onAuthorizationUrl: (url: string) => void | Promise<void>;
			signal?: AbortSignal;
		},
	): Promise<void> {
		const { server, context } = await this.#server(options);
		await this.#options.credentials.login(server, context, login);
	}

	/** 退出登录：删除一个标签下保存的 OAuth 状态，不向授权服务器撤销令牌。本来就没有时返回 false。 */
	mcpLogout(label: string): Promise<boolean> {
		return this.#options.credentials.logout(label);
	}
}
