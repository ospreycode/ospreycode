import { resolve } from "node:path";
import type { PluginOrigin, PluginStage } from "@ospreycode/agent-host";
import { flag, type ParsedArgs, value } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { stageDiff, stageLines, statusLabel } from "../extension-text.js";
import { sanitize } from "../format/text.js";
import { openHost } from "../host.js";
import { agreed, prompting, requireTerminal } from "./confirm.js";

/**
 * `ospreycode plugin list`：已安装的插件，每行一个，写明名字、版本目录、在当前目录下的状态和安装
 * 来源。`--json` 输出一个数组，字段是 Host SDK 的 `PluginInfo` 加上 `status`。
 */
export async function runPluginList(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const { extensions } = openHost(context);
	const { items } = await extensions.list(context.cwd);
	const plugins = extensions.plugins().map((plugin) => {
		const item = items.find(
			(candidate) =>
				candidate.kind === "plugin" && candidate.name === plugin.name,
		);
		if (item === undefined) {
			throw new Error(`已安装的插件 ${plugin.name} 不在扩展列表里`);
		}
		return { ...plugin, status: item.status };
	});
	if (flag(args, "json")) {
		context.stdout.write(`${JSON.stringify(plugins)}\n`);
		return 0;
	}
	if (plugins.length === 0) {
		context.stderr.write("还没有安装插件\n");
		return 0;
	}
	for (const plugin of plugins) {
		context.stdout.write(
			`${[
				plugin.name,
				plugin.version,
				statusLabel[plugin.status],
				sanitize(
					plugin.source.type === "local"
						? plugin.source.path
						: plugin.source.url,
				),
			].join("  ")}\n`,
		);
	}
	return 0;
}

/**
 * 把准备好的安装或更新给用户看，确认后生效，返回退出码。`--yes` 不询问；询问时回答 d 显示更新带来
 * 的完整差异后再问一次。没有确认、中途出错时都删掉准备好的内容。
 */
async function review(
	stage: PluginStage,
	context: CliContext,
	options: { yes: boolean; verb: "安装" | "更新" },
): Promise<number> {
	const { verb } = options;
	let committed = false;
	try {
		context.stdout.write(`${stageLines(stage).join("\n")}\n`);
		if (stage.unchanged) {
			context.stdout.write("已经安装的就是这份内容\n");
			return 0;
		}
		const confirmed =
			options.yes ||
			(await prompting(context, async (ask) => {
				for (;;) {
					const answer = await ask(
						stage.changes === undefined
							? `${verb}这个插件？它的 MCP server 和 hooks 会在沙盒里运行 [y/N] `
							: `${verb}这个插件？y 确认，d 查看完整差异 [y/d/N] `,
					);
					if (stage.changes === undefined || !/^d$/i.test(answer)) {
						return agreed(answer);
					}
					context.stdout.write(`${stageDiff(stage).join("\n")}\n`);
				}
			}));
		if (!confirmed) {
			context.stderr.write(`没有${verb}\n`);
			return 1;
		}
		await stage.commit();
		committed = true;
		context.stdout.write(
			`已${verb}插件 ${stage.name}，下一个 session 或 /reload 之后生效\n`,
		);
		return 0;
	} finally {
		if (!committed) stage.discard();
	}
}

/** 安装来源：带协议的是 git 仓库的地址，别的是本地目录，相对路径相对当前目录。 */
function originArg(args: ParsedArgs, cwd: string): PluginOrigin {
	const [source] = args.positionals;
	const ref = value(args, "ref");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
		return { type: "git", url: source, ...(ref === undefined ? {} : { ref }) };
	}
	if (ref !== undefined) throw new UsageError("--ref 只对 git 仓库有用");
	return { type: "local", path: resolve(cwd, source) };
}

/**
 * `ospreycode plugin add <DIR|URL>`：从本地目录或 git 仓库安装一个插件。先取来内容、按规范校验，
 * 列出它带的 skills、MCP server、hooks 和可执行文件，确认后才生效；`--yes` 不询问。用户不同意时
 * 不安装，退出码 1。
 */
export async function runPluginAdd(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const yes = flag(args, "yes");
	if (!yes) requireTerminal(context, "加上 --yes 直接安装");
	const origin = originArg(args, context.cwd);
	const stage = await openHost(context).extensions.stagePlugin(origin);
	return review(stage, context, { yes, verb: "安装" });
}

/**
 * `ospreycode plugin update <NAME>`：从安装时的来源再取一次，列出相对已安装版本的变化，确认后换成
 * 新版本；`--yes` 不询问。内容没有变时什么都不做。
 */
export async function runPluginUpdate(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const yes = flag(args, "yes");
	if (!yes) requireTerminal(context, "加上 --yes 直接更新");
	const [name] = args.positionals;
	const stage = await openHost(context).extensions.stagePluginUpdate(name);
	return review(stage, context, { yes, verb: "更新" });
}

/**
 * `ospreycode plugin remove <NAME>`：卸载一个插件。不带 `--yes` 时先确认，并问要不要连它的数据目录
 * 一起删除；带 `--yes` 时数据目录留着，除非写了 `--delete-data`。没有安装这个插件时退出码 1。
 */
export async function runPluginRemove(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const yes = flag(args, "yes");
	if (!yes) requireTerminal(context, "加上 --yes 直接卸载");
	const [name] = args.positionals;
	const { extensions } = openHost(context);
	if (!extensions.plugins().some((plugin) => plugin.name === name)) {
		context.stderr.write(`没有安装插件 ${name}\n`);
		return 1;
	}
	let deleteData = flag(args, "delete-data");
	if (!yes) {
		const confirmed = await prompting(context, async (ask) => {
			if (!agreed(await ask(`卸载插件 ${name}？[y/N] `))) return false;
			deleteData ||= agreed(
				await ask(
					"连它的数据目录一起删除？里面可能有它保存的设置和令牌 [y/N] ",
				),
			);
			return true;
		});
		if (!confirmed) {
			context.stderr.write("没有卸载\n");
			return 1;
		}
	}
	await extensions.removePlugin(name, deleteData);
	context.stdout.write(
		`已卸载插件 ${name}${deleteData ? "，数据目录也删除了" : "，数据目录留着"}\n`,
	);
	return 0;
}
