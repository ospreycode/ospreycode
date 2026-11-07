import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StreamModel, streamModel } from "@ospreycode/api";
import type { ApprovalAnswer } from "@ospreycode/sandbox";
import { checkSandboxSupport } from "@ospreycode/sandbox/backends";
import { ConfigError } from "../config/errors.js";
import {
	resolveSessionConfig,
	type SessionConfig,
	type SessionOptions,
} from "../config/session-config.js";
import { readCredential } from "../credentials/sources.js";
import {
	bootId,
	type ProcessIdentity,
	processStartTime,
} from "../processes/info.js";
import { ProcessRegistry } from "../processes/registry.js";
import {
	sandboxedSession,
	unsandboxedSession,
} from "../processes/sandboxed.js";
import { projectKey, Registry } from "../project/identity.js";
import { acquireWorkspaceLock } from "../project/locks.js";
import {
	checkInstallLocation,
	checkSeparate,
	findProjectRoot,
	prepareRoot,
	resolveWorkspace,
} from "../project/workspace.js";
import { HostSession } from "../sessions/host-session.js";
import { newId } from "../sessions/ids.js";
import type { HostEvent } from "./events.js";

/** 创建 Host 的选项。SDK 不改进程级的状态，依赖都由调用方传入。 */
export interface HostOptions {
	/** Host 根目录，CLI 用 `~/.ospreycode`；不存在时以 0700 创建。用户级配置是它下面的 `config.toml`。 */
	root: string;
	/** Host 启动时的环境变量：传给沙盒的白名单变量和环境变量来源的凭据从这里取。 */
	env: Readonly<Record<string, string | undefined>>;
	/** 发模型请求用的 `fetch`，需要代理时传入带代理的版本；不传时用 Node 内置的。 */
	fetch?: typeof globalThis.fetch;
	/** 发起模型请求的函数；不传时按模型清单的协议发出真实请求。 */
	streamModel?: StreamModel;
	/** agent 进程的入口文件；不传时从 `@ospreycode/agent-runtime` 的 exports 找到，`cli` 打包后传入打包的文件。 */
	agentEntry?: string;
	/** 沙盒辅助进程的入口文件；不传时从 `@ospreycode/sandbox` 的 exports 找到。 */
	sandboxHelperEntry?: string;
}

/** 打开 session 的选项。 */
export interface OpenSessionOptions extends SessionOptions {
	/**
	 * 接收这个 session 的全部事件，第一条是 `session.started`，最后一条是 `session.ended`；
	 * 仓库配置里被忽略的键和更松的值紧跟在 `session.started` 之后作为 `warning` 发出。
	 */
	onEvent: (event: HostEvent) => void;
}

/** 一个打开的 session。 */
export interface Session {
	readonly id: string;
	/** session 关闭后兑现，包括 agent 进程意外退出。 */
	readonly ended: Promise<void>;
	/** 在 session 空闲时开始一个 task，返回 `task_id`。 */
	submit(input: string): Promise<string>;
	/** 回答 `approval.requested`；询问已经有了结果时返回 false。 */
	respond(requestId: string, answer: ApprovalAnswer): boolean;
	/** 取消当前的 run，task 以 `cancelled` 结束。 */
	cancel(): Promise<void>;
	/** 关闭 session，结束其中的全部进程，释放工作区锁。 */
	close(): Promise<void>;
}

/** 登记过的一个项目。 */
export interface ProjectInfo {
	project_id: string;
	/** 关联到这个项目的路径：git 公共目录，或不是 git 仓库的目录。 */
	paths: string[];
}

/** 本地后端。CLI 和评测都只通过它使用 Host。 */
export interface Host {
	/**
	 * 按启动参数、仓库配置、用户级配置和内置默认值的顺序合并配置并检查，不打开 session：
	 * CLI 用它在打开 session 之前取代理设置，`doctor` 用它检查配置能否加载。参数或配置有错时
	 * 抛出 `ConfigError` 或 `WorkspaceError`。
	 */
	resolveConfig(options: SessionOptions): SessionConfig;
	/**
	 * 新建一个 session：合并配置，检查凭据，取得工作区锁，结束这个工作区里上次残留的进程，启动 agent
	 * 进程并完成握手。参数或配置有错时抛出 `ConfigError`、`CredentialError` 或 `WorkspaceError`
	 * （包括工作区已经有打开的 session）；当前平台没有沙盒后端时抛出 `SandboxUnavailableError`；
	 * agent 进程没能启动时抛出 `AgentStartError`。
	 */
	openSession(options: OpenSessionOptions): Promise<Session>;
	/** 登记过的项目（`ospreycode project list`）。 */
	listProjects(): ProjectInfo[];
	/**
	 * 把目录所在的项目关联到已有的项目（`ospreycode project link`）：仓库移动后路径变了就是新项目，
	 * 用它接上原来的记录。项目不存在时抛出 `ConfigError`。
	 */
	linkProject(directory: string, projectId: string): Promise<void>;
}

function resolveEntry(specifier: string): string {
	return fileURLToPath(import.meta.resolve(specifier));
}

/** Host 进程自己的身份，写进锁文件和进程登记表。 */
function selfIdentity(): ProcessIdentity {
	const startTime = processStartTime(process.pid);
	if (startTime === undefined) throw new Error("读不到 Host 进程的启动时间");
	return { pid: process.pid, start_time: startTime, boot_id: bootId() };
}

/** 创建 Host。 */
export function createHost(options: HostOptions): Host {
	const root = prepareRoot(options.root);
	const data = join(root, "data");
	const agentEntry =
		options.agentEntry ?? resolveEntry("@ospreycode/agent-runtime/agent");
	const helperEntry =
		options.sandboxHelperEntry ?? resolveEntry("@ospreycode/sandbox/helper");
	const agentCommand = [process.execPath, agentEntry];
	const programFiles = [
		fileURLToPath(import.meta.url),
		agentEntry,
		helperEntry,
		process.execPath,
	];
	const owner = selfIdentity();
	const registry = new Registry(data, owner);
	const processes = new ProcessRegistry(data, owner);

	const resolveConfig = (sessionOptions: SessionOptions): SessionConfig => {
		const workspace = resolveWorkspace(sessionOptions.workspace);
		checkSeparate(root, workspace);
		const project = findProjectRoot(workspace);
		return resolveSessionConfig(sessionOptions, {
			root,
			workspace,
			projectRoot: project.root,
			git: project.git,
			home: options.env.HOME,
			catalog: [],
		});
	};

	return {
		resolveConfig,
		async openSession(sessionOptions) {
			const config = resolveConfig(sessionOptions);
			const { workspace } = config;
			checkInstallLocation(workspace, programFiles);
			const credentialId = config.model.service;
			const source = config.credentials[credentialId];
			if (source === undefined) {
				throw new ConfigError(
					`没有模型服务 ${credentialId} 的凭据来源：用启动参数或用户级配置的 [credentials] 指定`,
				);
			}
			const apiKey = readCredential(credentialId, source, {
				workspace,
				env: options.env,
				platform: process.platform,
			});
			const mode = config.sandboxMode;
			if (mode !== "danger-full-access") checkSandboxSupport(process.platform);
			const userId = await registry.userId();
			const projectId = await registry.projectId(
				projectKey(config.projectRoot),
			);
			const lock = await acquireWorkspaceLock(
				join(data, "locks"),
				workspace,
				owner,
			);
			let session: HostSession;
			try {
				await processes.cleanWorkspace(workspace);
				const sessionId = newId();
				session = await HostSession.open({
					sessionId,
					root,
					config,
					apiKey,
					hostEnv: options.env,
					fetch: options.fetch ?? globalThis.fetch,
					streamModel: options.streamModel ?? streamModel,
					tracker: processes.tracker(sessionId, workspace),
					lock,
					userId,
					projectId,
					createSandbox: async ({ bash, env, directories, tracker }) => {
						if (mode === "danger-full-access") {
							return unsandboxedSession(agentCommand, bash);
						}
						if (env.HOME === undefined) {
							throw new ConfigError(
								"Host 的环境变量里没有 HOME，找不到要禁止读取的密钥位置",
							);
						}
						return sandboxedSession({
							helperEntry,
							policy: {
								mode,
								workspace,
								tmpdir: directories.tmp,
								readOnly: [directories.output],
								denyRead: [
									root,
									...("file" in source ? [realpathSync(source.file)] : []),
									...config.denyRead,
								],
								denyWrite: [...config.denyWrite],
								home: env.HOME,
							},
							env,
							bash,
							agentCommand,
							tracker,
						});
					},
					onEvent: sessionOptions.onEvent,
				});
			} catch (error) {
				lock.release();
				throw error;
			}
			return {
				id: session.sessionId,
				ended: session.ended,
				submit: (input) => session.submit(input),
				respond: (requestId, answer) => session.respond(requestId, answer),
				cancel: () => session.cancel(),
				close: () => session.close(),
			};
		},
		listProjects: () => registry.projects(),
		async linkProject(directory, projectId) {
			const workspace = resolveWorkspace(directory);
			if (!registry.projects().some((p) => p.project_id === projectId)) {
				throw new ConfigError(`没有这个项目：${projectId}`);
			}
			await registry.link(
				projectKey(findProjectRoot(workspace).root),
				projectId,
			);
		},
	};
}
