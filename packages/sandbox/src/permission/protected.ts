import { type Dirent, existsSync, lstatSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/**
 * 可写范围里保持只读的目录名：打开目录、进入目录或启动其他 agent 时会被自动执行，或能注册 hooks、
 * 给工具授权。整个目录只读。含 sandbox-runtime 自带的强制名单：它只以工作区为根，
 * 批准的可写路径要靠这份名单。
 */
const directories = [
	".git",
	".agents",
	".aws",
	".claude",
	".codex",
	".cursor",
	".gemini",
	".ospreycode",
	".github/hooks",
	".vscode",
	".idea",
	".zed",
	".helix",
	".nvim",
	".devcontainer",
	".mise",
	".config/mise",
	"mise/conf.d",
];

/** 可写范围里保持只读的文件名，`*` 匹配一段路径里的任意字符。 */
const files = [
	// `.git` 也可以是指向 git 目录的文件
	".git",
	".gitmodules",
	".gitconfig",
	".mcp.json",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zshenv",
	".zprofile",
	".profile",
	".ripgreprc",
	"*.code-workspace",
	"*.ipr",
	"*.iws",
	"*.run.xml",
	".nvim.lua",
	".nvimrc",
	".exrc",
	".lazy.lua",
	".dir-locals.el",
	".dir-locals-2.el",
	".devcontainer.json",
	".envrc",
	"mise*.toml",
	".mise*.toml",
	".config/mise*.toml",
	"mise/config*.toml",
	".tool-versions",
	"devenv.nix",
	"devenv.local.nix",
	"devenv.yaml",
	"devenv.local.yaml",
	"devenv.lock",
];

/**
 * Linux 上带通配的名字放不了占位，根目录下换成 mise 默认读取的这几个名字；`mise.<环境>.toml`
 * 和 `*.code-workspace` 这类列不全的名字不放。
 */
const standIns = [
	"mise.toml",
	"mise.local.toml",
	".mise.toml",
	".mise.local.toml",
	".config/mise.toml",
	".config/mise.local.toml",
	"mise/config.toml",
	"mise/config.local.toml",
];

/** 工作区里有 `.envrc` 时才保护：nix-direnv 在它们变化后的下一个提示符重新求值。 */
const nixFiles = [
	"flake.nix",
	"flake.lock",
	"devshell.toml",
	"shell.nix",
	"default.nix",
];

/** 根目录没有 `.git` 时保护的三项：加上带 `core.fsmonitor` 的 `config`，这个目录就成了能执行命令的裸仓库。 */
const bareRepository = ["HEAD", "objects", "refs"];

/** 工作区的 `.git` 允许写入时仍然只读的部分：它们能让 git 执行命令。 */
const gitExecutable = [".git/hooks", ".git/config", ".git/info/attributes"];

/** 一个可写的根目录里受保护的名字随它的状态变化的部分。 */
export interface ProtectedOptions {
	/**
	 * 这条命令声明了对这个根目录的 `.git` 的写入（越界申请或 `allow` 规则）：`.git` 可写，
	 * 其中的 hooks、config 和 info/attributes 仍然只读。只有工作区根目录可以这样。
	 */
	gitWritable?: boolean;
	/**
	 * 根目录里要保持可写的目录（临时目录、缓存目录、工作区）。它们自己或上级如果叫受保护的名字
	 * （Host 根目录就叫 `.ospreycode`，工作区可能在 `~/.cursor/worktrees/` 里），这一个目录不整个禁止，
	 * 由调用方用 `protectedAncestors` 找出来，另按其中的条目禁止。
	 */
	open?: readonly string[];
}

function segmentPattern(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${escaped}$`);
}

interface NameMatcher {
	name: string;
	segments: RegExp[];
}

function matchers(names: readonly string[]): NameMatcher[] {
	return names.map((name) => ({
		name,
		segments: name.split("/").map(segmentPattern),
	}));
}

const directoryMatchers = matchers(directories);
const fileMatchers = matchers(files);
const nixMatchers = matchers(nixFiles);

/**
 * 根目录的状态决定的名单：有 `.envrc` 时加上 nix 的文件，没有 `.git` 时加上裸仓库的三项。
 * 空的 `.envrc` 什么也不加载，空的 `.git` 文件和没有 `HEAD` 的 `.git` 目录 git 不认，都按没有算：
 * Linux 上的占位在宿主上就是空目录，不能因为它以为有了 `.envrc` 或仓库。
 */
function rootState(root: string): { envrc: boolean; git: boolean } {
	const envrc = statSync(join(root, ".envrc"), { throwIfNoEntry: false });
	const dotGit = join(root, ".git");
	// 悬空的符号链接也算有：lstat 不跟随
	const git = lstatSync(dotGit, { throwIfNoEntry: false });
	return {
		envrc: envrc?.isFile() === true && envrc.size > 0,
		git:
			git !== undefined &&
			(git.isSymbolicLink() ||
				(git.isFile() ? git.size > 0 : existsSync(join(dotGit, "HEAD")))),
	};
}

function matchAt(
	segments: readonly string[],
	index: number,
	matcher: NameMatcher,
): boolean {
	return matcher.segments.every((pattern, offset) => {
		const segment = segments[index + offset];
		return segment !== undefined && pattern.test(segment);
	});
}

function isInside(child: string, parent: string): boolean {
	return (
		child === parent ||
		child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
	);
}

/**
 * `path` 自己和它在 `root` 之下的各级上级目录里，名字是受保护的目录名的那些（绝对路径）。
 */
export function protectedAncestors(path: string, root: string): string[] {
	if (!isInside(path, root) || path === root) return [];
	const segments = relative(root, path).split(sep);
	const ancestors: string[] = [];
	for (let index = 0; index < segments.length; index++) {
		for (const matcher of directoryMatchers) {
			const end = index + matcher.segments.length;
			if (end <= segments.length && matchAt(segments, index, matcher)) {
				ancestors.push(join(root, ...segments.slice(0, end)));
			}
		}
	}
	return ancestors;
}

/**
 * `path` 落在 `root` 里受保护的位置时返回命中的名字，否则返回空。`path` 是 `root` 之下的绝对路径；
 * 名字在任意深度都算，路径不存在也算。文件工具的写入在登记时用它检查，和沙盒的 `denyWrite`
 * 是同一份名单。
 */
export function protectedName(
	path: string,
	root: string,
	options: ProtectedOptions = {},
): string | undefined {
	const segments = relative(root, path).split(sep);
	const state = rootState(root);
	if (options.gitWritable === true && segments[0] === ".git") {
		const inside = segments.join("/");
		return gitExecutable.find(
			(name) => inside === name || inside.startsWith(`${name}/`),
		);
	}
	const first = segments[0];
	if (!state.git && first !== undefined && bareRepository.includes(first)) {
		return first;
	}
	const candidates = [
		...directoryMatchers,
		...fileMatchers,
		...(state.envrc ? nixMatchers : []),
	];
	for (let index = 0; index < segments.length; index++) {
		const hit = candidates.find((matcher) => matchAt(segments, index, matcher));
		if (hit !== undefined) return hit.name;
	}
	return undefined;
}

/**
 * macOS 上一个可写的根目录里受保护的路径，写成 sandbox-runtime 的 `denyWrite` 通配：两个星号的那一段
 * 匹配任意深度（含根目录本身），之后新建的路径也受保护，路径不存在时 Seatbelt 直接拒绝创建。
 */
export function protectedGlobs(
	root: string,
	options: ProtectedOptions = {},
): string[] {
	const state = rootState(root);
	const gitWritable = options.gitWritable === true;
	const opened = (options.open ?? []).flatMap((path) =>
		protectedAncestors(path, root),
	);
	const globs: string[] = [];
	for (const name of directories) {
		const direct = join(root, name);
		const kept = opened.filter((path) => path.endsWith(`${sep}${name}`));
		if (kept.some((path) => path !== direct)) {
			// 更深处有一个要放开的同名目录，通配写不出"除了它"：这个根目录里不按名字保护它
			continue;
		}
		if ((name === ".git" && gitWritable) || kept.length > 0) {
			// 根目录的这一个放开，更深处的同名目录照常保护
			globs.push(`${root}/*/**/${name}`, `${root}/*/**/${name}/**`);
			continue;
		}
		globs.push(`${root}/**/${name}`, `${root}/**/${name}/**`);
	}
	for (const name of files) {
		if (name === ".git") continue;
		globs.push(`${root}/**/${name}`);
	}
	if (state.envrc) {
		globs.push(...nixFiles.map((name) => `${root}/**/${name}`));
	}
	if (gitWritable) {
		for (const name of gitExecutable) {
			globs.push(`${root}/${name}`, `${root}/${name}/**`);
		}
	}
	if (!state.git) {
		for (const name of bareRepository) {
			globs.push(`${root}/${name}`, `${root}/${name}/**`);
		}
	}
	return globs;
}

/** 扫描受保护的名字时不进入的目录：依赖目录很大，sandbox-runtime 自己的扫描也跳过它。 */
const skipped = new Set(["node_modules"]);

/** 一次扫描的结果。 */
export interface ProtectedScan {
	/** 已存在的受保护路径（绝对路径）。 */
	paths: string[];
	/** 根目录下还不存在、要放占位的受保护名字（绝对路径）；带通配的名字换成 mise 默认读取的几个名字。 */
	missing: string[];
	/** 扫描超时：没扫到的位置不受保护。 */
	timedOut: boolean;
}

/** 扫描的范围。 */
export interface ProtectedScanOptions extends ProtectedOptions {
	/** 从根目录往下扫描的层数。 */
	depth: number;
	/** 最长扫描时间（毫秒）。 */
	timeoutMs: number;
}

/**
 * Linux 上写入规则不支持通配：每次包装前扫描一个可写的根目录，找出受保护的名字已存在的位置，
 * 以绝对路径加入 `denyWrite`；根目录下还不存在的名字由 sandbox-runtime 放占位。
 * task 结束时也用它列出可写范围里的 `.git` 和其他受保护的名字。
 */
export async function scanProtected(
	root: string,
	options: ProtectedScanOptions,
): Promise<ProtectedScan> {
	const state = rootState(root);
	const gitWritable = options.gitWritable === true;
	const deadline = Date.now() + options.timeoutMs;
	const candidates = [
		...directoryMatchers,
		...fileMatchers,
		...(state.envrc ? nixMatchers : []),
	];
	const paths: string[] = [];
	let timedOut = false;
	const visit = async (dir: string, level: number): Promise<void> => {
		if (Date.now() > deadline) {
			timedOut = true;
			return;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			// 扫描期间目录被删掉或不可读：里面没有可保护的已有路径
			const { code } = error as NodeJS.ErrnoException;
			if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			const segments = relative(root, path).split(sep);
			const last = segments.length - 1;
			const hit = candidates.some((matcher) => {
				const start = last - (matcher.segments.length - 1);
				return start >= 0 && matchAt(segments, start, matcher);
			});
			// 要保持可写的目录和它的上级不整个禁止，里面的条目由调用方另行禁止
			if (hit && (options.open ?? []).some((kept) => isInside(kept, path))) {
				continue;
			}
			if (hit) {
				if (gitWritable && path === join(root, ".git")) {
					paths.push(...gitExecutable.map((name) => join(root, name)));
				} else {
					paths.push(path);
				}
				continue;
			}
			if (
				entry.isDirectory() &&
				level < options.depth &&
				!skipped.has(entry.name)
			) {
				await visit(path, level + 1);
			}
		}
	};
	await visit(root, 1);
	if (!state.git) {
		paths.push(
			...bareRepository
				.map((name) => join(root, name))
				.filter((path) => existsSync(path)),
		);
	}
	const fixed = [
		...directories,
		...files,
		...standIns,
		...(state.envrc ? nixFiles : []),
		...(state.git ? [] : bareRepository),
	].filter((name) => !name.includes("*"));
	const missing = [...new Set(fixed)]
		.filter((name) => !(gitWritable && name === ".git"))
		.map((name) => join(root, name))
		.filter(
			(path) =>
				lstatSync(path, { throwIfNoEntry: false }) === undefined &&
				// 两段的名字只在上一级已存在时放占位，不为它在用户的目录里新建上一级
				existsSync(dirname(path)),
		);
	return { paths, missing, timedOut };
}
