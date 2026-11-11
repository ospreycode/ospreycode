import { readFileSync } from "node:fs";
import { bubblewrapProblem } from "./bubblewrap.js";
import {
	type HelperCall,
	type HelperMessage,
	type HelperRequest,
	lines,
} from "./helper-protocol.js";

/** 辅助进程自己启动的子进程（Linux 上 sandbox-runtime 的 socat 桥接），报给 Host 记进进程登记表。 */
function childProcesses(): number[] {
	if (process.platform !== "linux") return [];
	return readFileSync(
		`/proc/${process.pid}/task/${process.pid}/children`,
		"utf8",
	)
		.split(" ")
		.filter((pid) => pid !== "")
		.map(Number);
}

/**
 * 辅助进程的入口：只在这里加载 sandbox-runtime（它是进程级单例，还注册信号处理函数），
 * Host 进程不加载它。按 Host 给出的配置初始化一次，为一组沙盒生成启动命令并运行它们的代理；
 * 沙盒里的进程由 Host 启动。名单之外的域名经 stdout 问 Host，连接挂起到 Host 回答为止。
 * 和 Host 之间的 stdin 关闭时拒绝全部等待中的连接并退出。
 */
export async function main(): Promise<void> {
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	type Config = Parameters<typeof SandboxManager.initialize>[0];
	let config: Config | undefined;
	const send = (message: HelperMessage) =>
		process.stdout.write(`${JSON.stringify(message)}\n`);
	const asks = new Map<number, (allow: boolean, reason?: string) => void>();
	let nextAsk = 0;
	const ask = ({ host, port }: { host: string; port: number | undefined }) =>
		new Promise<true | { allow: false; reason: string }>((resolve) => {
			if (port === undefined) {
				resolve({ allow: false, reason: "the connection has no port" });
				return;
			}
			const id = nextAsk++;
			asks.set(id, (allow, reason) =>
				resolve(allow ? true : { allow: false, reason: reason ?? "denied" }),
			);
			send({ ask: { id, host, port } });
		});
	const handle = async (
		request: HelperCall,
	): Promise<{ argv?: string[]; children?: number[] }> => {
		if (request.method === "initialize") {
			// 后端的警告按能力缺失处理：缺少 seccomp 组件之类的问题只出现在 warnings 里
			const { errors, warnings } = SandboxManager.checkDependencies();
			if (errors.length + warnings.length > 0) {
				throw new Error([...errors, ...warnings].join("; "));
			}
			if (process.platform === "linux") {
				// sandbox-runtime 只检查 bwrap 在不在，不看版本和安装方式
				const problem = bubblewrapProblem(process.env.PATH ?? "");
				if (problem !== undefined) throw new Error(problem);
			}
			// sandbox-runtime 每次包装时从本进程的环境变量取要 mask 的真实值
			Object.assign(process.env, request.params.secrets);
			config = request.params.config as Config;
			await SandboxManager.initialize(
				config,
				request.params.ask ? ask : undefined,
			);
			return { children: childProcesses() };
		}
		if (config === undefined) throw new Error("辅助进程还没有初始化");
		if (request.method === "cleanup") {
			SandboxManager.cleanupAfterCommand();
			return {};
		}
		const { command, bash, filesystem } = request.params;
		// 只有文件限制能按沙盒改，网络代理和询问按进程设置
		const { argv } = await SandboxManager.wrapWithSandboxArgv(command, bash, {
			filesystem,
		});
		// Linux 上写入规则里的通配会被悄悄跳过，等于没有保护
		const skipped = SandboxManager.getLinuxGlobPatternWarnings();
		if (skipped.length > 0) {
			throw new Error(`沙盒后端跳过了这些写入规则：${skipped.join(", ")}`);
		}
		return { argv };
	};
	for await (const line of lines(process.stdin)) {
		const request = JSON.parse(line) as HelperRequest;
		if (request.method === "answer") {
			const { ask: id, allow, reason } = request.params;
			const answer = asks.get(id);
			if (answer === undefined) {
				throw new Error(`Host 回答了不存在的网络询问 ${id}`);
			}
			asks.delete(id);
			answer(allow, reason);
			continue;
		}
		// 不等它做完再读下一行：包装可能要扫描目录，其间还要收网络询问的回答
		handle(request).then(
			(result) => send({ id: request.id, result }),
			// 回复给 Host，由 Host 决定这个沙盒启动失败怎么处理
			(error: Error) => send({ id: request.id, error: error.message }),
		);
	}
	for (const answer of asks.values()) answer(false, "the session ended");
	await SandboxManager.reset();
	process.exit(0);
}

if (import.meta.main) await main();
