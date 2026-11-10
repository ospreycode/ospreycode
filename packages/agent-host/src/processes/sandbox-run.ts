import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import type { Stream } from "node:stream";
import {
	networkLists,
	type SandboxMode,
	type ShellParser,
} from "@ospreycode/sandbox";
import {
	checkSandboxSupport,
	type SandboxPolicy,
	sandboxFilesystem,
	startSandboxHelper,
} from "@ospreycode/sandbox/backends";
import { ConfigError } from "../config/errors.js";
import { loadRuleFiles } from "../config/permission-rules.js";
import { profileDomainRules } from "../config/sandbox-mode.js";
import type {
	SessionConfig,
	SessionOptions,
} from "../config/session-config.js";
import { projectKey, type Registry } from "../project/identity.js";
import { createSessionDirectories } from "../project/workspace.js";
import { newId } from "../sessions/ids.js";
import { findBash, sandboxEnvironment } from "./environment.js";
import type { ProcessIdentity } from "./info.js";
import { Placeholders } from "./placeholders.js";
import { ReaperPipe } from "./reaper.js";

/** 命令的收尾进程管道所在的文件描述符，和 Host 代为执行的命令一样。 */
const reaperFd = 3;

/** 命令的一个标准流接到哪里：不接、继承 Host 进程的、文件描述符，或者带文件描述符的流。 */
export type SandboxStdio = "ignore" | "inherit" | number | Stream;

/** 在沙盒里运行一条命令的方式。 */
export interface SandboxRunOptions {
	/** 工作区：命令的当前目录，沙盒的读写范围按它计算。 */
	workspace: string;
	/** 沙盒模式或命名权限配置的名字（`--permissions`）；不给时按配置。 */
	permissions?: SandboxMode;
	/** 要运行的命令和它的参数。 */
	command: readonly string[];
	/** 命令的标准输入、标准输出和标准错误，直通给这三处。 */
	stdio: readonly [SandboxStdio, SandboxStdio, SandboxStdio];
	/** 中止时结束命令和它在沙盒里启动的全部进程。 */
	signal?: AbortSignal;
	/** 不影响运行、但用户该知道的问题：扫描受保护的路径超时了。 */
	onWarning: (message: string) => void;
}

/** 命令的结果。 */
export interface SandboxRunResult {
	/** 命令的退出码；被信号结束时为空。 */
	exit_code: number | null;
	signal: NodeJS.Signals | null;
}

/** `createHost` 里和打开 session 共用的部分。 */
export interface SandboxRunHost {
	root: string;
	/** Host 根目录下的 `data/`。 */
	data: string;
	owner: ProcessIdentity;
	env: Readonly<Record<string, string | undefined>>;
	helperEntry: string;
	hostEntries: string[];
	install: string[];
	registry: Registry;
	resolveConfig(options: SessionOptions): SessionConfig;
	shellParser(): Promise<ShellParser>;
}

function shellQuote(words: readonly string[]): string {
	return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/**
 * 用和 session 的命令沙盒同一套策略运行一条命令（`ospreycode sandbox`）：读写范围按沙盒模式
 * （内置的或命名权限配置），可以写这个项目的构建缓存，域名按权限规则和命名权限配置放行，名单
 * 之外的直接拒绝，不询问。命令结束后结束它留在沙盒里的进程。不取工作区锁，也不写 session 记录。
 * `danger-full-access` 下直接运行。配置有错时抛出 `ConfigError` 或 `WorkspaceError`，当前平台
 * 没有沙盒后端时抛出 `SandboxUnavailableError`。
 */
export async function runInSandbox(
	options: SandboxRunOptions,
	host: SandboxRunHost,
): Promise<SandboxRunResult> {
	const { permissions } = options;
	const config = host.resolveConfig({
		workspace: options.workspace,
		...(permissions === undefined ? {} : { sandboxMode: permissions }),
		// 这里不发模型请求，费用上限用不上：不让它因为选用的模型没有价格而报错
		budget: { maxCostUsd: null },
	});
	const { workspace } = config;
	const mode = config.baseSandboxMode;
	const profile = config.permissionProfile;
	// 先确认有沙盒后端，再建目录
	const sandbox =
		mode === "danger-full-access"
			? undefined
			: { mode, capabilities: checkSandboxSupport(process.platform) };
	const bash = findBash(host.env.PATH);
	const projectId = await host.registry.projectId(
		projectKey(config.projectRoot),
	);
	// 和 session 一样有自己的临时目录，命令结束后删掉
	const directories = createSessionDirectories(host.root, newId(), projectId);
	const env = sandboxEnvironment(host.env, {
		tmpdir: directories.tmp,
		cache: directories.cache,
		workspace,
		bash,
		extra: config.environment,
	});
	const command = shellQuote(options.command);
	const run = async (
		argv: readonly string[],
		reaper: boolean,
	): Promise<SandboxRunResult> => {
		const [file, ...args] = argv;
		if (file === undefined) throw new Error("沙盒的启动命令是空的");
		// 不另起进程组：命令留在终端的前台进程组里，能读终端，Ctrl+C 也到得了它
		const child = spawn(file, args, {
			cwd: workspace,
			env,
			stdio: [...options.stdio, ...(reaper ? ["pipe" as const] : [])],
		});
		const pipe = reaper
			? new ReaperPipe(child.stdio[reaperFd] as Socket)
			: undefined;
		const onAbort = () => {
			void pipe?.reap();
			child.kill("SIGTERM");
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted === true) onAbort();
		try {
			const [exitCode, signal] = (await once(child, "exit")) as [
				number | null,
				NodeJS.Signals | null,
			];
			return { exit_code: exitCode, signal };
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			// 命令留在后台的进程不跟着它继续运行
			await pipe?.reap();
		}
	};
	try {
		if (sandbox === undefined) {
			return await run([bash, "-c", command], false);
		}
		const { capabilities } = sandbox;
		const home = env.HOME;
		if (home === undefined) {
			throw new ConfigError(
				"Host 的环境变量里没有 HOME，找不到要禁止读取的密钥位置",
			);
		}
		const policy: SandboxPolicy = {
			mode: sandbox.mode,
			workspace,
			tmpdir: directories.tmp,
			cache: directories.cache,
			readOnly: [directories.output],
			denyRead: [
				host.root,
				// 配置里指定的凭据文件，不只是当前模型用的那一个
				...Object.values(config.credentials).flatMap((source) =>
					"file" in source && existsSync(source.file)
						? [realpathSync(source.file)]
						: [],
				),
				...config.denyRead,
			],
			denyWrite: [...config.denyWrite],
			home,
			hostRoot: host.root,
			hostEntries: host.hostEntries,
			install: host.install,
			...(profile === undefined ? {} : { profile }),
		};
		const rules = [
			...loadRuleFiles({
				root: host.root,
				projectRoot: config.projectRoot,
				startup: config.ruleFiles,
				parser: await host.shellParser(),
			}),
			...(profile === undefined
				? []
				: [profileDomainRules(config.sandboxMode, profile)]),
		];
		// 不给 ask：名单之外的域名全部拒绝
		const helper = await startSandboxHelper({
			entry: host.helperEntry,
			workspace,
			tmpdir: directories.tmp,
			env,
			scope: { network: networkLists(rules) },
		});
		try {
			const filesystem = await sandboxFilesystem(
				policy,
				{ kind: "command", read: [], write: [], escalated: false },
				capabilities.platform,
			);
			if (filesystem.scanTimedOut) {
				options.onWarning(
					"扫描受保护的路径超时了：没扫到的位置在这条命令的沙盒里不受保护。",
				);
			}
			// Linux 上可能留在用户目录里的占位先登记，下次打开这个工作区的 session 时清理残留
			await new Placeholders(host.data, host.owner, workspace).record(
				filesystem.placeholders,
			);
			const reaper = capabilities.process_cleanup === "reaper";
			const argv = await helper.wrap(
				command,
				bash,
				filesystem.rules,
				reaper ? { fd: reaperFd, close: [] } : undefined,
			);
			try {
				return await run(argv, reaper);
			} finally {
				if (capabilities.platform === "linux") await helper.cleanup();
			}
		} finally {
			await helper.stop();
		}
	} finally {
		for (const dir of [directories.tmp, directories.output]) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}
