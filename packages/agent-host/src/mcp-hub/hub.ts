import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	connectHttp,
	connectStdio,
	type ElicitationAnswer,
	type ElicitationRequest,
	type JsonValue,
	type McpAuth,
	type McpConnection,
	McpError,
	type McpTool,
	type McpToolResult,
} from "@ospreycode/mcp";
import { mcpToolName, type SessionServer } from "../extensions/catalog.js";
import { cacheEnvironment } from "../processes/environment.js";
import type { ExtensionSandbox } from "../processes/extension-sandbox.js";
import type { ProcessTracker } from "../processes/registry.js";
import { ensureDirectory } from "../project/workspace.js";
import type { ProcessEvent } from "../sessions/events.js";
import { VerdictCache } from "./verdicts.js";

/**
 * 握手不另外计时，交给启动超时：它在等用户回答网络询问时暂停，SDK 自己的 60 秒不会。
 * 这是定时器能表示的最大值。
 */
const handshakeTimeoutMs = 2 ** 31 - 1;

/** server 中途退出后，一个 session 里最多重启几次。 */
const maxRestarts = 3;

/** 为诊断保留的 stderr 的长度：启动失败时附在原因后面。 */
const stderrTailBytes = 2048;

/** 收尾进程监视的文件描述符：启动脚本把 stderr 复制到它上面。 */
const reaperFd = 9;

/**
 * server 在这个 session 里的状态：
 *
 * - `connected`：已连接
 * - `needs_login`：远程 server 要求授权，而凭据库里没有能用的令牌
 * - `failed`：启动或连接失败、启动超时、内容和确认时不一致，原因在 `detail`
 * - `exited`：中途退出了，下次调用它的工具时重启
 */
export type McpServerStatus = "connected" | "needs_login" | "failed" | "exited";

/** 一个 MCP server 在这个 session 里的情况，给 CLI 显示。 */
export interface McpServerState {
	id: string;
	label: string;
	transport: "stdio" | "streamable-http";
	status: McpServerStatus;
	/** 状态的说明：失败的原因、登录命令的提示。 */
	detail?: string;
	/** 协商出的协议版本。 */
	protocol_version?: string;
	/** 模型看到的工具名。 */
	tools: string[];
}

/** 交给 runtime 的一个 MCP 工具。 */
export interface HubTool {
	/** 模型看到的名字：标签加 `__` 再加工具名。 */
	name: string;
	server: SessionServer;
	tool: McpTool;
}

/** 连接一个 server 用的凭据。 */
export interface ServerCredentials {
	/** 凭据身份：协议探测的结果按它分开保存，不含凭据本身。 */
	identity: string;
	/** 远程 server 的授权方式；没有保存过令牌时为空。 */
	auth?: McpAuth;
}

/** MCP server 集合用到的依赖。 */
export interface McpHubOptions {
	/** 向 server 自报的客户端名字和版本。 */
	client: { name: string; version: string };
	workspace: string;
	/** 本地 server 的基础环境变量（`PATH`、`HOME`、`TMPDIR`），定义里的 `env` 盖在它上面。 */
	env: () => Record<string, string>;
	/** 一个本地 server 的沙盒；`danger-full-access` 下为空，直接启动。 */
	sandbox: (server: SessionServer) => Promise<ExtensionSandbox | undefined>;
	/**
	 * 没有沙盒时一个本地 server 的密钥：没有代理替它换成真实值，真实值直接放进环境变量。
	 * 有沙盒时不调用，沙盒里只有占位值。
	 */
	plainSecrets: (server: SessionServer) => Promise<Record<string, string>>;
	credentials: (server: SessionServer) => Promise<ServerCredentials>;
	/** 连接远程 server 用的 `fetch`：和模型请求用同一个，用户配的代理对它同样有效。 */
	fetch: typeof globalThis.fetch;
	verdicts: VerdictCache;
	tracker: ProcessTracker;
	/** 等每个 server 就绪的时限（毫秒）：到时还没连上的停掉，session 照常打开。 */
	startupTimeoutMs: () => number;
	/** 把 server 的提问交给用户；非交互模式不给，也就不向 server 声明这项能力。 */
	elicit?: (
		server: SessionServer,
		request: ElicitationRequest,
		context: { signal: AbortSignal },
	) => Promise<ElicitationAnswer>;
	/** 工具集变了：server 发了 list_changed，或者重启后列出的工具和之前不一样。 */
	onToolsChanged: () => void;
	onProcess: (event: ProcessEvent) => void;
	onWarning: (message: string) => void;
}

/** 调用失败：server 不可用，或者协议、传输出了错。消息是给模型看的英文。 */
export class McpCallError extends Error {
	override name = "McpCallError";
	/** 失败是不是因为调用被取消。 */
	readonly cancelled: boolean;

	constructor(message: string, cancelled = false, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.cancelled = cancelled;
	}
}

/** 能暂停的时限：等用户回答网络访问的询问期间不计时。 */
class Deadline {
	readonly signal: AbortSignal;
	#controller = new AbortController();
	#remaining: number;
	#started = 0;
	#timer: NodeJS.Timeout | undefined;
	#paused = 0;

	constructor(ms: number) {
		this.#remaining = ms;
		this.signal = this.#controller.signal;
		this.#run();
	}

	#run(): void {
		this.#started = Date.now();
		this.#timer = setTimeout(
			() => this.#controller.abort(),
			this.#remaining,
		).unref();
	}

	/** 暂停计时，调用返回的函数后继续。 */
	pause(): () => void {
		if (this.#paused === 0) {
			clearTimeout(this.#timer);
			this.#remaining -= Date.now() - this.#started;
		}
		this.#paused += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#paused -= 1;
			if (this.#paused === 0 && !this.signal.aborted) this.#run();
		};
	}

	clear(): void {
		clearTimeout(this.#timer);
	}
}

interface Entry {
	spec: SessionServer;
	status: McpServerStatus;
	detail?: string;
	connection?: McpConnection;
	tools: McpTool[];
	restarts: number;
	sandbox?: ExtensionSandbox;
	pid?: number;
	/** 正在进行的启动：同时到来的调用等同一次。 */
	starting?: Promise<void>;
	deadline?: Deadline;
	/** 启动停在了等用户回答上：打开 session 时不再等它。 */
	asked?: () => void;
	/** 最近的 stderr，诊断用。 */
	stderr: string;
}

/**
 * 建好数据目录、缓存目录和它们上面还不存在的各级目录：独立 server 的数据目录在
 * `server-data/<范围>/` 下面，这几层都是第一次用到时才建。
 */
function ensureNested(path: string): void {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
		ensureNested(dirname(path));
	}
	ensureDirectory(path);
}

function shellQuote(words: readonly string[]): string {
	return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

function sameTools(left: McpTool[], right: McpTool[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 一个 session 的全部 MCP server：打开 session 时并行启动，活到 session 关闭。本地 server 各自在
 * 沙盒里运行；工具调用由 Host 检查获准后经这里发给 server。
 */
export class McpHub {
	#options: McpHubOptions;
	#entries = new Map<string, Entry>();
	#stopped = new AbortController();

	constructor(options: McpHubOptions) {
		this.#options = options;
	}

	/**
	 * 换上一组 server：定义没变而且连着的继续运行，其余的停掉，新增、改动过和上次没连上的启动。`restartLocal` 为真时
	 * 本地 server 一律重启（它们的沙盒换了）。等每个新启动的 server 就绪、失败、超时或者停在等用户
	 * 回答网络访问的询问上之后返回：前端要等 session 打开才能回答，停在询问上的 server 在后台接着
	 * 启动，就绪后它的工具经 `onToolsChanged` 加入。单个 server 失败只记在它的状态里。
	 */
	async reconcile(
		servers: readonly SessionServer[],
		restartLocal = false,
	): Promise<void> {
		const wanted = new Map(servers.map((server) => [server.id, server]));
		const stopping: Promise<void>[] = [];
		for (const [id, entry] of this.#entries) {
			const next = wanted.get(id);
			if (
				next !== undefined &&
				!(restartLocal && entry.spec.definition.transport === "stdio") &&
				next.definitionHash === entry.spec.definitionHash &&
				next.label === entry.spec.label &&
				// 没连上的重新来一次：用户可能刚在另一个终端登录，或者修好了启动失败的原因
				entry.status !== "needs_login" &&
				entry.status !== "failed"
			) {
				// 确认状态可能变了：核对内容用新的
				entry.spec = next;
				wanted.delete(id);
				continue;
			}
			this.#entries.delete(id);
			stopping.push(this.#close(entry));
		}
		await Promise.all(stopping);
		const starting: Promise<void>[] = [];
		for (const spec of wanted.values()) {
			const entry: Entry = {
				spec,
				status: "exited",
				tools: [],
				restarts: 0,
				stderr: "",
			};
			this.#entries.set(spec.id, entry);
			const asked = Promise.withResolvers<boolean>();
			entry.asked = () => asked.resolve(true);
			const started = this.#start(entry);
			entry.starting = started;
			starting.push(Promise.race([started, asked.promise]).then(() => {}));
			void started.then(async () => {
				asked.resolve(false);
				entry.asked = undefined;
				if ((await asked.promise) && entry.tools.length > 0) {
					this.#options.onToolsChanged();
				}
			});
		}
		await Promise.all(starting);
	}

	/** 各个 server 的状态，按标签排序。 */
	states(): McpServerState[] {
		return [...this.#entries.values()]
			.map((entry) => ({
				id: entry.spec.id,
				label: entry.spec.label,
				transport: entry.spec.definition.transport,
				status: entry.status,
				...(entry.detail === undefined ? {} : { detail: entry.detail }),
				...(entry.connection === undefined
					? {}
					: { protocol_version: entry.connection.protocolVersion }),
				tools: entry.tools.map((tool) =>
					mcpToolName(entry.spec.label, tool.name),
				),
			}))
			.sort((a, b) => (a.label < b.label ? -1 : 1));
	}

	/** 现在能用的全部工具，按名字排序：顺序固定，提示缓存才稳定。 */
	tools(): HubTool[] {
		const tools: HubTool[] = [];
		for (const entry of this.#entries.values()) {
			for (const tool of entry.tools) {
				tools.push({
					name: mcpToolName(entry.spec.label, tool.name),
					server: entry.spec,
					tool,
				});
			}
		}
		return tools.sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	/** 按模型看到的名字找工具。 */
	find(name: string): HubTool | undefined {
		for (const entry of this.#entries.values()) {
			const prefix = `${entry.spec.label}__`;
			if (!name.startsWith(prefix)) continue;
			const tool = entry.tools.find(
				(candidate) => candidate.name === name.slice(prefix.length),
			);
			if (tool !== undefined) return { name, server: entry.spec, tool };
		}
		return undefined;
	}

	/**
	 * 等用户回答这个 server 的网络访问询问期间调用：暂停它的启动计时，调用返回的函数后继续。
	 * server 不在启动中时什么也不做。
	 */
	pauseStartup(serverId: string): () => void {
		const entry = this.#entries.get(serverId);
		entry?.asked?.();
		return entry?.deadline?.pause() ?? (() => {});
	}

	/**
	 * 调用一个工具。server 中途退出过就先重启它（每个 session 最多 3 次）。工具自己报的错在结果的
	 * `isError` 里；其余的失败抛 `McpCallError`。
	 */
	async call(
		tool: HubTool,
		args: Record<string, JsonValue>,
		options: {
			signal: AbortSignal;
			onProgress?: (progress: {
				progress: number;
				total?: number;
				message?: string;
			}) => void;
		},
	): Promise<McpToolResult> {
		const entry = this.#entries.get(tool.server.id);
		if (entry === undefined || entry.spec !== tool.server) {
			throw new McpCallError(
				`The MCP server ${tool.server.label} is no longer enabled in this session.`,
			);
		}
		if (entry.connection === undefined) {
			if (entry.status !== "exited") {
				throw new McpCallError(
					`The MCP server ${entry.spec.label} is not available: ${entry.detail ?? entry.status}`,
				);
			}
			if (entry.restarts >= maxRestarts) {
				throw new McpCallError(
					`The MCP server ${entry.spec.label} exited and has already been restarted ${maxRestarts} times in this session; it will not be restarted again.`,
				);
			}
			if (entry.starting === undefined) {
				entry.restarts += 1;
				const before = entry.tools;
				entry.starting = this.#start(entry).then(() => {
					if (!sameTools(before, entry.tools)) this.#options.onToolsChanged();
				});
			}
			await entry.starting;
		}
		const { connection } = entry;
		if (connection === undefined) {
			throw new McpCallError(
				`The MCP server ${entry.spec.label} could not be restarted: ${entry.detail ?? entry.status}`,
			);
		}
		try {
			return await connection.callTool(
				{ name: tool.tool.name, arguments: args },
				{
					signal: options.signal,
					...(options.onProgress === undefined
						? {}
						: { onProgress: options.onProgress }),
				},
			);
		} catch (error) {
			if (!(error instanceof McpError)) throw error;
			throw new McpCallError(
				this.#describe(entry, error),
				error.kind === "cancelled",
				error,
			);
		}
	}

	/** 关闭全部 server：先关 stdin，不退出再依次发 SIGTERM、SIGKILL，最后结束沙盒实例里剩下的进程。 */
	async stop(): Promise<void> {
		this.#stopped.abort();
		const entries = [...this.#entries.values()];
		this.#entries.clear();
		await Promise.all(entries.map((entry) => this.#close(entry)));
	}

	/** 把协议和传输的失败写成给模型看的话。 */
	#describe(entry: Entry, error: McpError): string {
		const { label } = entry.spec;
		switch (error.kind) {
			case "unauthorized":
				return `The MCP server ${label} requires the user to log in. Ask the user to run \`ospreycode mcp login ${label}\` in another terminal, then try again.`;
			case "insufficient_scope":
				return `The MCP server ${label} requires more permissions than the saved login has${error.requiredScope === undefined ? "" : ` (scope: ${error.requiredScope})`}. Ask the user to run \`ospreycode mcp login ${label}\` in another terminal, then try again.`;
			case "timeout":
				return `The MCP server ${label} did not answer in time.`;
			case "cancelled":
				return "The call was cancelled.";
			case "closed":
				return `The MCP server ${label} exited during the call. The call may or may not have taken effect; it was not sent again.`;
			case "protocol":
				return `The MCP server ${label} returned an error${error.code === undefined ? "" : ` (code ${error.code})`}: ${error.message}`;
			case "transport":
				return `The connection to the MCP server ${label} failed: ${error.message}`;
		}
	}

	async #start(entry: Entry): Promise<void> {
		const { spec } = entry;
		const startupTimeoutMs = this.#options.startupTimeoutMs();
		const deadline = new Deadline(startupTimeoutMs);
		entry.deadline = deadline;
		entry.detail = undefined;
		entry.stderr = "";
		const signal = AbortSignal.any([deadline.signal, this.#stopped.signal]);
		try {
			const changed = spec.verify();
			if (changed !== undefined) throw new Error(changed);
			const connection = await this.#connect(entry, signal);
			entry.connection = connection;
			entry.tools = await connection.listTools({ signal });
			entry.status = "connected";
		} catch (error) {
			const connection = entry.connection;
			entry.connection = undefined;
			await connection?.close();
			await this.#exited(entry);
			if (error instanceof McpError && error.kind === "unauthorized") {
				entry.status = "needs_login";
				entry.detail =
					process.platform === "linux"
						? `需要授权。Linux 上不支持 OAuth 登录；server 接受静态令牌时用 --credential-file mcp:${spec.label}=<文件> 提供`
						: `需要登录：运行 ospreycode mcp login ${spec.label}`;
			} else {
				entry.status = "failed";
				// 第一次用 `npx`、`uvx` 启动要下载包，慢的网络上会超时：告诉用户怎么放宽
				const reason = deadline.signal.aborted
					? `启动超过了 ${startupTimeoutMs / 1000} 秒（用户级配置的 mcp_startup_timeout_sec 可以调大）`
					: (error as Error).message;
				const stderr = entry.stderr.trim();
				entry.detail = stderr === "" ? reason : `${reason}\n${stderr}`;
			}
			entry.tools = [];
			if (!this.#stopped.signal.aborted) {
				this.#options.onWarning(
					`MCP server ${spec.label} 没有启用：${entry.detail}`,
				);
			}
		} finally {
			deadline.clear();
			entry.deadline = undefined;
			entry.starting = undefined;
		}
	}

	async #connect(entry: Entry, signal: AbortSignal): Promise<McpConnection> {
		const { spec } = entry;
		const { verdicts } = this.#options;
		const credentials = await this.#options.credentials(spec);
		const key = VerdictCache.key(spec.definitionHash, credentials.identity);
		const prior = verdicts.get(key);
		const elicit = this.#options.elicit;
		const open = async (verdict: typeof prior): Promise<McpConnection> => {
			const options = {
				client: this.#options.client,
				...(verdict === undefined ? {} : { prior: verdict }),
				signal,
				handshakeTimeoutMs,
				...(elicit === undefined
					? {}
					: {
							elicit: (
								request: ElicitationRequest,
								context: { signal: AbortSignal },
							) => elicit(entry.spec, request, context),
						}),
				onToolsChanged: () => void this.#refresh(entry),
				onClose: () => void this.#dropped(entry),
			};
			if (spec.definition.transport === "streamable-http") {
				return await connectHttp(
					{
						url: spec.definition.url,
						headers: spec.definition.headers,
						fetch: this.#options.fetch,
						...(credentials.auth === undefined
							? {}
							: { auth: credentials.auth }),
					},
					options,
				);
			}
			return await this.#launch(entry, options);
		};
		let connection: McpConnection;
		try {
			connection = await open(prior);
		} catch (error) {
			// 判为新版本的结果连不上时作废，重新探测一次：server 可能换成了旧版本
			if (
				prior?.era !== "modern" ||
				signal.aborted ||
				(error instanceof McpError && error.kind === "unauthorized")
			) {
				throw error;
			}
			await verdicts.delete(key);
			await this.#exited(entry);
			connection = await open(undefined);
		}
		await verdicts.set(key, connection.verdict);
		return connection;
	}

	async #launch(
		entry: Entry,
		options: Parameters<typeof connectStdio>[1],
	): Promise<McpConnection> {
		const { spec } = entry;
		const { definition, directories } = spec;
		if (definition.transport !== "stdio") {
			throw new Error("只有本地 server 需要启动进程");
		}
		// 规范要求启动前建好数据目录；Linux 上不存在的路径也没法挂进沙盒
		ensureNested(directories.pluginData);
		ensureNested(directories.cache);
		entry.sandbox ??= await this.#options.sandbox(spec);
		const { sandbox } = entry;
		const env = {
			...this.#options.env(),
			// `npx`、`uvx` 这类启动方式要写包管理器的缓存，沙盒里主目录不可写：指到 server 自己的缓存目录里
			...cacheEnvironment(directories.cache),
			// `uvx` 另外要写工具的环境和它下载的 Python，默认在主目录的 `~/.local/share/uv/` 里
			UV_TOOL_DIR: join(directories.cache, "uv-tools"),
			UV_PYTHON_INSTALL_DIR: join(directories.cache, "uv-python"),
			OSPREYCODE_WORKSPACE: this.#options.workspace,
			...definition.env,
			...(sandbox === undefined ? await this.#options.plainSecrets(spec) : {}),
			PLUGIN_ROOT: directories.pluginRoot,
			PLUGIN_DATA: directories.pluginData,
		};
		let command = definition.command;
		let args = definition.args;
		if (sandbox !== undefined) {
			const argv = await sandbox.wrap(
				shellQuote([definition.command, ...definition.args]),
				reaperFd,
			);
			// SDK 的 stdio 传输总会并入 Host 的这几个环境变量：不在白名单里的在这里去掉
			const unset = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]
				.filter((name) => !(name in env))
				.join(" ");
			command = "/bin/sh";
			args = [
				"-c",
				[
					...(unset === "" ? [] : [`unset ${unset}`]),
					// 这个传输只有三个标准流：收尾进程监视 stderr 的连接，Host 关掉它就结束实例。
					// SDK 探测协议版本用的兄弟进程没有 stderr 管道（接的是 /dev/null，收尾进程会立刻
					// 读到结束、把探测杀掉）：它监视 stdout 的连接，SDK 结束探测后会关掉这个连接
					...(sandbox.reaper
						? [
								`if [ -S /dev/fd/2 ]; then exec ${reaperFd}<&2; else exec ${reaperFd}<&1; fi`,
							]
						: []),
					'exec "$@"',
				].join("; "),
				"sh",
				...argv,
			];
		}
		const connection = await connectStdio(
			{
				command,
				args,
				env,
				cwd: definition.cwd,
				onStderr: (text) => {
					entry.stderr = (entry.stderr + text).slice(-stderrTailBytes);
				},
			},
			options,
		);
		const { pid } = connection;
		if (pid !== undefined) {
			entry.pid = pid;
			await this.#options.tracker.add(pid, "mcp_server");
			this.#options.onProcess({
				type: "process.started",
				kind: "mcp_server",
				pid,
			});
		}
		return connection;
	}

	/** server 的进程结束之后：从进程登记表里去掉，清理沙盒实例。 */
	async #exited(entry: Entry): Promise<void> {
		const { pid } = entry;
		if (pid !== undefined) {
			entry.pid = undefined;
			await this.#options.tracker.remove(pid);
			this.#options.onProcess({
				type: "process.exited",
				kind: "mcp_server",
				pid,
				// SDK 不给出退出码
				exit_code: null,
				signal: null,
			});
		}
		await entry.sandbox?.cleanup();
	}

	/** 连接断了：server 退出或传输关闭。 */
	async #dropped(entry: Entry): Promise<void> {
		if (entry.connection === undefined) return;
		const connection = entry.connection;
		entry.connection = undefined;
		entry.status = "exited";
		entry.detail = "server 退出了，下次调用它的工具时重启";
		// 收尾进程靠 Host 关掉 stderr 的连接察觉：进程自己退出时也要关
		await connection.close();
		await this.#exited(entry);
		if (this.#entries.get(entry.spec.id) === entry) {
			this.#options.onWarning(
				`MCP server ${entry.spec.label} 退出了，下次调用它的工具时重启（每个 session 最多 ${maxRestarts} 次）。`,
			);
		}
	}

	/** server 说工具列表变了：重新列出。 */
	async #refresh(entry: Entry): Promise<void> {
		const { connection } = entry;
		if (connection === undefined || entry.status !== "connected") return;
		let tools: McpTool[];
		try {
			tools = await connection.listTools({ signal: this.#stopped.signal });
		} catch (error) {
			if (!(error instanceof McpError)) throw error;
			if (!this.#stopped.signal.aborted && error.kind !== "closed") {
				this.#options.onWarning(
					`MCP server ${entry.spec.label} 的工具列表没能更新：${error.message}`,
				);
			}
			return;
		}
		if (entry.connection !== connection || sameTools(entry.tools, tools)) {
			return;
		}
		entry.tools = tools;
		this.#options.onToolsChanged();
	}

	async #close(entry: Entry): Promise<void> {
		await entry.starting;
		const { connection } = entry;
		entry.connection = undefined;
		entry.tools = [];
		await connection?.close();
		await this.#exited(entry);
		await entry.sandbox?.stop();
	}
}
