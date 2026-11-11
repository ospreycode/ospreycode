import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessIdentity } from "../processes/info.js";
import { withFileLock, writeFileAtomic } from "../project/locks.js";
import { ensureDirectory } from "../project/workspace.js";

/** `data/trust/extensions.json` 的格式版本。 */
const formatVersion = 1;

/** 一个扩展的确认记录。 */
export interface TrustRecord {
	/** 用户确认时的内容哈希；用户自己安装的独立扩展不用确认，没有。 */
	hash?: string;
	/** 确认的时间，ISO 8601。 */
	confirmed_at?: string;
	/** 用户停用了它。 */
	disabled?: true;
}

/** 插件从哪里安装。 */
export type PluginSource =
	| { type: "local"; path: string }
	| { type: "git"; url: string; commit: string };

/** 一个已安装的插件。 */
export interface InstalledPlugin {
	/** 当前的版本目录名：`plugins/<插件名>/<版本>/`。 */
	version: string;
	source: PluginSource;
	/** 安装或最近一次更新的时间，ISO 8601。 */
	installed_at: string;
}

interface TrustFile {
	version: number;
	extensions: Record<string, TrustRecord>;
	plugins: Record<string, InstalledPlugin>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkRecord(value: unknown): value is TrustRecord {
	return (
		isObject(value) &&
		(value.hash === undefined || typeof value.hash === "string") &&
		(value.confirmed_at === undefined ||
			typeof value.confirmed_at === "string") &&
		(value.disabled === undefined || value.disabled === true)
	);
}

function checkPlugin(value: unknown): value is InstalledPlugin {
	if (!isObject(value) || !isObject(value.source)) return false;
	const { source } = value;
	return (
		typeof value.version === "string" &&
		typeof value.installed_at === "string" &&
		((source.type === "local" && typeof source.path === "string") ||
			(source.type === "git" &&
				typeof source.url === "string" &&
				typeof source.commit === "string"))
	);
}

/**
 * 扩展的确认记录和已安装插件的登记，保存在 `data/trust/extensions.json`：任何沙盒都读写不到，
 * 沙盒里的程序没法替用户确认。改动在文件锁里读出、修改、原子写回，几个 Host 进程可以同时使用。
 */
export class TrustStore {
	#path: string;
	#lock: string;
	#owner: ProcessIdentity;

	/** `data` 是 Host 根目录下的 `data/`，`owner` 是 Host 进程的身份。 */
	constructor(data: string, owner: ProcessIdentity) {
		ensureDirectory(join(data, "trust"));
		this.#path = join(data, "trust", "extensions.json");
		this.#lock = join(data, "locks", "trust.lock");
		this.#owner = owner;
	}

	#read(): TrustFile {
		let text: string;
		try {
			text = readFileSync(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { version: formatVersion, extensions: {}, plugins: {} };
		}
		const file: unknown = JSON.parse(text);
		if (!isObject(file) || file.version !== formatVersion) {
			throw new Error(
				`${this.#path} 的格式版本不是这个版本的 Host 认识的 ${formatVersion}`,
			);
		}
		const { extensions, plugins } = file;
		if (
			!isObject(extensions) ||
			!Object.values(extensions).every(checkRecord) ||
			!isObject(plugins) ||
			!Object.values(plugins).every(checkPlugin)
		) {
			throw new Error(`${this.#path} 的格式不对`);
		}
		return {
			version: formatVersion,
			extensions: extensions as Record<string, TrustRecord>,
			plugins: plugins as Record<string, InstalledPlugin>,
		};
	}

	#update(change: (file: TrustFile) => void): Promise<void> {
		return withFileLock(this.#lock, this.#owner, () => {
			const file = this.#read();
			change(file);
			writeFileAtomic(this.#path, `${JSON.stringify(file, null, "\t")}\n`);
		});
	}

	/** 全部确认记录，键是扩展的标识。 */
	records(): Record<string, TrustRecord> {
		return this.#read().extensions;
	}

	/** 已安装的插件，键是插件名。 */
	plugins(): Record<string, InstalledPlugin> {
		return this.#read().plugins;
	}

	/** 记下用户确认了这个扩展的这份内容。 */
	confirm(id: string, hash: string): Promise<void> {
		return this.#update((file) => {
			const { disabled } = file.extensions[id] ?? {};
			file.extensions[id] = {
				hash,
				confirmed_at: new Date().toISOString(),
				...(disabled === undefined ? {} : { disabled }),
			};
		});
	}

	/** 启用或停用一个扩展；确认过的内容哈希保留。 */
	setEnabled(id: string, enabled: boolean): Promise<void> {
		return this.#update((file) => {
			const { disabled: _, ...record } = file.extensions[id] ?? {};
			if (!enabled) {
				file.extensions[id] = { ...record, disabled: true };
			} else if (Object.keys(record).length > 0) {
				file.extensions[id] = record;
			} else {
				delete file.extensions[id];
			}
		});
	}

	/** 撤销对一个扩展的确认；它被停用的状态保留。 */
	revoke(id: string): Promise<void> {
		return this.#update((file) => {
			if (file.extensions[id]?.disabled === true) {
				file.extensions[id] = { disabled: true };
			} else {
				delete file.extensions[id];
			}
		});
	}

	/** 登记一个安装好的插件版本，同时记下用户确认了它的内容。 */
	installPlugin(
		name: string,
		plugin: InstalledPlugin,
		hash: string,
	): Promise<void> {
		return this.#update((file) => {
			file.plugins[name] = plugin;
			const { disabled } = file.extensions[pluginId(name)] ?? {};
			file.extensions[pluginId(name)] = {
				hash,
				confirmed_at: plugin.installed_at,
				...(disabled === undefined ? {} : { disabled }),
			};
		});
	}

	/** 去掉一个插件的登记和确认记录。 */
	removePlugin(name: string): Promise<void> {
		return this.#update((file) => {
			delete file.plugins[name];
			delete file.extensions[pluginId(name)];
		});
	}
}

/** 插件的扩展标识。 */
export function pluginId(name: string): string {
	return `plugin/${name}`;
}
