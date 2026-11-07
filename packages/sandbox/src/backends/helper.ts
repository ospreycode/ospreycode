import {
	type HelperRequest,
	type HelperResponse,
	lines,
} from "./helper-protocol.js";

/**
 * 辅助进程的入口：只在这里加载 sandbox-runtime（它是进程级单例，还注册信号处理函数），
 * Host 进程不加载它。按 Host 给出的配置初始化一次，为一组沙盒生成启动命令；进程本身由 Host 启动。
 * 和 Host 之间的 stdin 关闭时退出。
 */
export async function main(): Promise<void> {
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	type Config = Parameters<typeof SandboxManager.initialize>[0];
	let config: Config | undefined;
	const reply = (response: HelperResponse) =>
		process.stdout.write(`${JSON.stringify(response)}\n`);
	for await (const line of lines(process.stdin)) {
		const request = JSON.parse(line) as HelperRequest;
		try {
			if (request.method === "initialize") {
				config = request.params.config as Config;
				await SandboxManager.initialize(config);
				reply({ id: request.id, result: {} });
				continue;
			}
			if (config === undefined) {
				throw new Error("辅助进程还没有初始化");
			}
			const { command, bash, filesystem } = request.params;
			// 只有文件限制能按沙盒改，网络代理和询问按进程设置
			const { argv } = await SandboxManager.wrapWithSandboxArgv(
				command,
				bash,
				filesystem === undefined
					? undefined
					: { filesystem: { ...config.filesystem, ...filesystem } },
			);
			reply({ id: request.id, result: { argv } });
		} catch (error) {
			// 回复给 Host，由 Host 决定这个沙盒启动失败怎么处理
			reply({ id: request.id, error: (error as Error).message });
		}
	}
	await SandboxManager.reset();
	process.exit(0);
}

if (import.meta.main) await main();
