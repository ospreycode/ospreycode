import type { BackendCapabilities } from "@ospreycode/sandbox";
import {
	type NetworkAnswer,
	type SandboxHelper,
	type SandboxPolicy,
	sandboxFilesystem,
	startSandboxHelper,
} from "@ospreycode/sandbox/backends";
import type { ProcessEvent } from "../sessions/events.js";
import type { PlaceholderRegistry } from "./placeholders.js";
import type { ProcessTracker } from "./registry.js";

/** 扩展的沙盒用到的依赖，和 session 的命令沙盒相同。 */
export interface ExtensionSandboxOptions {
	/** 沙盒辅助进程的入口文件。 */
	helperEntry: string;
	/** session 的沙盒策略：扩展的沙盒在它之上换模式、加读写路径，禁止读写的路径不变。 */
	policy: SandboxPolicy;
	capabilities: BackendCapabilities;
	/** 辅助进程的环境变量。 */
	env: Record<string, string>;
	bash: string;
	tracker: ProcessTracker;
	placeholders: PlaceholderRegistry;
	onWarning: (message: string) => void;
	onProcess: (event: ProcessEvent) => void;
}

/** 一个扩展的沙盒在 session 的策略之上的范围。 */
export interface ExtensionScope {
	/** 顶替 session 的沙盒策略：用户级 hooks 按它声明的 `permissions`。 */
	policy?: SandboxPolicy;
	/** 另外可读的路径（如插件的版本目录），可以在 Host 根目录里。 */
	read: readonly string[];
	/** 另外可写的路径（如插件的数据目录）。 */
	write: readonly string[];
}

/** 能联网的沙盒：预先放行和禁止的域名，以及名单之外的域名怎么回答。 */
export interface ExtensionNetwork {
	lists: { allowedDomains: string[]; deniedDomains: string[] };
	ask: (request: { host: string; port: number }) => Promise<NetworkAnswer>;
	/**
	 * 值要 mask 的环境变量：沙盒里只有占位值，这个沙盒的代理把请求发往 `hosts` 时换成真实值。
	 * 给了以后代理终止 TLS。
	 */
	secrets?: readonly { name: string; hosts: string[]; value: string }[];
}

/** 为一个扩展的进程生成沙盒的启动命令。 */
export interface ExtensionSandbox {
	/**
	 * 沙盒的完整启动命令。`reaperFd` 给出、并且这个平台靠收尾进程清理时，调用方要在这个文件描述符上
	 * 传入管道：关闭它，实例里的进程全部结束。
	 */
	wrap(command: string, reaperFd?: number): Promise<string[]>;
	/** 这个平台清理沙盒里的进程是不是靠收尾进程（macOS）。 */
	readonly reaper: boolean;
	/** 一个实例里的进程结束之后调用：Linux 上删掉 sandbox-runtime 为它放的占位。 */
	cleanup(): Promise<void>;
	/** 停掉这个沙盒自己的辅助进程；共用离线辅助进程的沙盒什么也不做。 */
	stop(): Promise<void>;
}

/**
 * 扩展（本地 MCP server 和 hooks）的沙盒：不联网的共用一个离线辅助进程，联网的各有自己的
 * 辅助进程和代理，连接才能准确归到这个扩展名下。
 */
export class ExtensionSandboxes {
	#options: ExtensionSandboxOptions;
	#offline: Promise<SandboxHelper> | undefined;
	#helpers = new Set<SandboxHelper>();
	#recorded = new Map<SandboxHelper, Promise<void>>();

	constructor(options: ExtensionSandboxOptions) {
		this.#options = options;
	}

	async #start(network?: ExtensionNetwork): Promise<SandboxHelper> {
		const { tracker, policy, onProcess } = this.#options;
		const secrets = network?.secrets ?? [];
		let pids: number[] = [];
		const helper = await startSandboxHelper({
			entry: this.#options.helperEntry,
			workspace: policy.workspace,
			tmpdir: policy.tmpdir,
			env: this.#options.env,
			scope:
				network === undefined
					? {}
					: {
							network: network.lists,
							...(secrets.length === 0
								? {}
								: {
										maskedEnv: secrets.map(({ name, hosts }) => ({
											name,
											hosts,
										})),
									}),
						},
			...(network === undefined ? {} : { ask: network.ask }),
			...(secrets.length === 0
				? {}
				: {
						secrets: Object.fromEntries(
							secrets.map(({ name, value }) => [name, value]),
						),
					}),
			onExit: () => {
				for (const pid of pids) void tracker.remove(pid);
			},
		});
		try {
			for (const pid of [helper.pid, ...helper.children]) {
				await tracker.add(pid, "helper");
				pids.push(pid);
			}
		} catch (error) {
			pids = [];
			await helper.stop();
			throw error;
		}
		const { pid } = helper;
		onProcess({ type: "process.started", kind: "helper", pid });
		this.#helpers.add(helper);
		this.#recorded.set(
			helper,
			helper.exited.then(({ code, signal }) => {
				this.#recorded.delete(helper);
				this.#helpers.delete(helper);
				if (this.#offline !== undefined) {
					// 离线辅助进程意外退出后，下一个沙盒换一个新的
					void this.#offline.then((offline) => {
						if (offline === helper) this.#offline = undefined;
					});
				}
				onProcess({
					type: "process.exited",
					kind: "helper",
					pid,
					exit_code: code,
					signal,
				});
			}),
		);
		return helper;
	}

	async #stopHelper(helper: SandboxHelper): Promise<void> {
		await helper.stop();
		for (const pid of [helper.pid, ...helper.children]) {
			await this.#options.tracker.remove(pid);
		}
		await this.#recorded.get(helper);
	}

	/** 一个扩展的沙盒。`network` 不给时不能联网。 */
	async create(
		scope: ExtensionScope,
		network?: ExtensionNetwork,
	): Promise<ExtensionSandbox> {
		const { capabilities, bash, placeholders, onWarning } = this.#options;
		const policy = scope.policy ?? this.#options.policy;
		const reaper = capabilities.process_cleanup === "reaper";
		let helper: SandboxHelper;
		if (network === undefined) {
			this.#offline ??= this.#start();
			helper = await this.#offline;
		} else {
			helper = await this.#start(network);
		}
		return {
			reaper,
			wrap: async (command, reaperFd) => {
				const filesystem = await sandboxFilesystem(
					policy,
					{
						kind: "command",
						read: [...scope.read],
						write: [...scope.write],
						escalated: false,
					},
					capabilities.platform,
				);
				if (filesystem.scanTimedOut) {
					onWarning(
						"扫描受保护的路径超时了：没扫到的位置在扩展的沙盒里不受保护。",
					);
				}
				await placeholders.record(filesystem.placeholders);
				return helper.wrap(
					command,
					bash,
					filesystem.rules,
					reaper && reaperFd !== undefined
						? { fd: reaperFd, close: [] }
						: undefined,
				);
			},
			cleanup: async () => {
				if (capabilities.platform === "linux" && this.#helpers.has(helper)) {
					await helper.cleanup();
				}
			},
			stop: async () => {
				if (network !== undefined) await this.#stopHelper(helper);
			},
		};
	}

	/** 停掉全部辅助进程。 */
	async stop(): Promise<void> {
		this.#offline = undefined;
		await Promise.all([...this.#helpers].map((h) => this.#stopHelper(h)));
	}
}
