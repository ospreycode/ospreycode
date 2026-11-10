import { join } from "node:path";
import { createHost, type Host } from "@ospreycode/agent-host";
import type { CliContext } from "./context.js";
import { UsageError } from "./errors.js";

/** Host 根目录：主目录下的 `.ospreycode`。不提供改位置的环境变量，测试用临时的 HOME。 */
export function hostRoot(context: CliContext): string {
	const home = context.env.HOME;
	if (home === undefined || home === "") {
		throw new UsageError(
			"环境变量里没有 HOME，找不到 Host 根目录 ~/.ospreycode",
		);
	}
	return join(home, ".ospreycode");
}

/** 按 CLI 的环境创建 Host：根目录在主目录下，打包后的进程入口交给它运行。 */
export function openHost(context: CliContext): Host {
	const { entries } = context;
	return createHost({
		root: hostRoot(context),
		env: context.env,
		...(entries === undefined
			? {}
			: {
					agentEntry: entries.agent,
					applyEditsEntry: entries.applyEdits,
					sandboxHelperEntry: entries.sandboxHelper,
				}),
	});
}
