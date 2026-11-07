import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** 从 Host 的环境里传给沙盒的变量，其余一律不传。 */
const inherited = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
] as const;

/** Host 自己设置的变量。 */
export interface SandboxEnvironmentOptions {
	/** session 的临时目录。 */
	tmpdir: string;
	workspace: string;
	/** 执行命令用的 bash。 */
	bash: string;
}

/**
 * 沙盒里进程的环境变量：按白名单从 Host 的环境里取，再加上 Host 设置的几个。不继承 Host 的
 * 其他变量，凭据不经环境变量进入沙盒。
 */
export function sandboxEnvironment(
	hostEnv: Readonly<Record<string, string | undefined>>,
	options: SandboxEnvironmentOptions,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of inherited) {
		const value = hostEnv[name];
		if (value !== undefined) env[name] = value;
	}
	return {
		...env,
		SHELL: options.bash,
		TMPDIR: options.tmpdir,
		TERM: "dumb",
		NO_COLOR: "1",
		OSPREYCODE_WORKSPACE: options.workspace,
	};
}

/** 按 Host 设置的 `PATH` 找到 bash：规则匹配按 bash 的语法解析命令，不用用户的默认 shell。 */
export function findBash(path: string | undefined): string {
	for (const dir of (path ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, "bash");
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile() !== true) {
			continue;
		}
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// 同名但不可执行的文件，接着找 PATH 里的下一个目录
		}
	}
	throw new Error(`PATH 里找不到 bash：${path ?? "（没有设置 PATH）"}`);
}
