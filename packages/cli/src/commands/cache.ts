import { flag, type ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { openHost } from "../host.js";

/** `ospreycode cache clear`：清空全部项目的构建缓存，`--project` 只清当前目录所在项目的。 */
export async function runCacheClear(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const cleared = openHost(context).clearCache(
		flag(args, "project") ? { directory: context.cwd } : {},
	);
	context.stdout.write(
		cleared.length === 0
			? "没有要清空的构建缓存\n"
			: `已清空 ${cleared.length} 个项目的构建缓存\n`,
	);
	return 0;
}
