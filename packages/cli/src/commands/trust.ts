import type { ExtensionInfo } from "@ospreycode/agent-host";
import { flag, type ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { extensionDetail, extensionLine } from "../extension-text.js";
import { openHost } from "../host.js";
import { agreed, prompting, requireTerminal } from "./confirm.js";

/**
 * `ospreycode trust list`：当前目录能用到的全部扩展和它们的状态，每行一个；要用户处理的事（没确认
 * 的、内容变了的、加载失败的）另写到 stderr。`--json` 输出一个数组，字段和 Host SDK 的
 * `ExtensionInfo` 相同。
 */
export async function runTrustList(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const { items, warnings } = await openHost(context).extensions.list(
		context.cwd,
	);
	if (flag(args, "json")) {
		context.stdout.write(`${JSON.stringify(items)}\n`);
		return 0;
	}
	if (items.length === 0) context.stderr.write("没有找到扩展\n");
	for (const item of items) context.stdout.write(`${extensionLine(item)}\n`);
	for (const warning of warnings) context.stderr.write(`${warning}\n`);
	return 0;
}

/** 要用户确认的：仓库自带、能读出内容，而且没有确认过或者内容和确认时不一样。 */
function needsReview(item: ExtensionInfo): boolean {
	return (
		item.origin === "project" &&
		item.hash !== undefined &&
		(item.status === "unconfirmed" || item.status === "changed")
	);
}

/**
 * `ospreycode trust review`：逐个审阅当前目录所在仓库里还没确认、或者内容和确认时不一样的扩展。
 * 每个先显示位置和内容摘要，回答 y 就记下对这份内容的确认，q 结束审阅，别的回答跳过。确认记的是
 * 显示出来的那一份：显示之后内容又变了时 Host 拒绝。
 */
export async function runTrustReview(
	_args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireTerminal(context, "trust review 要在终端里逐个确认");
	const { extensions } = openHost(context);
	const pending = (await extensions.list(context.cwd)).items.filter(
		needsReview,
	);
	if (pending.length === 0) {
		context.stdout.write("没有要确认的扩展\n");
		return 0;
	}
	const confirmed = await prompting(context, async (ask) => {
		let count = 0;
		for (const [index, item] of pending.entries()) {
			context.stdout.write(
				`${[
					`（${index + 1}/${pending.length}）${extensionLine(item)}`,
					...extensionDetail(item),
				].join("\n")}\n`,
			);
			const answer = await ask("确认并启用这份内容？y 确认，q 结束 [y/N/q] ");
			if (/^q(uit)?$/i.test(answer)) break;
			if (!agreed(answer)) continue;
			await extensions.confirm(context.cwd, item.id, item.hash as string);
			count += 1;
		}
		return count;
	});
	context.stdout.write(
		`确认了 ${confirmed} 个，还有 ${pending.length - confirmed} 个没有确认；确认的扩展在下一个 session 或 /reload 之后生效\n`,
	);
	return 0;
}
