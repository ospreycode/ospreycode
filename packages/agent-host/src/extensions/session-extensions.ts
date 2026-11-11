import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
	AgentConfig,
	McpToolInfo,
	SkillLoadResult,
	ToolResult,
} from "@ospreycode/agent-runtime";
import type { UserContent } from "@ospreycode/api/protocol";
import type { ElicitationAnswer, JsonValue } from "@ospreycode/mcp";
import {
	type ApprovalAnswer,
	askOrDeny,
	type PolicyContext,
	type ShellCommand,
	type ShellParser,
	type ShellScript,
} from "@ospreycode/sandbox";
import type { SandboxPolicy } from "@ospreycode/sandbox/backends";
import { loadSkill, renderSkillContent } from "@ospreycode/skills";
import type { Approvals } from "../actions/approvals.js";
import type { SessionRules } from "../actions/session-rules.js";
import { permissionDenial } from "../actions/shell-background.js";
import type { SessionConfig } from "../config/session-config.js";
import type { HookEvent, HookHandler } from "../hooks/config.js";
import {
	HookEngine,
	type HookOutcome,
	type HookTrigger,
} from "../hooks/engine.js";
import type { ServerSecret } from "../mcp-hub/credentials.js";
import {
	type HubTool,
	McpCallError,
	McpHub,
	type McpServerState,
	type ServerCredentials,
} from "../mcp-hub/hub.js";
import { ServerQuestions } from "../mcp-hub/questions.js";
import { mcpToolResult } from "../mcp-hub/tool-result.js";
import type { VerdictCache } from "../mcp-hub/verdicts.js";
import type {
	ExtensionSandbox,
	ExtensionSandboxes,
} from "../processes/extension-sandbox.js";
import type { ProcessTracker } from "../processes/registry.js";
import { isInside, realTarget } from "../project/paths.js";
import type { ProcessEvent } from "../sessions/events.js";
import type { Run } from "../sessions/run.js";
import { version as hostVersion } from "../version.js";
import {
	type ExtensionInfo,
	type ExtensionLocations,
	type LoadedExtensions,
	loadExtensions,
	type SessionServer,
	type SessionSkill,
} from "./catalog.js";
import type { ExtensionEvent } from "./events.js";
import { hashSkill } from "./hash.js";
import type { PluginStore } from "./plugins.js";
import type { TrustStore } from "./trust.js";

/** 一个 skill 最多包含多少个文件，和查找时的上限相同。 */
const maxSkillFiles = 2000;

/** 把脚本当参数运行的 shell、解释器和脚本运行器：它们的参数落在 skill 目录里也算 skill 脚本。 */
const interpreters: ReadonlySet<string> = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"source",
	".",
	"python",
	"python3",
	"node",
	"deno",
	"bun",
	"tsx",
	"ruby",
	"perl",
	"php",
	"uv",
	"uvx",
	"npx",
	"npm",
	"pnpm",
	"yarn",
]);

/** Host 级的扩展服务：信任记录、插件目录和 MCP 的凭据，几个 session 先后共用。 */
export interface ExtensionServices {
	trust: TrustStore;
	plugins: PluginStore;
	verdicts: VerdictCache;
	locations: ExtensionLocations;
	/** 连接一个 MCP server 用的凭据：来源和预先注册的客户端取自当前的配置。 */
	credentials: (
		server: SessionServer,
		config: SessionConfig,
	) => Promise<ServerCredentials>;
	/** 一个本地 MCP server 在配置里声明的密钥和它们的值；取不到值时抛出。 */
	secrets: (
		server: SessionServer,
		config: SessionConfig,
	) => Promise<ServerSecret[]>;
	/** 连接远程 MCP server 用的 `fetch`。 */
	fetch: typeof globalThis.fetch;
	/** 用户级 hooks 写的 `permissions` 按当前配置解析成沙盒模式；名字不存在时抛出。 */
	resolveMode: (
		name: string,
	) => Pick<SessionConfig, "baseSandboxMode" | "permissionProfile">;
}

/** 扩展的进程在哪里运行：随 session 的沙盒一起换。 */
export interface ExtensionRuntime {
	/** 扩展的沙盒；`danger-full-access` 下没有，扩展的进程由 Host 直接启动。 */
	sandboxes: ExtensionSandboxes | undefined;
	/** session 的沙盒策略；没有沙盒时为空。 */
	policy: SandboxPolicy | undefined;
	/** 沙盒里的进程的环境变量：扩展的进程只拿其中的 `PATH`、`HOME`、`TMPDIR`。 */
	env: Record<string, string>;
}

/** 一个 session 的扩展用到的依赖。 */
export interface SessionExtensionsOptions {
	services: ExtensionServices;
	sessionId: string;
	tracker: ProcessTracker;
	approvals: Approvals;
	/** 扩展的事件。 */
	emit: (event: ExtensionEvent) => void;
	onWarning: (message: string) => void;
	onProcess: (event: ProcessEvent) => void;
	/** 当前的配置、审批策略和权限规则。 */
	settings: () => {
		config: SessionConfig;
		policy: PolicyContext;
		rules: SessionRules;
	};
	/** MCP 工具集变了。 */
	onToolsChanged: () => void;
}

/** 一次 hooks 触发另带的归属，记进 `hooks.ran`。 */
export interface HookScope {
	tool_call_id?: string;
	input_id?: string;
	message_id?: string;
}

function text(value: string): UserContent[] {
	return [{ type: "text", text: value }];
}

/** 脚本里每条字面命令的词，包装命令执行的命令和脚本参数里的命令也在内。 */
function commandWords(script: ShellScript): (string | undefined)[][] {
	const expand = (command: ShellCommand): (string | undefined)[][] => [
		command.words.map((word) => word.value),
		...command.wrapped.flatMap(expand),
		...(command.script === undefined ? [] : commandWords(command.script.body)),
	];
	return script.commands.flatMap(expand);
}

/**
 * 一个 session 的扩展：找出并按信任记录启用 skills、MCP server 和 hooks，启动 MCP server，
 * 在固定时机运行 hooks，核对 skill 的内容。
 */
export class SessionExtensions {
	#options: SessionExtensionsOptions;
	#loaded: LoadedExtensions = {
		items: [],
		skills: [],
		servers: [],
		hooks: [],
		hookVerifiers: new Map(),
		pluginDirectories: [],
		pluginVersions: {},
		warnings: [],
	};
	#runtime: ExtensionRuntime = {
		sandboxes: undefined,
		policy: undefined,
		env: {},
	};
	#hub: McpHub;
	#questions: ServerQuestions;
	#hooks: HookEngine | undefined;
	/** hooks 的沙盒：按来源和权限各一个，辅助进程共用。 */
	#hookSandboxes = new Map<string, Promise<ExtensionSandbox>>();

	constructor(options: SessionExtensionsOptions) {
		this.#options = options;
		this.#questions = new ServerQuestions({
			emit: options.emit,
			settings: options.settings,
			pauseStartup: (serverId) => this.#hub.pauseStartup(serverId),
			onWarning: options.onWarning,
		});
		this.#hub = new McpHub({
			client: { name: "ospreycode", version: hostVersion },
			workspace: options.services.locations.workspace,
			env: () => this.#processEnv(),
			sandbox: (server) => this.#serverSandbox(server),
			plainSecrets: async (server) =>
				Object.fromEntries(
					(
						await options.services.secrets(server, options.settings().config)
					).map(({ name, value }) => [name, value]),
				),
			credentials: (server) =>
				options.services.credentials(server, options.settings().config),
			fetch: options.services.fetch,
			verdicts: options.services.verdicts,
			tracker: options.tracker,
			startupTimeoutMs: () => options.settings().config.mcpStartupTimeoutMs,
			// 非交互模式固定用 `never`：不向 server 声明能回答提问
			...(options.settings().config.approvalPolicy === "never"
				? {}
				: {
						elicit: (server, request, context) =>
							this.#questions.elicit(server, request, context),
					}),
			onToolsChanged: options.onToolsChanged,
			onProcess: options.onProcess,
			onWarning: options.onWarning,
		});
	}

	/** 按当前的信任记录找出全部扩展；换上它用 `apply`。 */
	load(): LoadedExtensions {
		const { services } = this.#options;
		return loadExtensions(services.locations, services.trust);
	}

	/** 这个 session 的扩展和状态。 */
	items(): ExtensionInfo[] {
		return this.#loaded.items;
	}

	/** 当前启用的插件的版本目录：agent 沙盒只读。 */
	pluginDirectories(): string[] {
		return this.#loaded.pluginDirectories;
	}

	/** MCP server 的状态。 */
	servers(): McpServerState[] {
		return this.#hub.states();
	}

	/**
	 * 换上一份扩展和它们运行的沙盒：固定插件的版本，重建 hooks。MCP server 另由 `startServers`
	 * 启动：打开 session 时会话开始的 hooks 排在它们前面。返回要提示用户的话。
	 */
	apply(loaded: LoadedExtensions, runtime: ExtensionRuntime): string[] {
		const { services, sessionId, tracker } = this.#options;
		this.#loaded = loaded;
		this.#runtime = runtime;
		services.plugins.pin(sessionId, loaded.pluginVersions);
		this.#hookSandboxes.clear();
		const tmpdir = runtime.env.TMPDIR;
		if (tmpdir === undefined) throw new Error("沙盒的环境变量里没有 TMPDIR");
		this.#hooks =
			loaded.hooks.length === 0
				? undefined
				: new HookEngine({
						handlers: loaded.hooks,
						env: {
							...(runtime.env.PATH === undefined
								? {}
								: { PATH: runtime.env.PATH }),
							...(runtime.env.HOME === undefined
								? {}
								: { HOME: runtime.env.HOME }),
							TMPDIR: tmpdir,
						},
						workspace: services.locations.workspace,
						common: () => {
							const { config } = this.#options.settings();
							return {
								session_id: sessionId,
								cwd: config.workspace,
								model: config.model.id,
								sandbox_mode: config.sandboxMode,
								approval_policy: config.approvalPolicy,
							};
						},
						sandbox: (handler) => this.#hookSandbox(handler),
						verify: (source) => loaded.hookVerifiers.get(source.file)?.(),
						tracker,
						onProcess: this.#options.onProcess,
						onWarning: this.#options.onWarning,
					});
		return [...loaded.warnings, ...this.#unsandboxed()];
	}

	/** 没有沙盒时不生效的设置，逐项提示用户：密钥的 mask 和 hooks 的 `permissions` 都靠沙盒。 */
	#unsandboxed(): string[] {
		if (this.#runtime.sandboxes !== undefined) return [];
		const { mcpSecrets } = this.#options.settings().config;
		return [
			...this.#loaded.servers.flatMap((server) => {
				const names = Object.keys(
					server.definition.transport === "stdio"
						? (mcpSecrets[server.label] ?? {})
						: {},
				);
				return names.length === 0
					? []
					: [
							`没有启用沙盒：MCP server ${server.label} 的密钥 ${names.join("、")} 以真实值放进它的环境变量`,
						];
			}),
			...(this.#loaded.hooks.some(
				(handler) => handler.permissions !== undefined,
			)
				? ["没有启用沙盒：用户级 hooks 的 permissions 不生效，handler 直接运行"]
				: []),
		];
	}

	/**
	 * 按 `apply` 换上的扩展启动 MCP server：定义没变的继续运行，其余的重启。`restartLocal` 为真
	 * （沙盒换了）时本地 server 一律重启。
	 */
	async startServers(restartLocal: boolean): Promise<void> {
		await this.#hub.reconcile(this.#loaded.servers, restartLocal);
	}

	/** 本地 server 和 hooks 的基础环境变量。 */
	#processEnv(): Record<string, string> {
		const { env } = this.#runtime;
		return Object.fromEntries(
			["PATH", "HOME", "TMPDIR"].flatMap((name) => {
				const value = env[name];
				return value === undefined ? [] : [[name, value]];
			}),
		);
	}

	/**
	 * 一个本地 server 的沙盒：session 的沙盒策略，加上只读它的插件目录、读写它的数据目录，
	 * 缓存目录换成它自己的（项目的构建缓存它写不到）；有自己的代理，名单之外的域名按这个 server 询问。
	 */
	async #serverSandbox(
		server: SessionServer,
	): Promise<ExtensionSandbox | undefined> {
		const { sandboxes, policy } = this.#runtime;
		if (sandboxes === undefined || policy === undefined) return undefined;
		const { rules, config } = this.#options.settings();
		const { pluginRoot, pluginData, cache } = server.directories;
		const secrets = await this.#options.services.secrets(server, config);
		const lists = rules.networkLists();
		return sandboxes.create(
			{
				policy: { ...policy, cache },
				read: pluginRoot === pluginData ? [] : [pluginRoot],
				write: [pluginData],
			},
			{
				// 用户为密钥指定的域名同时对这个 server 放行；规则禁止的域名照样连不上
				lists: {
					allowedDomains: [
						...lists.allowedDomains,
						...secrets.flatMap(({ hosts }) => hosts),
					],
					deniedDomains: lists.deniedDomains,
				},
				ask: (request) => this.#questions.askNetwork(server, request),
				secrets,
			},
		);
	}

	/**
	 * 一个 handler 的沙盒，按来源：用户级的按它写的 `permissions`，另外能读 `~/.ospreycode/hooks/`；
	 * 仓库里的用 session 的沙盒策略，不能联网；插件的另外能读自己的插件目录、读写自己的数据目录。
	 */
	#hookSandbox(handler: HookHandler): Promise<ExtensionSandbox | undefined> {
		const { sandboxes, policy } = this.#runtime;
		if (sandboxes === undefined || policy === undefined) {
			return Promise.resolve(undefined);
		}
		const { source } = handler;
		const key = JSON.stringify([
			source.origin,
			source.plugin ?? null,
			handler.permissions ?? null,
		]);
		let sandbox = this.#hookSandboxes.get(key);
		if (sandbox === undefined) {
			sandbox = (async () => {
				if (source.origin === "plugin") {
					return sandboxes.create({
						read: source.pluginRoot === undefined ? [] : [source.pluginRoot],
						write: source.pluginData === undefined ? [] : [source.pluginData],
					});
				}
				if (source.origin === "project") {
					return sandboxes.create({ read: [], write: [] });
				}
				if (handler.permissions === undefined) {
					throw new Error("用户级 hooks 加载时已经检查过 permissions");
				}
				const mode = this.#options.services.resolveMode(handler.permissions);
				const { profile: _, ...rest } = policy;
				const profile = mode.permissionProfile;
				const domains = profile?.domains;
				return sandboxes.create(
					{
						policy: {
							...rest,
							mode: mode.baseSandboxMode as SandboxPolicy["mode"],
							...(profile === undefined ? {} : { profile }),
						},
						read: [source.directory],
						write: [],
					},
					// hooks 不能申请越界：权限配置放行的域名之外一律拒绝
					domains === undefined || domains.allow.length === 0
						? undefined
						: {
								lists: {
									allowedDomains: [...domains.allow],
									deniedDomains: [...domains.deny],
								},
								ask: async () => ({
									allow: false,
									reason:
										"Hooks can only reach the domains their permission profile allows.",
								}),
							},
				);
			})();
			this.#hookSandboxes.set(key, sandbox);
			// 没建成的不留着，下次再试
			sandbox.catch(() => this.#hookSandboxes.delete(key));
		}
		return sandbox;
	}

	/** 交给 runtime 的配置：启用的 skills、MCP 工具，以及要不要经 `hooks/run` 运行 hooks。 */
	agentConfig(): Pick<
		AgentConfig,
		"skills" | "mcp_tools" | "stop_hooks" | "pre_compact_hooks"
	> {
		return {
			skills: this.#loaded.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				directory: skill.directory,
			})),
			mcp_tools: this.mcpTools(),
			...(this.hasHooks("Stop") ? { stop_hooks: true } : {}),
			...(this.hasHooks("PreCompact") ? { pre_compact_hooks: true } : {}),
		};
	}

	/** 交给 runtime 的 MCP 工具声明。三项属性由 Host 决定，不采信 server 的标注。 */
	mcpTools(): McpToolInfo[] {
		return this.#hub.tools().map(({ name, server, tool }) => ({
			declaration: {
				name,
				description:
					tool.description ??
					tool.title ??
					`Tool ${tool.name} of the MCP server ${server.label}.`,
				parameters: tool.inputSchema,
			},
			read_only: false,
			idempotent: false,
			concurrent: false,
		}));
	}

	/** 扩展带来的内置工具：有启用的 skill 时是 `skill_load`。 */
	builtinTools(): string[] {
		return this.#loaded.skills.length === 0 ? [] : ["skill_load"];
	}

	hasHooks(event: HookEvent): boolean {
		return this.#hooks?.has(event) === true;
	}

	/**
	 * 运行一个时机的 hooks，把合并后的结果记成事件，只给用户看的话作为警告发出。
	 * 这个时机没有 hooks 时什么也不做。归属要看结果才定得下来时（输出有没有交给模型的那条消息）
	 * `scope` 给一个函数。
	 */
	async runHooks(
		trigger: HookTrigger,
		scope: HookScope | ((outcome: HookOutcome) => HookScope) = {},
	): Promise<HookOutcome> {
		const hooks = this.#hooks;
		if (hooks === undefined || !hooks.has(trigger.event)) {
			return { blocked: false, systemMessages: [], ran: 0 };
		}
		const outcome = await hooks.run(trigger);
		if (outcome.ran === 0) return outcome;
		this.#options.emit({
			type: "hooks.ran",
			event: trigger.event,
			...(trigger.task_id === undefined ? {} : { task_id: trigger.task_id }),
			...(typeof scope === "function" ? scope(outcome) : scope),
			blocked: outcome.blocked,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
			...(outcome.additionalContext === undefined
				? {}
				: { additional_context: outcome.additionalContext }),
			system_messages: outcome.systemMessages,
		});
		return outcome;
	}

	/** 按模型看到的名字找 MCP 工具。 */
	mcpTool(name: string): HubTool | undefined {
		return this.#hub.find(name);
	}

	/** 调用一个已经获准的 MCP 工具，把结果换成工具结果；完整的输出超长时写到 `outputFile`。 */
	async callMcpTool(
		tool: HubTool,
		args: Record<string, JsonValue>,
		outputFile: string,
		signal: AbortSignal,
	): Promise<ToolResult> {
		try {
			return mcpToolResult(
				await this.#hub.call(tool, args, { signal }),
				outputFile,
			);
		} catch (error) {
			if (!(error instanceof McpCallError)) throw error;
			return error.cancelled
				? { status: "cancelled", content: text(error.message) }
				: { status: "failed", content: text(error.message) };
		}
	}

	#skill(name: string): SessionSkill | undefined {
		return this.#loaded.skills.find((skill) => skill.name === name);
	}

	/** skill 现在的内容和哈希；读不了（被删掉、改坏了）时返回原因。 */
	#current(
		skill: SessionSkill,
	): { content: string; hash: string } | { error: string } {
		try {
			const loaded = loadSkill(skill.directory, {
				kind: skill.origin === "plugin" ? "plugin" : "standalone",
				maxFiles: maxSkillFiles,
				...(skill.containedIn === undefined
					? {}
					: { containedIn: skill.containedIn }),
			});
			if ("skipped" in loaded) {
				return {
					error: loaded.skipped.issues.map((issue) => issue.message).join("; "),
				};
			}
			return {
				content: renderSkillContent(loaded.skill),
				hash: hashSkill(skill.directory, loaded.skill.files, skill.containedIn),
			};
		} catch (error) {
			return { error: (error as Error).message };
		}
	}

	/**
	 * skill 的内容和基准不一样时按 skill 询问，批准只对这份内容和本任务有效。可以继续时返回空，
	 * 否则返回交给模型的结果。
	 */
	async #approveSkill(
		run: Run,
		toolCallId: string,
		skill: SessionSkill,
		action: "load" | "script",
		command?: string,
	): Promise<ToolResult | undefined> {
		const current = this.#current(skill);
		if ("error" in current) {
			return {
				status: "failed",
				content: text(
					`The skill ${skill.name} can no longer be loaded: ${current.error}`,
				),
			};
		}
		if (current.hash === skill.baseline) return undefined;
		const key = `skill:${skill.id}:${current.hash}`;
		if (run.taskApprovals.has(key)) return undefined;
		const decision = askOrDeny(
			"skill_approval",
			[
				skill.origin === "user"
					? `skill ${skill.name} 的内容在这个 session 开始之后变了`
					: `skill ${skill.name} 的内容和确认时不一样`,
			],
			this.#options.settings().policy,
		);
		if (decision.action === "allow") {
			throw new Error("内容变了的 skill 不会直接放行");
		}
		if (decision.action === "deny") return permissionDenial(decision);
		const answer = await this.#options.approvals.ask(
			run,
			{
				kind: "extension_changed",
				tool_call_id: toolCallId,
				skill: skill.name,
				directory: skill.directory,
				action,
				...(command === undefined ? {} : { command }),
				reasons: decision.reasons,
			},
			decision.category,
		);
		const subject = action === "load" ? "skill" : "skill script";
		if (answer === undefined) {
			return run.cancelled
				? {
						status: "cancelled",
						content: text(`The ${subject} was cancelled.`),
					}
				: {
						status: "denied",
						reason: "policy",
						categories: decision.categories,
						content: text(
							`The approval policy changed while this ${subject} was waiting for an answer, and it now denies such requests without asking. Continue without it.`,
						),
					};
		}
		if (answer.decision === "deny") {
			return {
				status: "denied",
				reason: "user",
				content: text(
					answer.message === undefined
						? `The user denied this ${subject}: the content of the skill ${skill.name} has changed since it was confirmed.`
						: `The user denied this ${subject} and said: ${answer.message}`,
				),
				...(answer.message === undefined ? {} : { message: answer.message }),
			};
		}
		run.taskApprovals.add(key);
		return undefined;
	}

	/**
	 * 登记 `skill_load` 时的检查：没有这个 skill、内容读不了时如实告诉模型；内容和基准不一样时询问。
	 * 可以加载时返回空。
	 */
	async checkSkillLoad(
		run: Run,
		toolCallId: string,
		rawArguments: string,
	): Promise<ToolResult | undefined> {
		let name: unknown;
		try {
			name = (JSON.parse(rawArguments) as { name?: unknown } | null)?.name;
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			// 参数不对由 runtime 报给模型：它先检查参数，再登记
			return undefined;
		}
		if (typeof name !== "string") return undefined;
		const skill = this.#skill(name);
		if (skill === undefined) {
			return {
				status: "failed",
				content: text(
					`There is no enabled skill named ${name}. Enabled skills: ${this.#loaded.skills.map((each) => each.name).join(", ") || "none"}.`,
				),
			};
		}
		return this.#approveSkill(run, toolCallId, skill, "load");
	}

	/**
	 * `skill/load`：返回 skill 的完整内容。内容要和基准一致，或者这份内容在本任务内批准过；
	 * 登记之后又变了的不返回。
	 */
	loadSkill(name: string, run: Run): SkillLoadResult {
		const skill = this.#skill(name);
		if (skill === undefined) {
			return {
				loaded: false,
				reason: `There is no enabled skill named ${name}.`,
			};
		}
		const current = this.#current(skill);
		if ("error" in current) {
			return {
				loaded: false,
				reason: `The skill ${name} can no longer be loaded: ${current.error}`,
			};
		}
		if (
			current.hash !== skill.baseline &&
			!run.taskApprovals.has(`skill:${skill.id}:${current.hash}`)
		) {
			return {
				loaded: false,
				reason: `The content of the skill ${name} changed while it was being loaded. Call skill_load again.`,
			};
		}
		return { loaded: true, content: current.content };
	}

	/**
	 * 一条 shell 命令是不是在运行 skill 脚本：某条字面命令的可执行文件，或 shell、解释器、脚本运行器
	 * 的某个参数，相对工作目录解析成真实路径后落在启用的 skill 目录里。是的话核对这个 skill 的内容，
	 * 和基准不一样时询问。可以继续时返回空。
	 */
	async checkSkillScript(
		run: Run,
		toolCallId: string,
		command: string,
		workdir: string,
		parser: ShellParser,
	): Promise<ToolResult | undefined> {
		const { skills } = this.#loaded;
		if (skills.length === 0) return undefined;
		const touched = new Set<SessionSkill>();
		for (const words of commandWords(parser.parse(command))) {
			const [executable] = words;
			const candidates =
				executable !== undefined && interpreters.has(basename(executable))
					? words
					: // 不带斜杠的命令名按 PATH 查找，不相对工作目录
						executable?.includes("/") === true
						? [executable]
						: [];
			for (const word of candidates) {
				if (word === undefined || word === "") continue;
				const path = realTarget(resolve(workdir, word));
				if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
					continue;
				}
				for (const skill of skills) {
					if (isInside(path, realTarget(skill.directory))) touched.add(skill);
				}
			}
		}
		for (const skill of touched) {
			const refused = await this.#approveSkill(
				run,
				toolCallId,
				skill,
				"script",
				command,
			);
			if (refused !== undefined) return refused;
		}
		return undefined;
	}

	/**
	 * 回答 MCP server 的一个问题（elicitation 或网络询问）。这里没有这个编号的问题时返回空。
	 */
	respond(
		requestId: string,
		answer: ApprovalAnswer | ElicitationAnswer,
	): boolean | undefined {
		return this.#questions.respond(requestId, answer);
	}

	/** 审批策略换了：挂起的网络询问重新评估。 */
	reevaluate(policy: PolicyContext): void {
		this.#questions.reevaluate(policy);
	}

	/** 关闭：挂起的问题答为取消，停掉全部 MCP server，不再固定插件的版本。 */
	async close(): Promise<void> {
		this.#questions.close();
		await this.#hub.stop();
		this.#options.services.plugins.unpin(this.#options.sessionId);
	}
}
