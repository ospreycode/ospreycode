import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadShellParser } from "@ospreycode/sandbox";
import {
	checkSandboxSupport,
	SandboxUnavailableError,
} from "@ospreycode/sandbox/backends";
import { ConfigError } from "../config/errors.js";
import { loadRuleFiles } from "../config/permission-rules.js";
import {
	findProjectRoot,
	prepareRoot,
	resolveWorkspace,
	WorkspaceError,
} from "../project/workspace.js";
import { createHost } from "./host.js";

/** 检查运行环境时的输入，和创建 Host 时的相同。 */
export interface DoctorOptions {
	/** Host 根目录。 */
	root: string;
	/** 启动时的环境变量：按里面的 `PATH` 找 git，按 `HOME` 找登录钥匙串。 */
	env: Readonly<Record<string, string | undefined>>;
	/** 检查配置时用的工作区：运行命令时的当前目录。 */
	workspace: string;
}

/** 一项检查的结果。 */
export interface DoctorCheck {
	/** 检查项：`node`、`sandbox`、`keychain`（只在 macOS 上）、`git`、`root`、`socket_path`、`config`、`rules`。 */
	id: string;
	ok: boolean;
	/** 通过时是查到的情况，失败时是原因。 */
	message: string;
}

/** Unix socket 路径的字节上限和沙盒后端最长的 socket 文件名，和 sandbox 包启动辅助进程时检查的一致。 */
const maxSocketPathBytes = 103;
const longestSocketName = "srt-mux-4194304-99.sock";

/** 快照用到的 git 功能要求的最低版本。 */
const minGit = [2, 32] as const;

/** 各个包 `engines.node` 写的范围：`^24.15.0 || >=26.0.0`。 */
function nodeCheck(version: string): DoctorCheck {
	const [major, minor] = version.split(".").map(Number);
	const ok = (major === 24 && minor >= 15) || major >= 26;
	return {
		id: "node",
		ok,
		message: ok
			? `Node ${version}`
			: `Node ${version} 不满足要求：要 24.15.0 以上的 24.x，或 26 以上`,
	};
}

function sandboxCheck(): DoctorCheck {
	try {
		const { platform, process_cleanup } = checkSandboxSupport(process.platform);
		return {
			id: "sandbox",
			ok: true,
			message: `${platform} 上有沙盒后端，沙盒里的进程靠 ${process_cleanup} 清理`,
		};
	} catch (error) {
		if (!(error instanceof SandboxUnavailableError)) throw error;
		return { id: "sandbox", ok: false, message: error.message };
	}
}

/**
 * 登录钥匙串能不能用：原生模块加载得了，钥匙串文件在。不去读条目：钥匙串锁着时读取会弹出解锁的
 * 对话框，检查环境不该打扰用户。
 */
async function keychainCheck(home: string | undefined): Promise<DoctorCheck> {
	if (home === undefined) {
		return {
			id: "keychain",
			ok: false,
			message: "环境变量里没有 HOME，找不到登录钥匙串",
		};
	}
	try {
		await import("@napi-rs/keyring");
	} catch (error) {
		return {
			id: "keychain",
			ok: false,
			message: `加载不了读写钥匙串的原生模块 @napi-rs/keyring：${(error as Error).message}`,
		};
	}
	const keychain = join(home, "Library", "Keychains", "login.keychain-db");
	return existsSync(keychain)
		? {
				id: "keychain",
				ok: true,
				message: `登录钥匙串在 ${keychain}（没有检查它是否锁着）`,
			}
		: { id: "keychain", ok: false, message: `找不到登录钥匙串 ${keychain}` };
}

function gitCheck(path: string | undefined): DoctorCheck {
	const result = spawnSync("git", ["--version"], {
		env: path === undefined ? {} : { PATH: path },
		encoding: "utf8",
	});
	if (result.error !== undefined || result.status !== 0) {
		return {
			id: "git",
			ok: false,
			message: `运行不了 git --version：${result.error?.message ?? result.stderr.trim()}`,
		};
	}
	const output = result.stdout.trim();
	const match = /^git version (\d+)\.(\d+)/.exec(output);
	if (match === null) {
		return { id: "git", ok: false, message: `看不懂 git 的版本：${output}` };
	}
	const [major, minor] = [Number(match[1]), Number(match[2])];
	const ok = major > minGit[0] || (major === minGit[0] && minor >= minGit[1]);
	return {
		id: "git",
		ok,
		message: ok ? output : `${output}，快照要求 ${minGit.join(".")} 以上`,
	};
}

/** 根目录的属主和权限。通过时返回它的真实路径。 */
function rootCheck(root: string): DoctorCheck & { real?: string } {
	try {
		const real = prepareRoot(root);
		return {
			id: "root",
			ok: true,
			message: `${real} 属于当前用户，权限是 700`,
			real,
		};
	} catch (error) {
		if (!(error instanceof WorkspaceError)) throw error;
		return { id: "root", ok: false, message: error.message };
	}
}

/** session 的临时目录以 session 编号的前 12 个字符命名，沙盒后端的 socket 建在里面。 */
function socketCheck(root: string): DoctorCheck {
	const socket = join(root, "tmp", "0".repeat(12), longestSocketName);
	const bytes = Buffer.byteLength(socket);
	const ok = bytes <= maxSocketPathBytes;
	return {
		id: "socket_path",
		ok,
		message: ok
			? `最长的 socket 路径 ${bytes} 字节，上限 ${maxSocketPathBytes}`
			: `最长的 socket 路径 ${bytes} 字节，超出上限 ${maxSocketPathBytes}：${socket}`,
	};
}

function configCheck(options: DoctorOptions): DoctorCheck {
	try {
		const config = createHost({
			root: options.root,
			env: options.env,
			credentialStore: null,
		}).resolveConfig({ workspace: options.workspace });
		return {
			id: "config",
			ok: true,
			message: [
				`配置加载成功：模型 ${config.model.id}，沙盒模式 ${config.sandboxMode}，审批策略 ${config.approvalPolicy}`,
				...config.warnings,
			].join("；"),
		};
	} catch (error) {
		if (!(error instanceof ConfigError || error instanceof WorkspaceError)) {
			throw error;
		}
		return { id: "config", ok: false, message: error.message };
	}
}

/** 用户级的和仓库里的权限规则文件；`--rules` 指定的在启动时才知道，不在这里检查。 */
async function rulesCheck(
	root: string | undefined,
	workspace: string,
): Promise<DoctorCheck> {
	if (root === undefined) {
		return {
			id: "rules",
			ok: false,
			message: "Host 根目录不可用，没有检查权限规则文件",
		};
	}
	try {
		const files = loadRuleFiles({
			root,
			projectRoot: findProjectRoot(resolveWorkspace(workspace)).root,
			startup: [],
			parser: await loadShellParser(),
		});
		return {
			id: "rules",
			ok: true,
			message:
				files.length === 0
					? "没有权限规则文件"
					: `权限规则文件加载成功：${files.map((file) => file.path).join("、")}`,
		};
	} catch (error) {
		if (!(error instanceof ConfigError || error instanceof WorkspaceError)) {
			throw error;
		}
		return { id: "rules", ok: false, message: error.message };
	}
}

/**
 * 检查运行环境（`ospreycode doctor`）：Node 版本、当前平台有没有沙盒后端、登录钥匙串（只在 macOS 上）、
 * git 版本、Host 根目录的属主和权限、最长的 socket 路径、配置和权限规则文件能否加载。每项给出
 * 是否通过和说明，有一项不通过也接着查完。根目录不存在时照 Host 启动时的做法创建。
 */
export async function doctor(options: DoctorOptions): Promise<DoctorCheck[]> {
	const { real, ...root } = rootCheck(options.root);
	return [
		nodeCheck(process.versions.node),
		sandboxCheck(),
		...(process.platform === "darwin"
			? [await keychainCheck(options.env.HOME)]
			: []),
		gitCheck(options.env.PATH),
		root,
		socketCheck(real ?? options.root),
		configCheck(options),
		await rulesCheck(real, options.workspace),
	];
}
