import { realpathSync } from "node:fs";
import type { BackendCapabilities, CommandRequest } from "@ospreycode/sandbox";
import {
	type HelperScope,
	type NetworkAnswer,
	type SandboxHelper,
	type SandboxPolicy,
	type SandboxScope,
	SandboxUnavailableError,
	sandboxFilesystem,
	startSandboxHelper,
	verifySandboxBackend,
	writableRoots,
} from "@ospreycode/sandbox/backends";
import type {
	CommandLauncher,
	EditLauncher,
	SandboxLaunch,
	TaskGrants,
} from "../actions/tool-calls.js";
import { isInside } from "../project/paths.js";
import type { ProcessEvent } from "../sessions/events.js";
import type { SandboxedRunner } from "../workspace/git.js";
import type { ExtensionSandboxes } from "./extension-sandbox.js";
import { runGit } from "./git-runner.js";
import type { Placeholders } from "./placeholders.js";
import type { ProcessTracker } from "./registry.js";

/** agent 进程的收尾进程管道所在的文件描述符：fd 3 是通道。 */
export const agentReaperFd = 4;

/** 命令和 apply-edits 的收尾进程管道所在的文件描述符。 */
const commandReaperFd = 3;

/** 快照沙盒：在里面运行影子仓库的 git。 */
export interface SnapshotSandbox {
	run: SandboxedRunner;
	/** 快照沙盒能不能读这个路径（真实路径）：读不到的文件不保存进快照。 */
	canRead(path: string): boolean;
}

/**
 * 一个 session 的沙盒：agent 进程的启动命令、命令沙盒和 apply-edits 的启动方式，session 结束时
 * 停掉辅助进程。没有沙盒时没有可写范围之外的文件，也就没有 `edits`。
 */
export interface SessionSandbox {
	agentArgv: readonly string[];
	/** agent 进程的沙盒实例里有收尾进程（macOS）：启动时在 `agentReaperFd` 上传入它的管道。 */
	agentReaper: boolean;
	/** 沙盒后端的能力；没有沙盒时为空。 */
	capabilities?: BackendCapabilities;
	commands: CommandLauncher;
	edits?: EditLauncher;
	/**
	 * 扩展（本地 MCP server 和 hooks）的沙盒，以及它们在其上加读写路径的沙盒策略：和 agent 沙盒的
	 * 相同，只是不含别的插件的目录。没有沙盒时为空，扩展的进程由 Host 直接启动。
	 */
	extensions?: { sandboxes: ExtensionSandboxes; policy: SandboxPolicy };
	/**
	 * 快照沙盒：不能联网，只有影子仓库 `repository` 可写，还原时工作区也可写。没有沙盒时 git 由
	 * Host 直接运行，环境变量相同。
	 */
	snapshots(repository: string): Promise<SnapshotSandbox>;
	stop(): Promise<void>;
}

function shellQuote(words: readonly string[]): string {
	return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/** 这次调用申请并获准的额外权限；没有申请时为空。 */
function additional(request: CommandRequest) {
	return request.sandbox_permissions === "with_additional_permissions"
		? (request.additional_permissions ?? {})
		: {};
}

/** 一条命令的沙盒在策略之上的读写范围：本任务内批下来的，加上这次调用申请并获准的。 */
function commandScope(
	request: CommandRequest,
	grants: TaskGrants,
): Extract<SandboxScope, { kind: "command" }> {
	const requested = additional(request).file_system;
	return {
		kind: "command",
		read: [...grants.read, ...(requested?.read ?? [])],
		write: [...grants.write, ...(requested?.write ?? [])],
		escalated: request.sandbox_permissions === "require_escalated",
	};
}

/** `danger-full-access` 下没有沙盒：agent 进程和命令由 Host 直接启动，也没有收尾进程。 */
export function unsandboxedSession(
	agentCommand: readonly string[],
	bash: string,
): SessionSandbox {
	return {
		agentArgv: agentCommand,
		agentReaper: false,
		commands: {
			unsupported: () => undefined,
			launch: async (request) => ({
				argv: [bash, "-c", request.command],
				env: {},
				reaper: false,
				proxyLost: () => false,
				release: async () => {},
			}),
			summary: () => ({
				mode: "danger-full-access",
				writable_roots: ["/"],
				network: "unrestricted",
			}),
		},
		snapshots: async () => ({ run: runGit, canRead: () => true }),
		stop: async () => {},
	};
}

/** 启动沙盒的方式。 */
export interface SandboxedSessionOptions {
	/** 辅助进程的入口文件。 */
	helperEntry: string;
	policy: SandboxPolicy;
	/** 当前平台的沙盒后端的能力。 */
	capabilities: BackendCapabilities;
	env: Record<string, string>;
	bash: string;
	/** agent 进程的完整命令：Node 加入口文件。 */
	agentCommand: readonly string[];
	/** apply-edits 的完整命令：Node 加入口文件。 */
	applyEditsCommand: readonly string[];
	/** 辅助进程记进进程登记表。 */
	tracker: ProcessTracker;
	/** 权限规则预先放行和禁止的域名，编译成沙盒后端的名单。 */
	network: { allowedDomains: string[]; deniedDomains: string[] };
	/**
	 * 沙盒里的程序连接名单之外的域名时由它回答，连接挂起到它返回。连接来自某条命令自己的代理
	 * （越界执行的命令）时带上 `toolCallId`，否则只知道来自这个 session 的命令沙盒。
	 */
	ask: (
		request: { host: string; port: number },
		toolCallId?: string,
	) => Promise<NetworkAnswer>;
	/** Host 环境里的 `SSH_AUTH_SOCK`：模型申请符号 `ssh-agent` 时换成它。 */
	sshAuthSock?: string;
	/** Linux 上受保护路径的占位登记表。 */
	placeholders: Placeholders;
	/** 不影响继续运行的问题：辅助进程退出了，扫描受保护的名字超时了。 */
	onWarning: (message: string) => void;
	/** 随 session 存在的两个辅助进程启动和退出时调用，记成进程事件。 */
	onProcess: (event: ProcessEvent) => void;
}

/** 一个随 session 存在的辅助进程：退出后为后续的沙盒重新启动一个。 */
class HelperSlot {
	/** 每次辅助进程退出加一：运行中的命令据此知道自己的代理失效了。 */
	generation = 0;
	#helper: Promise<SandboxHelper> | undefined;
	#start: (onExit: (reason: string) => void) => Promise<SandboxHelper>;

	constructor(
		start: (onExit: (reason: string) => void) => Promise<SandboxHelper>,
	) {
		this.#start = start;
	}

	current(): Promise<SandboxHelper> {
		if (this.#helper === undefined) {
			const forget = () => {
				if (this.#helper === started) this.#helper = undefined;
			};
			const started: Promise<SandboxHelper> = this.#start(() => {
				this.generation += 1;
				forget();
			});
			this.#helper = started;
			// 启动失败时下一个沙盒再试一次，不把失败的结果留着
			started.catch(forget);
		}
		return this.#helper;
	}

	/** 现在的辅助进程；已经退出、还没有重新启动时为空。 */
	take(): Promise<SandboxHelper> | undefined {
		const helper = this.#helper;
		this.#helper = undefined;
		return helper;
	}
}

/**
 * 为 session 启动两个辅助进程：离线的为 agent 进程和 apply-edits 生成启动命令，不能联网；命令的
 * 为每条 shell 命令单独生成命令沙盒，名单之外的域名交给 Host 回答。批准的越界申请只加在这一条
 * 命令的沙盒上；`require_escalated`、Unix socket 和本地端口只能按进程设置，为这条命令单独启动
 * 一个辅助进程，命令结束后停掉。
 */
export async function sandboxedSession(
	options: SandboxedSessionOptions,
): Promise<SessionSandbox> {
	const { policy, bash, tracker, capabilities } = options;
	const { platform } = capabilities;
	const reaper = capabilities.process_cleanup === "reaper";
	const own = new Set<SandboxHelper>();
	/** 启动已经记成进程事件的辅助进程：退出事件记下之后兑现。 */
	const recorded = new Map<SandboxHelper, Promise<void>>();

	const start = async (
		scope: HelperScope,
		ask:
			| ((request: { host: string; port: number }) => Promise<NetworkAnswer>)
			| undefined,
		onExit: (reason: string) => void,
	) => {
		let pids: number[] = [];
		const helper = await startSandboxHelper({
			entry: options.helperEntry,
			workspace: policy.workspace,
			tmpdir: policy.tmpdir,
			env: options.env,
			scope,
			...(ask === undefined ? {} : { ask }),
			onExit: (reason) => {
				for (const pid of pids) void tracker.remove(pid);
				onExit(reason);
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
		return helper;
	};
	const stopHelper = async (helper: SandboxHelper) => {
		await helper.stop();
		for (const pid of [helper.pid, ...helper.children]) {
			await tracker.remove(pid);
		}
		// 调用方接下来可能关闭 session 记录：退出事件先记下
		await recorded.get(helper);
	};
	const slot = (name: string, scope: HelperScope, asks: boolean) =>
		new HelperSlot(async (onExit) => {
			const helper = await start(
				scope,
				asks ? (request) => options.ask(request) : undefined,
				(reason) => {
					onExit(reason);
					options.onWarning(
						`${name}退出了，之后的沙盒会换一个新的；运行中的命令不中断，但它们的网络代理已经失效。${reason}`,
					);
				},
			);
			const { pid } = helper;
			options.onProcess({ type: "process.started", kind: "helper", pid });
			recorded.set(
				helper,
				helper.exited.then(({ code, signal }) => {
					recorded.delete(helper);
					options.onProcess({
						type: "process.exited",
						kind: "helper",
						pid,
						exit_code: code,
						signal,
					});
				}),
			);
			return helper;
		});
	const offline = slot("离线的沙盒辅助进程", {}, false);
	const commands = slot(
		"命令的沙盒辅助进程",
		{ network: options.network },
		true,
	);
	const stop = async () => {
		const helpers = await Promise.allSettled([
			offline.take(),
			commands.take(),
			...own,
		]);
		await Promise.all(
			helpers.map(async (result) => {
				if (result.status === "fulfilled" && result.value !== undefined) {
					await stopHelper(result.value);
				}
			}),
		);
		if (platform === "linux") await options.placeholders.clean();
	};

	/** 为一个沙盒实例生成启动命令。 */
	const wrap = async (
		helper: SandboxHelper,
		command: string,
		scope: SandboxScope,
		// 不给时实例里没有收尾进程：快照沙盒里的 git 不留下后台进程
		reaperFd: { fd: number; close: number[] } | undefined,
	) => {
		const filesystem = await sandboxFilesystem(policy, scope, platform);
		if (filesystem.scanTimedOut) {
			options.onWarning(
				"扫描受保护的路径超时了：没扫到的位置在这条命令的沙盒里不受保护。",
			);
		}
		await options.placeholders.record(filesystem.placeholders);
		return helper.wrap(
			command,
			bash,
			filesystem.rules,
			reaper ? reaperFd : undefined,
		);
	};
	/** Linux 上删掉命令结束后留下的占位；辅助进程已经退出时由登记表在 session 结束时清理。 */
	const cleanup = async (helper: SandboxHelper) => {
		if (platform !== "linux") return;
		try {
			await helper.cleanup();
		} catch (error) {
			if (!(error instanceof SandboxUnavailableError)) throw error;
		}
	};
	const socketPath = (socket: string) => {
		if (socket !== "ssh-agent") return socket;
		if (options.sshAuthSock === undefined) {
			throw new Error(
				"申请 ssh-agent 之前要先确认 Host 的环境里有 SSH_AUTH_SOCK",
			);
		}
		return realpathSync(options.sshAuthSock);
	};

	try {
		if (platform === "linux") await options.placeholders.clean();
		const [agentHelper] = await Promise.all([
			offline.current(),
			commands.current(),
		]);
		if (platform === "linux") {
			const { rules } = await sandboxFilesystem(
				policy,
				{ kind: "agent" },
				platform,
			);
			await verifySandboxBackend(agentHelper, bash, rules, options.env);
		}
		const launcher: CommandLauncher = {
			unsupported(request) {
				const sockets = additional(request).unix_sockets ?? [];
				if (sockets.length > 0 && !capabilities.unix_sockets) {
					return "Unix sockets cannot be granted on Linux: the sandbox cannot allow a single socket there. Run this command yourself outside the agent, or use a network service instead.";
				}
				if (
					sockets.includes("ssh-agent") &&
					options.sshAuthSock === undefined
				) {
					return "There is no ssh-agent to connect to: SSH_AUTH_SOCK is not set in the environment Osprey Code was started from.";
				}
				return undefined;
			},
			async launch(request, grants, toolCallId): Promise<SandboxLaunch> {
				const scope = commandScope(request, grants);
				const permissions = additional(request);
				const sockets = (permissions.unix_sockets ?? []).map(socketPath);
				// Linux 上每个命令沙盒有自己的 127.0.0.1，这项权限不改变什么
				const binding =
					capabilities.local_binding && permissions.local_binding === true;
				if (!scope.escalated && sockets.length === 0 && !binding) {
					const generation = commands.generation;
					const helper = await commands.current();
					return {
						argv: await wrap(helper, request.command, scope, {
							fd: commandReaperFd,
							close: [],
						}),
						env: {},
						reaper,
						proxyLost: () => commands.generation !== generation,
						release: () => cleanup(helper),
					};
				}
				// 只能按进程设置的权限：这条命令有自己的辅助进程和代理，连接能准确归到它名下
				let lost = false;
				const helper = await start(
					{
						network: options.network,
						...(sockets.length === 0 ? {} : { unixSockets: sockets }),
						...(binding ? { localBinding: true } : {}),
					},
					(question) => options.ask(question, toolCallId),
					() => {
						lost = true;
					},
				);
				own.add(helper);
				const release = async () => {
					own.delete(helper);
					await cleanup(helper);
					await stopHelper(helper);
				};
				try {
					return {
						argv: await wrap(helper, request.command, scope, {
							fd: commandReaperFd,
							close: [],
						}),
						env: (permissions.unix_sockets ?? []).includes("ssh-agent")
							? { SSH_AUTH_SOCK: socketPath("ssh-agent") }
							: {},
						reaper,
						proxyLost: () => lost,
						release,
					};
				} catch (error) {
					await release();
					throw error;
				}
			},
			summary: (request, grants) => {
				const scope = commandScope(request, grants);
				return {
					mode: policy.mode,
					writable_roots: scope.escalated
						? ["/"]
						: [...writableRoots(policy), policy.cache, ...scope.write],
					network: "proxy",
				};
			},
		};
		return {
			agentArgv: await wrap(
				agentHelper,
				shellQuote(options.agentCommand),
				{ kind: "agent" },
				// 收尾进程不占着通道：agent 进程退出后 Host 要能看到通道关闭
				{ fd: agentReaperFd, close: [3] },
			),
			agentReaper: reaper,
			capabilities,
			commands: launcher,
			// 写权限只给这次批准的文件，工作区也不给
			edits: async (paths) => {
				const helper = await offline.current();
				return {
					argv: await wrap(
						helper,
						shellQuote(options.applyEditsCommand),
						{ kind: "edits", files: [...paths] },
						{ fd: commandReaperFd, close: [] },
					),
					env: {},
					reaper,
					proxyLost: () => false,
					release: () => cleanup(helper),
				};
			},
			snapshots: async (repository) => {
				const { rules } = await sandboxFilesystem(
					policy,
					{ kind: "snapshot", repository, restore: false },
					platform,
				);
				const deepest = (entries: readonly string[], path: string) =>
					entries
						.filter((entry) => isInside(path, entry))
						.reduce((depth, entry) => Math.max(depth, entry.length), -1);
				return {
					// 读取规则里更具体的一条生效，同一个路径上放开优先于禁止
					canRead: (path) =>
						deepest(rules.allowRead, path) >= deepest(rules.denyRead, path),
					run: async (argv, run) => {
						const helper = await offline.current();
						// 沙盒的启动命令用 session 的环境变量找到；git 自己的环境变量只有调用方给的那些
						const assignments = Object.entries(run.env).map(
							([name, value]) => `${name}=${value}`,
						);
						const wrapped = await wrap(
							helper,
							shellQuote(["/usr/bin/env", "-i", ...assignments, ...argv]),
							{
								kind: "snapshot",
								repository,
								restore: run.writeWorkspace,
							},
							undefined,
						);
						try {
							return await runGit(wrapped, { ...run, env: options.env });
						} finally {
							await cleanup(helper);
						}
					},
				};
			},
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
