import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProcessIdentity } from "../processes/info.js";
import { newId } from "../sessions/ids.js";
import { withFileLock, writeFileAtomic } from "./locks.js";

/** `data/identity.json` 和 `data/projects.json` 的格式版本。 */
const formatVersion = 1;

/** 读 git 目录里的一个小文件：只读不是符号链接的普通文件，不超过 4 KiB。不是这样的文件时返回空。 */
function readGitFile(path: string): string | undefined {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat?.isFile() !== true || stat.size > 4096) return undefined;
	return readFileSync(path, "utf8");
}

function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
			return undefined;
		}
		throw error;
	}
}

/**
 * linked worktree 的公共目录（照 Codex 的 `git-utils/trust.rs`）：`.git` 文件的 `gitdir:` 的父目录名要是
 * `worktrees`，那里的 `commondir` 解析成真实路径，公共目录下 `worktrees/<名字>/gitdir` 要指回这个
 * `.git` 文件。要核对双向的引用：`.git` 文件属于仓库内容，可以写成别的仓库的路径。核对不成立时返回空。
 */
function worktreeCommonDir(root: string, dotGit: string): string | undefined {
	const line = readGitFile(dotGit)?.split(/\r?\n/)[0];
	if (line?.startsWith("gitdir: ") !== true) return undefined;
	const gitdir = resolve(root, line.slice("gitdir: ".length));
	if (basename(dirname(gitdir)) !== "worktrees") return undefined;
	const commondir = readGitFile(join(gitdir, "commondir"))?.trim();
	if (commondir === undefined || commondir === "") return undefined;
	const common = realpathOrUndefined(resolve(gitdir, commondir));
	if (common === undefined) return undefined;
	const entry = join(common, "worktrees", basename(gitdir));
	const back = readGitFile(join(entry, "gitdir"))?.trim();
	if (back === undefined || back === "") return undefined;
	return realpathOrUndefined(resolve(entry, back)) === dotGit
		? common
		: undefined;
}

/**
 * 项目登记表的键：git 公共目录的真实路径，非 git 目录用目录本身的真实路径。`projectRoot` 是项目根目录的
 * 真实路径。识别时不运行 git，不采信仓库内容自己声明的身份：`.git` 是符号链接，或者是核对不成立的
 * `.git` 文件（包括子模块）时，按新项目处理，键是项目根目录。
 */
export function projectKey(projectRoot: string): string {
	const dotGit = join(projectRoot, ".git");
	const stat = lstatSync(dotGit, { throwIfNoEntry: false });
	if (stat?.isDirectory() === true) return dotGit;
	if (stat?.isFile() === true) {
		return worktreeCommonDir(projectRoot, dotGit) ?? projectRoot;
	}
	return projectRoot;
}

interface ProjectsFile {
	version: number;
	projects: Record<string, string>;
}

function readJson<T extends { version: number }>(path: string, empty: T): T {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
		throw error;
	}
	const value = JSON.parse(text) as T;
	if (value.version !== formatVersion) {
		throw new Error(
			`${path} 的格式版本是 ${value.version}，这个版本的 Host 只认识 ${formatVersion}`,
		);
	}
	return value;
}

function readProjects(path: string): ProjectsFile {
	const file = readJson<ProjectsFile>(path, {
		version: formatVersion,
		projects: {},
	});
	if (
		typeof file.projects !== "object" ||
		Object.values(file.projects).some((id) => typeof id !== "string")
	) {
		throw new Error(`${path} 的格式不对`);
	}
	return file;
}

/** Host 根目录下 `data/` 里的标识和登记表。 */
export class Registry {
	#data: string;
	#owner: ProcessIdentity;

	/** `data` 是 Host 根目录下的 `data/`，`owner` 是 Host 进程的身份。 */
	constructor(data: string, owner: ProcessIdentity) {
		this.#data = data;
		this.#owner = owner;
	}

	#lock<T>(name: string, run: () => T): Promise<T> {
		return withFileLock(join(this.#data, "locks", name), this.#owner, run);
	}

	/** 这个 Host 根目录的 `user_id`：第一次用到时生成，保存在 `data/identity.json`。 */
	userId(): Promise<string> {
		const path = join(this.#data, "identity.json");
		return this.#lock("identity.lock", () => {
			const file = readJson<{ version: number; user_id?: string }>(path, {
				version: formatVersion,
			});
			if (typeof file.user_id === "string") return file.user_id;
			const userId = newId();
			writeFileAtomic(
				path,
				`${JSON.stringify({ version: formatVersion, user_id: userId }, null, "\t")}\n`,
			);
			return userId;
		});
	}

	/** 键对应的 `project_id`，第一次见到时登记。 */
	projectId(key: string): Promise<string> {
		const path = join(this.#data, "projects.json");
		return this.#lock("projects.lock", () => {
			const file = readProjects(path);
			const existing = file.projects[key];
			if (existing !== undefined) return existing;
			const id = newId();
			this.#writeProjects(path, { ...file.projects, [key]: id });
			return id;
		});
	}

	/** 把一个键关联到已有的项目。 */
	link(key: string, projectId: string): Promise<void> {
		const path = join(this.#data, "projects.json");
		return this.#lock("projects.lock", () => {
			const file = readProjects(path);
			this.#writeProjects(path, { ...file.projects, [key]: projectId });
		});
	}

	/** 登记过的项目和各自关联的路径。 */
	projects(): { project_id: string; paths: string[] }[] {
		const { projects } = readProjects(join(this.#data, "projects.json"));
		const grouped = new Map<string, string[]>();
		for (const [path, id] of Object.entries(projects)) {
			grouped.set(id, [...(grouped.get(id) ?? []), path]);
		}
		return [...grouped].map(([project_id, paths]) => ({ project_id, paths }));
	}

	#writeProjects(path: string, projects: Record<string, string>): void {
		writeFileAtomic(
			path,
			`${JSON.stringify({ version: formatVersion, projects }, null, "\t")}\n`,
		);
	}
}
