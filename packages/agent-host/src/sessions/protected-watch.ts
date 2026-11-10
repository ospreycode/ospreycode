import { basename } from "node:path";
import { scanProtected } from "@ospreycode/sandbox";

/** 和包装命令时的扫描相同（见 sandbox 的"受保护的路径"）：深度 3，最多 10 秒。 */
const scan = { depth: 3, timeoutMs: 10_000 };

/** task 结束时的一次检查。 */
export interface ProtectedCheck {
	/** `.git` 的集合和 agent 进程启动时不一样：agent 沙盒没有保护新的仓库，要重启。 */
	repositoriesChanged: boolean;
	/** 这个 task 里新出现的其他受保护路径，提醒用户在沙盒外进入那些目录之前先查看。 */
	appeared: string[];
	/** 扫描超时：没扫到的位置按没有变化处理。 */
	timedOut: boolean;
}

/**
 * Linux 上 agent 沙盒的保护停在它启动的时刻：写入规则不支持通配，受保护的路径是包装时扫描出来的。
 * 这里记下那时工作区里受保护的路径，每个 task 结束时再扫一遍来比较。
 */
export class ProtectedWatch {
	#workspace: string;
	#repositories: Set<string>;
	#known: Set<string>;

	private constructor(workspace: string, paths: readonly string[]) {
		this.#workspace = workspace;
		this.#repositories = new Set(paths.filter(isRepository));
		this.#known = new Set(paths);
	}

	/**
	 * 在准备 agent 沙盒之前调用：之后才出现的仓库都算新的。agent 沙盒要放占位的名字一起记下，
	 * 宿主上的占位不算新出现的路径。
	 */
	static async start(workspace: string): Promise<ProtectedWatch> {
		const { paths, missing } = await scanProtected(workspace, scan);
		return new ProtectedWatch(workspace, [...paths, ...missing]);
	}

	/** task 结束时调用。新出现的受保护路径只报告一次。 */
	async check(): Promise<ProtectedCheck> {
		const { paths, timedOut } = await scanProtected(this.#workspace, scan);
		const repositories = paths.filter(isRepository);
		const appeared = paths.filter(
			(path) => !isRepository(path) && !this.#known.has(path),
		);
		for (const path of paths) this.#known.add(path);
		return {
			// 超时的扫描看不全，少了的不算变化
			repositoriesChanged:
				repositories.some((path) => !this.#repositories.has(path)) ||
				(!timedOut && repositories.length !== this.#repositories.size),
			appeared,
			timedOut,
		};
	}
}

function isRepository(path: string): boolean {
	return basename(path) === ".git";
}
