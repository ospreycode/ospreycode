import { constants } from "node:os";
import { type ParsedArgs, value } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { openHost } from "../host.js";

/**
 * `ospreycode sandbox [--permissions NAME] -- <COMMAND...>`：在当前目录用同一套沙盒运行一条命令，
 * 标准输入输出直通，退出码是命令的退出码；命令被信号结束时是 128 加信号的编号。
 */
export async function runSandbox(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const permissions = value(args, "permissions");
	const abort = new AbortController();
	// 终端里按 Ctrl+C 时命令自己也收到信号；只发给 CLI 的信号要由它结束命令
	const unsubscribe = context.onSignal(() => abort.abort());
	try {
		const result = await openHost(context).runInSandbox({
			workspace: context.cwd,
			...(permissions === undefined ? {} : { permissions }),
			command: args.positionals,
			stdio: [context.stdin, context.stdout, context.stderr],
			signal: abort.signal,
			onWarning: (message) =>
				context.stderr.write(`ospreycode: 警告：${message}\n`),
		});
		if (result.exit_code !== null) return result.exit_code;
		if (result.signal === null) {
			throw new Error("命令结束时既没有退出码也没有信号");
		}
		return 128 + constants.signals[result.signal];
	} finally {
		unsubscribe();
	}
}
