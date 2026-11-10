import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { realPath } from "../permission/paths.js";
import type { ResolvedProfile } from "../permission/profile.js";
import {
	type ProtectedOptions,
	protectedAncestors,
	protectedGlobs,
	scanProtected,
} from "../permission/protected.js";
import { secretPaths } from "../permission/secrets.js";

/** 一组沙盒的策略：按沙盒模式和 Host 给出的路径生成，一个 session 里不变。 */
export interface SandboxPolicy {
	mode: "read-only" | "workspace-write";
	/** 工作区的真实路径。 */
	workspace: string;
	/** session 的临时目录（`TMPDIR`），可读写。 */
	tmpdir: string;
	/** 这个项目的构建缓存目录，只有命令沙盒可读写。 */
	cache: string;
	/** 沙盒只能读的目录，如 session 的输出目录；它们可以在禁止读取的目录里面。 */
	readOnly: string[];
	/** 禁止读取的路径：Host 根目录、凭据文件和额外禁止的路径。 */
	denyRead: string[];
	/** 可写范围里额外禁止写入的路径。 */
	denyWrite: string[];
	/** 用户的主目录，常见的密钥位置相对它。 */
	home: string;
	/** Host 根目录：越界执行的命令也只能写其中的 `tmpdir` 和 `cache`。 */
	hostRoot: string;
	/** Host 根目录下 Host 会读的文件和目录的名字，不存在的也列出：越界执行的命令不能新建它们。 */
	hostEntries: string[];
	/** Host 自己和它依赖的包（包括 Node）的安装目录：越界执行的命令也不能写。 */
	install: string[];
	/**
	 * 沙盒模式是命名权限配置时，它在继承的模式之上放开和禁止的路径（`resolvePermissionProfile`
	 * 的结果）；这时 `mode` 取它的 `mode`。
	 */
	profile?: ResolvedProfile;
}

/** 本机所有 sandbox-runtime 沙盒都能写这两处，禁止读取，不让它们成为沙盒之间的通道。 */
const sharedLocations = [".npm/_logs", ".claude/debug"];

/**
 * 主目录下越界执行的命令也不能写的位置：shell 初始化文件和 `~/.gitconfig` 会在沙盒外被执行，
 * mise、direnv、devenv 和 Neovim 记录信任的目录能替仓库里的配置授权。
 */
const escalatedProtected = [
	".bashrc",
	".bash_profile",
	".zshrc",
	".zshenv",
	".zprofile",
	".profile",
	".gitconfig",
	".config/git",
	".local/state/mise",
	".local/share/mise",
	".local/share/direnv/allow",
	".local/share/devenv",
	".local/state/nvim",
];

/** 私有网段：允许的域名解析到这些地址时也拒绝。 */
const privateRanges = [
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"100.64.0.0/10",
	"fc00::/7",
];

/** 文件的读写范围，和 sandbox-runtime 的 `filesystem` 设置对应。 */
export interface FilesystemRules {
	denyRead: string[];
	allowRead: string[];
	allowWrite: string[];
	denyWrite: string[];
}

/** 一个沙盒用来做什么，决定它在策略之上的读写范围。 */
export type SandboxScope =
	/** agent 进程：按沙盒模式读写工作区和临时目录。 */
	| { kind: "agent" }
	/**
	 * 命令沙盒：另可写构建缓存，加上批准的路径（本任务内批下来的，和这次调用申请并获准的）。
	 * `escalated` 是批准了的 `require_escalated`：放开文件写入，Host 根目录、凭据、安装目录、
	 * 主目录里会被自动执行的文件和受保护的路径仍然不可写。
	 */
	| { kind: "command"; read: string[]; write: string[]; escalated: boolean }
	/**
	 * apply-edits：写权限只给批准的文件，工作区也不给。Linux 上 sandbox-runtime 跳过不存在的可写路径，
	 * 要新建的文件放开它所在的目录，目录里的受保护名字照样禁止写入。
	 */
	| { kind: "edits"; files: string[] };

/** 一个沙盒的文件规则。 */
export interface SandboxFilesystem {
	rules: FilesystemRules;
	/**
	 * Linux 上包装时还不存在、sandbox-runtime 会在用户目录里放占位（空目录）的路径。Host 把它们记进
	 * 占位登记表，进程被强制结束后留下的空目录按登记表删除。macOS 上为空。
	 */
	placeholders: string[];
	/** Linux 上对受保护名字的扫描超时了：没扫到的位置不受保护。 */
	scanTimedOut: boolean;
}

/** 按沙盒模式可写的根目录，含 `TMPDIR` 和命名权限配置里 `write` 的路径。 */
export function writableRoots(policy: SandboxPolicy): string[] {
	return [
		...(policy.mode === "workspace-write" ? [policy.workspace] : []),
		policy.tmpdir,
		...(policy.profile?.write ?? []),
	];
}

function isInside(child: string, parent: string): boolean {
	return (
		child === parent ||
		child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
	);
}

/** `dir` 下除了通向 `keep` 的路径以外的全部条目：已有的，加上 `names` 里列出的。 */
function entriesExcept(
	dir: string,
	names: readonly string[],
	keep: readonly string[],
): string[] {
	const existing = existsSync(dir) ? readdirSync(dir) : [];
	return [...new Set([...names, ...existing])].flatMap((name) => {
		const path = join(dir, name);
		if (keep.includes(path)) return [];
		return keep.some((kept) => isInside(kept, path))
			? entriesExcept(path, [], keep)
			: [path];
	});
}

/** 一个要加上受保护名字的可写根目录。 */
interface ProtectedRoot {
	root: string;
	options: ProtectedOptions;
	/** Linux 上根目录下还不存在的名字要不要放占位。 */
	missing: boolean;
}

/** Linux 上对受保护名字的扫描范围，和 sandbox-runtime 的强制保护相同。 */
const scan = { depth: 3, timeoutMs: 10_000 };

/**
 * sandbox-runtime 的占位落在禁止路径第一个不存在的那一级：下面还有禁止的路径时是只读的空目录，
 * 否则在宿主上留一个空文件、在沙盒里绑上 `/dev/null`。每个占位下面都多禁止这一级，占位一律是空目录：
 * 字符设备让 `git add -A` 失败，空目录 git 不管。
 */
const placeholderChild = ".placeholder";

/** 一个不存在的受保护路径交给 sandbox-runtime 的禁止写入路径：占位成空目录。 */
function placeholderPaths(path: string): string[] {
	return [path, join(path, placeholderChild)];
}

/** 宿主上实际放占位的位置：路径上第一个不存在的那一级。 */
function placeholderAt(path: string): string {
	const parent = dirname(path);
	return lstatSync(parent, { throwIfNoEntry: false }) === undefined
		? placeholderAt(parent)
		: path;
}

/**
 * sandbox-runtime 只以工作区为根强制保护的这两个目录里的子路径。目录已存在、整个禁止写入时，
 * 它仍为不存在的子路径放占位；排在目录前面的禁止路径先放好占位，否则工作区在禁止读取的目录里时，
 * 占位落进只读的目录，bwrap 不启动。
 */
const runtimeChildren: Record<string, string[]> = {
	".claude": ["commands", "agents"],
	".git": ["hooks", "config"],
};

/** 工作区里 sandbox-runtime 强制保护、还不存在、要先放占位的子路径。 */
function missingRuntimeChildren(
	workspace: string,
	gitWritable: boolean,
): string[] {
	return Object.entries(runtimeChildren).flatMap(([name, children]) => {
		const dir = join(workspace, name);
		if (name === ".git" && gitWritable) return [];
		if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
			return [];
		}
		return children
			.map((child) => join(dir, child))
			.filter(
				(path) => lstatSync(path, { throwIfNoEntry: false }) === undefined,
			);
	});
}

/**
 * 一个沙盒的文件规则。受保护的路径在每个可写的根目录里都加上：macOS 上写成通配，
 * Linux 上写入规则不支持通配，包装前扫描出已存在的位置，不存在的只在根目录放占位（空目录）。
 */
export async function sandboxFilesystem(
	policy: SandboxPolicy,
	scope: SandboxScope,
	platform: "darwin" | "linux",
): Promise<SandboxFilesystem> {
	const command = scope.kind === "command" ? scope : undefined;
	const escalated = command?.escalated === true;
	const granted = command?.write ?? [];
	const { profile } = policy;
	// Linux 上 sandbox-runtime 跳过不存在的可写路径：要新建的文件放开它所在的目录
	const created =
		scope.kind === "edits" && platform === "linux"
			? scope.files.filter(
					(path) => lstatSync(path, { throwIfNoEntry: false }) === undefined,
				)
			: [];
	const opened = [...new Set(created.map((path) => dirname(path)))];
	const allowWrite =
		scope.kind === "edits"
			? [...scope.files.filter((path) => !created.includes(path)), ...opened]
			: [
					...writableRoots(policy),
					...(command === undefined ? [] : [policy.cache]),
					...granted,
					...(escalated ? ["/"] : []),
				];
	const denyWrite = [
		...policy.denyWrite,
		// 写入规则里禁止优先于允许：批准的路径和越界执行也写不进这些位置
		...(profile?.readOnly ?? []),
		// 本机所有 sandbox-runtime 沙盒都能写这里，不让它成为沙盒之间的通道。Linux 上它不存在时
		// sandbox-runtime 不放开它，不用禁止：禁止不存在的路径要放占位，这个占位由本机所有辅助进程共用，
		// 一个辅助进程收尾时删掉它，别的辅助进程的沙盒就启动不了，或者失去这条禁止
		...(platform === "linux" && !existsSync("/tmp/claude")
			? []
			: ["/tmp/claude"]),
		"/private/tmp/claude",
	];
	// 越界执行时要保持可写的目录：它们的上级可能叫受保护的名字，不能整个禁止
	const open = [policy.tmpdir, policy.cache, policy.workspace];
	if (escalated) {
		const named = open
			.flatMap((path) => protectedAncestors(path, policy.home))
			// Host 根目录另按已知的条目禁止；要保持可写的目录自己不禁止
			.filter((path) => path !== policy.hostRoot && !open.includes(path));
		denyWrite.push(
			...entriesExcept(policy.hostRoot, policy.hostEntries, open).filter(
				(path) => platform === "darwin" || existsSync(path),
			),
			// 只能禁止已有的条目：写入规则写不出"除了通向工作区的那个名字"，之后新建的名字拦不住
			...[...new Set(named)].flatMap((path) => entriesExcept(path, [], open)),
			// 不可读的路径同样不可写；包含临时目录和缓存目录的（Host 根目录）已经按子目录禁止了
			...policy.denyRead.filter(
				(path) =>
					!isInside(policy.tmpdir, path) && !isInside(policy.cache, path),
			),
			...secretPaths(policy.home),
			...policy.install,
			...escalatedProtected.map((path) => join(policy.home, path)),
		);
	}
	// 工作区的 .git 只在这条命令声明了对它的写入时可写
	const dotGit = join(policy.workspace, ".git");
	const workspaceOptions: ProtectedOptions = {
		gitWritable: granted.some((path) => isInside(path, dotGit)),
	};
	// 工作区以外的可写路径（批准的，和命名权限配置里 `write` 的）各自作为根
	const outside = [...granted, ...(profile?.write ?? [])].filter(
		(path) => !isInside(path, policy.workspace),
	);
	const roots: ProtectedRoot[] =
		scope.kind === "edits"
			? opened.map((root) => ({ root, options: {}, missing: true }))
			: [
					{ root: policy.workspace, options: workspaceOptions, missing: true },
					...outside.map((root) => ({ root, options: {}, missing: true })),
					// 越界执行时整个文件系统都可写，主目录作为根；不在主目录里放占位：名单很长，用户看得到
					...(escalated
						? [{ root: policy.home, options: { open }, missing: false }]
						: []),
				];
	const placeholders: string[] = [];
	let scanTimedOut = false;
	if (platform === "linux" && scope.kind !== "edits") {
		const ahead = missingRuntimeChildren(
			policy.workspace,
			workspaceOptions.gitWritable === true,
		);
		denyWrite.push(...ahead.flatMap(placeholderPaths));
		placeholders.push(...ahead);
	}
	for (const { root, options, missing } of roots) {
		if (platform === "darwin") {
			denyWrite.push(...protectedGlobs(root, options));
			continue;
		}
		const found = await scanProtected(root, { ...options, ...scan });
		// 声明了写 `.git` 时列出的 hooks、config 和 info/attributes 可能还不存在
		const absent = found.paths.filter(
			(path) => lstatSync(path, { throwIfNoEntry: false }) === undefined,
		);
		denyWrite.push(
			...found.paths.filter((path) => !absent.includes(path)),
			...absent.flatMap(placeholderPaths),
		);
		placeholders.push(...absent.map(placeholderAt));
		if (missing) {
			denyWrite.push(...found.missing.flatMap(placeholderPaths));
			placeholders.push(...found.missing);
		}
		scanTimedOut ||= found.timedOut;
	}
	return {
		rules: {
			denyRead: [
				...policy.denyRead,
				// 命名权限配置正好在某个密钥位置上写了 `read` 或 `write` 时不再禁止它：
				// 同一个路径又禁止又放开，两个后端的结果不一定相同
				...secretPaths(policy.home).filter(
					(path) => profile?.reopened.includes(realPath(path)) !== true,
				),
				...sharedLocations.map((path) => join(policy.home, path)),
				...(profile?.deny ?? []),
			],
			// sandbox-runtime 的 allowRead 优先于 denyRead，用它在 Host 根目录里放开 session 的子目录
			allowRead: [
				policy.tmpdir,
				...policy.readOnly,
				...(command === undefined ? [] : [policy.cache, ...command.read]),
				...granted,
				...(profile?.reopened ?? []),
			],
			allowWrite,
			denyWrite,
		},
		placeholders,
		scanTimedOut,
	};
}

/** 一个辅助进程里只能按进程设置的部分：网络名单和本机通信。 */
export interface HelperScope {
	/**
	 * 预先放行和禁止的域名（权限规则编译而来）。不给时这个辅助进程生成的沙盒完全不能联网；
	 * 给了以后，名单之外的域名经询问回调交给调用方。
	 */
	network?: { allowedDomains: string[]; deniedDomains: string[] };
	/** 批准的 Unix socket 的路径，只能按进程设置。 */
	unixSockets?: string[];
	/** 批准了监听端口和连接本机端口，只能按进程设置。 */
	localBinding?: boolean;
}

/**
 * 交给辅助进程初始化 sandbox-runtime 的配置。文件规则在每次包装时给出，这里只有按进程设置的部分。
 * macOS 上放行 FSEvents，监视目录的命令才能运行。
 */
export function runtimeConfig(scope: HelperScope): Record<string, unknown> {
	return {
		network: {
			allowedDomains: scope.network?.allowedDomains ?? [],
			deniedDomains: scope.network?.deniedDomains ?? [],
			// sandbox-runtime 默认不拒绝私有网段
			deniedResolvedAddresses: privateRanges,
			allowMachLookup: ["com.apple.FSEvents"],
			...(scope.unixSockets === undefined
				? {}
				: { allowUnixSockets: scope.unixSockets }),
			...(scope.localBinding === true ? { allowLocalBinding: true } : {}),
		},
		// 每次包装都给出完整的文件规则；初始化时的这份不会用到，按最严的写
		filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
	};
}
