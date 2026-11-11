import type { Host } from "@ospreycode/agent-host";
import type { CliContext } from "./context.js";

/**
 * 开始清理到期的 session，不等它做完：打开 session 之后调用，不拖慢启动。返回的函数在进程退出之前
 * 调用，等清理结束；清理出了错就在 stderr 上写一条警告，退出码不变。
 */
export function startSessionCleanup(
	host: Host,
	context: CliContext,
): () => Promise<void> {
	// 这时还没有人等它：失败先当作结果留着，等的时候再报告
	const cleaning = host.cleanExpiredSessions().then(
		() => undefined,
		(error: unknown) => ({ error }),
	);
	return async () => {
		const failed = await cleaning;
		if (failed === undefined) return;
		const { error } = failed;
		if (!(error instanceof Error)) throw error;
		context.stderr.write(
			`ospreycode: 警告：清理到期的 session 时出错：${error.stack}\n`,
		);
	};
}
