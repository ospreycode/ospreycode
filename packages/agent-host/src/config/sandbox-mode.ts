import {
	type BuiltinSandboxMode,
	builtinSandboxModes,
	checkPermissionProfile,
	PermissionConfigError,
	type PermissionProfile,
	type ResolvedProfile,
	type RuleFile,
	resolvePermissionProfile,
	type SandboxMode,
} from "@ospreycode/sandbox";
import { ConfigError, joinKey } from "./errors.js";

/** 选定的沙盒模式。 */
export interface ResolvedSandboxMode {
	/** 沙盒模式的名字：内置的三种之一，或命名权限配置的名字。 */
	sandboxMode: SandboxMode;
	/** 沙盒按哪个内置模式建立：选用命名权限配置时是它在这个工作区上的模式。 */
	baseSandboxMode: BuiltinSandboxMode;
	/** 选用命名权限配置时，它在这个工作区上解析出的路径和域名。 */
	permissionProfile?: ResolvedProfile;
}

/** 检查和解析命名权限配置用到的位置。 */
export interface SandboxModeContext {
	/** 用户级配置文件的路径：命名权限配置只能写在里面，报错时带上。 */
	userFile: string;
	/** Host 环境里的 HOME。 */
	home: string | undefined;
	/** 工作区的真实路径。 */
	workspace: string;
	/** Host 根目录的真实路径。 */
	root: string;
	/** 配置里指定的凭据文件。 */
	credentials: readonly string[];
	/** 配置里额外禁止读、禁止写的路径。 */
	denyRead: readonly string[];
	denyWrite: readonly string[];
	/** Host 自己和它依赖的包（包括 Node）的安装目录。 */
	install: readonly string[];
}

/**
 * 按名字选定沙盒模式。每个命名权限配置都做加载时的检查（`write` 不能写到受保护的路径上），
 * 选用的那个再按工作区解析成沙盒后端能执行的路径名单。名字不存在、命名权限配置写得不对或
 * 沙盒后端表达不了时抛出 `ConfigError`，带用户级配置文件的路径和出错的键。
 */
export function resolveSandboxMode(
	mode: SandboxMode,
	profiles: Readonly<Record<string, PermissionProfile>>,
	context: SandboxModeContext,
): ResolvedSandboxMode {
	const { userFile, home, workspace } = context;
	const selected = Object.hasOwn(profiles, mode) ? profiles[mode] : undefined;
	try {
		for (const [name, profile] of Object.entries(profiles)) {
			checkPermissionProfile(profile, {
				key: joinKey("permissions", name),
				home,
				workspace,
			});
		}
		if (selected !== undefined) {
			if (home === undefined) {
				throw new ConfigError(
					"Host 的环境变量里没有 HOME，找不到要禁止读取的密钥位置",
				);
			}
			const permissionProfile = resolvePermissionProfile(selected, {
				key: joinKey("permissions", mode),
				home,
				workspace,
				hostRoot: context.root,
				credentials: context.credentials,
				denyRead: context.denyRead,
				denyWrite: context.denyWrite,
				install: context.install,
			});
			return {
				sandboxMode: mode,
				baseSandboxMode: permissionProfile.mode,
				permissionProfile,
			};
		}
	} catch (error) {
		if (!(error instanceof PermissionConfigError)) throw error;
		throw new ConfigError(`${userFile}：${error.key} ${error.message}`);
	}
	const builtin = builtinSandboxModes.find((name) => name === mode);
	if (builtin === undefined) {
		throw new ConfigError(
			`沙盒模式 ${mode} 不存在：要是 ${builtinSandboxModes.join("、")} 或 [permissions.<名字>] 定义的名字`,
		);
	}
	return { sandboxMode: builtin, baseSandboxMode: builtin };
}

/**
 * 命名权限配置的域名写成一份权限规则：`allow` 等同 `allow` 域名规则，`deny` 等同 `forbidden`
 * 域名规则。和权限规则文件里的域名规则一起判断，网络访问的审批和沙盒的名单就不用另认一种来源。
 */
export function profileDomainRules(
	name: string,
	profile: ResolvedProfile,
): RuleFile {
	const justification = `Set by the permission profile \`${name}\`.`;
	return {
		path: `permissions.${name}.domains`,
		source: "user",
		rules: {
			rules: [],
			network_rules: [
				...profile.domains.deny.map((host) => ({
					host,
					decision: "forbidden" as const,
					justification,
				})),
				...profile.domains.allow.map((host) => ({
					host,
					decision: "allow" as const,
					justification,
				})),
			],
			mcp_rules: [],
		},
	};
}
