import { randomUUID } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { readPlugin } from "@ospreycode/agent-plugins";
import type { McpServerDefinition } from "@ospreycode/mcp";
import { createTwoFilesPatch } from "diff";
import { ConfigError } from "../config/errors.js";
import { parseHooks } from "../hooks/config.js";
import { isSameProcess, type ProcessIdentity } from "../processes/info.js";
import { writeFileAtomic } from "../project/locks.js";
import { ensureDirectory } from "../project/workspace.js";
import { directoryEntries, hashEntries } from "./hash.js";
import type { InstalledPlugin, PluginSource, TrustStore } from "./trust.js";

/** 一个 skill 最多包含多少个文件、一个插件最多多少个 skill，和加载时的上限相同。 */
const maxSkillFiles = 2000;
const maxPluginSkills = 500;

/** 完整差异里一个文件最多比较这么大，超过只说明它变了。 */
const maxDiffBytes = 256 * 1024;

/** 插件名用作目录名：规范要求小写字母、数字和连字符，这里在落盘之前再核对一次。 */
const pluginNamePattern = /^[a-z0-9][a-z0-9-]*$/;

/** 从哪里安装插件：本地目录，或 git 仓库（`https://` 或 `file://`）。 */
export type PluginOrigin =
	| { type: "local"; path: string }
	| { type: "git"; url: string; ref?: string };

/** 新旧版本之间一个文件的变化。 */
export interface PluginFileChange {
	/** 相对插件根目录的路径。 */
	path: string;
	change: "added" | "removed" | "modified";
	/**
	 * 这个文件是什么：清单、`mcp.json`、hooks（`dev.ospreycode/` 里的文件）、`SKILL.md`、可执行文件，
	 * 或者其他。前五类要用户在确认时先看到。
	 */
	category: "manifest" | "mcp" | "hooks" | "skill" | "executable" | "other";
	/** 文本文件的统一 diff；二进制或太大的文件没有。 */
	diff?: string;
}

/** 准备好、等用户确认的一次安装或更新。 */
export interface PluginStage {
	name: string;
	/** 版本目录名：git 来源是完整的 commit，本地目录是内容哈希。 */
	version: string;
	/** 清单声明的版本。 */
	declaredVersion?: string;
	description?: string;
	source: PluginSource;
	skills: { name: string; description: string }[];
	servers: { name: string; definition: McpServerDefinition }[];
	hooks: { event: string; command: string; args: string[] }[];
	/** 插件里带执行权限的文件。 */
	executables: string[];
	/** 读取插件时发现的问题。 */
	diagnostics: string[];
	/** 更新时相对已安装版本的变化；第一次安装时为空。 */
	changes?: PluginFileChange[];
	/** 已经安装的就是这份内容：不用再确认。 */
	unchanged: boolean;
	/** 用户确认了：装进 `plugins/<插件名>/<版本>/` 并记下确认。 */
	commit(): Promise<void>;
	/** 用户没有确认：删掉准备好的内容。 */
	discard(): void;
}

/** 列表里的一个已安装的插件。 */
export interface PluginInfo extends InstalledPlugin {
	name: string;
}

/** 在沙盒里运行 git 的结果。 */
export interface GitResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** 插件仓库用到的依赖。 */
export interface PluginStoreOptions {
	/** Host 根目录。 */
	root: string;
	/** Host 根目录下的 `data/`。 */
	data: string;
	owner: ProcessIdentity;
	trust: TrustStore;
	/**
	 * 在沙盒里运行 git：只能写 `directory`，只能访问 `host`（不给时不能联网）。Host 的凭据不进沙盒，
	 * 所以克隆不了私有仓库。
	 */
	runGit: (
		args: readonly string[],
		options: { directory: string; host?: string },
	) => Promise<GitResult>;
}

interface PinFile extends ProcessIdentity {
	versions: Record<string, string>;
}

function categoryOf(
	path: string,
	executable: boolean,
): PluginFileChange["category"] {
	if (path === "plugin.json") return "manifest";
	if (path === "mcp.json") return "mcp";
	if (path.startsWith("dev.ospreycode/")) return "hooks";
	if (basename(path) === "SKILL.md") return "skill";
	return executable ? "executable" : "other";
}

/** 目录里每个文件的内容，键是相对路径；值带上是不是可执行、是不是符号链接。 */
function snapshot(
	directory: string,
): Map<string, { data: Buffer | string; executable: boolean }> {
	return new Map(
		directoryEntries(directory).map(({ name, data }) => {
			const executable = name.endsWith("*");
			const path = executable || name.endsWith("@") ? name.slice(0, -1) : name;
			return [path, { data, executable }];
		}),
	);
}

function isText(data: Buffer | string): boolean {
	return (
		typeof data === "string" ||
		(data.length <= maxDiffBytes && !data.includes(0))
	);
}

/** 新旧两个版本目录按文件比较。 */
export function comparePluginVersions(
	oldDirectory: string,
	newDirectory: string,
): PluginFileChange[] {
	const before = snapshot(oldDirectory);
	const after = snapshot(newDirectory);
	const changes: PluginFileChange[] = [];
	for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const old = before.get(path);
		const now = after.get(path);
		const same =
			old !== undefined &&
			now !== undefined &&
			old.executable === now.executable &&
			Buffer.from(old.data).equals(Buffer.from(now.data));
		if (same) continue;
		const text = (entry: typeof old) =>
			entry === undefined ? "" : Buffer.from(entry.data).toString("utf8");
		const comparable =
			(old === undefined || isText(old.data)) &&
			(now === undefined || isText(now.data));
		changes.push({
			path,
			change:
				old === undefined
					? "added"
					: now === undefined
						? "removed"
						: "modified",
			category: categoryOf(
				path,
				old?.executable === true || now?.executable === true,
			),
			...(comparable
				? { diff: createTwoFilesPatch(path, path, text(old), text(now)) }
				: {}),
		});
	}
	return changes;
}

/**
 * 已安装的插件：放在 `plugins/<插件名>/<版本>/`，升级时新建版本目录；数据目录
 * `plugin-data/<插件名>/` 升级后保留。安装和更新分两步：先把内容准备好交给用户看，确认后才生效。
 */
export class PluginStore {
	#options: PluginStoreOptions;
	#plugins: string;
	#pins: string;

	constructor(options: PluginStoreOptions) {
		this.#options = options;
		this.#plugins = join(options.root, "plugins");
		this.#pins = join(options.data, "plugins-in-use");
	}

	/** 已安装的插件，按名字排序。 */
	list(): PluginInfo[] {
		const plugins = this.#options.trust.plugins();
		return Object.keys(plugins)
			.sort()
			.map((name) => ({ name, ...(plugins[name] as InstalledPlugin) }));
	}

	/** 一个已安装插件的版本目录。 */
	directory(name: string, version: string): string {
		return join(this.#plugins, name, version);
	}

	/** 把来源的内容取到一个临时的准备目录里，返回目录和来源的记录。 */
	async #fetch(
		origin: PluginOrigin,
	): Promise<{ staging: string; source: PluginSource }> {
		ensureDirectory(this.#plugins);
		const staging = join(this.#plugins, `.staging-${randomUUID()}`);
		if (origin.type === "local") {
			if (
				statSync(origin.path, { throwIfNoEntry: false })?.isDirectory() !== true
			) {
				throw new ConfigError(`插件的来源不是目录：${origin.path}`);
			}
			const path = realpathSync(origin.path);
			cpSync(path, staging, {
				recursive: true,
				verbatimSymlinks: true,
				filter: (source) => basename(source) !== ".git",
			});
			return { staging, source: { type: "local", path } };
		}
		let url: URL;
		try {
			url = new URL(origin.url);
		} catch {
			throw new ConfigError(`插件的 git 地址不是合法的 URL：${origin.url}`);
		}
		if (url.protocol !== "https:" && url.protocol !== "file:") {
			throw new ConfigError(
				"插件的 git 地址要是 https:// 或 file://：Host 的凭据不进沙盒，私有仓库先自己克隆，再按本地目录安装",
			);
		}
		if (url.username !== "" || url.password !== "") {
			throw new ConfigError("插件的 git 地址里不能带用户名和密码");
		}
		ensureDirectory(join(this.#options.root, "tmp"));
		// 目录名要短：沙盒后端的 Unix socket 建在这个目录里，路径有长度上限
		const work = join(
			this.#options.root,
			"tmp",
			`plugin-${randomUUID().slice(0, 8)}`,
		);
		mkdirSync(work, { mode: 0o700 });
		try {
			const run = async (args: readonly string[]) => {
				const result = await this.#options.runGit(args, {
					directory: work,
					...(url.protocol === "https:" ? { host: url.hostname } : {}),
				});
				if (result.exitCode !== 0) {
					throw new ConfigError(
						`git ${args[0]} 失败了：${result.stderr.trim() || `退出码 ${result.exitCode}`}`,
					);
				}
				return result.stdout.trim();
			};
			await run([
				"clone",
				"--quiet",
				"--no-recurse-submodules",
				"--depth",
				"1",
				...(origin.ref === undefined ? [] : ["--branch", origin.ref]),
				"--",
				url.href,
				join(work, "repo"),
			]);
			const commit = await run(["-C", join(work, "repo"), "rev-parse", "HEAD"]);
			if (!/^[0-9a-f]{40,64}$/.test(commit)) {
				throw new Error(`git rev-parse 的输出不是 commit：${commit}`);
			}
			cpSync(join(work, "repo"), staging, {
				recursive: true,
				verbatimSymlinks: true,
				filter: (source) => basename(source) !== ".git",
			});
			return { staging, source: { type: "git", url: url.href, commit } };
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	/**
	 * 准备一次安装或更新：取来内容，按规范校验，列出它带的组件和相对已安装版本的变化。
	 * 这时还没有生效，等 `commit()`。来源取不到或插件不合规时抛出 `ConfigError`。
	 */
	async stage(origin: PluginOrigin): Promise<PluginStage> {
		const { staging, source } = await this.#fetch(origin);
		const discard = () => rmSync(staging, { recursive: true, force: true });
		try {
			const root = realpathSync(staging);
			const hash = hashEntries(directoryEntries(root));
			// 准备目录之后会改名，数据目录要按插件名定：先读清单拿到名字
			const first = readPlugin(root, {
				pluginData: join(this.#options.root, "plugin-data", ".unknown"),
				maxSkills: maxPluginSkills,
				maxSkillFiles,
			});
			if (first.plugin === undefined) {
				throw new ConfigError(
					`不是合规的插件：${first.diagnostics.map((d) => d.message).join("；")}`,
				);
			}
			const { name } = first.plugin.manifest;
			if (!pluginNamePattern.test(name)) {
				throw new ConfigError(`插件名不能用作目录名：${name}`);
			}
			const pluginData = join(this.#options.root, "plugin-data", name);
			const { plugin, diagnostics } = readPlugin(root, {
				pluginData,
				maxSkills: maxPluginSkills,
				maxSkillFiles,
			});
			if (plugin === undefined) throw new Error("第二次读取插件失败了");
			const version = source.type === "git" ? source.commit : hash;
			const target = this.directory(name, version);
			const hooks: PluginStage["hooks"] = [];
			const problems = diagnostics.map(
				(d) => `${d.subject === undefined ? "" : `${d.subject}：`}${d.message}`,
			);
			if (plugin.namespaceDirectory !== undefined) {
				const file = join(plugin.namespaceDirectory, "hooks.json");
				if (statSync(file, { throwIfNoEntry: false })?.isFile() === true) {
					const parsed = parseHooks(readFileSync(file, "utf8"), {
						origin: "plugin",
						plugin: name,
						file,
						directory: plugin.namespaceDirectory,
						pluginData,
						pluginRoot: root,
					});
					if ("error" in parsed) {
						problems.push(`hooks.json 不会加载：${parsed.error}`);
					} else {
						hooks.push(
							...parsed.handlers.map(({ event, command, args }) => ({
								event,
								// 准备目录之后会改名：显示相对插件根目录的路径
								command: command.startsWith(root)
									? `.${command.slice(root.length)}`
									: command,
								args: args.map((arg) =>
									// biome-ignore lint/suspicious/noTemplateCurlyInString: 显示给用户的是 hooks.json 里的写法，不是模板字符串
									arg.replaceAll(root, "${PLUGIN_ROOT}"),
								),
							})),
						);
					}
				}
			}
			const installed = this.#options.trust.plugins()[name];
			const current =
				installed === undefined
					? undefined
					: this.directory(name, installed.version);
			const hasCurrent =
				current !== undefined &&
				statSync(current, { throwIfNoEntry: false })?.isDirectory() === true;
			const changes = hasCurrent
				? comparePluginVersions(current, root)
				: undefined;
			const { trust } = this.#options;
			return {
				name,
				version,
				...(plugin.manifest.version === undefined
					? {}
					: { declaredVersion: plugin.manifest.version }),
				...(plugin.manifest.description === undefined
					? {}
					: { description: plugin.manifest.description }),
				source,
				skills: plugin.skills.map(({ name, description }) => ({
					name,
					description,
				})),
				servers: plugin.mcpServers.map(({ name, definition }) => ({
					name,
					definition,
				})),
				hooks,
				executables: [...snapshot(root)]
					.filter(([, entry]) => entry.executable)
					.map(([path]) => path),
				diagnostics: problems,
				...(changes === undefined ? {} : { changes }),
				unchanged:
					installed !== undefined &&
					installed.version === version &&
					changes?.length === 0,
				commit: async () => {
					ensureDirectory(join(this.#plugins, name));
					rmSync(target, { recursive: true, force: true });
					renameSync(staging, target);
					await trust.installPlugin(
						name,
						{ version, source, installed_at: new Date().toISOString() },
						hash,
					);
					this.cleanVersions();
				},
				discard,
			};
		} catch (error) {
			discard();
			throw error;
		}
	}

	/** 已安装插件的来源，更新时从这里再取一次。没有安装时抛出 `ConfigError`。 */
	originOf(name: string): PluginOrigin {
		const installed = this.#options.trust.plugins()[name];
		if (installed === undefined) throw new ConfigError(`没有安装插件 ${name}`);
		return installed.source.type === "git"
			? { type: "git", url: installed.source.url }
			: installed.source;
	}

	/**
	 * 卸载一个插件：去掉登记和确认记录，删掉没有打开的 session 在用的版本目录；`deleteData` 为真时
	 * 连数据目录和它的 server 的缓存目录一起删。没有安装时返回 false。
	 */
	async remove(name: string, deleteData: boolean): Promise<boolean> {
		if (this.#options.trust.plugins()[name] === undefined) return false;
		await this.#options.trust.removePlugin(name);
		this.cleanVersions();
		if (deleteData) {
			for (const directory of [
				join(this.#options.root, "plugin-data", name),
				join(this.#options.root, "server-cache", "plugin", name),
			]) {
				rmSync(directory, { recursive: true, force: true });
			}
		}
		return true;
	}

	/** 一个 session 固定了这些插件版本：它关闭之前这些版本目录不删。 */
	pin(sessionId: string, versions: Record<string, string>): void {
		ensureDirectory(this.#pins);
		const file: PinFile = { ...this.#options.owner, versions };
		writeFileAtomic(
			join(this.#pins, `${sessionId}.json`),
			JSON.stringify(file),
		);
	}

	/** session 关闭了，不再固定插件版本。 */
	unpin(sessionId: string): void {
		rmSync(join(this.#pins, `${sessionId}.json`), { force: true });
	}

	/** 打开着的 session 固定的版本目录。持有者已经不在的记录顺手删掉。 */
	#pinned(): Set<string> {
		const pinned = new Set<string>();
		let names: string[];
		try {
			names = readdirSync(this.#pins);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return pinned;
			throw error;
		}
		for (const file of names) {
			if (!file.endsWith(".json")) continue;
			const path = join(this.#pins, file);
			const pin = JSON.parse(readFileSync(path, "utf8")) as PinFile;
			if (!isSameProcess(pin, this.#options.owner.boot_id)) {
				unlinkSync(path);
				continue;
			}
			for (const [name, version] of Object.entries(pin.versions)) {
				pinned.add(this.directory(name, version));
			}
		}
		return pinned;
	}

	/**
	 * 删掉不再用的版本目录：不是当前版本、也没有打开的 session 固定着它的；上次中断留下的准备目录
	 * 也删掉。Host 启动时和每次安装、更新、卸载之后调用。
	 */
	cleanVersions(): void {
		let names: string[];
		try {
			names = readdirSync(this.#plugins);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const installed = this.#options.trust.plugins();
		const pinned = this.#pinned();
		for (const name of names) {
			const directory = join(this.#plugins, name);
			if (name.startsWith(".staging-")) {
				// 别的 Host 进程可能正在准备：只删一小时之前的
				if (Date.now() - statSync(directory).mtimeMs > 3_600_000) {
					rmSync(directory, { recursive: true, force: true });
				}
				continue;
			}
			if (!statSync(directory).isDirectory()) continue;
			const versions = readdirSync(directory);
			let kept = 0;
			for (const version of versions) {
				const path = join(directory, version);
				if (installed[name]?.version === version || pinned.has(path)) {
					kept += 1;
				} else {
					rmSync(path, { recursive: true, force: true });
				}
			}
			if (kept === 0) rmSync(directory, { recursive: true, force: true });
		}
	}
}
