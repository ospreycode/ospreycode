import { join } from "node:path";
import type { AdditionalPermissions } from "../contracts/requests.js";

/** 一组沙盒的策略：按沙盒模式和 Host 给出的路径生成，在辅助进程初始化时固定。 */
export interface SandboxPolicy {
	mode: "read-only" | "workspace-write";
	/** 工作区的真实路径。 */
	workspace: string;
	/** session 的临时目录（`TMPDIR`），可读写。 */
	tmpdir: string;
	/** 沙盒只能读的目录，如 session 的输出目录；它们可以在禁止读取的目录里面。 */
	readOnly: string[];
	/** 禁止读取的路径：Host 根目录、凭据文件和额外禁止的路径。 */
	denyRead: string[];
	/** 用户的主目录，常见的密钥位置相对它。 */
	home: string;
}

/** 主目录下常见的凭据和密钥位置，所有沙盒都不能读。 */
const secretLocations = [
	".ssh",
	".aws",
	".azure",
	".config/gcloud",
	".gnupg",
	".netrc",
	".npmrc",
	".docker",
	".kube",
	"Library/Keychains",
	"Library/Cookies",
	"Library/Application Support/Google/Chrome",
	"Library/Application Support/Firefox",
	"Library/Safari",
	// 本机所有 sandbox-runtime 沙盒都能写这两处，不让它们成为沙盒之间的通道
	".npm/_logs",
	".claude/debug",
];

/** 文件的读写范围，和 sandbox-runtime 的 `filesystem` 设置对应。 */
export interface FilesystemRules {
	denyRead: string[];
	allowRead: string[];
	allowWrite: string[];
	denyWrite: string[];
}

/** 按沙盒模式可写的根目录，含 `TMPDIR`。 */
export function writableRoots(policy: SandboxPolicy): string[] {
	return policy.mode === "workspace-write"
		? [policy.workspace, policy.tmpdir]
		: [policy.tmpdir];
}

/** 一组沙盒的文件规则。 */
export function filesystemRules(policy: SandboxPolicy): FilesystemRules {
	return {
		denyRead: [
			...policy.denyRead,
			...secretLocations.map((path) => join(policy.home, path)),
		],
		// sandbox-runtime 的 allowRead 优先于 denyRead，用它在 Host 根目录里放开 session 的子目录
		allowRead: [policy.tmpdir, ...policy.readOnly],
		allowWrite: writableRoots(policy),
		denyWrite: ["/tmp/claude", "/private/tmp/claude"],
	};
}

/**
 * 交给辅助进程初始化 sandbox-runtime 的配置。网络全部拒绝：`allowedDomains` 为空、没有询问回调；
 * 未放行域名的询问在 P1 加入。macOS 上放行 FSEvents，监视目录的命令才能运行。
 */
export function runtimeConfig(policy: SandboxPolicy): Record<string, unknown> {
	return {
		network: {
			allowedDomains: [],
			deniedDomains: [],
			allowMachLookup: ["com.apple.FSEvents"],
		},
		filesystem: filesystemRules(policy),
	};
}

/** 一条命令按批准的越界申请加上额外的文件权限之后的读写范围。 */
export function withAdditionalPermissions(
	policy: SandboxPolicy,
	permissions: AdditionalPermissions,
): Pick<FilesystemRules, "allowRead" | "allowWrite"> {
	const base = filesystemRules(policy);
	const write = permissions.file_system?.write ?? [];
	return {
		allowRead: [
			...base.allowRead,
			...(permissions.file_system?.read ?? []),
			...write,
		],
		allowWrite: [...base.allowWrite, ...write],
	};
}
