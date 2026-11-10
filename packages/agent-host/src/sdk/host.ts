import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolRegistry } from "@ospreycode/agent-runtime";
import { builtinModels, type StreamModel, streamModel } from "@ospreycode/api";
import type { ReasoningEffort } from "@ospreycode/api/protocol";
import {
	type ApprovalAnswer,
	type ApprovalPolicy,
	type GranularApproval,
	loadShellParser,
	type SandboxMode,
	type ShellParser,
} from "@ospreycode/sandbox";
import { checkSandboxSupport } from "@ospreycode/sandbox/backends";
import { SessionStore, type SessionWriter } from "@ospreycode/session-store";
import { SessionRules } from "../actions/session-rules.js";
import { ConfigError } from "../config/errors.js";
import {
	loadRuleFiles,
	userRulesDirectory,
} from "../config/permission-rules.js";
import { profileDomainRules } from "../config/sandbox-mode.js";
import {
	resolveSessionConfig,
	type SessionConfig,
	type SessionOptions,
} from "../config/session-config.js";
import {
	CredentialError,
	type LoadedCredential,
	loadCredential,
} from "../credentials/sources.js";
import {
	type CredentialStatus,
	type CredentialStatusOptions,
	credentialStatus,
	defaultService,
} from "../credentials/status.js";
import { type CredentialStore, macosKeychain } from "../credentials/store.js";
import { DiagnosticLog } from "../diagnostics/log.js";
import type { BackgroundCommandInfo } from "../processes/background.js";
import {
	bootId,
	type ProcessIdentity,
	processStartTime,
} from "../processes/info.js";
import { installDirectories } from "../processes/install-location.js";
import { Placeholders } from "../processes/placeholders.js";
import { ProcessRegistry } from "../processes/registry.js";
import {
	runInSandbox,
	type SandboxRunOptions,
	type SandboxRunResult,
} from "../processes/sandbox-run.js";
import {
	sandboxedSession,
	unsandboxedSession,
} from "../processes/sandboxed.js";
import { type ClearCacheOptions, clearCache } from "../project/cache.js";
import { projectKey, Registry } from "../project/identity.js";
import {
	acquireExclusiveLock,
	acquireWorkspaceLock,
} from "../project/locks.js";
import {
	checkInstallLocation,
	checkSeparate,
	ensureDirectory,
	findProjectRoot,
	prepareRoot,
	resolveWorkspace,
} from "../project/workspace.js";
import { redact } from "../redaction/redact.js";
import {
	HostSession,
	type ReloadedSettings,
} from "../sessions/host-session.js";
import { newId } from "../sessions/ids.js";
import type { InputQueueSnapshot, QueuedInput } from "../sessions/inputs.js";
import {
	type ListSessionsOptions,
	listSessions,
	type SessionInfo,
} from "../sessions/list.js";
import type { UserInput } from "../sessions/user-input.js";
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
	/** apply-edits 的入口文件，执行批准的、可写范围之外的文件改动；不传时同样从 exports 找到。 */
	applyEditsEntry?: string;
	/** 沙盒辅助进程的入口文件；不传时从 `@ospreycode/sandbox` 的 exports 找到。 */
	sandboxHelperEntry?: string;
	/**
	 * 系统凭据库：启动参数和用户级配置都没有指定某个凭据的来源时从这里读。不传时 macOS 上用登录钥匙串，
	 * 其他平台没有；传 `null` 表示不用系统凭据库。
	 */
	credentialStore?: CredentialStore | null;
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
	/**
	 * 当前生效的配置：会话中换过的模型、推理强度、沙盒模式和审批策略已经并在里面。配置文件的改动要到
	 * `reload()` 之后才在里面，所以前端显示当前的设置时用它，不要自己再调 `resolveConfig`。
	 */
	config(): SessionConfig;
	/**
	 * 在 session 空闲时开始一个 task，返回 `task_id`。输入是一段文字，或分好段的输入：其中 `@` 提及的
	 * 路径由 runtime 在这条输入进入上下文时在沙盒里读取，文件内容放进这条用户消息。`steer` 和
	 * `followUp` 的输入相同。
	 */
	submit(input: string | UserInput[]): Promise<string>;
	/**
	 * task 运行时的输入，并入当前 task（steering）：在下一次模型请求之前插入，返回这条输入的编号。
	 * 取消时还没插入的 steering 立即交给模型，同一个 task 接着进行；task 结束时还没插入的随
	 * `input.dequeued`（`reason: "task_ended"`）交还，前端把它放回输入框。没有进行中的 task 时抛出。
	 */
	steer(input: string | UserInput[]): string;
	/**
	 * 排进 follow-up 列表，返回这条输入的编号：当前 task 以 `completed` 结束后，列表里的输入逐条作为
	 * 新的 task 开始（`task.started` 的 `source` 为 `follow_up`）；别的结果让列表暂停。session 空闲时
	 * 只有列表暂停着才能排，否则抛出。
	 */
	followUp(input: string | UserInput[]): string;
	/** 取回排队的 steering 和 follow-up：给了编号只取那一条，不给取回全部；返回取回的输入。 */
	dequeue(inputId?: string): QueuedInput[];
	/** 当前排队的 steering 和 follow-up，以及列表是不是暂停着。 */
	inputQueue(): InputQueueSnapshot;
	/**
	 * 让暂停的 follow-up 列表继续：session 空闲时马上开始列表的第一条。用户的下一次 `submit`
	 * 也会让列表继续。
	 */
	resumeFollowUps(): Promise<void>;
	/**
	 * 切换模型（`/model`），可以同时换推理强度：从下一次模型请求起生效，task 运行中也可以换。
	 * 切换前做和启动时相同的检查，不满足时抛出、session 不受影响：模型不在清单里或开启费用上限而
	 * 模型没有价格是 `ConfigError`，没有凭据是 `CredentialError`。实际换了之后，在用到新模型的
	 * 第一次请求之前发出 `model.changed`。新模型的凭据来自另一个文件、沙盒还读得到它时，按 `reload()`
	 * 处理（重启 agent 进程），只能在 session 空闲时做，否则抛出 `SessionCommandError`。
	 */
	setModel(model: string, reasoningEffort?: ReasoningEffort): Promise<void>;
	/**
	 * 切换推理强度（`/effort`）：从下一次模型请求起生效，task 运行中也可以换。实际换了之后，在用到
	 * 新级别的第一次请求之前发出 `reasoning_effort.changed`。
	 */
	setReasoningEffort(reasoningEffort: ReasoningEffort): Promise<void>;
	/**
	 * 运行中的后台命令和监视（`/bg`），按开始的顺序。它们属于 session，task 结束后继续运行；开始和结束
	 * 另有 `background.started`、`background.ended` 事件，非交互模式据此等它们结束。
	 */
	backgroundCommands(): BackgroundCommandInfo[];
	/**
	 * 停止一条后台命令，等它和它的子孙进程结束；没有这个编号或已经结束时返回 false。用户停掉的命令
	 * 产生一条不唤醒 session 的通知，等下一次开始 task 时交给模型。
	 */
	stopBackgroundCommand(backgroundId: string): Promise<boolean>;
	/**
	 * 等 session 空闲下来：没有进行中的 task，task 结束后接着要开始的（follow-up、后台通知的唤醒）
	 * 也都结束了；session 关闭后立即兑现。还在运行的后台命令不算在内，用 `backgroundCommands()` 看。
	 * 非交互模式用它判断主任务之后还有没有通知要处理。
	 */
	whenIdle(): Promise<void>;
	/** 回答 `approval.requested`；询问已经有了结果时返回 false。 */
	respond(requestId: string, answer: ApprovalAnswer): boolean;
	/**
	 * 切换审批策略（`/approval`）：马上生效，task 进行中也可以，完成后发出 `approval_policy.changed`。
	 * 挂起的询问在新策略下不该再问的，立即答为拒绝（`approval.decided` 的 `denied_by_policy`）。
	 * 和启动参数排在同一层：仓库配置收紧过的策略放不松，实际生效的策略以事件里的 `to` 为准。
	 * `granular` 按类别覆盖配置文件里的 `[approval_granular]`；换成 `granular` 而七个类别没有写全时
	 * 抛出 `ConfigError`。
	 */
	setApprovalPolicy(
		policy: ApprovalPolicy,
		granular?: Partial<GranularApproval>,
	): void;
	/** 取消当前的 run，task 以 `cancelled` 结束。 */
	cancel(): Promise<void>;
	/**
	 * 切换沙盒模式（`/sandbox`）：按新模式准备沙盒、重启 agent 进程，新进程按 session 记录重建发给
	 * 模型的历史，完成后发出 `sandbox_mode.changed`。只能在 session 空闲时做，`danger-full-access`
	 * 只能在启动时指定：这两种情况抛出 `SessionCommandError`，session 不受影响。模式不存在时抛出
	 * `ConfigError`，当前平台没有沙盒后端时抛出 `SandboxUnavailableError`。agent 进程没能重新启动时
	 * session 关闭，抛出 `AgentStartError`。
	 */
	setSandboxMode(mode: SandboxMode): Promise<void>;
	/**
	 * 重新加载配置（`/reload`）：重新读取全部配置和凭据，会话中切换过的沙盒模式保留；重新准备沙盒、
	 * 重启命令辅助进程和 agent 进程。只能在 session 空闲时做，否则抛出 `SessionCommandError`；
	 * 配置有错时抛出 `ConfigError` 或 `CredentialError`，session 照旧用原来的配置。
	 */
	reload(): Promise<void>;
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
	/**
	 * 把凭据保存进系统凭据库（`ospreycode login`），已有的覆盖。没有系统凭据库的平台抛出
	 * `CredentialError`：那里用 `--credential-file` 或用户级配置的 `[credentials]` 指定来源。
	 */
	saveCredential(id: string, value: string): Promise<void>;
	/** 从系统凭据库删除凭据（`ospreycode logout`），本来就没有时返回 false。 */
	deleteCredential(id: string): Promise<boolean>;
	/**
	 * 用户级配置选用的默认模型所属的服务（`login`、`logout` 不写 `--service` 时用它）；没有选用模型，
	 * 或者选用的模型不在清单里时为空。只读用户级配置，和当前目录无关；它加载出错时抛出 `ConfigError`。
	 */
	defaultService(): string | undefined;
	/**
	 * 各个模型服务的凭据取自哪一层（`ospreycode login status`）：启动参数、用户级配置还是系统凭据库。
	 * 只说明来源，不返回凭据的值。用户级配置加载出错时抛出 `ConfigError`，系统凭据库锁定或不可用时
	 * 抛出 `CredentialError`。
	 */
	credentialStatus(
		options?: CredentialStatusOptions,
	): Promise<CredentialStatus[]>;
	/**
	 * 列出 session（`ospreycode session list`），最近写过的在前；给了目录只列它所在项目的。
	 * 只读 session 记录，不取工作区锁。目录不存在时抛出 `WorkspaceError`。
	 */
	listSessions(options?: ListSessionsOptions): SessionInfo[];
	/**
	 * 清空构建缓存（`ospreycode cache clear`），返回清空了的项目的 `project_id`；给了目录只清它所在
	 * 项目的。只删缓存目录里的内容，不管有没有打开的 session；没有缓存时什么也不做。
	 */
	clearCache(options?: ClearCacheOptions): string[];
	/**
	 * 用和 session 的命令沙盒同一套策略运行一条命令（`ospreycode sandbox`）：不询问，权限规则没有
	 * 放行的域名直接拒绝，标准输入输出直通。配置有错时抛出 `ConfigError` 或 `WorkspaceError`，
	 * 当前平台没有沙盒后端时抛出 `SandboxUnavailableError`。
	 */
	runInSandbox(options: SandboxRunOptions): Promise<SandboxRunResult>;
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
	const applyEditsEntry =
		options.applyEditsEntry ??
		resolveEntry("@ospreycode/agent-runtime/apply-edits");
	const agentCommand = [process.execPath, agentEntry];
	const programFiles = [
		fileURLToPath(import.meta.url),
		agentEntry,
		applyEditsEntry,
		helperEntry,
		process.execPath,
	];
	const owner = selfIdentity();
	// 越界执行的命令也不能写的位置：Host 根目录下 Host 会读的条目（不存在的也列出），和安装目录
	const hostEntries = [
		"config.toml",
		"mcp.json",
		"hooks.json",
		"rules",
		"AGENTS.md",
		"data",
		"hooks",
		"plugins",
		"plugin-data",
		"server-data",
		"snapshots",
		"cache",
		"tmp",
		"output",
	];
	const install = installDirectories(programFiles, process.execPath);
	// 规则匹配用的 bash 解析器：加载一次 WASM，这个 Host 的 session 共用
	let parser: Promise<ShellParser> | undefined;
	const shellParser = () => {
		parser ??= loadShellParser();
		return parser;
	};
	const registry = new Registry(data, owner);
	const processes = new ProcessRegistry(data, owner);
	const store =
		options.credentialStore === undefined
			? process.platform === "darwin"
				? macosKeychain()
				: undefined
			: (options.credentialStore ?? undefined);
	// Host 读进内存的凭据，日志、错误信息和事件里都去掉它们
	const secrets = new Set<string>();
	const scrub = (text: string) => redact(text, [...secrets]);
	const log = new DiagnosticLog(join(data, "logs"), scrub);
	const requireStore = (): CredentialStore => {
		if (store === undefined) {
			throw new CredentialError(
				"这个平台没有系统凭据库：用 --credential-file 或用户级配置的 [credentials] 指定凭据来源",
			);
		}
		return store;
	};

	/** 凭据按启动参数、用户级配置、系统凭据库的顺序取第一个找到的来源。 */
	const credentialFor = async (
		config: SessionConfig,
	): Promise<{ credential: LoadedCredential; file?: string }> => {
		const id = config.model.service;
		const source = config.credentials[id];
		if (source !== undefined) {
			return {
				credential: loadCredential(id, source, {
					workspace: config.workspace,
					env: options.env,
					platform: process.platform,
				}),
				...("file" in source ? { file: realpathSync(source.file) } : {}),
			};
		}
		const value = await store?.get(id);
		if (value === undefined) {
			throw new CredentialError(
				store === undefined
					? `没有模型服务 ${id} 的凭据来源：用 --credential-file 或用户级配置的 [credentials] 指定`
					: `没有模型服务 ${id} 的凭据：用 ospreycode login --service ${id} 保存，或用 --credential-file 指定`,
			);
		}
		return { credential: { id, value } };
	};

	/** 一份配置对应的凭据和权限规则，以及沙盒读写不到、任何批准也放不开的路径。 */
	const settingsFor = async (
		config: SessionConfig,
	): Promise<ReloadedSettings> => {
		const { credential, file } = await credentialFor(config);
		secrets.add(credential.value);
		const parser = await shellParser();
		return {
			config,
			credential,
			rules: new SessionRules({
				files: loadRuleFiles({
					root,
					projectRoot: config.projectRoot,
					startup: config.ruleFiles,
					parser,
				}),
				...(config.permissionProfile === undefined
					? {}
					: {
							profile: profileDomainRules(
								config.sandboxMode,
								config.permissionProfile,
							),
						}),
				parser,
				userRulesDir: userRulesDirectory(root),
				lockDir: join(data, "locks"),
				owner,
			}),
			denied: {
				read: [root, ...(file === undefined ? [] : [file]), ...config.denyRead],
				write: [...config.denyWrite],
			},
		};
	};

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
			catalog: builtinModels,
			toolNames: [...toolRegistry.keys()],
			install,
		});
	};

	const openSession = async (
		sessionOptions: OpenSessionOptions,
	): Promise<Session> => {
		const config = resolveConfig(sessionOptions);
		const { workspace } = config;
		checkInstallLocation(workspace, programFiles);
		const settings = await settingsFor(config);
		if (config.sandboxMode !== "danger-full-access") {
			checkSandboxSupport(process.platform);
		}
		const userId = await registry.userId();
		const projectId = await registry.projectId(projectKey(config.projectRoot));
		const lock = await acquireWorkspaceLock(
			join(data, "locks"),
			workspace,
			owner,
		);
		let session: HostSession;
		let store: SessionStore | undefined;
		let writer: SessionWriter | undefined;
		try {
			await processes.cleanWorkspace(workspace);
			const sessionId = newId();
			const projectDir = join(data, "projects", projectId);
			ensureDirectory(join(data, "projects"));
			ensureDirectory(projectDir);
			store = SessionStore.open(join(projectDir, "sessions.sqlite"));
			writer = await store.create(
				{
					session_id: sessionId,
					workspace,
					created_at: new Date().toISOString(),
				},
				(id) =>
					acquireExclusiveLock(
						join(data, "locks", `session-${id}.lock`),
						owner,
						`session ${id} `,
					),
			);
			session = await HostSession.open({
				store,
				writer,
				sessionId,
				root,
				...settings,
				scrub,
				onSecret: (value) => secrets.add(value),
				log,
				hostEnv: options.env,
				fetch: options.fetch ?? globalThis.fetch,
				streamModel: options.streamModel ?? streamModel,
				tracker: processes.tracker(sessionId, workspace),
				lock,
				userId,
				projectId,
				// 切换沙盒模式和重新加载配置时再调用，所以模式和路径都取这一次给的
				createSandbox: async (context) => {
					const { denied, bash, env, directories, tracker } = context;
					const mode = context.config.baseSandboxMode;
					const profile = context.config.permissionProfile;
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
							cache: directories.cache,
							readOnly: [directories.output],
							denyRead: [...denied.read],
							denyWrite: [...denied.write],
							home: env.HOME,
							hostRoot: root,
							hostEntries,
							install,
							...(profile === undefined ? {} : { profile }),
						},
						capabilities: checkSandboxSupport(process.platform),
						env,
						bash,
						agentCommand,
						applyEditsCommand: [process.execPath, applyEditsEntry],
						tracker,
						network: context.rules.networkLists(),
						ask: context.askNetwork,
						...(options.env.SSH_AUTH_SOCK === undefined
							? {}
							: { sshAuthSock: options.env.SSH_AUTH_SOCK }),
						placeholders: new Placeholders(data, owner, workspace),
						onWarning: context.onWarning,
						onProcess: context.onProcess,
					});
				},
				onEvent: sessionOptions.onEvent,
			});
		} catch (error) {
			writer?.close();
			store?.close();
			lock.release();
			throw error;
		}
		// 会话中换过的设置和启动参数排在同一层：重新加载配置时不被配置文件盖掉
		let current: SessionOptions = sessionOptions;
		return {
			id: session.sessionId,
			ended: session.ended,
			config: () => session.config,
			submit: (input) => session.submit(input),
			steer: (input) => session.steer(input),
			followUp: (input) => session.followUp(input),
			dequeue: (inputId) => session.dequeue(inputId),
			inputQueue: () => session.inputQueue(),
			resumeFollowUps: () => session.resumeFollowUps(),
			async setModel(model, reasoningEffort) {
				const next = {
					...current,
					model,
					...(reasoningEffort === undefined ? {} : { reasoningEffort }),
				};
				await session.setModel(await settingsFor(resolveConfig(next)));
				current = next;
			},
			async setReasoningEffort(reasoningEffort) {
				const next = { ...current, reasoningEffort };
				await session.setModel(await settingsFor(resolveConfig(next)));
				current = next;
			},
			backgroundCommands: () => session.backgroundCommands(),
			stopBackgroundCommand: (backgroundId) =>
				session.stopBackgroundCommand(backgroundId),
			whenIdle: () => session.whenIdle(),
			respond: (requestId, answer) => session.respond(requestId, answer),
			setApprovalPolicy(policy, granular) {
				const next = {
					...current,
					approvalPolicy: policy,
					...(granular === undefined ? {} : { granular }),
				};
				const config = resolveConfig(next);
				session.setApprovalPolicy(config.approvalPolicy, config.granular);
				current = next;
			},
			cancel: () => session.cancel(),
			close: () => session.close(),
			async setSandboxMode(mode) {
				const next = { ...current, sandboxMode: mode };
				const resolved = resolveConfig(next);
				if (resolved.baseSandboxMode !== "danger-full-access") {
					checkSandboxSupport(process.platform);
				}
				await session.setSandboxMode(resolved);
				current = next;
			},
			async reload() {
				const reloaded = await settingsFor(resolveConfig(current));
				if (reloaded.config.sandboxMode !== "danger-full-access") {
					checkSandboxSupport(process.platform);
				}
				await session.reload(reloaded);
			},
		};
	};

	return {
		resolveConfig,
		async openSession(sessionOptions) {
			try {
				return await openSession(sessionOptions);
			} catch (error) {
				log.write({
					level: "error",
					message: `打开 session 失败：${(error as Error).message}`,
				});
				throw error;
			}
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
		saveCredential: async (id, value) => requireStore().set(id, value),
		deleteCredential: async (id) => requireStore().delete(id),
		defaultService: () => defaultService(root, options.env.HOME),
		credentialStatus: (statusOptions = {}) =>
			credentialStatus({ root, home: options.env.HOME, store }, statusOptions),
		listSessions: (listOptions = {}) =>
			listSessions(data, registry, listOptions),
		clearCache: (cacheOptions = {}) => clearCache(root, registry, cacheOptions),
		runInSandbox: (runOptions) =>
			runInSandbox(runOptions, {
				root,
				data,
				owner,
				env: options.env,
				helperEntry,
				hostEntries,
				install,
				registry,
				resolveConfig,
				shellParser,
			}),
	};
}
