import { flag, type ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { extensionDetail, originText, statusLabel } from "../extension-text.js";
import { openHost } from "../host.js";
import { sanitize } from "../interactive/format.js";

/**
 * `ospreycode hooks list`：当前目录下找到的每一份 hooks 配置（用户级、仓库自带和插件里的）和它的
 * 状态，下面列出它在哪个时机运行什么命令；只有"已启用"的会运行。`--json` 输出一个数组，字段和 Host
 * SDK 的 `ExtensionInfo` 相同。
 */
export async function runHooksList(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const { items } = await openHost(context).extensions.list(context.cwd);
	const hooks = items.filter((item) => item.kind === "hooks");
	if (flag(args, "json")) {
		context.stdout.write(`${JSON.stringify(hooks)}\n`);
		return 0;
	}
	if (hooks.length === 0) {
		context.stderr.write("没有配置 hooks\n");
		return 0;
	}
	for (const item of hooks) {
		const detail =
			item.detail === undefined ? "" : `：${sanitize(item.detail)}`;
		context.stdout.write(
			`${[
				`${originText(item)}  ${statusLabel[item.status]}${detail}`,
				...extensionDetail(item),
			].join("\n")}\n`,
		);
	}
	return 0;
}
