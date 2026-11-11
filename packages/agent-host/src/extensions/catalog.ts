import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	type McpServerEntry,
	parseMcpConfig,
	readPlugin,
} from "@ospreycode/agent-plugins";
import type { McpServerDefinition } from "@ospreycode/mcp";
import { discoverSkills, type Skill } from "@ospreycode/skills";
import {
	type HookHandler,
	type HookSource,
	parseHooks,
} from "../hooks/config.js";
import {
	canonicalJson,
	directoryEntries,
	hashDirectory,
	hashEntries,
	hashSkill,
} from "./hash.js";
import { pluginId, type TrustStore } from "./trust.js";

/** 独立 skills 目录往下找几层、最多看多少个目录。 */
const skillSearchDepth = 4;
const skillSearchDirectories = 2000;
/** 一个 skill 最多包含多少个文件：内容哈希要覆盖全部文件。 */
const maxSkillFiles = 2000;
/** 一个插件的 `skills/` 下最多看多少个子目录。 */
const maxPluginSkills = 500;

/** 扩展的种类。 */
export type ExtensionKind = "skill" | "mcp_server" | "hooks" | "plugin";

/** 扩展的来源：用户安装的独立扩展、仓库自带、用户安装的插件。 */
export type ExtensionOrigin = "user" | "project" | "plugin";

/**
 * 扩展在这个 session 里的状态：
 *
 * - `enabled`：在用
 * - `disabled`：用户停用了
 * - `unconfirmed`：仓库自带，还没有确认
 * - `changed`：内容和确认时不一样，要重新确认
 * - `shadowed`：有同名（MCP server 是同标签）的扩展排在它前面
 * - `failed`：加载失败，原因在 `detail`
 */
export type ExtensionStatus =
	| "enabled"
	| "disabled"
	| "unconfirmed"
	| "changed"
	| "shadowed"
	| "failed";

/** 一个扩展的来源、版本和状态。 */
export interface ExtensionInfo {
	/** 扩展的标识：确认、启用和停用时引用它。 */
	id: string;
	kind: ExtensionKind;
	origin: ExtensionOrigin;
	/** skill 的名字、MCP server 的标签、插件的名字；hooks 是它的配置文件。 */
	name: string;
	/** 所属的插件；不是插件的组件时为空。 */
	plugin?: string;
	/** 插件的版本：清单声明的，没有声明时是版本目录名（commit 或内容哈希）。 */
	version?: string;
	/** 文件或目录的位置；远程 MCP server 是它的 URL。 */
	location: string;
	/** MCP server 的传输方式：`stdio` 是本地进程，`streamable-http` 是远程 server。 */
	transport?: "stdio" | "streamable-http";
	status: ExtensionStatus;
	/** 状态的说明：失败的原因、被谁盖住。 */
	detail?: string;
	/** 当前内容的哈希：确认时记下它。 */
	hash?: string;
	/**
	 * 确认之前给用户看的内容摘要：skill 的说明，MCP server 的命令行或地址，hooks 的每个 handler，
	 * 插件的说明。加载失败的没有。
	 */
	summary?: string[];
}

/** 这个 session 启用的一个 skill。 */
export interface SessionSkill {
	id: string;
	name: string;
	description: string;
	/** skill 目录，agent 沙盒里可读。 */
	directory: string;
	origin: ExtensionOrigin;
	/** 插件里的 skill 所在的插件版本目录：读取时文件不能落在它外面。 */
	containedIn?: string;
	/** 基准哈希：仓库自带和插件里的是确认时的，用户级的是 session 开始时的。 */
	baseline: string;
}

/** 一个本地 MCP server 用到的目录。 */
export interface ServerDirectories {
	pluginRoot: string;
	pluginData: string;
	/** 包管理器的缓存：在数据目录之外，那里受保护的名字只读，包管理器要写的 `.git` 这类名字建不出来。 */
	cache: string;
}

/** 这个 session 启用的一个 MCP server。 */
export interface SessionServer {
	id: string;
	/** Host 分配的标签：工具名的前缀，也是凭据和权限规则里引用它的名字。 */
	label: string;
	origin: ExtensionOrigin;
	plugin?: string;
	definition: McpServerDefinition;
	/**
	 * `PLUGIN_ROOT`、`PLUGIN_DATA` 和包管理器的缓存目录：本地 server 的环境变量和沙盒的读写范围
	 * 按它们给。
	 */
	directories: ServerDirectories;
	/** 定义的哈希：重新加载时据此判断要不要重启，探测结果的缓存也按它存。 */
	definitionHash: string;
	/** 启动前核对内容还是不是确认过的那一份：不是时返回原因。用户级的不用核对。 */
	verify(): string | undefined;
}

/** 这个 session 的全部扩展。 */
export interface LoadedExtensions {
	/** 找到的每个扩展和状态，供查看、确认、启用和停用。 */
	items: ExtensionInfo[];
	skills: SessionSkill[];
	servers: SessionServer[];
	hooks: HookHandler[];
	/**
	 * 运行前核对一份 hooks 的内容还是不是确认过的那一份，键是 `hooks.json` 的路径：不是时返回原因。
	 * 只有仓库自带的 hooks 在里面：用户级的不用确认，插件的版本目录沙盒写不到。
	 */
	hookVerifiers: Map<string, () => string | undefined>;
	/** 启用的插件的版本目录：agent 沙盒只读。 */
	pluginDirectories: string[];
	/** 这个 session 固定下来的插件版本：插件名到版本目录名。 */
	pluginVersions: Record<string, string>;
	/** 要提示用户的话：没确认的仓库扩展、被跳过的条目、加载失败的原因。 */
	warnings: string[];
}

/** 查找扩展用到的位置。 */
export interface ExtensionLocations {
	/** Host 根目录。 */
	root: string;
	/** 用户的主目录；没有时不找用户级 skills。 */
	home: string | undefined;
	workspace: string;
	projectRoot: string;
	projectId: string;
}

/** MCP server 的标签：转小写，`[a-z0-9_-]` 以外的字符改成下划线。 */
export function normalizeLabel(name: string): string {
	return name.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_");
}

/** 模型看到的 MCP 工具名：标签加 `__` 再加工具名。 */
export function mcpToolName(label: string, tool: string): string {
	return `${label}__${tool}`;
}

/** 一个 MCP server 会运行什么、连到哪里。 */
function describeServer(definition: McpServerDefinition): string[] {
	if (definition.transport === "streamable-http") {
		const headers = Object.keys(definition.headers);
		return [
			`streamable-http ${definition.url}`,
			...(headers.length === 0 ? [] : [`headers: ${headers.join(", ")}`]),
		];
	}
	const env = Object.keys(definition.env);
	return [
		`stdio ${[definition.command, ...definition.args].join(" ")}`,
		`cwd: ${definition.cwd}`,
		...(env.length === 0 ? [] : [`env: ${env.join(", ")}`]),
	];
}

/** 一个 handler 在什么时机运行什么命令。 */
function describeHandler(handler: HookHandler): string {
	const matcher =
		handler.matcher === undefined ? "" : `(${handler.matcher.source})`;
	const permissions =
		handler.permissions === undefined ? "" : ` [${handler.permissions}]`;
	return `${handler.event}${matcher}: ${[handler.command, ...handler.args].join(" ")}${permissions}`;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

function realDirectory(path: string): string | undefined {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
		? realpathSync(path)
		: undefined;
}

/** `mcp.json` 里一个 server 的原文，哈希按它算。 */
function rawServers(text: string): Record<string, unknown> {
	const raw = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
	return raw.mcpServers ?? {};
}

/**
 * 找出这个 session 的全部扩展，按信任记录定下各自的状态。不执行扩展里的任何东西，
 * 也不联网；单个扩展加载失败只影响它自己。
 */
export function loadExtensions(
	locations: ExtensionLocations,
	trust: TrustStore,
): LoadedExtensions {
	const { root, projectRoot, projectId } = locations;
	const records = trust.records();
	const result: LoadedExtensions = {
		items: [],
		skills: [],
		servers: [],
		hooks: [],
		hookVerifiers: new Map(),
		pluginDirectories: [],
		pluginVersions: {},
		warnings: [],
	};
	/**
	 * 一个扩展的状态。`confirm` 为真（仓库自带和插件）时要有内容相同的确认记录；
	 * 用户级的只看有没有停用。
	 */
	const statusOf = (
		id: string,
		hash: string,
		confirm: boolean,
	): ExtensionStatus => {
		const record = records[id];
		if (record?.disabled === true) return "disabled";
		if (!confirm) return "enabled";
		if (record?.hash === undefined) return "unconfirmed";
		return record.hash === hash ? "enabled" : "changed";
	};
	const add = (item: ExtensionInfo): boolean => {
		result.items.push(item);
		return item.status === "enabled";
	};

	// skills：同名时项目级的优先于用户级的，再是插件的；项目内离工作区近的优先
	const skillCandidates: {
		skill: Skill;
		item: ExtensionInfo;
		containedIn?: string;
		confirmed?: string;
	}[] = [];
	const addSkills = (
		directory: string,
		origin: ExtensionOrigin,
		idOf: (skill: Skill) => string,
		plugin?: { name: string; root: string; status: ExtensionStatus },
		found?: readonly Skill[],
	) => {
		let skills = found;
		if (skills === undefined) {
			const discovered = discoverSkills(directory, {
				kind: "standalone",
				maxDepth: skillSearchDepth,
				maxDirectories: skillSearchDirectories,
				maxFiles: maxSkillFiles,
			});
			for (const skipped of discovered.skipped) {
				result.warnings.push(
					`跳过了 skill ${skipped.directory}：${skipped.issues.map((issue) => issue.message).join("；")}`,
				);
			}
			if (discovered.truncated) {
				result.warnings.push(
					`${directory} 里的目录太多，只找了前 ${skillSearchDirectories} 个`,
				);
			}
			skills = discovered.skills;
		}
		for (const skill of skills) {
			const id = idOf(skill);
			let hash: string;
			try {
				hash = hashSkill(skill.directory, skill.files, plugin?.root);
			} catch (error) {
				result.items.push({
					id,
					kind: "skill",
					origin,
					name: skill.name,
					...(plugin === undefined ? {} : { plugin: plugin.name }),
					location: skill.directory,
					status: "failed",
					detail: (error as Error).message,
				});
				continue;
			}
			// 插件的 skill 随插件确认，自己只记有没有停用
			const own = statusOf(id, hash, origin === "project");
			const status =
				plugin !== undefined && plugin.status !== "enabled"
					? plugin.status
					: own;
			skillCandidates.push({
				skill,
				item: {
					id,
					kind: "skill",
					origin,
					name: skill.name,
					...(plugin === undefined ? {} : { plugin: plugin.name }),
					location: skill.directory,
					status,
					hash,
					summary: [skill.description],
				},
				...(plugin === undefined ? {} : { containedIn: plugin.root }),
			});
		}
	};

	// MCP server：标签重复时按用户级、插件、项目级的顺序保留第一个
	const serverCandidates: {
		item: ExtensionInfo;
		server: Omit<SessionServer, "label" | "id">;
	}[] = [];
	const addServers = (
		file: string,
		origin: ExtensionOrigin,
		entries: readonly McpServerEntry[],
		raw: Record<string, unknown>,
		describe: (entry: McpServerEntry) => {
			id: string;
			name: string;
			directories: ServerDirectories;
			/** 定义之外也算进内容的部分（项目配置目录里的文件）。 */
			content: string;
			confirm: boolean;
			plugin?: { name: string; status: ExtensionStatus };
			verify: (hash: string) => string | undefined;
		},
	) => {
		for (const entry of [...entries].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		)) {
			const info = describe(entry);
			const definitionHash = hashEntries([
				{ name: "definition", data: canonicalJson(raw[entry.name]) },
			]);
			const hash = hashEntries([
				{ name: "definition", data: canonicalJson(raw[entry.name]) },
				{ name: "content", data: info.content },
			]);
			const own = statusOf(info.id, hash, info.confirm);
			const status =
				info.plugin !== undefined && info.plugin.status !== "enabled"
					? info.plugin.status
					: own;
			serverCandidates.push({
				item: {
					id: info.id,
					kind: "mcp_server",
					origin,
					name: info.name,
					...(info.plugin === undefined ? {} : { plugin: info.plugin.name }),
					location:
						entry.definition.transport === "stdio"
							? file
							: entry.definition.url,
					transport: entry.definition.transport,
					status,
					hash,
					summary: describeServer(entry.definition),
				},
				server: {
					origin,
					...(info.plugin === undefined ? {} : { plugin: info.plugin.name }),
					definition: entry.definition,
					directories: info.directories,
					definitionHash,
					verify: () => info.verify(hash),
				},
			});
		}
	};
	const reportMcp = (
		file: string,
		parsed: ReturnType<typeof parseMcpConfig>,
	) => {
		if (parsed.disabled !== undefined) {
			result.warnings.push(`${file} 没有加载：${parsed.disabled}`);
		}
		for (const skipped of parsed.skipped) {
			result.warnings.push(
				`跳过了 ${file} 里的 server ${skipped.name}：${skipped.message}`,
			);
		}
	};

	const addHooks = (
		source: HookSource,
		id: string,
		hash: string,
		confirm: boolean,
		plugin?: { name: string; status: ExtensionStatus },
	) => {
		const text = readText(source.file);
		if (text === undefined) return;
		const parsed = parseHooks(text, source);
		const base = {
			id,
			kind: "hooks" as const,
			origin: source.origin,
			name: source.file,
			...(plugin === undefined ? {} : { plugin: plugin.name }),
			location: source.file,
		};
		if ("error" in parsed) {
			result.items.push({ ...base, status: "failed", detail: parsed.error });
			result.warnings.push(`${source.file} 没有加载：${parsed.error}`);
			return;
		}
		const own = statusOf(id, hash, confirm);
		const status =
			plugin !== undefined && plugin.status !== "enabled" ? plugin.status : own;
		const summary = parsed.handlers.map(describeHandler);
		if (add({ ...base, status, hash, summary })) {
			result.hooks.push(...parsed.handlers);
		}
	};

	// 用户级
	const { home } = locations;
	if (home !== undefined) {
		addSkills(
			join(home, ".agents", "skills"),
			"user",
			(skill) => `skill/user/${skill.name}`,
		);
	}
	const userMcp = join(root, "mcp.json");
	const userMcpText = readText(userMcp);
	if (userMcpText !== undefined) {
		const directories = (name: string) => {
			const directory = join(root, "server-data", "user", normalizeLabel(name));
			return { pluginRoot: directory, pluginData: directory };
		};
		const parsed = parseMcpConfig(userMcpText, {
			...directories(""),
			userLevel: true,
			serverDirectories: directories,
		});
		reportMcp(userMcp, parsed);
		if (parsed.disabled === undefined) {
			addServers(
				userMcp,
				"user",
				parsed.servers,
				rawServers(userMcpText),
				(entry) => ({
					id: `mcp/user/${entry.name}`,
					name: entry.name,
					directories: {
						...directories(entry.name),
						cache: join(
							root,
							"server-cache",
							"user",
							normalizeLabel(entry.name),
						),
					},
					content: "",
					confirm: false,
					verify: () => undefined,
				}),
			);
		}
	}

	// 用户级 hooks：配置文件在根目录里，脚本在只对它们的沙盒开放读取的 `hooks/` 里；不用确认
	const userHooks = join(root, "hooks.json");
	const userHooksText = readText(userHooks);
	if (userHooksText !== undefined) {
		addHooks(
			{ origin: "user", file: userHooks, directory: join(root, "hooks") },
			"hooks/user",
			hashEntries([{ name: "hooks.json", data: userHooksText }]),
			false,
		);
	}

	// 插件：只从 Host 根目录里用户安装的版本目录加载
	const plugins = trust.plugins();
	for (const name of Object.keys(plugins).sort()) {
		const installed = plugins[name];
		if (installed === undefined) continue;
		const directory = join(root, "plugins", name, installed.version);
		const pluginData = join(root, "plugin-data", name);
		const id = pluginId(name);
		const base = {
			id,
			kind: "plugin" as const,
			origin: "plugin" as const,
			name,
			location: directory,
		};
		const versionRoot = realDirectory(directory);
		if (versionRoot === undefined) {
			result.items.push({
				...base,
				status: "failed",
				detail: "版本目录不存在，重新安装这个插件",
			});
			continue;
		}
		const read = readPlugin(versionRoot, {
			pluginData,
			maxSkills: maxPluginSkills,
			maxSkillFiles,
		});
		const { plugin } = read;
		if (plugin === undefined) {
			const detail = read.diagnostics.map((d) => d.message).join("；");
			result.items.push({ ...base, status: "failed", detail });
			result.warnings.push(`插件 ${name} 没有加载：${detail}`);
			continue;
		}
		for (const diagnostic of read.diagnostics) {
			result.warnings.push(
				`插件 ${name}：${diagnostic.subject === undefined ? "" : `${diagnostic.subject}：`}${diagnostic.message}`,
			);
		}
		const hash = hashDirectory(versionRoot);
		const status = statusOf(id, hash, true);
		result.items.push({
			...base,
			version: plugin.manifest.version ?? installed.version,
			status,
			hash,
			...(plugin.manifest.description === undefined
				? {}
				: { summary: [plugin.manifest.description] }),
		});
		if (status === "changed") {
			result.warnings.push(
				`插件 ${name} 的内容和安装时确认的不一样，已停用：用 ospreycode plugin update ${name} 重新确认`,
			);
		}
		const owner = { name, root: versionRoot, status };
		if (status === "enabled") {
			result.pluginDirectories.push(versionRoot);
			result.pluginVersions[name] = installed.version;
		}
		addSkills(
			versionRoot,
			"plugin",
			(skill) => `${id}/skill/${skill.name}`,
			owner,
			plugin.skills,
		);
		const mcpFile = join(versionRoot, "mcp.json");
		const mcpText = readText(mcpFile);
		if (mcpText !== undefined && plugin.mcpServers.length > 0) {
			addServers(
				mcpFile,
				"plugin",
				plugin.mcpServers,
				rawServers(mcpText),
				(entry) => ({
					id: `${id}/mcp/${entry.name}`,
					name: `${name}_${entry.name}`,
					directories: {
						pluginRoot: versionRoot,
						pluginData,
						cache: join(root, "server-cache", "plugin", name),
					},
					content: "",
					confirm: false,
					plugin: owner,
					// 版本目录在 Host 根目录里，沙盒写不到；重启 server 前再核对一次整个目录
					verify: () =>
						hashDirectory(versionRoot) === hash
							? undefined
							: `插件 ${name} 的内容和确认时不一样`,
				}),
			);
		}
		if (plugin.namespaceDirectory !== undefined) {
			addHooks(
				{
					origin: "plugin",
					plugin: name,
					file: join(plugin.namespaceDirectory, "hooks.json"),
					directory: plugin.namespaceDirectory,
					pluginData,
					pluginRoot: versionRoot,
				},
				`${id}/hooks`,
				hash,
				false,
				owner,
			);
		}
	}

	// 仓库自带：项目配置目录里的 mcp.json 和 hooks.json，项目根目录到工作区各级的 .agents/skills/
	const projectConfig = realDirectory(join(projectRoot, ".ospreycode"));
	if (projectConfig !== undefined) {
		// stdio server 会运行这个目录里的文件：定义之外，目录里别的文件变了也要重新确认
		const filesHash = () =>
			hashEntries(directoryEntries(projectConfig, ["mcp.json", "hooks.json"]));
		const projectMcp = join(projectConfig, "mcp.json");
		const projectMcpText = readText(projectMcp);
		if (projectMcpText !== undefined) {
			const directories = (name: string) => ({
				pluginRoot: projectConfig,
				pluginData: join(root, "server-data", projectId, normalizeLabel(name)),
			});
			const parsed = parseMcpConfig(projectMcpText, {
				...directories(""),
				userLevel: false,
				serverDirectories: directories,
			});
			reportMcp(projectMcp, parsed);
			if (parsed.disabled === undefined) {
				const raw = rawServers(projectMcpText);
				const files = filesHash();
				addServers(projectMcp, "project", parsed.servers, raw, (entry) => {
					const local = entry.definition.transport === "stdio";
					return {
						id: `mcp/project/${projectId}/${entry.name}`,
						name: entry.name,
						directories: {
							...directories(entry.name),
							cache: join(
								root,
								"server-cache",
								projectId,
								normalizeLabel(entry.name),
							),
						},
						content: local ? files : "",
						confirm: true,
						verify: (hash) => {
							const text = readText(projectMcp);
							const current =
								text === undefined
									? undefined
									: hashEntries([
											{
												name: "definition",
												data: canonicalJson(rawServers(text)[entry.name]),
											},
											{ name: "content", data: local ? filesHash() : "" },
										]);
							return current === hash
								? undefined
								: `${projectMcp} 里 ${entry.name} 的定义或项目配置目录里的文件和确认时不一样`;
						},
					};
				});
			}
		}
		const projectHooks = join(projectConfig, "hooks.json");
		const hooksHash = hashDirectory(projectConfig);
		addHooks(
			{ origin: "project", file: projectHooks, directory: projectConfig },
			`hooks/project/${projectId}`,
			hooksHash,
			true,
		);
		result.hookVerifiers.set(projectHooks, () =>
			hashDirectory(projectConfig) === hooksHash
				? undefined
				: "项目配置目录里的文件和确认时不一样",
		);
	}
	const skillRoots: string[] = [];
	for (let dir = locations.workspace; ; dir = dirname(dir)) {
		skillRoots.unshift(dir);
		if (dir === projectRoot || dirname(dir) === dir) break;
	}
	// 离工作区近的排在前面：同名时保留第一个
	for (const dir of skillRoots.reverse()) {
		addSkills(
			join(dir, ".agents", "skills"),
			"project",
			(skill) =>
				`skill/project/${projectId}/${relative(projectRoot, skill.directory)}`,
		);
	}

	// 同名的 skill 按项目级、用户级、插件的顺序保留第一个启用的
	const order: Record<ExtensionOrigin, number> = {
		project: 0,
		user: 1,
		plugin: 2,
	};
	const names = new Map<string, string>();
	for (const candidate of skillCandidates
		.map((value, index) => ({ value, index }))
		.sort(
			(a, b) =>
				order[a.value.item.origin] - order[b.value.item.origin] ||
				a.index - b.index,
		)
		.map(({ value }) => value)) {
		const { skill, item } = candidate;
		if (item.status === "enabled") {
			const first = names.get(skill.name);
			if (first !== undefined) {
				item.status = "shadowed";
				item.detail = `和 ${first} 同名`;
				result.warnings.push(
					`skill ${skill.name}（${skill.directory}）和 ${first} 同名，没有启用`,
				);
			} else {
				names.set(skill.name, skill.directory);
				result.skills.push({
					id: item.id,
					name: skill.name,
					description: skill.description,
					directory: skill.directory,
					origin: item.origin,
					...(candidate.containedIn === undefined
						? {}
						: { containedIn: candidate.containedIn }),
					baseline: item.hash as string,
				});
			}
		}
		result.items.push(item);
	}

	const labels = new Map<string, string>();
	for (const { item, server } of serverCandidates) {
		const label = normalizeLabel(item.name);
		if (item.status === "enabled") {
			const first = labels.get(label);
			if (first !== undefined) {
				item.status = "shadowed";
				item.detail = `标签 ${label} 已经被 ${first} 占用`;
				result.warnings.push(
					`MCP server ${item.name}（${item.id}）的标签 ${label} 已经被 ${first} 占用，跳过`,
				);
			} else {
				labels.set(label, item.id);
				result.servers.push({ ...server, id: item.id, label });
			}
		}
		result.items.push({ ...item, name: label });
	}

	for (const item of result.items) {
		if (item.origin !== "project") continue;
		if (item.status === "unconfirmed") {
			result.warnings.push(
				`仓库自带的${kindName[item.kind]} ${item.name} 还没有确认，没有启用：用 /extensions 或 ospreycode trust review 确认`,
			);
		} else if (item.status === "changed") {
			result.warnings.push(
				`仓库自带的${kindName[item.kind]} ${item.name} 的内容和确认时不一样，已停用：用 /extensions 或 ospreycode trust review 重新确认`,
			);
		}
	}
	return result;
}

const kindName: Record<ExtensionKind, string> = {
	skill: " skill",
	mcp_server: " MCP server",
	hooks: " hooks",
	plugin: "插件",
};
